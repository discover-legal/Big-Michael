// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

package providers

// ─── Provider abstraction ─────────────────────────────────────────────────────

type ContentBlockType string

const (
	BlockText       ContentBlockType = "text"
	BlockToolUse    ContentBlockType = "tool_use"
	BlockToolResult ContentBlockType = "tool_result"
	BlockThinking   ContentBlockType = "thinking"
)

type ContentBlock struct {
	Type      ContentBlockType       `json:"type"`
	Text      string                 `json:"text,omitempty"`
	Thinking  string                 `json:"thinking,omitempty"`
	ID        string                 `json:"id,omitempty"`          // tool_use
	Name      string                 `json:"name,omitempty"`        // tool_use
	Input     map[string]interface{} `json:"input,omitempty"`       // tool_use
	ToolUseID string                 `json:"tool_use_id,omitempty"` // tool_result
	Content   string                 `json:"content,omitempty"`     // tool_result
}

type Message struct {
	Role    string      `json:"role"`    // "user" | "assistant"
	Content interface{} `json:"content"` // string | []ContentBlock
}

type ToolParam struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
}

type ThinkingConfig struct {
	BudgetTokens int `json:"budget_tokens"`
}

type ChatParams struct {
	Model       string
	MaxTokens   int
	System      string
	Messages    []Message
	Tools       []ToolParam
	CacheSystem bool
	Thinking    *ThinkingConfig
	// JSONMode constrains the decoder to emit a single valid JSON value — no
	// prose preamble, no markdown fences. Honored by the local OpenAI-compatible
	// provider (Ollama/LM Studio) via response_format; the Anthropic provider
	// ignores it (Claude already emits clean JSON on request, and prefill-style
	// forcing 400s on current models). Set it on structured-extraction calls.
	JSONMode bool
}

type Usage struct {
	InputTokens      int
	OutputTokens     int
	CacheWriteTokens *int
	CacheReadTokens  *int
}

type StopReason string

const (
	StopEndTurn   StopReason = "end_turn"
	StopToolUse   StopReason = "tool_use"
	StopMaxTokens StopReason = "max_tokens"
)

type ChatResponse struct {
	StopReason StopReason
	Content    []ContentBlock
	Usage      Usage
	DurationMs int64
}

type Provider interface {
	Chat(params ChatParams) (*ChatResponse, error)
}
