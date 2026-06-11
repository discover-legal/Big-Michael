// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// Tabular review tools — multi-document, column-based extraction into a
// matrix, ported from src/tools/tabular.ts (engine originally from Mike,
// AGPL-3.0). Each (document × column) cell is an independent model extraction
// returning a RAG flag (green/grey/yellow/red), a cited summary using the
// [[page:N||quote:...]] pinpoint format, and reasoning. Completed matrices are
// persisted in-memory keyed by review id so read_table_cells can slice them
// later in the run.

package tools

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/discover-legal/biglaw-go/internal/agents"
	"github.com/discover-legal/biglaw-go/internal/cost"
	"github.com/discover-legal/biglaw-go/internal/providers"
	"github.com/discover-legal/biglaw-go/internal/routing"
	"github.com/google/uuid"
)

// extractionSystem is taken from Mike (AGPL-3.0); see NOTICE.
const extractionSystem = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting — the values are still plain JSON strings (escape newlines as \n).

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[page:N||quote:exact quoted text]], where N is the page number and the quote is a short verbatim excerpt (≤ 25 words), narrowly scoped to the specific claim it supports. Do not have multiple claims share the same long quote. All reasoning and explanation belongs in "reasoning" only.

Flag meaning: green = clearly addressed/favourable; grey = not addressed / not found; yellow = present but qualified, unusual, or needs review; red = problematic, onerous, or non-market.`

const (
	tabularMaxDocs     = 50
	tabularMaxCols     = 30
	tabularMaxDocChars = 120_000
)

var tabularFlags = map[string]bool{"green": true, "grey": true, "yellow": true, "red": true}

// ─── In-memory review store ───────────────────────────────────────────────────

type tabularCell struct {
	Column    string `json:"column"`
	Summary   string `json:"summary"`
	Flag      string `json:"flag"`
	Reasoning string `json:"reasoning"`
}

type tabularRow struct {
	DocumentID string        `json:"documentId"`
	Document   string        `json:"document"`
	Cells      []tabularCell `json:"cells"`
}

type tabularReviewResult struct {
	ReviewID string       `json:"reviewId"`
	Columns  []string     `json:"columns"`
	Rows     []tabularRow `json:"rows"`
}

var (
	tabularMu      sync.Mutex
	tabularReviews = map[string]*tabularReviewResult{}
)

// ─── Cell parsing ─────────────────────────────────────────────────────────────

// parseTabularCell tolerates markdown fences and partial JSON from the model.
func parseTabularCell(raw string) (summary, flag, reasoning string) {
	cleaned := strings.TrimSpace(raw)
	cleaned = strings.TrimPrefix(cleaned, "```json")
	cleaned = strings.TrimPrefix(cleaned, "```JSON")
	cleaned = strings.TrimPrefix(cleaned, "```")
	cleaned = strings.TrimSuffix(strings.TrimSpace(cleaned), "```")
	cleaned = strings.TrimSpace(cleaned)

	var p struct {
		Summary   string `json:"summary"`
		Value     string `json:"value"`
		Flag      string `json:"flag"`
		Reasoning string `json:"reasoning"`
	}
	if err := json.Unmarshal([]byte(cleaned), &p); err != nil {
		fallback := strings.TrimSpace(raw)
		if r := []rune(fallback); len(r) > 500 {
			fallback = string(r[:500])
		}
		if fallback == "" {
			fallback = "Not addressed"
		}
		return fallback, "grey", ""
	}
	summary = strings.TrimSpace(p.Summary)
	if summary == "" {
		summary = strings.TrimSpace(p.Value)
	}
	if summary == "" {
		summary = "Not addressed"
	}
	flag = p.Flag
	if !tabularFlags[flag] {
		flag = "grey"
	}
	return summary, flag, p.Reasoning
}

// truncateUTF8 cuts s to at most n bytes without splitting a rune.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := s[:n]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}

// recordToolModelCost records a CostEntry for a model call made directly by a
// tool (mirrors Agent.recordCost in agents/base.go).
func (r *Registry) recordToolModelCost(resp *providers.ChatResponse, modelID string, cctx cost.CostContext, taskID string) {
	if r.costs == nil || resp == nil {
		return
	}
	isLocal := routing.IsOllamaModel(modelID) || routing.IsLocalModel(modelID)
	bare := routing.ResolveModelID(modelID)

	var costUSD *float64
	var wh *float64
	var watts *int
	if !isLocal {
		cw, cr := 0, 0
		if resp.Usage.CacheWriteTokens != nil {
			cw = *resp.Usage.CacheWriteTokens
		}
		if resp.Usage.CacheReadTokens != nil {
			cr = *resp.Usage.CacheReadTokens
		}
		costUSD = cost.CalcCostUSD(bare, resp.Usage.InputTokens, resp.Usage.OutputTokens, cw, cr)
	} else {
		w := cost.CalcWattHours(r.cfg.Local.InferenceWatts, resp.DurationMs)
		wh = &w
		watts = &r.cfg.Local.InferenceWatts
	}
	provider := "anthropic"
	if routing.IsOllamaModel(modelID) {
		provider = "ollama"
	} else if routing.IsLocalModel(modelID) {
		provider = "local"
	}
	r.costs.Record(cost.RecordRequest{
		Model:            bare,
		Provider:         provider,
		InputTokens:      resp.Usage.InputTokens,
		OutputTokens:     resp.Usage.OutputTokens,
		CacheWriteTokens: resp.Usage.CacheWriteTokens,
		CacheReadTokens:  resp.Usage.CacheReadTokens,
		CostUSD:          costUSD,
		EstimatedWh:      wh,
		EstimatedWatts:   watts,
		DurationMs:       resp.DurationMs,
		Context:          cctx,
		TaskID:           taskID,
	})
}

