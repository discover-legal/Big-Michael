// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// Word (.docx) generation tools — docx_generate builds a Word document from
// structured sections (headings, prose, bullet lists, tables, landscape
// orientation, page breaks); replicate_document makes byte-for-byte copies of
// an existing .docx for use as templates. Ported from src/tools/docx.ts
// (itself ported from Mike, AGPL-3.0). Uses a minimal dependency-free OOXML
// writer (same technique as internal/lpm/docx.go) instead of an Office library.

package tools

import (
	"archive/zip"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/discover-legal/biglaw-go/internal/agents"
	"github.com/discover-legal/biglaw-go/internal/providers"
)

// ─── Shared .docx path resolution ────────────────────────────────────────────

// Docx tools are confined to the configured output directory so that a
// prompt-injected agent cannot read or overwrite arbitrary .docx files
// elsewhere on the filesystem. Symlinks are resolved before the boundary
// check so a link inside the output dir pointing outside it cannot escape.
func (r *Registry) resolveDocxOutputPath(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("a file path is required")
	}
	root, err := filepath.Abs(r.cfg.PDF.OutputDir)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	// Always resolve relative to the output dir; absolute paths are re-anchored
	// there too so agents cannot escape to arbitrary filesystem locations.
	base := p
	if filepath.IsAbs(p) {
		base = filepath.Base(p)
	}
	candidate := filepath.Join(root, base) // Join cleans any ../ segments
	real, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("file not found: '%s'", p)
	}
	if real != root && !strings.HasPrefix(real, root+string(filepath.Separator)) {
		return "", fmt.Errorf("path '%s' resolves outside the document output directory", p)
	}
	return real, nil
}

// ─── Minimal OOXML writer ─────────────────────────────────────────────────────

const docxFont = "Times New Roman"

var docxXMLEscaper = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&apos;",
)

func docxEscape(s string) string { return docxXMLEscaper.Replace(s) }

// docxRunXML renders a single Times New Roman text run at the given
// half-point size, optionally bold. xml:space="preserve" keeps spaces intact.
func docxRunXML(text string, bold bool, halfPt int) string {
	var b strings.Builder
	b.WriteString("<w:r><w:rPr>")
	b.WriteString(`<w:rFonts w:ascii="` + docxFont + `" w:hAnsi="` + docxFont + `" w:cs="` + docxFont + `"/>`)
	if bold {
		b.WriteString("<w:b/>")
	}
	b.WriteString(`<w:sz w:val="` + strconv.Itoa(halfPt) + `"/><w:szCs w:val="` + strconv.Itoa(halfPt) + `"/>`)
	b.WriteString(`</w:rPr><w:t xml:space="preserve">` + docxEscape(text) + "</w:t></w:r>")
	return b.String()
}

// docxBody accumulates body content as OOXML fragments.
type docxBody struct{ b strings.Builder }

func (d *docxBody) para(props, runs string) {
	d.b.WriteString("<w:p>")
	if props != "" {
		d.b.WriteString("<w:pPr>" + props + "</w:pPr>")
	}
	d.b.WriteString(runs + "</w:p>")
}

// Title — bold 16pt, matching the TS Title heading.
func (d *docxBody) title(text string) {
	d.para(`<w:spacing w:after="240"/>`, docxRunXML(text, true, 32))
}

// Heading — bold 13pt for any level (the TS port used size 26 for all heading
// levels); the level is kept for outline semantics via spacing.
func (d *docxBody) heading(level int, text string) {
	_ = level
	d.para(`<w:spacing w:before="240" w:after="120"/>`, docxRunXML(text, true, 26))
}

// Prose paragraph — justified 11pt body text.
func (d *docxBody) prose(text string) {
	d.para(`<w:spacing w:after="160"/><w:jc w:val="both"/>`, docxRunXML(text, false, 22))
}

// Bullet — rendered with a literal bullet glyph to avoid a numbering part.
func (d *docxBody) bullet(text string) {
	d.para(`<w:spacing w:after="40"/>`, docxRunXML("•  "+text, false, 22))
}

