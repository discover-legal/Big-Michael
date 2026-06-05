// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * ClientStatusReport — synthesises a matter status update for client delivery.
 * Pulls task output, findings, time spend, and budget burn into a branded report.
 * Uses Opus + lawyer tone injection (same pattern as orchestrator synthesise()).
 */

import { getProvider, resolveModelId, isOllamaModel, isLocalModel } from "../providers/index.js";
import { costStore, calcCostUsd, calcWattHours } from "../cost/index.js";
import { Config } from "../config.js";
import { logger } from "../logger.js";
import type { Task, TimeEntry, LawyerProfile } from "../types.js";
import { sanitizePromptContent } from "../adapters/lavern.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatusReportOptions {
  taskId: string;
  format: "html" | "markdown";
  includeTimeEntries?: boolean;   // default true
  includeBudgetBurn?: boolean;    // default true
  includeOcgFlags?: boolean;      // default false (internal — omit from client version)
  customNote?: string;            // optional partner note prepended to the report
}

export interface StatusReport {
  taskId: string;
  matterNumber?: string;
  clientNumber?: string;
  generatedAt: string;           // ISO
  format: "html" | "markdown";
  content: string;               // the rendered report body
  wordCount: number;
  costUsd: number;               // Opus call cost
}

/** Budget burn shape returned by BudgetMonitor.getBurn() */
interface BudgetBurn {
  budgetUsd: number;
  burnUsd: number;
  burnPct: number;
  remaining: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert basic Markdown to HTML using simple regex transforms.
 * Handles: headings (## / ###), bold (**text**), bullet lists (- item),
 * horizontal rules (---), and paragraphs. No npm packages needed.
 */
export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const htmlParts: string[] = [];
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine;

    // Heading 1
    if (/^# (.+)$/.test(line)) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      htmlParts.push(`<h1>${escapeHtml(line.slice(2).trim())}</h1>`);
      continue;
    }
    // Heading 2
    if (/^## (.+)$/.test(line)) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      htmlParts.push(`<h2>${escapeHtml(line.slice(3).trim())}</h2>`);
      continue;
    }
    // Heading 3
    if (/^### (.+)$/.test(line)) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      htmlParts.push(`<h3>${escapeHtml(line.slice(4).trim())}</h3>`);
      continue;
    }
    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      htmlParts.push("<hr>");
      continue;
    }
    // Bullet list item
    if (/^[-*] (.+)$/.test(line)) {
      if (!inList) { htmlParts.push("<ul>"); inList = true; }
      const content = line.replace(/^[-*] /, "");
      htmlParts.push(`<li>${inlineFormat(content)}</li>`);
      continue;
    }
    // Numbered list item — emit as a paragraph for simplicity (no ol nesting needed)
    if (/^\d+\. (.+)$/.test(line)) {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      htmlParts.push(`<p>${inlineFormat(line)}</p>`);
      continue;
    }
    // Blank line — close list if open
    if (line.trim() === "") {
      if (inList) { htmlParts.push("</ul>"); inList = false; }
      continue;
    }
    // Ordinary paragraph
    if (inList) { htmlParts.push("</ul>"); inList = false; }
    htmlParts.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inList) htmlParts.push("</ul>");
  return htmlParts.join("\n");
}

