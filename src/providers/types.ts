// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

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
