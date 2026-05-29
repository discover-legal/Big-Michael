// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

import Anthropic from "@anthropic-ai/sdk";
import { Config } from "../config.js";
import type {
  ModelProvider,
  ChatParams,
  ChatResponse,
  ProviderContentBlock,
  ProviderMessage,
  ProviderTool,
} from "./types.js";

export class AnthropicProvider implements ModelProvider {
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: Config.anthropic.apiKey });
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const msg = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools: params.tools as Anthropic.Tool[] | undefined,
      messages: params.messages.map(toAnthropicMessage),
    });

    const content = msg.content.map(fromAnthropicBlock);
    const stopReason = fromAnthropicStopReason(msg.stop_reason);
    return { stopReason, content };
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function toAnthropicMessage(m: ProviderMessage): Anthropic.MessageParam {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }
  return {
    role: m.role,
    // Anthropic accepts the same block shapes we use internally — cast is safe
    content: m.content as Anthropic.ContentBlock[],
  };
}

function fromAnthropicBlock(b: Anthropic.ContentBlock): ProviderContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") {
    return {
      type: "tool_use",
      id: b.id,
      name: b.name,
      input: b.input as Record<string, unknown>,
    };
  }
  // Fallback — shouldn't happen in practice
  return { type: "text", text: JSON.stringify(b) };
}

function fromAnthropicStopReason(
  reason: string | null,
): "end_turn" | "tool_use" | "max_tokens" {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end_turn";
}