// ─── register ─────────────────────────────────────────────────────────────────

func (r *Registry) registerTabularTools() {
	r.Register(r.tabularReviewTool())
	r.Register(r.readTableCellsTool())
}

// ─── tabular_review ───────────────────────────────────────────────────────────

func (r *Registry) tabularReviewTool() *ToolImpl {
	return &ToolImpl{
		Name: "tabular_review",
		Schema: providers.ToolParam{
			Name: "tabular_review",
			Description: "Run a tabular review across one or more documents. Define columns (each a question/field to extract); " +
				"for every document × column the tool extracts a cited answer with a RAG flag (green/grey/yellow/red) and reasoning. " +
				"Returns a matrix suitable for due-diligence, CP checklists, or comparison tables.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"documentIds": map[string]interface{}{
						"type":        "array",
						"items":       map[string]interface{}{"type": "string"},
						"description": "Knowledge-store document IDs to review (rows; capped at 50)",
					},
					"columns": map[string]interface{}{
						"type":        "array",
						"description": "Columns (fields) to extract. Each has a name and an extraction prompt (capped at 30).",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"name":   map[string]interface{}{"type": "string", "description": "Column header"},
								"prompt": map[string]interface{}{"type": "string", "description": "What to extract for this column"},
							},
							"required": []string{"name", "prompt"},
						},
					},
				},
				"required": []string{"documentIds", "columns"},
			},
		},
		Exec: func(input map[string]interface{}, ctx agents.ToolContext) (interface{}, error) {
			documentIDs := strSlice(input["documentIds"])
			if len(documentIDs) > tabularMaxDocs {
				documentIDs = documentIDs[:tabularMaxDocs]
			}
			type column struct{ name, prompt string }
			var columns []column
			if rawCols, ok := input["columns"].([]interface{}); ok {
				for _, rc := range rawCols {
					m, _ := rc.(map[string]interface{})
					if m == nil {
						continue
					}
					columns = append(columns, column{name: strInput(m, "name"), prompt: strInput(m, "prompt")})
					if len(columns) == tabularMaxCols {
						break
					}
				}
			}
			if len(documentIDs) == 0 || len(columns) == 0 {
				return map[string]interface{}{"error": "tabular_review requires documentIds and columns", "rows": []interface{}{}}, nil
			}
			if ctx.KnowledgeStore == nil {
				return map[string]interface{}{"error": "knowledge store unavailable", "rows": []interface{}{}}, nil
			}

			model := routing.SelectModel(r.cfg, routing.SelectParams{TaskType: routing.TaskExtraction})
			prov, err := r.provReg.Get(model)
			if err != nil {
				return nil, err
			}
			resolved := routing.ResolveModelID(model)

			rows := make([]tabularRow, 0, len(documentIDs))
			for _, docID := range documentIDs {
				text, _ := ctx.KnowledgeStore.GetFullText(docID)
				docLabel := docID
				if text == "" {
					docLabel = docID + " (not found)"
				}
				cells := make([]tabularCell, len(columns))
				var wg sync.WaitGroup
				for i, col := range columns {
					if text == "" {
						cells[i] = tabularCell{Column: col.name, Summary: "Document not found", Flag: "grey"}
						continue
					}
					wg.Add(1)
					go func(i int, col column) {
						defer wg.Done()
						resp, err := prov.Chat(providers.ChatParams{
							Model:     resolved,
							MaxTokens: 1200,
							System:    extractionSystem,
							Messages: []providers.Message{{
								Role: "user",
								Content: fmt.Sprintf(
									"Document: %s\n\n%s\n\n---\nInstruction: %s If not found, state \"Not Found\". Leave all reasoning in the \"reasoning\" field only.",
									docID, truncateUTF8(text, tabularMaxDocChars), col.prompt),
							}},
						})
						if err != nil {
							slog.Warn("tabular_review cell failed", "docId", docID, "column", col.name, "error", err)
							cells[i] = tabularCell{Column: col.name, Summary: "Extraction failed", Flag: "grey", Reasoning: err.Error()}
							return
						}
						r.recordToolModelCost(resp, model, cost.ContextTask, ctx.TaskID)
						raw := ""
						for _, b := range resp.Content {
							if b.Type == providers.BlockText {
								raw = b.Text
								break
							}
						}
						summary, flag, reasoning := parseTabularCell(raw)
						cells[i] = tabularCell{Column: col.name, Summary: summary, Flag: flag, Reasoning: reasoning}
					}(i, col)
				}
				wg.Wait()
				rows = append(rows, tabularRow{DocumentID: docID, Document: docLabel, Cells: cells})
			}

			flagTally := map[string]int{}
			for _, row := range rows {
				for _, c := range row.Cells {
					flagTally[c.Flag]++
				}
			}
			colNames := make([]string, len(columns))
			for i, c := range columns {
				colNames[i] = c.name
			}

			// Persist the matrix in-memory so read_table_cells can read
			// col/row subsets later in the run.
			reviewID := uuid.New().String()
			tabularMu.Lock()
			tabularReviews[reviewID] = &tabularReviewResult{ReviewID: reviewID, Columns: colNames, Rows: rows}
			tabularMu.Unlock()

			return map[string]interface{}{
				"reviewId":  reviewID,
				"columns":   colNames,
				"rows":      rows,
				"flagTally": flagTally,
				"legend": map[string]interface{}{
					"green":  "addressed/favourable",
					"grey":   "not found",
					"yellow": "qualified/review",
					"red":    "problematic/non-market",
				},
			}, nil
		},
	}
}

