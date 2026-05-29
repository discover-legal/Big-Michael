// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

/**
 * Seed script — registers all default agents into the RuVector/Qdrant registry.
 * Run once after `docker compose up`: npm run seed
 */
import { AgentRegistry } from "../agents/registry.js";
import { ALL_AGENT_DEFINITIONS } from "../agents/definitions.js";
import { InterRoundMemoryStore } from "../memory/index.js";
import { KnowledgeStore } from "../knowledge/index.js";
import { logger } from "../logger.js";
import "dotenv/config";

async function seed(): Promise<void> {
  logger.info("Seeding collections…");

  const registry = new AgentRegistry();
  const memory = new InterRoundMemoryStore();
  const knowledge = new KnowledgeStore();

  await Promise.all([registry.init(), memory.init(), knowledge.init()]);

  await registry.registerAll(ALL_AGENT_DEFINITIONS);
  logger.info("Agent registry seeded", { count: ALL_AGENT_DEFINITIONS.length });

  // Print agent roster
  for (const def of ALL_AGENT_DEFINITIONS) {
    logger.info(`  [T${def.tier}] ${def.name} (${def.domain})`, {
      tools: def.allowedTools.length,
    });
  }

  logger.info("Seed complete");
}

seed().catch((err) => {
  logger.error("Seed failed", { error: err.message });
  process.exit(1);
});