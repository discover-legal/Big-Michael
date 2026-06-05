// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * Twenty CRM integration.
 *
 * Twenty (https://twenty.com) is an open-source CRM. Its primary API is
 * GraphQL (POST /api). Authentication: API key sent as a Bearer token.
 *
 * Configuration: TWENTY_API_URL (e.g. http://localhost:3000) + TWENTY_API_KEY.
 * Both must be set for the client to be considered configured; any call on an
 * unconfigured client returns { error: "not configured" } (it never throws).
 *
 * Security: the API URL is SSRF-validated at construction (http/https only);
 * response bodies are capped at 2 MB; requests time out at 30 s; the API key
 * never appears in logs or error messages.
 */

import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { Client } from "../types.js";

const RESPONSE_CAP = 2_000_000; // 2 MB

// ── Public shapes ─────────────────────────────────────────────────────────────

export interface TwentyCompany {
  id: string;
  name: string;
  domainName?: { primaryLinkUrl?: string };
  employees?: number;
  address?: { addressCity?: string; addressCountry?: string };
}

export interface TwentyPerson {
  id: string;
  name: { firstName?: string; lastName?: string };
  primaryEmail?: { primaryEmail?: string };
  primaryPhone?: { primaryPhoneNumber?: string };
  company?: { id: string; name: string };
}

export interface TwentyNote {
  id: string;
  title?: string;
  body?: string;
  createdAt: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class TwentyClient {
  private readonly base: string | null;

  constructor() {
    const raw = Config.twenty.apiUrl;
    if (!raw) {
      this.base = null;
      return;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`TWENTY_API_URL is not a valid URL: "${raw}"`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("TWENTY_API_URL must use http or https");
    }
    this.base = raw.replace(/\/$/, "");
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!this.base || !Config.twenty.apiKey) {
      throw new Error("Twenty not configured — set TWENTY_API_URL and TWENTY_API_KEY");
    }
    const res = await fetch(`${this.base}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Config.twenty.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Twenty API ${res.status}: ${res.statusText}`);
    const text = await res.text();
    if (text.length > RESPONSE_CAP) throw new Error("Twenty response exceeded 2 MB cap");
    const json = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`Twenty: ${json.errors[0].message}`);
    if (!json.data) throw new Error("Twenty returned no data");
    return json.data;
  }

  // ── Company ────────────────────────────────────────────────────────────────

  async searchCompanies(query: string, limit = 20): Promise<TwentyCompany[]> {
    const data = await this.gql<{ companies: { edges: { node: TwentyCompany }[] } }>(`
      query SearchCompanies($filter: CompanyFilterInput, $first: Int) {
        companies(filter: $filter, first: $first, orderBy: { name: AscNullsLast }) {
          edges { node { id name domainName { primaryLinkUrl } employees } }
        }
      }
    `, { filter: { name: { like: `%${query}%` } }, first: limit });
    return data.companies.edges.map((e) => e.node);
  }

  async getCompany(id: string): Promise<TwentyCompany | null> {
    try {
      const data = await this.gql<{ company: TwentyCompany }>(`
        query GetCompany($id: ID!) {
          company(id: $id) {
            id name
            domainName { primaryLinkUrl }
            employees
            address { addressCity addressCountry }
          }
        }
      `, { id });
      return data.company;
    } catch {
      return null;
    }
  }

  async createCompany(input: { name: string; domainName?: string }): Promise<TwentyCompany> {
    const data = await this.gql<{ createCompany: TwentyCompany }>(`
      mutation CreateCompany($data: CompanyCreateInput!) {
        createCompany(data: $data) { id name }
      }
    `, {
      data: {
        name: input.name,
        ...(input.domainName ? { domainName: { primaryLinkUrl: input.domainName } } : {}),
      },
    });
    return data.createCompany;
  }

  // ── Person ─────────────────────────────────────────────────────────────────

  async searchPeople(query: string, opts: { companyId?: string; limit?: number } = {}): Promise<TwentyPerson[]> {
    const nameFilter = {
      or: [
        { name: { firstName: { like: `%${query}%` } } },
        { name: { lastName: { like: `%${query}%` } } },
      ],
    };
    const filter = opts.companyId
      ? { and: [nameFilter, { company: { id: { eq: opts.companyId } } }] }
      : nameFilter;
    const data = await this.gql<{ people: { edges: { node: TwentyPerson }[] } }>(`
      query SearchPeople($filter: PersonFilterInput, $first: Int) {
        people(filter: $filter, first: $first) {
          edges { node {
            id
            name { firstName lastName }
            primaryEmail { primaryEmail }
            company { id name }
          } }
        }
      }
    `, { filter, first: opts.limit ?? 20 });
    return data.people.edges.map((e) => e.node);
  }

  async createPerson(input: {
    firstName: string;
    lastName: string;
    email?: string;
    companyId?: string;
  }): Promise<TwentyPerson> {
    const data = await this.gql<{ createPerson: TwentyPerson }>(`
      mutation CreatePerson($data: PersonCreateInput!) {
        createPerson(data: $data) { id name { firstName lastName } }
      }
    `, {
      data: {
        name: { firstName: input.firstName, lastName: input.lastName },
        ...(input.email ? { primaryEmail: { primaryEmail: input.email } } : {}),
        ...(input.companyId ? { company: { id: input.companyId } } : {}),
      },
    });
    return data.createPerson;
  }

  // ── Note ───────────────────────────────────────────────────────────────────

  async createNote(input: {
    title: string;
    body: string;
    companyId?: string;
    personId?: string;
  }): Promise<TwentyNote> {
    const noteTargets: Record<string, string>[] = [];
    if (input.companyId) noteTargets.push({ companyId: input.companyId });
    if (input.personId) noteTargets.push({ personId: input.personId });
    const data = await this.gql<{ createNote: TwentyNote }>(`
      mutation CreateNote($data: NoteCreateInput!) {
        createNote(data: $data) { id title createdAt }
      }
    `, {
      data: {
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 50_000),
        ...(noteTargets.length ? {
          noteTargets: { createMany: { data: noteTargets } },
        } : {}),
      },
    });
    return data.createNote;
  }

  // ── High-level sync ────────────────────────────────────────────────────────

  /**
   * Upsert a Big Michael Client as a Twenty Company.
   * Searches by exact name first to avoid duplicates; creates if not found.
   */
  async upsertClientAsCompany(client: Client): Promise<TwentyCompany> {
    const results = await this.searchCompanies(client.name, 5);
    const match = results.find((c) => c.name.toLowerCase() === client.name.toLowerCase());
    if (match) {
      logger.info("Twenty: matched existing company", { id: match.id, name: match.name });
      return match;
    }
    const created = await this.createCompany({ name: client.name });
    logger.info("Twenty: created company", { id: created.id, name: created.name });
    return created;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  isConfigured(): boolean {
    return Boolean(Config.twenty.apiKey && Config.twenty.apiUrl);
  }

  status(): { configured: boolean; apiUrl?: string } {
    if (!this.isConfigured()) return { configured: false };
    return { configured: true, apiUrl: Config.twenty.apiUrl };
  }
}

export const twentyClient = new TwentyClient();
