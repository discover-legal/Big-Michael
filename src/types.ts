// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

// ─── Agent taxonomy ───────────────────────────────────────────────────────────

export type AgentTier = 0 | 1 | 2 | 3;

export type AgentType =
  | "root"        // tier 0
  | "manager"     // tier 1
  | "specialist"  // tier 2
  | "tool";       // tier 3

export type AgentDomain =
  | "orchestration"
  | "research"
  | "investigation"
  | "drafting"
  | "review"
  | "compliance"
  | "analysis"
  | "tool";

export interface AgentDefinition {
  id: string;
  name: string;
  tier: AgentTier;
  type: AgentType;
  domain: AgentDomain;
  /** Free-text capabilities description — embedded for semantic search */
  description: string;
  systemPrompt: string;
  /** Tool names this agent is permitted to call — principle of least privilege */
  allowedTools: string[];
  skills: string[];
  metadata?: Record<string, unknown>;
}

// ─── DyTopo core ──────────────────────────────────────────────────────────────

export type TaskPhase =
  | "intake"
  | "research"
  | "analysis"
  | "drafting"
  | "review"
  | "verification"
  | "delivery";

export interface RoundGoal {
  id: string;
  round: number;
  phase: TaskPhase;
  description: string;
  /** What outputs the orchestrator expects this round to produce */
  expectedOutputs: string[];
}

export interface NeedDescriptor {
  agentId: string;
  /** Natural language: what context or knowledge this agent currently requires */
  text: string;
  embedding?: number[];
}

export interface OfferDescriptor {
  agentId: string;
  /** Natural language: what knowledge or capability this agent can contribute */
  text: string;
  embedding?: number[];
}

export interface CommunicationEdge {
  /** Agent that offers → sends its offer content as context to the needing agent */
  from: string;
  to: string;
  similarity: number;
  offerText: string;
}

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  round: number;
  timestamp: Date;
}

export interface RoundState {
  roundId: string;
  goal: RoundGoal;
  activeAgentIds: string[];
  edges: CommunicationEdge[];
  messages: AgentMessage[];
  findings: Finding[];
  status: "running" | "complete" | "awaiting_gate";
  startedAt: Date;
  completedAt?: Date;
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * Intra-round memory: accumulates within a single round.
 * Cleared at round boundaries.
 */
export interface IntraRoundMemory {
  roundId: string;
  /** Keyed by agentId — messages received this round */
  receivedMessages: Record<string, AgentMessage[]>;
  /** Keyed by agentId — findings produced this round */
  agentFindings: Record<string, Finding[]>;
  sharedContext: string[];
}

/** Alias used in memory module imports */
export type InterRoundMemory = MemoryEntry[];

/**
 * Inter-round memory: persists across rounds, stored in the vector DB.
 * Agents query this to recover context from earlier rounds.
 */
export interface MemoryEntry {
  id: string;
  taskId: string;
  round: number;
  phase: TaskPhase;
  agentId?: string;   // undefined = task-level summary
  /** Natural language content, embedded for retrieval */
  content: string;
  embedding?: number[];
  tags: string[];
  createdAt: Date;
}

// ─── Laverne-style debate protocol ───────────────────────────────────────────

export interface Citation {
  source: string;       // document ID or URL
  quote: string;        // verbatim text cited
  page?: number;
  /** True when mechanical string-match against source passes */
  mechanicallyVerified: boolean;
}

export interface Finding {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  citations: Citation[];
  /** 0–1 confidence from the producing agent */
  confidence: number;
  challenged: boolean;
  challenge?: Challenge;
  resolved: boolean;
  verificationResult?: VerificationResult;
  round: number;
  timestamp: Date;
}

export interface Challenge {
  challengerId: string;
  challengerName: string;
  content: string;
  citations: Citation[];
  /** Orchestrator's resolution after weighing both sides */
  resolution?: string;
  resolvedAt?: Date;
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  notes?: string;
}

export interface VerificationResult {
  findingId: string;
  checks: VerificationCheck[];
  passed: boolean;
  completedAt: Date;
}

// ─── Human gates ─────────────────────────────────────────────────────────────

export interface GateRequest {
  id: string;
  taskId: string;
  findingId: string;
  finding: Finding;
  status: "pending" | "approved" | "rejected";
  reviewerNote?: string;
  createdAt: Date;
  reviewedAt?: Date;
}

// ─── Task management ─────────────────────────────────────────────────────────

export type WorkflowType =
  | "counsel"      // single specialist, quick turnaround
  | "roundtable"   // multi-agent open discussion
  | "adversarial"  // red-team vs blue-team
  | "review"       // document review and annotation
  | "tabulate"     // bulk extraction → spreadsheet
  | "full_bench";  // comprehensive all-tier review

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_gate"
  | "complete"
  | "failed";

export interface Task {
  id: string;
  description: string;
  /** Document IDs ingested into the knowledge store for this task */
  documentIds: string[];
  workflowType: WorkflowType;
  status: TaskStatus;
  currentPhase: TaskPhase;
  currentRound: number;
  maxRounds: number;
  activeAgentIds: string[];
  rounds: RoundState[];
  findings: Finding[];
  pendingGates: GateRequest[];
  /** Final synthesised output from the root orchestrator */
  output?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

// ─── Knowledge store ─────────────────────────────────────────────────────────

export interface Document {
  id: string;
  title: string;
  content: string;
  source?: string;
  jurisdiction?: string;
  documentType?: string;
  metadata?: Record<string, unknown>;
  ingestedAt: Date;
}

export interface SearchResult {
  document: Document;
  score: number;
  excerpt: string;
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  text: string;
  embedding: number[];
  model: string;
}