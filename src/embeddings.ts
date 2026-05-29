// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

import OpenAI from "openai";
import { Config } from "./config.js";
import type { EmbeddingResult } from "./types.js";

// OpenAI embeddings in dev; swap for Voyage AI (voyage-3-lite) or RuVector's built-in
// ruvllm inference when moving to production with RuVector.
const client = new OpenAI({ apiKey: Config.embeddings.apiKey });

export async function embed(text: string): Promise<EmbeddingResult> {
  const response = await client.embeddings.create({
    model: Config.embeddings.model,
    input: text,
    dimensions: Config.embeddings.dimensions,
  });
  return {
    text,
    embedding: response.data[0].embedding,
    model: Config.embeddings.model,
  };
}

export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];
  const response = await client.embeddings.create({
    model: Config.embeddings.model,
    input: texts,
    dimensions: Config.embeddings.dimensions,
  });
  return response.data.map((item, i) => ({
    text: texts[i],
    embedding: item.embedding,
    model: Config.embeddings.model,
  }));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}