// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Discover Legal
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//     http://www.apache.org/licenses/LICENSE-2.0

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