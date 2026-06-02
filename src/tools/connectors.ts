// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * Legal data connector tools.
 *
 * Four connectors, two transport types:
 *   CourtListener  — public REST API (no key required for basic use)
 *   Ironclad       — MCP HTTP server (subscription, IRONCLAD_API_KEY required)
 *   iManage        — MCP HTTP server (subscription, IMANAGE_API_KEY required)
 *   Definely       — MCP HTTP server (subscription, DEFINELY_API_KEY required)
 *
 * All tools return a structured error object when the connector is not
 * configured — they never throw — so agents can degrade gracefully.
 */

import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { ToolImpl } from "./index.js";

// ─── Generic MCP HTTP client ──────────────────────────────────────────────────

/**
 * Calls a tool on a Streamable HTTP MCP server using JSON-RPC 2.0.
 * Returns the text content of the first content block, or an error object.
 */
async function mcpCall(
  endpoint: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  let resp: Response;
  try {
    resp = await fetch(endpoint, { method: "POST", headers, body });
  } catch (err) {
    return { error: `MCP request failed: ${(err as Error).message}` };
  }

  if (!resp.ok) {
    return { error: `MCP server returned ${resp.status}: ${await resp.text().catch(() => "")}` };
  }

  const raw = await resp.text();
  // Handle SSE: take the last `data:` line that contains a JSON-RPC result
  const lines = raw.split("\n");
  let json: string | undefined;
  for (const line of lines) {
    if (line.startsWith("data: ") && line.includes('"result"')) json = line.slice(6);
  }
  if (!json) json = raw;

  let parsed: { result?: { content?: { type: string; text: string }[] }; error?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "MCP server returned non-JSON response", raw: raw.slice(0, 500) };
  }

  if (parsed.error) return { error: parsed.error };

  const content = parsed.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return { result: text };
  }
  return parsed.result ?? {};
}

// ─── CourtListener REST tools ─────────────────────────────────────────────────

async function courtListenerGet(path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${Config.connectors.courtListener.endpoint}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = { "Accept": "application/json" };
  if (Config.connectors.courtListener.apiKey) {
    headers["Authorization"] = `Token ${Config.connectors.courtListener.apiKey}`;
  }

  let resp: Response;
  try {
    resp = await fetch(url.toString(), { headers });
  } catch (err) {
    return { error: `CourtListener request failed: ${(err as Error).message}` };
  }

  if (!resp.ok) return { error: `CourtListener ${resp.status}` };

  try {
    return await resp.json();
  } catch {
    return { error: "CourtListener returned non-JSON response" };
  }
}

export const courtListenerSearchTool: ToolImpl = {
  name: "court_listener_search",
  schema: {
    name: "court_listener_search",
    description:
      "Search US case law, dockets, and legal opinions via CourtListener. Returns citations, " +
      "case names, courts, dates, and excerpts. Use for US federal and state precedent research.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Full-text search query" },
        type: {
          type: "string",
          description: "Result type: 'o' (opinions), 'r' (RECAP dockets), 'p' (people), 'oa' (oral arguments). Default: o",
        },
        court: { type: "string", description: "Court ID filter, e.g. 'scotus', 'ca2', 'dcd'" },
        filed_after: { type: "string", description: "ISO date — only cases filed after this date" },
        filed_before: { type: "string", description: "ISO date — only cases filed before this date" },
        max_results: { type: "number", description: "Maximum results (default 5, max 20)" },
      },
      required: ["query"],
    },
  },
  async execute(input) {
    const params: Record<string, string> = {
      q: input.query as string,
      type: (input.type as string | undefined) ?? "o",
      format: "json",
      page_size: String(Math.min((input.max_results as number | undefined) ?? 5, 20)),
    };
    if (input.court)       params.court = input.court as string;
    if (input.filed_after) params.filed_after = input.filed_after as string;
    if (input.filed_before) params.filed_before = input.filed_before as string;

    const data = await courtListenerGet("/search/", params) as {
      count?: number;
      results?: {
        caseName?: string; citation?: string; court?: string; dateFiled?: string;
        absoluteUrl?: string; snippet?: string;
      }[];
    };

    if (!data.results) return data;

    return {
      count: data.count,
      results: data.results.map((r) => ({
        caseName: r.caseName,
        citation: r.citation,
        court: r.court,
        dateFiled: r.dateFiled,
        url: r.absoluteUrl ? `https://www.courtlistener.com${r.absoluteUrl}` : undefined,
        excerpt: r.snippet,
      })),
    };
  },
};

