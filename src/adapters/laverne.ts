// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

/**
 * Laverne adapter — imports agents from github.com/AnttiHero/laverne.
 *
 * Laverne defines 67 agents across 9 workflow types. Each agent has:
 *   - A natural-language role description
 *   - A system prompt (the "agent directive")
 *   - A list of MCP tool permissions
 *   - Optional: jurisdiction, specialty, workflow affiliation
 *
 * This adapter converts Laverne's format to our AgentDefinition and maps:
 *   - Laverne orchestrators → T1 Domain Managers
 *   - Laverne specialist agents → T2 Specialists
 *   - Laverne tool-only agents → T3 Tool Agents
 *
 * Usage:
 *   const adapter = new LaverneAdapter();
 *   const agents = await adapter.load('/path/to/laverne/agents');
 *   // or from the Laverne config object directly:
 *   const agents = adapter.fromConfigs(laverneAgentConfigs);
 *
 * The imported agents are tagged with source='laverne' in metadata so
 * they can be filtered or weighted differently in DyTopo rounds.
 */

import { readdir, readFile } from "fs/promises";
import { join, extname } from "path";
import type { AgentDefinition, AgentTier, AgentDomain } from "../types.js";
import type { AgentHarness } from "./index.js";

// ─── Laverne's native format (from their TypeScript source) ───────────────────

export interface LaverneAgentConfig {
  id?: string;
  name: string;
  role: string;
  specialty?: string;
  systemPrompt: string;
  /** MCP tool names Laverne permits this agent to call */
  mcpTools: string[];
  /** Laverne workflow affiliation */
  workflow?: string;
  jurisdiction?: string;
  tier?: "orchestrator" | "specialist" | "reviewer" | "tool";
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

export class LaverneAdapter implements AgentHarness {
  readonly name = "laverne";
  readonly version = "0.15.0";

  /**
   * Load Laverne agents from a directory of JSON/TS export files.
   * Each file should export a LaverneAgentConfig or array of configs.
   */
  async load(sourcePath: string): Promise<AgentDefinition[]> {
    const entries = await readdir(sourcePath);
    const configs: LaverneAgentConfig[] = [];

    for (const entry of entries) {
      if (extname(entry) !== ".json") continue;
      const raw = await readFile(join(sourcePath, entry), "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        configs.push(...parsed);
      } else {
        configs.push(parsed);
      }
    }

    return this.fromConfigs(configs);
  }

  /**
   * Convert an array of Laverne agent configs directly (no file I/O).
   * Use this when you have Laverne's configs in memory.
   */
  fromConfigs(configs: LaverneAgentConfig[]): AgentDefinition[] {
    return configs.map((c) => this.convert(c));
  }

  private convert(c: LaverneAgentConfig): AgentDefinition {
    const tier = this.inferTier(c);
    const domain = this.inferDomain(c);

    return {
      id: c.id ?? `laverne:${slugify(c.name)}`,
      name: `[Laverne] ${c.name}`,
      tier,
      type: tier === 0 ? "root" : tier === 1 ? "manager" : tier === 3 ? "tool" : "specialist",
      domain,
      description: [c.role, c.specialty, c.jurisdiction].filter(Boolean).join(" — "),
      systemPrompt: c.systemPrompt,
      allowedTools: this.mapTools(c.mcpTools),
      skills: extractSkills(c),
      metadata: {
        source: "laverne",
        laverneTier: c.tier,
        laverneWorkflow: c.workflow,
        jurisdiction: c.jurisdiction,
      },
    };
  }

  private inferTier(c: LaverneAgentConfig): AgentTier {
    if (c.tier === "orchestrator") return 1;
    if (c.tier === "tool") return 3;
    if (c.tier === "reviewer") return 2;
    if (c.tier === "specialist") return 2;
    // Heuristic from role text
    if (/orchestrat|coordinator|manager|lead/i.test(c.role)) return 1;
    if (/tool|search|retrieve|extract|translat/i.test(c.role)) return 3;
    return 2;
  }

  private inferDomain(c: LaverneAgentConfig): AgentDomain {
    const text = `${c.role} ${c.specialty ?? ""} ${c.workflow ?? ""}`.toLowerCase();
    if (/research|investigat|find|search/i.test(text)) return "research";
    if (/draft|writ|memo|brief|plead/i.test(text)) return "drafting";
    if (/review|check|verif|audit|challenge/i.test(text)) return "review";
    if (/compli|regulat|gdpr|dma|dsa/i.test(text)) return "compliance";
    if (/analys|assess|evaluat/i.test(text)) return "analysis";
    if (/tool|search|extract|translat/i.test(text)) return "tool";
    return "investigation";
  }