// ─── read_table_cells ─────────────────────────────────────────────────────────

func intSliceInput(input map[string]interface{}, key string) []int {
	arr, ok := input[key].([]interface{})
	if !ok {
		return nil
	}
	var out []int
	for _, v := range arr {
		switch n := v.(type) {
		case float64:
			out = append(out, int(n))
		case int:
			out = append(out, n)
		}
	}
	return out
}

func (r *Registry) readTableCellsTool() *ToolImpl {
	return &ToolImpl{
		Name: "read_table_cells",
		Schema: providers.ToolParam{
			Name: "read_table_cells",
			Description: "Read extracted cells from a prior tabular_review (by its review_id). Each cell holds the value " +
				"extracted for a specific column from a specific document, with its RAG flag and reasoning. Pass " +
				"col_indices and/or row_indices (0-based) to read a subset; omit either to read all columns or rows.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"review_id":   map[string]interface{}{"type": "string", "description": "The review_id returned by tabular_review."},
					"col_indices": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "integer"}, "description": "0-based column indices (omit for all)."},
					"row_indices": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "integer"}, "description": "0-based document (row) indices (omit for all)."},
				},
				"required": []string{"review_id"},
			},
		},
		Exec: func(input map[string]interface{}, _ agents.ToolContext) (interface{}, error) {
			reviewID := strInput(input, "review_id")
			tabularMu.Lock()
			review := tabularReviews[reviewID]
			tabularMu.Unlock()
			if review == nil {
				return map[string]interface{}{
					"ok":    false,
					"error": fmt.Sprintf("Review '%s' not found. Run tabular_review first.", reviewID),
				}, nil
			}

			colIndices := intSliceInput(input, "col_indices")
			rowIndices := intSliceInput(input, "row_indices")

			type colRef struct {
				name string
				i    int
			}
			var cols []colRef
			if len(colIndices) > 0 {
				want := map[int]bool{}
				for _, i := range colIndices {
					want[i] = true
				}
				for i, name := range review.Columns {
					if want[i] {
						cols = append(cols, colRef{name, i})
					}
				}
			} else {
				for i, name := range review.Columns {
					cols = append(cols, colRef{name, i})
				}
			}
			type rowRef struct {
				row *tabularRow
				i   int
			}
			var rowRefs []rowRef
			if len(rowIndices) > 0 {
				want := map[int]bool{}
				for _, i := range rowIndices {
					want[i] = true
				}
				for i := range review.Rows {
					if want[i] {
						rowRefs = append(rowRefs, rowRef{&review.Rows[i], i})
					}
				}
			} else {
				for i := range review.Rows {
					rowRefs = append(rowRefs, rowRef{&review.Rows[i], i})
				}
			}

			var cells []map[string]interface{}
			for _, col := range cols {
				for _, row := range rowRefs {
					summary, flag, reasoning := "(not generated)", "grey", ""
					for _, c := range row.row.Cells {
						if c.Column == col.name {
							summary, flag, reasoning = c.Summary, c.Flag, c.Reasoning
							break
						}
					}
					cells = append(cells, map[string]interface{}{
						"col":       col.i,
						"column":    col.name,
						"row":       row.i,
						"document":  row.row.Document,
						"summary":   summary,
						"flag":      flag,
						"reasoning": reasoning,
					})
				}
			}
			colNames := make([]string, len(cols))
			for i, c := range cols {
				colNames[i] = c.name
			}
			return map[string]interface{}{
				"ok":        true,
				"review_id": reviewID,
				"columns":   colNames,
				"cellCount": len(cells),
				"cells":     cells,
			}, nil
		},
	}
}
