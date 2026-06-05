// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * Twenty CRM tool definitions — 6 tools exposing the Twenty open-source CRM
 * to agents and the orchestrator.
 *
 * All tools return a result object or { error: string } — they never throw.
 * Unconfigured tools return { error: "not configured" } so they are always
 * safe to register in agent allowedTools lists.
 */

import { twentyClient } from "../integrations/twenty.js";
import type { ToolImpl } from "./index.js";

// ─── twenty_search_companies ──────────────────────────────────────────────────

const twentySearchCompanies: ToolImpl = {
  name: "twenty_search_companies",
  schema: {
    name: "twenty_search_companies",
    description: "Search for client companies in the Twenty CRM by name. Returns id, name, domain, and employee count.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Company name to search for (partial match)" },
        limit: { type: "number", description: "Maximum results (default 20)" },
      },
      required: ["query"],
    },
  },
  async execute(input) {
    if (!twentyClient.isConfigured()) return { error: "not configured" };
    try {
      return { companies: await twentyClient.searchCompanies(
        input.query as string,
        (input.limit as number | undefined) ?? 20,
      ) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};

// ─── twenty_get_company ───────────────────────────────────────────────────────

const twentyGetCompany: ToolImpl = {
  name: "twenty_get_company",
  schema: {
    name: "twenty_get_company",
    description: "Get full details of a Twenty CRM company by ID, including domain, address, and employee count.",
    input_schema: {
      type: "object" as const,
      properties: {
        company_id: { type: "string", description: "Twenty company UUID" },
      },
      required: ["company_id"],
    },
  },
  async execute(input) {
    if (!twentyClient.isConfigured()) return { error: "not configured" };
    try {
      const company = await twentyClient.getCompany(input.company_id as string);
      return company ?? { error: "Company not found" };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};

// ─── twenty_search_people ─────────────────────────────────────────────────────

const twentySearchPeople: ToolImpl = {
  name: "twenty_search_people",
  schema: {
    name: "twenty_search_people",
    description: "Search for contacts in the Twenty CRM by name. Optionally filter to a specific company.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Contact name to search for (partial match on first or last name)" },
        company_id: { type: "string", description: "Optional Twenty company UUID — restricts results to contacts at that company" },
        limit: { type: "number", description: "Maximum results (default 20)" },
      },
      required: ["query"],
    },
  },
  async execute(input) {
    if (!twentyClient.isConfigured()) return { error: "not configured" };
    try {
      return { people: await twentyClient.searchPeople(
        input.query as string,
        {
          companyId: input.company_id as string | undefined,
          limit: (input.limit as number | undefined) ?? 20,
        },
      ) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};

// ─── twenty_create_company ────────────────────────────────────────────────────

const twentyCreateCompany: ToolImpl = {
  name: "twenty_create_company",
  schema: {
    name: "twenty_create_company",
    description: "Create a new company record in the Twenty CRM. Use for new client intake after conflict checks pass.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Company name" },
        domain_name: { type: "string", description: "Primary website URL (e.g. https://acme.com)" },
      },
      required: ["name"],
    },
  },
  async execute(input) {
    if (!twentyClient.isConfigured()) return { error: "not configured" };
    try {
      return await twentyClient.createCompany({
        name: input.name as string,
        domainName: input.domain_name as string | undefined,
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};

// ─── twenty_create_person ─────────────────────────────────────────────────────

const twentyCreatePerson: ToolImpl = {
  name: "twenty_create_person",
  schema: {
    name: "twenty_create_person",
    description: "Create a new contact (person) in the Twenty CRM and optionally link them to an existing company.",
    input_schema: {
      type: "object" as const,
      properties: {
        first_name: { type: "string", description: "Contact first name" },
        last_name: { type: "string", description: "Contact last name" },
        email: { type: "string", description: "Primary email address" },
        company_id: { type: "string", description: "Twenty company UUID to link this person to" },
      },
      required: ["first_name", "last_name"],
    },
  },
  async execute(input) {
    if (!twentyClient.isConfigured()) return { error: "not configured" };
    try {
      return await twentyClient.createPerson({
        firstName: input.first_name as string,
        lastName: input.last_name as string,
        email: input.email as string | undefined,
        companyId: input.company_id as string | undefined,
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};

// ─── twenty_create_note ───────────────────────────────────────────────────────

const twentyCreateNote: ToolImpl = {
  name: "twenty_create_note",
  schema: {
    name: "twenty_create_note",
    description: "Post a note to a company or contact in the Twenty CRM. Use this to push Big Michael research findings, synthesis output, or legal memos back into the client record.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Note title (max 200 characters)" },
        body: { type: "string", description: "Note body — supports plain text or Markdown" },
        company_id: { type: "string", description: "Twenty company UUID to attach this note to" },
        person_id: { type: "string", description: "Twenty person UUID to attach this note to" },
      },
      required: ["title", "body"],
    },
  },
  async execute(input) {
    if (!twentyClient.isConfigured()) return { error: "not configured" };
    try {
      return await twentyClient.createNote({
        title: input.title as string,
        body: input.body as string,
        companyId: input.company_id as string | undefined,
        personId: input.person_id as string | undefined,
      });
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

export const TWENTY_TOOLS: ToolImpl[] = [
  twentySearchCompanies,
  twentyGetCompany,
  twentySearchPeople,
  twentyCreateCompany,
  twentyCreatePerson,
  twentyCreateNote,
];

export const TWENTY_TOOL_NAMES = TWENTY_TOOLS.map((t) => t.name);
