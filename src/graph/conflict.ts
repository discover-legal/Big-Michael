// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. See <https://www.gnu.org/licenses/>.

/**
 * ConflictGraph — thin facade over TypeDBConflictGraph.
 *
 * Singleton used by the Orchestrator. If TYPEDB_URL is not set, all methods
 * are no-ops and isEnabled() returns false — TypeDB is entirely optional.
 */

import { Config } from "../config.js";
import { logger } from "../logger.js";
import { TypeDBConflictGraph } from "./typedb.js";
import type { ConflictReport } from "../types.js";
import type { ClientStore } from "../clients/index.js";
import type { TimeStore } from "../time/index.js";

export class ConflictGraph {
  private readonly inner = new TypeDBConflictGraph();
  private _connected = false;

  isEnabled(): boolean {
    return Boolean(Config.typedb.url);
  }

  async connect(): Promise<void> {
    if (!this.isEnabled()) {
      logger.info("TypeDB conflict graph disabled (TYPEDB_URL not set)");
      return;
    }
    try {
      await this.inner.connect(Config.typedb.url);
      this._connected = true;
    } catch (err) {
      logger.warn("TypeDB conflict graph unavailable — continuing without it", {
        err: (err as Error).message,
      });
      this._connected = false;
    }
  }

  async close(): Promise<void> {
    if (this._connected) {
      await this.inner.close();
      this._connected = false;
    }
  }

  /**
   * Full resync from the ClientStore and TimeStore.
   * Iterates all clients, their matters, and adversaries and upserts to TypeDB.
   */
  async sync(clients: ClientStore, _time: TimeStore): Promise<void> {
    if (!this._connected) return;
    const allClients = clients.list();
    // Flatten all matters with jurisdiction info (matters live on clients in this model)
    const allMatters = allClients.flatMap((c) =>
      c.matters.map((m) => ({
        matterNumber: m.matterNumber,
        practiceArea: m.practiceArea,
        jurisdiction: undefined as string | undefined,
        status: "active",
      })),
    );
    await this.inner.syncFromClients(
      allClients.map((c) => ({
        id: c.id,
        name: c.name,
        adversaries: c.adversaries,
        matters: c.matters,
      })),
      allMatters,
    );
  }

  /**
   * Return all conflicts touching a specific client.
   */
  async checkClient(clientId: string): Promise<ConflictReport[]> {
    if (!this._connected) return [];
    return this.inner.queryConflicts(clientId);
  }

  /**
   * Simulate adding a new matter for clientId with a set of adversary IDs and
   * return any conflicts that would arise (does NOT write to the graph).
   *
   * Since TypeDB inference is rule-based, we check existing graph state for
   * conflicts between the proposed client and each adversary.
   */
  async checkNewMatter(clientId: string, adversaryIds: string[]): Promise<ConflictReport[]> {
    if (!this._connected) return [];
    const results: ConflictReport[] = [];
    for (const advId of adversaryIds) {
      // Check if any existing client matches this adversary ID
      const conflicts = await this.inner.queryConflicts(advId);
      // Filter to conflicts that involve our clientId on one side and the adversary on the other
      for (const c of conflicts) {
        if (
          (c.clientAId === clientId && c.clientBId === advId) ||
          (c.clientBId === clientId && c.clientAId === advId)
        ) {
          results.push(c);
        }
      }
    }
    return results;
  }
}
