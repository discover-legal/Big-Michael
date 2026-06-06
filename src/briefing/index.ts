// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

/**
 * Client Intelligence Briefing — pre-call / pre-meeting partner briefing pack.
 *
 * Replaces Clio Grow (CRM), Clio Insights client reports, and the
 * 30-minute manual assembly partners do before every client call:
 * pulling billing history, open matters, recent activity, and
 * relationship contacts from three different screens.
 *
 * Given a clientId (or clientNumber), produces a single structured
 * briefing in under 10 seconds — matter status, billing posture,
 * open items, relationship summary, and any regulatory/industry
 * context the firm's knowledge store surfaces.
 *
 * WHAT IT KILLS:
 *   Clio Grow / CRM — relationship management + pre-call prep
 *   Clio Insights client reports — billing + activity summaries
 *   Manual partner prep (30 min before every call)
 *   Relationship intelligence tools (ContactsLaw, Nexl, Introhive)
 */

import Anthropic from "@anthropic-ai/sdk";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import { costStore, calcCostUsd } from "../cost/index.js";
import { resolveModelId } from "../providers/index.js";
import type { Client, ClientMatter, Task, TimeEntry } from "../types.js";

const SONNET_MODEL = "claude-sonnet-4-6";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BriefingMatterSnapshot {
  matterNumber: string;
  description: string;
  practiceArea?: string;
  status: "active" | "idle" | "complete";
  /** Days since last activity in the task/time store */
  daysSinceActivity: number;
  /** Open billing amount (WIP — hours logged but not yet billed) */
  openBillingUsd: number;
  /** Total billed to date for this matter */
  totalBilledUsd: number;
  /** Number of pending human gates on this matter */
  pendingGates: number;
  /** Most recent task output snippet */
  lastOutput?: string;
}

export interface BriefingBillingSnapshot {
  /** Rolling 90-day billed total */
  last90DaysUsd: number;
  /** Current WIP (open, unbilled time entries) */
  wipUsd: number;
  /** Oldest unbilled entry in days */
  oldestWipDays: number;
  /** Outstanding invoice count (from matters where status != completed) */
  openMatterCount: number;
}

export interface ClientBriefing {
  id: string;
  clientId: string;
  clientName: string;
  clientNumber: string;
  generatedAt: string;
  /** When the briefing is for (ISO date — used in the heading) */
  briefingDate: string;
  /** Executive paragraph — 3 sentences for the opening of a partner's call */
  executiveSummary: string;
  /** Active and recently active matters */
  matters: BriefingMatterSnapshot[];
  billing: BriefingBillingSnapshot;
  /** Open items requiring partner attention */
  openItems: string[];
  /** Relationship notes from the client record */
  relationshipNotes?: string;
  /** Industry / regulatory context pulled from the knowledge store (if any) */
  industryContext?: string;
  /** Full markdown briefing document */
  document: string;
}

// ─── BriefingEngine ───────────────────────────────────────────────────────────

