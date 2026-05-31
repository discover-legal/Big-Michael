// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

import { QdrantClient } from "@qdrant/js-client-rest";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../config.js";
import { embed } from "../embeddings.js";
import { logger } from "../logger.js";
import type { Document, SearchResult } from "../types.js";

const COLLECTION = Config.vectorDb.collections.documents;
const DIMS = Config.embeddings.dimensions;
const CHUNK_SIZE = 1500;    // characters per chunk
const CHUNK_OVERLAP = 200;

export class KnowledgeStore {
  private readonly qdrant: QdrantClient;
  private ready = false;

  constructor() {
    this.qdrant = new QdrantClient({
      url: Config.vectorDb.url,
      apiKey: Config.vectorDb.apiKey,
    });
  }

  async init(): Promise<void> {
    const { collections } = await this.qdrant.getCollections();
    if (!collections.some((c) => c.name === COLLECTION)) {
      await this.qdrant.createCollection(COLLECTION, {
        vectors: { size: DIMS, distance: "Cosine" },
      });
      logger.info("Knowledge store collection created", { collection: COLLECTION });
    }
    this.ready = true;
  }

  /**
   * Ingest a document — chunks it and stores each chunk with its embedding.
   * Returns the document ID.
   */
  async ingest(doc: Omit<Document, "id" | "ingestedAt">): Promise<string> {
    this.assertReady();
    const docId = uuidv4();
    const chunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);

    logger.info("Ingesting document", { title: doc.title, chunks: chunks.length });

    const points = await Promise.all(
      chunks.map(async (chunk, i) => {
        const { embedding } = await embed(chunk);
        return {
          id: uuidv4(),
          vector: embedding,
          payload: {
            docId,
            title: doc.title,
            source: doc.source ?? null,
            jurisdiction: doc.jurisdiction ?? null,
            documentType: doc.documentType ?? null,
            chunkIndex: i,
            totalChunks: chunks.length,
            content: chunk,
            ingestedAt: new Date().toISOString(),
          },
        };
      }),
    );

    await this.qdrant.upsert(COLLECTION, { wait: true, points });
    logger.info("Document ingested", { docId, chunks: chunks.length });
    return docId;
  }

  /**
   * Semantic search across all ingested documents.
   */
  async search(
    query: string,
    opts: { topK?: number; jurisdiction?: string; documentType?: string } = {},
  ): Promise<SearchResult[]> {
    this.assertReady();
    const { embedding } = await embed(query);

    const must: unknown[] = [];
    if (opts.jurisdiction) must.push({ key: "jurisdiction", match: { value: opts.jurisdiction } });
    if (opts.documentType) must.push({ key: "documentType", match: { value: opts.documentType } });

    const results = await this.qdrant.search(COLLECTION, {
      vector: embedding,
      limit: opts.topK ?? 8,
      filter: must.length ? { must } : undefined,
      with_payload: true,
    });

    return results.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return {
        document: {
          id: p.docId as string,
          title: p.title as string,
          content: p.content as string,
          source: p.source as string | undefined,
          jurisdiction: p.jurisdiction as string | undefined,
          documentType: p.documentType as string | undefined,
          ingestedAt: new Date(p.ingestedAt as string),
        },
        score: r.score,
        excerpt: (p.content as string).slice(0, 300) + "…",
      };
    });
  }

  /**
   * Retrieve full document text by docId — concatenates all chunks in order.
   */
  async getFullText(docId: string): Promise<string | null> {
    this.assertReady();
    const result = await this.qdrant.scroll(COLLECTION, {
      filter: { must: [{ key: "docId", match: { value: docId } }] },
      limit: 500,
      with_payload: true,
    });

    if (!result.points.length) return null;

    const sorted = result.points.sort(
      (a, b) =>
        ((a.payload as Record<string, unknown>).chunkIndex as number) -
        ((b.payload as Record<string, unknown>).chunkIndex as number),
    );

    return sorted.map((p) => (p.payload as Record<string, unknown>).content as string).join("\n");
  }

  private assertReady(): void {
    if (!this.ready) throw new Error("KnowledgeStore not initialised — call init() first");
  }
}

// ─── Text chunking ────────────────────────────────────────────────────────────

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}