  /**
   * Map Laverne MCP tool names to our internal tool identifiers.
   * Laverne uses 21 MCP tools; we map to our equivalents or keep the name.
   */
  private mapTools(mcpTools: string[]): string[] {
    const toolMap: Record<string, string> = {
      "mcp_search":          "web_search",
      "mcp_retrieve":        "search_knowledge",
      "mcp_extract":         "extract_from_document",
      "mcp_translate":       "translate",
      "mcp_verify_citation": "citation_check",
      "mcp_draft":           "query_memory",
      "mcp_memory":          "query_memory",
    };
    return mcpTools.map((t) => toolMap[t] ?? t);
  }
}

// ─── Mike OSS workflow adapter ────────────────────────────────────────────────

/**
 * Mike OSS Workflows are NOT agents — they are reusable prompt templates (presets)
 * that define a legal task and how to run it. A lawyer picks one, uploads documents,
 * and the platform executes it in a single pass.
 *
 * In our system, Mike OSS workflows map to TaskTemplates. Our T1 managers and T2
 * specialists operate ON these templates — the workflow defines the task; the agents
 * perform it. This is the correct model: the workflow is the task specification,
 * not the actor.
 *
 * A TaskTemplate is stored separately from the agent registry. When a user selects
 * a Mike OSS workflow, it instantiates a Task with the template's description,
 * workflowType, and any structural constraints — and our agent system executes it.
 */
export interface MikeOSSWorkflow {
  id: string;
  name: string;
  /** Short description shown to users in the workflow picker */
  description: string;
  /**
   * The prompt template — defines what the task IS, not who does it.
   * May contain {{document}} placeholders for injecting uploaded documents.
   */
  promptTemplate: string;
  /** Which of our WorkflowType orchestration modes suits this preset */
  workflowType?: import("../types.js").WorkflowType;
  /** Optional: restrict to specific agent domains for this workflow */
  preferredDomains?: import("../types.js").AgentDomain[];
}

export interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  /** Expanded task description — used as Task.description when instantiated */
  taskDescriptionTemplate: string;
  workflowType: import("../types.js").WorkflowType;
  preferredDomains?: import("../types.js").AgentDomain[];
  source: "mikeoss" | "laverne" | "custom";
  metadata?: Record<string, unknown>;
}

/** Convert a Mike OSS workflow to a TaskTemplate. */
export function fromMikeOSSWorkflow(workflow: MikeOSSWorkflow): TaskTemplate {
  return {
    id: `mikeoss:${workflow.id}`,
    name: workflow.name,
    description: workflow.description,
    taskDescriptionTemplate: workflow.promptTemplate,
    workflowType: workflow.workflowType ?? "roundtable",
    preferredDomains: workflow.preferredDomains,
    source: "mikeoss",
    metadata: { originalId: workflow.id },
  };
}

/**
 * Instantiate a TaskTemplate into a task submission payload.
 * The caller substitutes {{document}} and other placeholders before calling this.
 */
export function instantiateTemplate(
  template: TaskTemplate,
  substitutions: Record<string, string> = {},
): { description: string; workflowType: import("../types.js").WorkflowType } {
  let description = template.taskDescriptionTemplate;
  for (const [key, value] of Object.entries(substitutions)) {
    description = description.replaceAll(`{{${key}}}`, value);
  }
  return { description, workflowType: template.workflowType };
}

// ─── Generic external agent format ───────────────────────────────────────────

/**
 * Minimal format for importing agents from any external system as JSON.
 * Drop a JSON file in /agents/external/ and it will be imported on startup.
 */
export interface ExternalAgentConfig {
  id: string;
  name: string;
  tier: 0 | 1 | 2 | 3;
  domain: AgentDomain;
  description: string;
  systemPrompt: string;
  allowedTools?: string[];
  skills?: string[];
  source?: string;
}

export function fromExternalConfig(c: ExternalAgentConfig): AgentDefinition {
  return {
    id: c.id,
    name: c.name,
    tier: c.tier,
    type: c.tier === 0 ? "root" : c.tier === 1 ? "manager" : c.tier === 3 ? "tool" : "specialist",
    domain: c.domain,
    description: c.description,
    systemPrompt: c.systemPrompt,
    allowedTools: c.allowedTools ?? [],
    skills: c.skills ?? [],
    metadata: { source: c.source ?? "external" },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function extractSkills(c: LaverneAgentConfig): string[] {
  const skills: string[] = [];
  if (c.specialty) skills.push(slugify(c.specialty));
  if (c.jurisdiction) skills.push(`jurisdiction:${c.jurisdiction}`);
  if (c.workflow) skills.push(`workflow:${c.workflow}`);
  return skills;
}