// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * syncConflictGraph — called once at startup and on POST /graph/sync.
 *
 * Iterates all clients, matters, and adversaries from the ClientStore and
 * syncs them into the TypeDB conflict graph.
 */

import { logger } from "../logger.js";
import type { ConflictGraph } from "./conflict.js";
import type { ClientStore } from "../clients/index.js";
import type { TimeStore } from "../time/index.js";

export async function syncConflictGraph(
  graph: ConflictGraph,
  clientStore: ClientStore,
  timeStore: TimeStore,
): Promise<void> {
  if (!graph.isEnabled()) {
    logger.debug("syncConflictGraph: TypeDB disabled, skipping");
    return;
  }
  logger.info("syncConflictGraph: starting full resync");
  try {
    await graph.sync(clientStore, timeStore);
    logger.info("syncConflictGraph: complete");
  } catch (err) {
    logger.error("syncConflictGraph: failed", { err: (err as Error).message });
  }
}
