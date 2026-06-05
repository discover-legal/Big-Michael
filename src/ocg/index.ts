// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

/**
 * OcgStore — persists and queries Outside Counsel Guidelines documents.
 *
 * Extracts billing rules from OCG text via a Haiku call, then checks time
 * entries against those rules (also via Haiku) to produce OcgSuggestion
 * arrays that lawyers can accept or dismiss in the UI.
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import { costStore, calcCostUsd } from "../cost/index.js";
import type { OcgDocument, OcgRule, OcgRuleCategory, OcgSuggestion, TimeEntry } from "../types.js";

// ─── Sanitisation ─────────────────────────────────────────────────────────────

function sanitizeText(s: string): string {
  return s
    .replace(/FINDING:/g, "")
    .replace(/END_FINDING/g, "")
    .replace(/NO_FINDINGS/g, "")
    .replace(/NO_CHALLENGE/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

// ─── Store ────────────────────────────────────────────────────────────────────

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export class OcgStore {
  private readonly path = Config.persistence.ocgFile;
  /** Map<clientId, OcgDocument> */
  private docs: Map<string, OcgDocument> = new Map();

  async init(): Promise<void> {
    try {
      await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [clientId, raw] of Object.entries(parsed)) {
        const d = raw as OcgDocument;
        this.docs.set(clientId, {
          ...d,
          createdAt: new Date(d.createdAt as unknown as string),
          updatedAt: new Date(d.updatedAt as unknown as string),
        });
      }
      logger.info("OCG store loaded", { count: this.docs.size });
    } catch {
      this.docs = new Map();
    }
  }

  getByClient(clientId: string): OcgDocument | undefined {
    return this.docs.get(clientId);
  }

  async remove(clientId: string): Promise<void> {
    this.docs.delete(clientId);
    await this.persist();
  }

  /**
   * Ingest OCG text for a client: call Haiku to extract structured rules,
   * store the resulting OcgDocument, return it.
   */
  async ingest(clientId: string, title: string, text: string): Promise<OcgDocument> {
    const sanitized = sanitizeText(text).slice(0, 60_000);
    const excerpt = sanitized.slice(0, 500);

    const prompt = `You are extracting billing rules from an Outside Counsel Guidelines document.
Return a JSON array of rules. Each rule must have:
  - category: one of billing_increments | entry_specificity | prohibited_tasks | rate_limits | staffing | description_format | timing | other
  - text: the rule in plain English, concise (max 200 chars)
  - severity: "hard" (billing violation, will be rejected) or "soft" (style preference)

Focus only on billing and time-entry rules. Ignore unrelated provisions.

OCG text:
${sanitized}

Respond with ONLY a valid JSON array, no markdown, no prose:
[{"category":"...","text":"...","severity":"..."},...]`;

    const client = new Anthropic({ apiKey: Config.anthropic.apiKey });
    const t0 = Date.now();
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });
    const durationMs = Date.now() - t0;

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    costStore.record({
      model: HAIKU_MODEL,
      provider: "anthropic",
      inputTokens,
      outputTokens,
      costUsd: calcCostUsd(HAIKU_MODEL, inputTokens, outputTokens),
      estimatedWh: null,
      estimatedWatts: null,
      durationMs,
      context: "ocg_extraction",
    });

    const rawText = response.content[0].type === "text" ? response.content[0].text : "[]";
    let rawRules: Array<{ category: string; text: string; severity: string }> = [];
    try {
      // Strip markdown fences if present
      const cleaned = rawText.replace(/```(?:json)?/gi, "").trim();
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");
      if (start !== -1 && end !== -1) {
        rawRules = JSON.parse(cleaned.slice(start, end + 1));
      }
    } catch {
      logger.warn("OCG rule extraction parse error — no rules extracted", { clientId });
    }

    const validCategories = new Set<OcgRuleCategory>([
      "billing_increments", "entry_specificity", "prohibited_tasks",
      "rate_limits", "staffing", "description_format", "timing", "other",
    ]);

    const rules: OcgRule[] = rawRules
      .filter((r) => r && typeof r.text === "string" && r.text.trim())
      .map((r) => ({
        id: randomUUID(),
        category: validCategories.has(r.category as OcgRuleCategory)
          ? (r.category as OcgRuleCategory)
          : "other",
        text: String(r.text).trim().slice(0, 200),
        severity: r.severity === "hard" ? "hard" : "soft",
      }));

    const now = new Date();
    const existing = this.docs.get(clientId);
    const doc: OcgDocument = {
      id: existing?.id ?? randomUUID(),
      clientId,
      title: title.trim().slice(0, 200),
      rules,
      excerpt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.docs.set(clientId, doc);
    await this.persist();
    logger.info("OCG ingested", { clientId, title, ruleCount: rules.length });
    return doc;
  }

  /**
   * Check a set of time entries against an OCG document's rules.
   * Processes entries in batches of 5; returns a Map<entryId, OcgSuggestion[]>.
   */
  async checkEntries(
    entries: TimeEntry[],
    ocgDoc: OcgDocument,
  ): Promise<Map<string, OcgSuggestion[]>> {
    const result = new Map<string, OcgSuggestion[]>();
    if (!entries.length || !ocgDoc.rules.length) return result;

    const client = new Anthropic({ apiKey: Config.anthropic.apiKey });
    const BATCH_SIZE = 5;

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const rulesText = ocgDoc.rules
        .map((r, idx) => `${idx + 1}. [${r.severity.toUpperCase()}/${r.category}] ${r.text}`)
        .join("\n");
      const entriesText = batch
        .map((e) => `ID:${e.id.slice(0, 8)} | ${e.startedAt instanceof Date ? e.startedAt.toISOString().slice(0, 10) : String(e.startedAt).slice(0, 10)} | ${(e.durationMs / 3_600_000).toFixed(2)}h | ${e.profileName} | ${e.description}`)
        .join("\n");

      const prompt = `You are a billing compliance reviewer. Check these time entries against OCG rules.
Return violations ONLY for entries that actually violate a rule.

OCG rules:
${rulesText}

Time entries:
${entriesText}

For each violating entry, provide:
{"entryId":"ID prefix","violations":[{"ruleIndex":1,"issue":"what is wrong","suggestedDescription":"rewritten entry"}]}

Return a JSON array ([] if all compliant):`;

      const t0 = Date.now();
      let responseText = "[]";
      try {
        const response = await client.messages.create({
          model: HAIKU_MODEL,
          max_tokens: 2048,
          messages: [{ role: "user", content: prompt }],
        });
        const durationMs = Date.now() - t0;
        const inputTokens = response.usage.input_tokens;
        const outputTokens = response.usage.output_tokens;
        costStore.record({
          model: HAIKU_MODEL,
          provider: "anthropic",
          inputTokens,
          outputTokens,
          costUsd: calcCostUsd(HAIKU_MODEL, inputTokens, outputTokens),
          estimatedWh: null,
          estimatedWatts: null,
          durationMs,
          context: "ocg_check",
        });
        responseText = response.content[0].type === "text" ? response.content[0].text : "[]";
      } catch (err) {
        logger.warn("OCG check Haiku call failed", { error: (err as Error).message });
        continue;
      }

      let violations: Array<{ entryId: string; violations: Array<{ ruleIndex: number; issue: string; suggestedDescription: string }> }> = [];
      try {
        const cleaned = responseText.replace(/```(?:json)?/gi, "").trim();
        const start = cleaned.indexOf("[");
        const end = cleaned.lastIndexOf("]");
        if (start !== -1 && end !== -1) {
          violations = JSON.parse(cleaned.slice(start, end + 1));
        }
      } catch {
        logger.warn("OCG check parse error", { batchIndex: i });
      }

      for (const v of violations) {
        if (!v.entryId || !Array.isArray(v.violations)) continue;
        const prefix = v.entryId.slice(0, 8);
        const entry = batch.find((e) => e.id.slice(0, 8) === prefix);
        if (!entry) continue;

        const suggestions: OcgSuggestion[] = v.violations
          .filter((viol) => typeof viol.ruleIndex === "number")
          .map((viol) => {
            const rule = ocgDoc.rules[viol.ruleIndex - 1];
            if (!rule) return null;
            return {
              ruleId: rule.id,
              ruleText: rule.text,
              category: rule.category,
              severity: rule.severity,
              issue: String(viol.issue || "").trim().slice(0, 500),
              suggestedDescription: String(viol.suggestedDescription || "").trim().slice(0, 1000),
              status: "pending" as const,
            };
          })
          .filter((s): s is OcgSuggestion => s !== null);

        if (suggestions.length) {
          result.set(entry.id, suggestions);
        }
      }
    }

    return result;
  }

  /** Atomic write — tmp file then rename. */
  async persist(): Promise<void> {
    const obj: Record<string, unknown> = {};
    for (const [clientId, doc] of this.docs) {
      obj[clientId] = {
        ...doc,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      };
    }
    const tmp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true }).catch(() => {});
    await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmp, this.path);
  }
}

export const ocgStore = new OcgStore();
