// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

import Anthropic from "@anthropic-ai/sdk";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import { PRACTICE_AREAS } from "../types.js";
import type { Client } from "../types.js";

const client = new Anthropic({ apiKey: Config.anthropic.apiKey });

/** Detect the primary practice area from a document's title + first ~2000 chars. */
export async function detectPracticeArea(title: string, content: string): Promise<string | null> {
  const snippet = content.slice(0, 2000);
  const prompt = `You are a legal categorisation assistant. Given a document title and excerpt, identify the single most relevant practice area from the list below. Reply with ONLY the exact practice area name, or "Unknown" if none fits.

Practice areas:
${PRACTICE_AREAS.join("\n")}

Document title: ${title}
Document excerpt:
${snippet}`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (msg.content[0] as { type: string; text: string }).text?.trim();
    if (!text || text === "Unknown") return null;
    const match = PRACTICE_AREAS.find((pa) => pa.toLowerCase() === text.toLowerCase());
    return match ?? null;
  } catch (err) {
    logger.warn("Practice area detection failed", { error: (err as Error).message });
    return null;
  }
}

/** Identify which client (if any) a document likely relates to, based on known clients. */
export async function detectClient(
  title: string,
  content: string,
  clients: Client[],
): Promise<{ clientNumber: string; clientName: string } | null> {
  if (!clients.length) return null;
  const snippet = content.slice(0, 3000);
  const clientList = clients.map((c) => `- ${c.clientNumber}: ${c.name}`).join("\n");
  const prompt = `You are a legal matter assistant. Given a document and a list of clients, identify which client the document most likely relates to. Reply with ONLY the client number (e.g. "C-001"), or "None" if no clear match.

Clients:
${clientList}

Document title: ${title}
Document excerpt:
${snippet}`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 32,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (msg.content[0] as { type: string; text: string }).text?.trim();
    if (!text || text === "None") return null;
    const found = clients.find((c) => c.clientNumber.toLowerCase() === text.toLowerCase());
    return found ? { clientNumber: found.clientNumber, clientName: found.name } : null;
  } catch (err) {
    logger.warn("Client detection failed", { error: (err as Error).message });
    return null;
  }
}