export const courtListenerOpinionTool: ToolImpl = {
  name: "court_listener_opinion",
  schema: {
    name: "court_listener_opinion",
    description: "Fetch the full text of a specific US court opinion by CourtListener opinion ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        opinion_id: { type: "number", description: "CourtListener opinion ID (from search results)" },
      },
      required: ["opinion_id"],
    },
  },
  async execute(input) {
    return courtListenerGet(`/opinions/${input.opinion_id as number}/`, { format: "json" });
  },
};

export const courtListenerDocketTool: ToolImpl = {
  name: "court_listener_docket",
  schema: {
    name: "court_listener_docket",
    description: "Fetch a US court docket by CourtListener docket ID. Returns parties, filings, and case status.",
    input_schema: {
      type: "object" as const,
      properties: {
        docket_id: { type: "number", description: "CourtListener docket ID (from search results)" },
      },
      required: ["docket_id"],
    },
  },
  async execute(input) {
    return courtListenerGet(`/dockets/${input.docket_id as number}/`, { format: "json" });
  },
};

// ─── Ironclad MCP tools ────────────────────────────────────────────────────────

function ironcladNotConfigured() {
  return { error: "Ironclad not configured — set IRONCLAD_API_KEY to enable contract register access" };
}

export const ironcladSearchContractsTool: ToolImpl = {
  name: "ironclad_search_contracts",
  schema: {
    name: "ironclad_search_contracts",
    description:
      "Search the Ironclad contract register. Returns matching contracts with metadata (parties, " +
      "type, status, key dates, renewal deadlines). Requires IRONCLAD_API_KEY.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query — searches contract names, parties, and metadata" },
        contract_type: { type: "string", description: "Optional filter by contract type" },
        status: { type: "string", description: "Optional filter: 'executed', 'in_review', 'expired'" },
      },
      required: ["query"],
    },
  },
  async execute(input) {
    if (!Config.connectors.ironclad.enabled) return ironcladNotConfigured();
    logger.debug("ironclad_search_contracts", { query: input.query });
    return mcpCall(
      Config.connectors.ironclad.endpoint,
      Config.connectors.ironclad.apiKey,
      "searchContracts",
      input,
    );
  },
};

export const ironcladGetContractTool: ToolImpl = {
  name: "ironclad_get_contract",
  schema: {
    name: "ironclad_get_contract",
    description:
      "Fetch a specific contract from Ironclad by ID — returns the document metadata, key " +
      "clauses extracted by Ironclad, and links to the signed PDF. Requires IRONCLAD_API_KEY.",
    input_schema: {
      type: "object" as const,
      properties: {
        contract_id: { type: "string", description: "Ironclad contract/record ID" },
      },
      required: ["contract_id"],
    },
  },
  async execute(input) {
    if (!Config.connectors.ironclad.enabled) return ironcladNotConfigured();
    logger.debug("ironclad_get_contract", { id: input.contract_id });
    return mcpCall(
      Config.connectors.ironclad.endpoint,
      Config.connectors.ironclad.apiKey,
      "getContract",
      input,
    );
  },
};

// ─── iManage MCP tools ────────────────────────────────────────────────────────

function imanageNotConfigured() {
  return { error: "iManage not configured — set IMANAGE_API_KEY to enable DMS access" };
}

export const imanageSearchTool: ToolImpl = {
  name: "imanage_search",
  schema: {
    name: "imanage_search",
    description:
      "Search the iManage document management system (DMS) for matter documents, precedents, " +
      "and templates. Returns document metadata and version links. Requires IMANAGE_API_KEY.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Full-text search query" },
        matter_id: { type: "string", description: "Optional: restrict to a specific matter workspace" },
        document_type: { type: "string", description: "Optional: filter by document type" },
        max_results: { type: "number", description: "Maximum results (default 10)" },
      },
      required: ["query"],
    },
  },
  async execute(input) {
    if (!Config.connectors.imanage.enabled) return imanageNotConfigured();
    logger.debug("imanage_search", { query: input.query });
    return mcpCall(
      Config.connectors.imanage.endpoint,
      Config.connectors.imanage.apiKey,
      "searchDocuments",
      input,
    );
  },
};

