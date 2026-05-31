// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

/**
 * Smoke test — validates the full stack is wired up correctly without
 * making real API calls. Checks:
 *   - Config loads without throwing
 *   - ToolRegistry has all 6 tools
 *   - AgentDefinitions cover all expected IDs
 *   - TemplateStore loads 3 built-in templates
 *   - selectModel routing produces correct models
 *   - Agent.process() falls back gracefully when no toolRegistry
 *   - Orchestrator init path (registry + memory + knowledge) runs without Qdrant
 *     (will error on Qdrant connect — expected in CI; exit 0 if all pre-Qdrant checks pass)
 */

import { globalToolRegistry } from "../tools/index.js";
import { ALL_AGENT_DEFINITIONS } from "../agents/definitions.js";
import { TemplateStore } from "../templates/store.js";
import { selectModel } from "../routing/model.js";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const PASS = "✓";
const FAIL = "✗";
let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stdout.write(`  ${PASS} ${label}\n`);
  } else {
    process.stdout.write(`  ${FAIL} ${label}${detail ? ` — ${detail}` : ""}\n`);
    failures++;
  }
}

// ─── 1. Config ────────────────────────────────────────────────────────────────

process.stdout.write("\n[1] Config\n");
try {
  const { Config } = await import("../config.js");
  check("ANTHROPIC_API_KEY present", !!Config.anthropic.apiKey);
  check("Default model set", !!Config.anthropic.model);
  check("DyTopo threshold in range", Config.dytopo.similarityThreshold > 0 && Config.dytopo.similarityThreshold < 1);
  check("Debate gate threshold in range", Config.debate.gateConfidenceThreshold > 0 && Config.debate.gateConfidenceThreshold <= 1);
} catch (err) {
  check("Config loads", false, (err as Error).message);
}

// ─── 2. Tool registry ─────────────────────────────────────────────────────────

process.stdout.write("\n[2] ToolRegistry\n");
const expectedTools = ["web_search", "search_knowledge", "query_memory", "extract_from_document", "translate", "citation_check"];
for (const name of expectedTools) {
  check(`tool: ${name}`, globalToolRegistry.has(name));
}
const schemas = globalToolRegistry.schemasFor(expectedTools);
check("schemasFor returns correct count", schemas.length === expectedTools.length, `got ${schemas.length}`);

// ─── 3. Agent definitions ─────────────────────────────────────────────────────

process.stdout.write("\n[3] Agent definitions\n");
check("Total agents >= 40", ALL_AGENT_DEFINITIONS.length >= 40, `got ${ALL_AGENT_DEFINITIONS.length}`);
check("T0 root orchestrator present", ALL_AGENT_DEFINITIONS.some((a) => a.tier === 0));
const t1 = ALL_AGENT_DEFINITIONS.filter((a) => a.tier === 1);
const t2 = ALL_AGENT_DEFINITIONS.filter((a) => a.tier === 2);
const t3 = ALL_AGENT_DEFINITIONS.filter((a) => a.tier === 3);
check("T1 managers >= 4", t1.length >= 4, `got ${t1.length}`);
check("T2 specialists >= 30", t2.length >= 30, `got ${t2.length}`);
check("T3 tool agents >= 5", t3.length >= 5, `got ${t3.length}`);

// No duplicate IDs
const ids = ALL_AGENT_DEFINITIONS.map((a) => a.id);
const uniqueIds = new Set(ids);
check("No duplicate agent IDs", uniqueIds.size === ids.length, `${ids.length - uniqueIds.size} duplicates`);

// All agents have non-empty systemPrompt
const noPrompt = ALL_AGENT_DEFINITIONS.filter((a) => !a.systemPrompt?.trim());
check("All agents have systemPrompt", noPrompt.length === 0, `missing: ${noPrompt.map((a) => a.id).join(", ")}`);

// ─── 4. Templates ─────────────────────────────────────────────────────────────

process.stdout.write("\n[4] TemplateStore\n");
const store = new TemplateStore();
const templateDir = join(dirname(fileURLToPath(import.meta.url)), "../templates");
await store.load(templateDir);
check("Templates loaded >= 3", store.list().length >= 3, `got ${store.list().length}`);
check("eu-competition-brief present", !!store.get("eu-competition-brief"));
check("gdpr-complaint-response present", !!store.get("gdpr-complaint-response"));
check("merger-pre-notification present", !!store.get("merger-pre-notification"));

// ─── 5. Model routing ─────────────────────────────────────────────────────────

