// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

// Ollama / generic OpenAI-compatible provider.
// Used for LM Studio, Jan, vLLM, llama.cpp, and local inference.

package providers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/discover-legal/biglaw-go/internal/config"
	"github.com/discover-legal/biglaw-go/internal/routing"
)

type OllamaProvider struct {
	baseURL                string
	apiKey                 string
	useMaxCompletionTokens bool
	client                 *http.Client
}

func NewOllamaProvider(cfg *config.Config) *OllamaProvider {
	baseURL := cfg.Local.OllamaURL
	apiKey := "ollama"
	if !cfg.Local.OllamaEnabled && cfg.Local.LocalInferenceURL != "" {
		apiKey = cfg.Local.LocalInferenceKey
	}
	if cfg.Local.LocalInferenceURL != "" {
		baseURL = cfg.Local.LocalInferenceURL
		apiKey = cfg.Local.LocalInferenceKey
	}
	// The OpenAI convention (and our .env examples) is a base URL that already
	// ends in /v1 — e.g. http://localhost:11434/v1. Chat() appends the full
	// /v1/chat/completions path, so strip a trailing /v1 to avoid /v1/v1/.
	baseURL = strings.TrimRight(baseURL, "/")
	baseURL = strings.TrimSuffix(baseURL, "/v1")
	return &OllamaProvider{
		baseURL: baseURL,
		apiKey:  apiKey,
		// See openAIChatRequest: OpenAI-hosted models take a different
		// token-cap parameter than local OpenAI-compatible servers.
		useMaxCompletionTokens: strings.Contains(baseURL, "api.openai.com"),
		client:                 &http.Client{Timeout: 120 * time.Second},
	}
}

// openAIChatRequest matches the OpenAI/Ollama chat completions format.
// Exactly one of MaxTokens / MaxCompletionTokens is set per request:
// OpenAI-hosted models (gpt-5.x, o-series) reject max_tokens outright and
// require max_completion_tokens, while local OpenAI-compatible servers
// (Ollama, LM Studio, vLLM, llama.cpp) speak the original max_tokens.
type openAIChatRequest struct {
	Model               string             `json:"model"`
	Messages            []openAIMessage    `json:"messages"`
	Tools               []openAITool       `json:"tools,omitempty"`
	MaxTokens           int                `json:"max_tokens,omitempty"`
	MaxCompletionTokens int                `json:"max_completion_tokens,omitempty"`
	Stream              bool               `json:"stream"`
	ResponseFormat      *openAIResponseFmt `json:"response_format,omitempty"`
}

// openAIResponseFmt requests JSON-constrained decoding. Ollama and LM Studio
// honor {"type":"json_object"} on the OpenAI-compatible endpoint, guaranteeing
// a single valid JSON value with no prose preamble or markdown fences.
type openAIResponseFmt struct {
	Type string `json:"type"`
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAITool struct {
	Type     string         `json:"type"`
	Function openAIFunction `json:"function"`
}

type openAIFunction struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
}

type openAIChatResponse struct {
	Choices []struct {
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

func (p *OllamaProvider) Chat(params ChatParams) (*ChatResponse, error) {
	t0 := time.Now()

	// Build messages — Ollama uses a flat OpenAI-style format.
	// Prepend system message if present.
	var msgs []openAIMessage
	if params.System != "" {
		msgs = append(msgs, openAIMessage{Role: "system", Content: params.System})
	}
	for _, m := range params.Messages {
		switch v := m.Content.(type) {
		case string:
			msgs = append(msgs, openAIMessage{Role: m.Role, Content: v})
		case []ContentBlock:
			// Flatten to text for Ollama (no tool_use support in all models).
			var sb strings.Builder
			for _, b := range v {
				if b.Type == BlockText {
					sb.WriteString(b.Text)
				} else if b.Type == BlockToolResult {
					sb.WriteString(b.Content)
				}
			}
			msgs = append(msgs, openAIMessage{Role: m.Role, Content: sb.String()})
		}
	}

	bareModel := routing.ResolveModelID(params.Model)
	reqBody := openAIChatRequest{
		Model:    bareModel,
		Messages: msgs,
		Stream:   false,
	}
	if p.useMaxCompletionTokens {
		reqBody.MaxCompletionTokens = params.MaxTokens
	} else {
		reqBody.MaxTokens = params.MaxTokens
	}
	if params.JSONMode {
		reqBody.ResponseFormat = &openAIResponseFmt{Type: "json_object"}
	}

	body, _ := json.Marshal(reqBody)
	url := p.baseURL + "/v1/chat/completions"
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("ollama: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if p.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+p.apiKey)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ollama: do request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("ollama: HTTP %d: %s", resp.StatusCode, string(b))
	}

	var chatResp openAIChatResponse
	if err := json.NewDecoder(resp.Body).Decode(&chatResp); err != nil {
		return nil, fmt.Errorf("ollama: decode response: %w", err)
	}

	text := ""
	if len(chatResp.Choices) > 0 {
		text = chatResp.Choices[0].Message.Content
	}

	return &ChatResponse{
		StopReason: StopEndTurn,
		Content:    []ContentBlock{{Type: BlockText, Text: text}},
		Usage: Usage{
			InputTokens:  chatResp.Usage.PromptTokens,
			OutputTokens: chatResp.Usage.CompletionTokens,
		},
		DurationMs: time.Since(t0).Milliseconds(),
	}, nil
}