/** Apply inline formatting: **bold**, *italic*, `code`. */
function inlineFormat(text: string): string {
  return escapeHtml(text)
    // Bold: **text**
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic: *text* (single asterisk, non-greedy)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    // Inline code: `text`
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap rendered content in a minimal, printable HTML template. */
function wrapInHtmlTemplate(content: string, matterNumber: string | undefined, date: string): string {
  const title = matterNumber ? `Matter Status Update — ${matterNumber}` : "Matter Status Update";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 1.4em; border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; }
  h2 { font-size: 1.1em; margin-top: 24px; }
  .meta { color: #555; font-size: 0.9em; margin-bottom: 24px; }
  .footer { margin-top: 40px; font-size: 0.8em; color: #888; border-top: 1px solid #ddd; padding-top: 8px; }
</style></head>
<body>
${content}
<div class="footer">Generated ${escapeHtml(date)} · Big Michael · CONFIDENTIAL — ATTORNEY-CLIENT PRIVILEGE</div>
</body></html>`;
}

/** Count words in a string. */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Sanitize a user-supplied note: strip control characters and cap at 1000 chars.
 * Also applies the prompt-injection marker sanitization from lavern.
 */
function sanitizeNote(note: string): string {
  const stripped = note
    // Strip control characters (C0 and C1, except newline/tab)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .slice(0, 1000);
  return sanitizePromptContent(stripped);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a client-ready status report for the given task.
 *
 * @param task           The task to report on (should be complete or in-progress)
 * @param timeEntries    Billable time entries for the task (pass [] to omit)
 * @param budgetBurn     Budget burn object from BudgetMonitor.getBurn(), or undefined
 * @param opts           Report options (format, flags, custom note)
 * @param lawyerProfile  Optional: the primary lawyer's profile for tone injection
 */
export async function generateStatusReport(
  task: Task,
  timeEntries: TimeEntry[],
  budgetBurn: BudgetBurn | undefined,
  opts: StatusReportOptions,
  lawyerProfile?: LawyerProfile,
): Promise<StatusReport> {
  const {
    format,
    includeTimeEntries = true,
    includeBudgetBurn = true,
    includeOcgFlags = false,
    customNote,
  } = opts;

  // ── 1. Build the context block ─────────────────────────────────────────────

  // Sort findings by confidence descending, take top 5
  const topFindings = [...task.findings]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);

  const findingsBlock = topFindings.length > 0
    ? topFindings
        .map((f, i) => `[${i + 1}] (${f.agentName}, conf ${f.confidence.toFixed(2)}) ${f.content.slice(0, 400)}`)
        .join("\n")
    : "(none yet)";

  // Time spend aggregation
  const closedEntries = timeEntries.filter((e) => e.endedAt);
  const totalHours = closedEntries.reduce((sum, e) => sum + (e.billingUnits ?? 0) * 0.1, 0);
  const totalAmountUsd = closedEntries.reduce((sum, e) => sum + (e.billingAmountUsd ?? 0), 0);

  const timeBlock = includeTimeEntries
    ? `TIME SPEND: ${totalHours.toFixed(1)}h billed ($${totalAmountUsd.toFixed(2)} USD)`
    : "";

  const budgetBlock = includeBudgetBurn && budgetBurn
    ? `BUDGET BURN: ${(budgetBurn.burnPct * 100).toFixed(1)}% of $${budgetBurn.budgetUsd.toLocaleString()} budget ($${budgetBurn.burnUsd.toFixed(2)} spent, $${budgetBurn.remaining.toFixed(2)} remaining)`
    : "";

  // OCG flags block (placeholder — OCG store not available in this schema version)
  const ocgBlock = includeOcgFlags
    ? `OCG FLAGS: see time entries for compliance suggestions`
    : "";

  const synthesisExcerpt = task.output ? task.output.slice(0, 3000) : "(analysis in progress)";

  const contextLines = [
    `MATTER: ${task.matterNumber ?? "—"} — ${task.description}`,
    `JURISDICTION: ${task.jurisdiction ?? "Not specified"}`,
    `STATUS: ${task.status} | Phase: ${task.currentPhase}`,
    ``,
    `FINDINGS (${topFindings.length} of ${task.findings.length} shown, by confidence):`,
    findingsBlock,
    ``,
    `SYNTHESIS:`,
    synthesisExcerpt,
    timeBlock ? `\n${timeBlock}` : "",
    budgetBlock ? budgetBlock : "",
    ocgBlock ? ocgBlock : "",
  ].filter(Boolean).join("\n");

  // ── 2. Build the system prompt ─────────────────────────────────────────────

  const toneInjection = lawyerProfile?.toneProfile
    ? `\n${sanitizePromptContent(lawyerProfile.toneProfile.injectionSnippet)}\n`
    : "";

  const noteBlock = customNote
    ? `PARTNER NOTE (include this verbatim near the top of the report):\n${sanitizeNote(customNote)}\n\n`
    : "";

  const systemPrompt = [
    "You are a senior lawyer drafting a client status update.",
    `Write a professional, concise status report in ${format} format.`,
    "Address the client directly. Summarise progress, key findings, next steps.",
    "Use clear headings. Keep it under 500 words unless the matter is complex.",
    "Do NOT reveal internal agent names, tool names, or system architecture details.",
    toneInjection,
  ].filter(Boolean).join("\n");

  const userPrompt = `${noteBlock}${contextLines}`;

  // ── 3. Call Opus ───────────────────────────────────────────────────────────

  const modelId = "claude-opus-4-8";
  const provider = getProvider(modelId);
  const start = Date.now();

  logger.info("Generating client status report", {
    taskId: task.id,
    format,
    findings: task.findings.length,
    hasProfile: !!lawyerProfile?.toneProfile,
  });

  const response = await provider.chat({
    model: resolveModelId(modelId),
    maxTokens: 2000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    cacheSystem: true,
  });

  const durationMs = Date.now() - start;

  // ── 4. Record cost ─────────────────────────────────────────────────────────

  const isLocal = isOllamaModel(modelId) || isLocalModel(modelId);
  const bare = resolveModelId(modelId);
  const cw = response.usage.cacheWriteTokens ?? 0;
  const cr = response.usage.cacheReadTokens ?? 0;

  const costUsd = isLocal
    ? 0
    : (calcCostUsd(bare, response.usage.inputTokens, response.usage.outputTokens, cw, cr) ?? 0);

  costStore.record({
    model: bare,
    provider: isLocal ? (isOllamaModel(modelId) ? "ollama" : "local") : "anthropic",
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    ...(cw ? { cacheWriteTokens: cw } : {}),
    ...(cr ? { cacheReadTokens: cr } : {}),
    costUsd: isLocal ? null : costUsd,
    estimatedWh: isLocal ? calcWattHours(Config.local.inferenceWatts, durationMs) : null,
    estimatedWatts: isLocal ? Config.local.inferenceWatts : null,
    durationMs,
    context: "synthesis",
    taskId: task.id,
    profileId: lawyerProfile?.id,
  });

  // ── 5. Extract text and render ─────────────────────────────────────────────

  const textBlock = response.content.find((b) => b.type === "text");
  const rawMarkdown = textBlock?.type === "text" ? textBlock.text : "";

  const generatedAt = new Date().toISOString();
  const humanDate = new Date(generatedAt).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });

  let content: string;
  if (format === "html") {
    const htmlBody = markdownToHtml(rawMarkdown);
    content = wrapInHtmlTemplate(htmlBody, task.matterNumber, humanDate);
  } else {
    content = rawMarkdown;
  }

  return {
    taskId: task.id,
    matterNumber: task.matterNumber,
    clientNumber: task.clientNumber,
    generatedAt,
    format,
    content,
    wordCount: countWords(rawMarkdown),
    costUsd,
  };
}
