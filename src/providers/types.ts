// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

/**
 * Normalized provider interface — abstracts Anthropic and Ollama (local) APIs
 * behind a common message format so the agent loop works identically for both.
 */

// ─── Content blocks ───────────────────────────────────────────────────────────

export interface ProviderTextBlock {
  type: "text";
  text: string;
}

export interface ProviderToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type ProviderContentBlock =
  | ProviderTextBlock
  | ProviderToolUseBlock
  | ProviderToolResultBlock;

// ─── Messages ─────────────────────────────────────────────────────────────────

export interface ProviderMessage {
  role: "user" | "assistant";
  /** String shorthand for simple text messages; content block array otherwise */
  content: string | ProviderContentBlock[];
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export interface ProviderTool {
  name: string;
  description?: string;
  input_schema: {
    type: "object";
    properties?: unknown;
    required?: string[];
    [key: string]: unknown;
  };
}

// ─── Chat params / response ───────────────────────────────────────────────────

export interface ChatParams {
  model: string;
  system: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  maxTokens: number;
}

export interface ChatResponse {
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  content: ProviderContentBlock[];
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface ModelProvider {
  chat(params: ChatParams): Promise<ChatResponse>;
}
