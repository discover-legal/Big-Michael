// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

/**
 * Application entry point — Big Michael.
 *
 * Startup order (strict — DO NOT reorder imports):
 *   1. dotenv           — loads .env into process.env
 *   2. Infisical        — overlays managed secrets on top of process.env
 *   3. Everything else  — Config reads process.env, which is now fully populated
 *
 * Infisical (https://infisical.com) is an open-source self-hostable secrets
 * manager. Only INFISICAL_* bootstrap vars need to be in .env; all other
 * secrets (API keys, passwords, tokens) live in Infisical.
 * If INFISICAL_CLIENT_ID is not set, Infisical is skipped and .env is used as-is.
 */

// ─── Step 1: dotenv ─── must be the very first import ─────────────────────────
import "dotenv/config";

// ─── Step 2: Infisical ─── injects managed secrets before Config is evaluated ──
import { loadSecrets } from "./secrets/index.js";
await loadSecrets();

// ─── Step 3: Application ─── safe to import after secrets are loaded ───────────
import { logger } from "./logger.js";
import { Orchestrator } from "./orchestrator.js";
import { startMcpServer, startRestApi } from "./mcp/server.js";

async function main(): Promise<void> {
  logger.info("Big Michael starting…");

  const orchestrator = new Orchestrator();
  await orchestrator.init();

  // REST API always starts; MCP stdio only when invoked by an MCP client (non-TTY)
  await startRestApi(orchestrator);

  if (!process.stdin.isTTY) {
    await startMcpServer(orchestrator);
  } else {
    logger.info(
      `Interactive terminal — MCP stdio skipped. REST API on port ${process.env.API_PORT ?? "3101"}`,
    );
  }
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err.message, stack: err.stack });
  process.exit(1);
});
