// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * Memory layer — intra-round and inter-round.
 *
 * Intra-round: IntraRoundMemoryStore (in-process, reset per round)
 * Inter-round: InterRoundMemoryStore (Qdrant/RuVector, persists across rounds and tasks)
 *
 * Agents call query() to retrieve relevant memories before generating Need/Offer descriptors
 * or processing their round. The orchestrator writes new memories after each round completes.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../config.js";
import { embed, embedBatch } from "../embeddings.js";
import { logger } from "../logger.js";
import type {
  IntraRoundMemory,
  InterRoundMemory,
  MemoryEntry,
  AgentMessage,
  Finding,
  TaskPhase,
} from "../types.js";

const COLLECTION = Config.vectorDb.collections.memory;
const DIMS = Config.embeddings.dimensions;

// ─── Intra-round memory ───────────────────────────────────────────────────────

export class IntraRoundMemoryStore {
  private store: IntraRoundMemory;

  constructor(roundId: string) {
    this.store = {
      roundId,
      receivedMessages: {},
      agentFindings: {},
      sharedContext: [],
    };
  }

  recordMessage(agentId: string, message: AgentMessage): void {
    if (!this.store.receivedMessages[agentId]) {
      this.store.receivedMessages[agentId] = [];
    }
    this.store.receivedMessages[agentId].push(message);
  }

  recordFinding(agentId: string, finding: Finding): void {
    if (!this.store.agentFindings[agentId]) {
      this.store.agentFindings[agentId] = [];
    }
    this.store.agentFindings[agentId].push(finding);
  }

  addSharedContext(text: string): void {
    this.store.sharedContext.push(text);
  }

  getMessagesFor(agentId: string): AgentMessage[] {
    return this.store.receivedMessages[agentId] ?? [];
  }

  getFindingsFor(agentId: string): Finding[] {
    return this.store.agentFindings[agentId] ?? [];
  }

  getAllFindings(): Finding[] {
    return Object.values(this.store.agentFindings).flat();
  }

  getSharedContext(): string[] {
    return this.store.sharedContext;
  }

  snapshot(): IntraRoundMemory {
    return { ...this.store };
  }
}

// ─── Inter-round memory ───────────────────────────────────────────────────────

export class InterRoundMemoryStore {
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
        quantization_config: {
          scalar: { type: "int8", quantile: 0.99, always_ram: true },
        },
      });
      logger.info("Memory collection created", { collection: COLLECTION });
    }
    this.ready = true;
  }

  /**
   * Persist a memory entry. Called by the orchestrator at end of each round.
   */
  async write(entry: Omit<MemoryEntry, "id" | "embedding">): Promise<MemoryEntry> {
    this.assertReady();
    const { embedding } = await embed(entry.content);
    const full: MemoryEntry = { ...entry, id: uuidv4(), embedding };

    await this.qdrant.upsert(COLLECTION, {
      wait: true,
      points: [
        {
          id: full.id,
          vector: embedding,
          payload: {
            taskId: full.taskId,
            round: full.round,
            phase: full.phase,
            agentId: full.agentId ?? null,
            content: full.content,
            tags: full.tags,
            createdAt: full.createdAt.toISOString(),
          },
        },
      ],
    });

    logger.debug("Memory entry written", { id: full.id, round: full.round, agentId: full.agentId });
    return full;
  }

  /**
   * Semantic query: retrieve the most relevant memories for an agent given a query.
   * Scoped to the current task; can optionally filter by agentId.
   */
  async query(
    query: string,
    opts: {
      taskId: string;
      agentId?: string;
      topK?: number;
      beforeRound?: number;
    },
  ): Promise<MemoryEntry[]> {
    this.assertReady();
    const { embedding } = await embed(query);

    const must: unknown[] = [
      { key: "taskId", match: { value: opts.taskId } },
    ];
    if (opts.agentId) must.push({ key: "agentId", match: { value: opts.agentId } });
    if (opts.beforeRound !== undefined) {
      must.push({ key: "round", range: { lt: opts.beforeRound } });
    }

    const results = await this.qdrant.search(COLLECTION, {
      vector: embedding,
      limit: Math.min(opts.topK ?? 8, 100),
      filter: { must },
      with_payload: true,
    });

    return results.map((r) => {
      const p = r.payload as Record<string, unknown>;
      return {
        id: r.id as string,
        taskId: p.taskId as string,
        round: p.round as number,
        phase: p.phase as TaskPhase,
        agentId: p.agentId as string | undefined,
        content: p.content as string,
        tags: p.tags as string[],
        createdAt: new Date(p.createdAt as string),
      };
    });
  }

  /**
   * Write a round summary — called after every round completes.
   */
  async writeRoundSummary(params: {
    taskId: string;
    round: number;
    phase: TaskPhase;
    summary: string;
    findingCount: number;
  }): Promise<void> {
    await this.write({
      taskId: params.taskId,
      round: params.round,
      phase: params.phase,
      content: `Round ${params.round} summary (${params.phase}): ${params.summary}. Findings produced: ${params.findingCount}.`,
      tags: ["round-summary", `round-${params.round}`, params.phase],
      createdAt: new Date(),
    });
  }

  /**
   * Write agent-specific finding as a memory entry.
   */
  async writeFindingMemory(params: {
    taskId: string;
    round: number;
    phase: TaskPhase;
    agentId: string;
    finding: Finding;
  }): Promise<void> {
    await this.write({
      taskId: params.taskId,
      round: params.round,
      phase: params.phase,
      agentId: params.agentId,
      content: params.finding.content,
      tags: ["finding", `round-${params.round}`, params.agentId, params.phase],
      createdAt: new Date(),
    });
  }

  /**
   * Delete all memory entries for a task. Called when a task is deleted so
   * orphaned vectors don't remain queryable or leak into future tasks.
   */
  async deleteByTaskId(taskId: string): Promise<void> {
    this.assertReady();
    await this.qdrant.delete(COLLECTION, {
      filter: { must: [{ key: "taskId", match: { value: taskId } }] },
    });
    logger.debug("Memory entries deleted for task", { taskId });
  }

  private assertReady(): void {
    if (!this.ready) throw new Error("InterRoundMemoryStore not initialised — call init() first");
  }
}