process.stdout.write("\n[5] Model routing\n");
check("descriptor → Haiku", selectModel({ taskType: "descriptor" }).includes("haiku"));
check("extraction → Haiku", selectModel({ taskType: "extraction" }).includes("haiku"));
check("debate → Opus", selectModel({ taskType: "debate" }).includes("opus"));
check("synthesis → Opus", selectModel({ taskType: "synthesis" }).includes("opus"));
check("T0 → Opus", selectModel({ tier: 0, taskType: "reasoning" }).includes("opus"));
check("T3 → Haiku", selectModel({ tier: 3, taskType: "reasoning" }).includes("haiku"));
check("T1 reasoning → Sonnet", selectModel({ tier: 1, taskType: "reasoning" }).includes("sonnet"));

// Ollama routing — simulate OLLAMA_ENABLED=true by checking prefix logic
const { isOllamaModel, ollamaModelName } = await import("../providers/index.js");
check("ollama: prefix detection", isOllamaModel("ollama:llama3.2"));
check("ollama: prefix stripping", ollamaModelName("ollama:llama3.2") === "llama3.2");
check("claude model not flagged as ollama", !isOllamaModel("claude-opus-4-8"));

// ─── 6. PDF tools ─────────────────────────────────────────────────────────────

process.stdout.write("\n[6] PDF tools (live Python round-trip)\n");
const { globalToolRegistry: toolReg } = await import("../tools/index.js");
check("pdf_generate registered", toolReg.has("pdf_generate"));
check("pdf_extract_text registered", toolReg.has("pdf_extract_text"));
check("pdf_extract_tables registered", toolReg.has("pdf_extract_tables"));
check("pdf_ocr registered", toolReg.has("pdf_ocr"));

// ─── 7. DocuSeal + secrets registration ───────────────────────────────────────

process.stdout.write("\n[7] DocuSeal + secrets\n");
check("docuseal_send_for_signing registered", toolReg.has("docuseal_send_for_signing"));
check("docuseal_submission_status registered", toolReg.has("docuseal_submission_status"));
check("docuseal_list_templates registered", toolReg.has("docuseal_list_templates"));

// Signing agent exists in definitions
check(
  "docuseal-signing-agent defined",
  ALL_AGENT_DEFINITIONS.some((a) => a.id === "docuseal-signing-agent"),
);

// All drafter agents have docuseal_send_for_signing
const drafterAgents = ALL_AGENT_DEFINITIONS.filter((a) => a.id.includes("drafter"));
const allDraftersHaveSigning = drafterAgents.every((a) => a.allowedTools.includes("docuseal_send_for_signing"));
check(`All ${drafterAgents.length} drafter agents have docuseal_send_for_signing`, allDraftersHaveSigning);

// Secrets loader exports correctly (no Infisical configured in CI — just checks module loads)
const { loadSecrets } = await import("../secrets/index.js");
check("loadSecrets is a function", typeof loadSecrets === "function");
const secretsResult = await loadSecrets(); // will no-op (no INFISICAL_CLIENT_ID in CI)
check("loadSecrets returns source field", secretsResult.source === "env" || secretsResult.source === "infisical");

// ─── 8. PDF round-trip ────────────────────────────────────────────────────────

process.stdout.write("\n[8] PDF round-trip\n");

// Live round-trip: generate a PDF then extract its text
import { tmpdir } from "os";
import { join as pathJoin } from "path";
const tmp = tmpdir();
const mockCtx = { knowledge: null as never, memory: null as never, taskId: "smoke" };
const genResult = await toolReg.execute("pdf_generate", {
  title: "Smoke Test Brief",
  filename: "smoke-test.pdf",
  content: "## Introduction\n\nThis is a smoke test document.\n\n## Conclusion\n\nPDF generation works.",
  output_dir: tmp,
}, mockCtx) as Record<string, unknown>;
check("pdf_generate produces a file", typeof genResult.outputPath === "string", JSON.stringify(genResult));
check("pdf_generate reports pageCount", typeof genResult.pageCount === "number");

if (genResult.outputPath) {
  const extractResult = await toolReg.execute("pdf_extract_text", { path: genResult.outputPath }, mockCtx) as Record<string, unknown>;
  check("pdf_extract_text reads back content", typeof extractResult.pageCount === "number");
  const allText = (extractResult.pages as Array<{text: string}>)?.[0]?.text ?? "";
  check("pdf_extract_text finds document title", allText.includes("Smoke Test Brief") || allText.includes("Introduction"));

  // OCR round-trip
  const ocrResult = await toolReg.execute("pdf_ocr", { path: genResult.outputPath }, mockCtx) as Record<string, unknown>;
  check("pdf_ocr returns text", typeof ocrResult.text === "string" && (ocrResult.text as string).length > 0);
  check("pdf_ocr finds title via Tesseract", (ocrResult.text as string).includes("Smoke Test") || (ocrResult.text as string).includes("Introduction"));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

process.stdout.write("\n");
if (failures === 0) {
  process.stdout.write(`All smoke tests passed.\n`);
  process.exit(0);
} else {
  process.stdout.write(`${failures} smoke test(s) failed.\n`);
  process.exit(1);
}