export class BriefingEngine {
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: Config.anthropic.apiKey,
      ...(Config.anthropic.baseUrl ? { baseURL: Config.anthropic.baseUrl } : {}),
    });
  }

  /**
   * Generate a pre-call client briefing.
   *
   * @param clientRecord  Client from the ClientStore.
   * @param allTasks      All tasks — filtered to this client's matters internally.
   * @param timeEntries   All time entries — filtered to this client internally.
   * @param opts          Context for the briefing.
   */
  async generate(
    clientRecord: Client,
    allTasks: Task[],
    timeEntries: TimeEntry[],
    opts: {
      taskId?: string;
      /** ISO date string — defaults to today */
      briefingDate?: string;
      /** Knowledge-store industry context (optional, caller supplies) */
      industryContext?: string;
    } = {},
  ): Promise<ClientBriefing> {
    const start = Date.now();
    const now = new Date();
    const briefingDate = opts.briefingDate ?? now.toISOString().slice(0, 10);

    // Filter to this client's data
    const clientTasks = allTasks.filter(
      (t) => t.clientNumber === clientRecord.clientNumber || t.clientNumber === clientRecord.id,
    );
    const clientEntries = timeEntries.filter(
      (e) => e.clientNumber === clientRecord.clientNumber,
    );

    // Build matter snapshots
    const matters = this.buildMatterSnapshots(clientRecord.matters, clientTasks, clientEntries, now);

    // Build billing snapshot
    const billing = this.buildBillingSnapshot(clientEntries, matters, now);

    // Collect open items
    const openItems = this.collectOpenItems(matters, clientTasks);

    // Generate the briefing document (Sonnet)
    const { executiveSummary, document } = await this.generateDocument(
      clientRecord, matters, billing, openItems, opts,
    );

    const briefing: ClientBriefing = {
      id: crypto.randomUUID(),
      clientId: clientRecord.id,
      clientName: clientRecord.name,
      clientNumber: clientRecord.clientNumber,
      generatedAt: now.toISOString(),
      briefingDate,
      executiveSummary,
      matters,
      billing,
      openItems,
      relationshipNotes: clientRecord.notes,
      industryContext: opts.industryContext,
      document,
    };

    logger.info("Client briefing generated", {
      id: briefing.id,
      client: clientRecord.name,
      matters: matters.length,
      openItems: openItems.length,
    });

    return briefing;
  }

  // ─── Matter snapshot builder ──────────────────────────────────────────────

  private buildMatterSnapshots(
    clientMatters: ClientMatter[],
    tasks: Task[],
    entries: TimeEntry[],
    now: Date,
  ): BriefingMatterSnapshot[] {
    return clientMatters.map((m): BriefingMatterSnapshot => {
      const matterTasks = tasks.filter((t) => t.matterNumber === m.matterNumber);
      const matterEntries = entries.filter((e) => e.matterNumber === m.matterNumber);

      // Activity freshness
      const lastActivity = matterTasks
        .map((t) => t.updatedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      const daysSinceActivity = lastActivity
        ? Math.floor((now.getTime() - lastActivity.getTime()) / 86_400_000)
        : 999;

      // Billing
      const ninety = new Date(now.getTime() - 90 * 86_400_000);
      const recent = matterEntries.filter(
        (e) => e.endedAt && e.billingAmountUsd != null,
      );
      const openWip = matterEntries.filter((e) => !e.endedAt);
      const openBillingUsd = openWip.reduce((s, e) => s + (e.billingAmountUsd ?? 0), 0);
      const totalBilledUsd = recent.reduce((s, e) => s + (e.billingAmountUsd ?? 0), 0);

      // Gates
      const pendingGates = matterTasks.reduce(
        (s, t) => s + (t.pendingGates?.length ?? 0), 0,
      );

      // Status
      const latestTask = matterTasks.sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
      )[0];
      let status: BriefingMatterSnapshot["status"] = "idle";
      if (latestTask?.status === "running") status = "active";
      else if (latestTask?.status === "complete") status = "complete";

      // Last output snippet
      const lastOutput = latestTask?.output?.slice(0, 300);

      return {
        matterNumber: m.matterNumber,
        description: m.description,
        practiceArea: m.practiceArea,
        status,
        daysSinceActivity,
        openBillingUsd,
        totalBilledUsd,
        pendingGates,
        lastOutput,
      };
    });
  }

  // ─── Billing snapshot ─────────────────────────────────────────────────────

  private buildBillingSnapshot(
    entries: TimeEntry[],
    matters: BriefingMatterSnapshot[],
    now: Date,
  ): BriefingBillingSnapshot {
    const ninety = new Date(now.getTime() - 90 * 86_400_000);
    const closed = entries.filter(
      (e) => e.endedAt && new Date(e.endedAt) >= ninety && e.billingAmountUsd != null,
    );
    const open = entries.filter((e) => !e.endedAt);

    const last90DaysUsd = closed.reduce((s, e) => s + (e.billingAmountUsd ?? 0), 0);
    const wipUsd = matters.reduce((s, m) => s + m.openBillingUsd, 0);

    const oldest = open
      .map((e) => Math.floor((now.getTime() - e.startedAt.getTime()) / 86_400_000))
      .sort((a, b) => b - a)[0] ?? 0;

    const openMatterCount = matters.filter((m) => m.status !== "complete").length;

    return { last90DaysUsd, wipUsd, oldestWipDays: oldest, openMatterCount };
  }

  // ─── Open items ───────────────────────────────────────────────────────────

  private collectOpenItems(
    matters: BriefingMatterSnapshot[],
    tasks: Task[],
  ): string[] {
    const items: string[] = [];

    for (const m of matters) {
      if (m.pendingGates > 0) {
        items.push(`${m.matterNumber}: ${m.pendingGates} pending gate(s) require partner approval`);
      }
      if (m.openBillingUsd > 0) {
        items.push(`${m.matterNumber}: $${m.openBillingUsd.toFixed(0)} WIP unbilled`);
      }
      if (m.status === "idle" && m.daysSinceActivity > 30) {
        items.push(`${m.matterNumber}: idle for ${m.daysSinceActivity} days — confirm status with client`);
      }
    }

    return items.slice(0, 10);
  }

  // ─── Document generation ──────────────────────────────────────────────────

  private async generateDocument(
    client: Client,
    matters: BriefingMatterSnapshot[],
    billing: BriefingBillingSnapshot,
    openItems: string[],
    opts: { taskId?: string; briefingDate?: string; industryContext?: string },
  ): Promise<{ executiveSummary: string; document: string }> {
    const start = Date.now();

    const matterLines = matters
      .map((m) =>
        `• ${m.matterNumber} [${m.status.toUpperCase()}] — ${m.description}` +
        (m.practiceArea ? ` (${m.practiceArea})` : "") +
        ` | $${m.totalBilledUsd.toFixed(0)} billed | ${m.daysSinceActivity}d since activity` +
        (m.pendingGates > 0 ? ` | ⚠ ${m.pendingGates} gate(s) pending` : ""),
      )
      .join("\n");

    const openItemLines = openItems.map((i) => `- ${i}`).join("\n") || "- None";

    const prompt = `You are writing a pre-call partner briefing for a law firm.

CLIENT: ${client.name} (${client.clientNumber})
BRIEFING DATE: ${opts.briefingDate ?? new Date().toISOString().slice(0, 10)}

MATTERS:
${matterLines || "(no matters on record)"}

BILLING:
  Last 90 days billed: $${billing.last90DaysUsd.toFixed(0)}
  Current WIP (unbilled): $${billing.wipUsd.toFixed(0)}
  Oldest open entry: ${billing.oldestWipDays} days
  Open matters: ${billing.openMatterCount}

OPEN ITEMS:
${openItemLines}

${client.notes ? `RELATIONSHIP NOTES:\n${client.notes}\n` : ""}
${opts.industryContext ? `INDUSTRY CONTEXT:\n${opts.industryContext}\n` : ""}

Write:
1. A 2-sentence EXECUTIVE SUMMARY — most important thing the partner needs to know right now.
2. A full BRIEFING DOCUMENT in Markdown with sections:
   ## ${client.name} — Partner Briefing (${opts.briefingDate ?? "today"})
   ### Executive Summary
   ### Matter Status
   ### Billing Posture
   ### Open Items
   ### Relationship Notes (if any)
   ### Industry Context (if any)
   ### Recommended Actions

Return JSON:
{"executiveSummary":"...","document":"..."}`;

    try {
      const response = await this.client.messages.create({
        model: SONNET_MODEL, max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      });

      const usage = response.usage;
      costStore.record({
        model: resolveModelId(SONNET_MODEL), provider: "anthropic",
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cacheWriteTokens: (usage as Record<string, unknown>)["cache_creation_input_tokens"] as number | undefined,
        cacheReadTokens: (usage as Record<string, unknown>)["cache_read_input_tokens"] as number | undefined,
        costUsd: calcCostUsd(resolveModelId(SONNET_MODEL), usage.input_tokens, usage.output_tokens),
        estimatedWh: null, estimatedWatts: null,
        durationMs: Date.now() - start, context: "client_briefing", taskId: opts.taskId,
      });

      const raw = response.content[0]?.type === "text" ? response.content[0].text : "{}";
      const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
      if (s === -1 || e <= s) return this.fallbackDocument(client, matters, billing, openItems);
      return JSON.parse(raw.slice(s, e + 1));
    } catch {
      return this.fallbackDocument(client, matters, billing, openItems);
    }
  }

  private fallbackDocument(
    client: Client,
    matters: BriefingMatterSnapshot[],
    billing: BriefingBillingSnapshot,
    openItems: string[],
  ): { executiveSummary: string; document: string } {
    const summary = `${client.name} has ${matters.length} matter(s) on record. ` +
      `$${billing.wipUsd.toFixed(0)} WIP outstanding; ${openItems.length} open item(s) require attention.`;

    const doc = `## ${client.name} — Partner Briefing\n\n` +
      `**Matters:** ${matters.length} | **WIP:** $${billing.wipUsd.toFixed(0)} | **Open items:** ${openItems.length}\n\n` +
      openItems.map((i) => `- ${i}`).join("\n");

    return { executiveSummary: summary, document: doc };
  }
}

export const briefingEngine = new BriefingEngine();