// PageBreak — an empty paragraph forcing a new page.
func (d *docxBody) pageBreak() {
	d.b.WriteString(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`)
}

// Spacer — empty paragraph after a table.
func (d *docxBody) spacer() {
	d.para(`<w:spacing w:after="160"/>`, "")
}

// table renders a full-width bordered table; the header row is bold.
func (d *docxBody) table(headers []string, rows [][]string) {
	const border = `<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
		`<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
		`<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
		`<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
		`<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
		`<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>`
	cell := func(text string, bold bool) string {
		return "<w:tc><w:tcPr></w:tcPr><w:p>" + docxRunXML(text, bold, 20) + "</w:p></w:tc>"
	}
	d.b.WriteString(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>` + border + `</w:tblBorders></w:tblPr>`)
	d.b.WriteString(`<w:tr><w:trPr><w:tblHeader/></w:trPr>`)
	for _, h := range headers {
		d.b.WriteString(cell(h, true))
	}
	d.b.WriteString("</w:tr>")
	for _, row := range rows {
		d.b.WriteString("<w:tr>")
		for i := range headers {
			v := ""
			if i < len(row) {
				v = row[i]
			}
			d.b.WriteString(cell(v, false))
		}
		d.b.WriteString("</w:tr>")
	}
	d.b.WriteString("</w:tbl>")
}

// bytes assembles the parts into a .docx ZIP archive (A4, optional landscape).
func (d *docxBody) bytes(landscape bool) ([]byte, error) {
	const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

	sectPr := `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`
	if landscape {
		sectPr = `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`
	}

	document := `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>` + d.b.String() + sectPr + `</w:body>
</w:document>`

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	parts := []struct{ name, body string }{
		{"[Content_Types].xml", contentTypes},
		{"_rels/.rels", rels},
		{"word/document.xml", document},
	}
	for _, p := range parts {
		w, err := zw.Create(p.name)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write([]byte(p.body)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ─── Section parsing ──────────────────────────────────────────────────────────

var blankLineSplit = regexp.MustCompile(`\n{2,}`)

func isBulletLine(line string) bool {
	t := strings.TrimSpace(line)
	return strings.HasPrefix(t, "- ") || strings.HasPrefix(t, "* ") || strings.HasPrefix(t, "• ")
}

func stripBulletMarker(line string) string {
	t := strings.TrimSpace(line)
	for _, m := range []string{"- ", "* ", "• "} {
		if strings.HasPrefix(t, m) {
			return strings.TrimSpace(strings.TrimPrefix(t, m))
		}
	}
	return t
}

// writeProse renders prose content: paragraphs separated by blank lines; a
// block whose lines all start with a bullet marker becomes a bullet list.
func writeProse(d *docxBody, content string) {
	for _, block := range blankLineSplit.Split(content, -1) {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		lines := strings.Split(block, "\n")
		allBullets := true
		for _, l := range lines {
			if strings.TrimSpace(l) == "" {
				continue
			}
			if !isBulletLine(l) {
				allBullets = false
				break
			}
		}
		if allBullets {
			for _, l := range lines {
				if strings.TrimSpace(l) == "" {
					continue
				}
				d.bullet(stripBulletMarker(l))
			}
			continue
		}
		d.prose(strings.Join(strings.Fields(strings.ReplaceAll(block, "\n", " ")), " "))
	}
}

var slugUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

func docxSlugFilename(name string) string {
	slug := slugUnsafe.ReplaceAllString(strings.ToLower(name), "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 80 {
		slug = slug[:80]
	}
	if slug == "" {
		slug = "document"
	}
	if !strings.HasSuffix(slug, ".docx") {
		slug += ".docx"
	}
	return slug
}

// ─── register ─────────────────────────────────────────────────────────────────

func (r *Registry) registerDocxTools() {
	r.Register(r.docxGenerateTool())
	r.Register(r.replicateDocumentTool())
}

// ─── docx_generate ────────────────────────────────────────────────────────────

func (r *Registry) docxGenerateTool() *ToolImpl {
	return &ToolImpl{
		Name: "docx_generate",
		Schema: providers.ToolParam{
			Name: "docx_generate",
			Description: "Generate a Word (.docx) legal document from structured content (headings, prose, bullet lists, tables). " +
				"Use when drafting or producing a deliverable document. Supports landscape orientation and page breaks. " +
				"Returns the output file path.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"title":     map[string]interface{}{"type": "string", "description": "Document title (used as filename and H1 heading)"},
					"filename":  map[string]interface{}{"type": "string", "description": "Optional output filename (defaults to a slug of the title)"},
					"landscape": map[string]interface{}{"type": "boolean", "description": "True for landscape orientation (e.g. wide checklists/tables)"},
					"sections": map[string]interface{}{
						"type":        "array",
						"description": "Document sections, each with an optional heading, prose content, and/or table.",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"heading":   map[string]interface{}{"type": "string"},
								"level":     map[string]interface{}{"type": "integer", "description": "Heading level 1-3"},
								"content":   map[string]interface{}{"type": "string", "description": "Prose (paragraphs separated by blank lines; lines starting with '- ' become bullets)"},
								"pageBreak": map[string]interface{}{"type": "boolean", "description": "Start this section on a new page"},
								"table": map[string]interface{}{
									"type": "object",
									"properties": map[string]interface{}{
										"headers": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}},
										"rows":    map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}}},
									},
									"required": []string{"headers", "rows"},
								},
							},
						},
					},
				},
				"required": []string{"title", "sections"},
			},
		},
		Exec: func(input map[string]interface{}, _ agents.ToolContext) (interface{}, error) {
			title := strInput(input, "title")
			if title == "" {
				title = "Legal Document"
			}
			landscape, _ := input["landscape"].(bool)
			sections, _ := input["sections"].([]interface{})

			// Always write into the configured output directory — ignore any
			// caller-supplied directory to prevent path traversal.
			outputRoot, err := filepath.Abs(r.cfg.PDF.OutputDir)
			if err != nil {
				return nil, err
			}
			name := strInput(input, "filename")
			if name == "" {
				name = title
			}
			filename := docxSlugFilename(name)
			outputPath := filepath.Join(outputRoot, filename)
			// Belt-and-suspenders: verify the resolved path stays within the root.
			if abs, _ := filepath.Abs(outputPath); abs != outputRoot &&
				!strings.HasPrefix(abs, outputRoot+string(filepath.Separator)) {
				return nil, fmt.Errorf("resolved output path escapes the configured output directory")
			}

			body := &docxBody{}
			body.title(title)
			for _, raw := range sections {
				s, _ := raw.(map[string]interface{})
				if s == nil {
					continue
				}
				if pb, _ := s["pageBreak"].(bool); pb {
					body.pageBreak()
				}
				if h, _ := s["heading"].(string); h != "" {
					level := intInput(s, "level", 1)
					if level < 1 {
						level = 1
					}
					if level > 3 {
						level = 3
					}
					body.heading(level, h)
				}
				if c, _ := s["content"].(string); c != "" {
					writeProse(body, c)
				}
				if tbl, _ := s["table"].(map[string]interface{}); tbl != nil {
					headers := strSlice(tbl["headers"])
					if len(headers) > 0 {
						var rows [][]string
						if rawRows, ok := tbl["rows"].([]interface{}); ok {
							for _, rr := range rawRows {
								rows = append(rows, strSlice(rr))
							}
						}
						body.table(headers, rows)
						body.spacer()
					}
				}
			}

			buf, err := body.bytes(landscape)
			if err != nil {
				return nil, err
			}
			if err := os.MkdirAll(outputRoot, 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(outputPath, buf, 0o644); err != nil {
				return nil, err
			}
			return map[string]interface{}{
				"outputPath":    outputPath,
				"filename":      filename,
				"sectionCount":  len(sections),
				"landscape":     landscape,
				"fileSizeBytes": len(buf),
			}, nil
		},
	}
}

// strSlice coerces a JSON array of values into []string.
func strSlice(v interface{}) []string {
	arr, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		out = append(out, fmt.Sprintf("%v", item))
	}
	return out
}

// ─── replicate_document ───────────────────────────────────────────────────────

func (r *Registry) replicateDocumentTool() *ToolImpl {
	return &ToolImpl{
		Name: "replicate_document",
		Schema: providers.ToolParam{
			Name: "replicate_document",
			Description: "Make byte-for-byte copies of an existing .docx file as new files. Use when you want standalone " +
				"copies to edit (e.g. 'use this NDA as a template', 'give me three drafts I can adapt') without " +
				"modifying the original. Pass `count` to create multiple copies in one call. Returns the new file " +
				"paths so you can immediately call edit_document on them.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"path":         map[string]interface{}{"type": "string", "description": "Path to the source .docx (absolute, or relative to the output dir)."},
					"count":        map[string]interface{}{"type": "integer", "description": "How many copies to create (default 1, max 20).", "minimum": 1, "maximum": 20},
					"new_filename": map[string]interface{}{"type": "string", "description": "Optional base filename for the copies (extension forced to .docx)."},
				},
				"required": []string{"path"},
			},
		},
		Exec: func(input map[string]interface{}, _ agents.ToolContext) (interface{}, error) {
			rawPath := strInput(input, "path")
			count := intInput(input, "count", 1)
			if count < 1 {
				count = 1
			}
			if count > 20 {
				count = 20
			}
			resolved, err := r.resolveDocxOutputPath(rawPath)
			if err != nil {
				return map[string]interface{}{"ok": false, "error": err.Error()}, nil
			}
			if strings.ToLower(filepath.Ext(resolved)) != ".docx" {
				return map[string]interface{}{"ok": false, "error": "replicate_document only supports .docx files."}, nil
			}
			data, err := os.ReadFile(resolved)
			if err != nil {
				return map[string]interface{}{"ok": false, "error": fmt.Sprintf("Could not read file: %s", err)}, nil
			}

			dir := filepath.Dir(resolved)
			base := strings.TrimSuffix(filepath.Base(resolved), ".docx")
			if nf := strInput(input, "new_filename"); nf != "" {
				base = strings.TrimSuffix(filepath.Base(nf), ".docx")
			}
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, err
			}

			var copies []map[string]interface{}
			for i := 1; i <= count; i++ {
				filename := base + ".docx"
				if count > 1 {
					filename = fmt.Sprintf("%s (%d).docx", base, i)
				}
				outPath := filepath.Join(dir, filename)
				if err := os.WriteFile(outPath, data, 0o644); err != nil {
					return nil, err
				}
				copies = append(copies, map[string]interface{}{"path": outPath, "filename": filename})
			}
			return map[string]interface{}{"ok": true, "count": len(copies), "copies": copies}, nil
		},
	}
}