export const imanageGetDocumentTool: ToolImpl = {
  name: "imanage_get_document",
  schema: {
    name: "imanage_get_document",
    description:
      "Fetch a specific document from iManage by document ID. Returns the document content " +
      "and version history. Requires IMANAGE_API_KEY.",
    input_schema: {
      type: "object" as const,
      properties: {
        document_id: { type: "string", description: "iManage document ID" },
        version: { type: "string", description: "Optional: specific version ID (default: latest)" },
      },
      required: ["document_id"],
    },
  },
  async execute(input) {
    if (!Config.connectors.imanage.enabled) return imanageNotConfigured();
    logger.debug("imanage_get_document", { id: input.document_id });
    return mcpCall(
      Config.connectors.imanage.endpoint,
      Config.connectors.imanage.apiKey,
      "getDocument",
      input,
    );
  },
};

// ─── Definely MCP tools ───────────────────────────────────────────────────────

function definelyNotConfigured() {
  return { error: "Definely not configured — set DEFINELY_API_KEY to enable contract structure analysis" };
}

export const definelyAnalyzeStructureTool: ToolImpl = {
  name: "definely_analyze_structure",
  schema: {
    name: "definely_analyze_structure",
    description:
      "Analyse the structure of a contract document using Definely — resolves cross-references, " +
      "identifies defined terms and their definitions, and surfaces structural diffs from a base " +
      "version. Requires DEFINELY_API_KEY.",
    input_schema: {
      type: "object" as const,
      properties: {
        document_text: {
          type: "string",
          description: "The contract text to analyse (max 200 000 characters)",
        },
        focus: {
          type: "string",
          description: "Optional: specific aspect to focus on — 'definitions', 'cross-references', 'structure', 'all'",
        },
      },
      required: ["document_text"],
    },
  },
  async execute(input) {
    if (!Config.connectors.definely.enabled) return definelyNotConfigured();
    const text = (input.document_text as string).slice(0, 200_000);
    logger.debug("definely_analyze_structure", { chars: text.length });
    return mcpCall(
      Config.connectors.definely.endpoint,
      Config.connectors.definely.apiKey,
      "analyzeStructure",
      { ...input, document_text: text },
    );
  },
};

export const definelyResolveDefinitionTool: ToolImpl = {
  name: "definely_resolve_definition",
  schema: {
    name: "definely_resolve_definition",
    description:
      "Resolve the full definition of a defined term in a contract, following all cross-references " +
      "and nested definitions. Returns the complete expanded meaning. Requires DEFINELY_API_KEY.",
    input_schema: {
      type: "object" as const,
      properties: {
        document_text: { type: "string", description: "The contract text containing the definition" },
        term: { type: "string", description: "The defined term to resolve (exactly as capitalised in the contract)" },
      },
      required: ["document_text", "term"],
    },
  },
  async execute(input) {
    if (!Config.connectors.definely.enabled) return definelyNotConfigured();
    const text = (input.document_text as string).slice(0, 200_000);
    logger.debug("definely_resolve_definition", { term: input.term });
    return mcpCall(
      Config.connectors.definely.endpoint,
      Config.connectors.definely.apiKey,
      "resolveDefinition",
      { ...input, document_text: text },
    );
  },
};

// ─── Connector tool list ──────────────────────────────────────────────────────

export const CONNECTOR_TOOLS: ToolImpl[] = [
  // CourtListener — always available (public API)
  courtListenerSearchTool,
  courtListenerOpinionTool,
  courtListenerDocketTool,
  // Ironclad — active when IRONCLAD_API_KEY set
  ironcladSearchContractsTool,
  ironcladGetContractTool,
  // iManage — active when IMANAGE_API_KEY set
  imanageSearchTool,
  imanageGetDocumentTool,
  // Definely — active when DEFINELY_API_KEY set
  definelyAnalyzeStructureTool,
  definelyResolveDefinitionTool,
];
