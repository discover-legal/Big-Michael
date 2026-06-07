// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Discover Legal

/**
 * TypeDB conflict-graph sidecar.
 *
 * Exposes the TypeDBConflictGraph over a minimal HTTP API so the Go core
 * binary can call it without a Go TypeDB driver.
 *
 * Port: TYPEDB_SIDECAR_PORT (default 3102)
 * TypeDB address: TYPEDB_URL (required, host:port format e.g. 0.0.0.0:1729)
 *
 * API:
 *   GET  /health                    → { ok, connected }
 *   POST /sync                      → { clients, matters }
 *   GET  /conflicts?clientId=xxx    → ConflictReport[]
 *   POST /check-new-matter          → { clientId, adversaryIds } → ConflictReport[]
 */

import Fastify from "fastify";
import { TypeDBConflictGraph, type ConflictReport } from "./typedb.js";

const port = parseInt(process.env.TYPEDB_SIDECAR_PORT ?? "3102", 10);
const typedbUrl = process.env.TYPEDB_URL ?? "";

if (!typedbUrl) {
  console.error(JSON.stringify({ level: "error", msg: "TYPEDB_URL is required" }));
  process.exit(1);
}

const graph = new TypeDBConflictGraph();
let connected = false;

const app = Fastify({ logger: false });

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", async () => ({ ok: true, connected }));

// ─── Sync ────────────────────────────────────────────────────────────────────

interface SyncBody {
  clients: Array<{
    id: string;
    name: string;
    adversaries: string[];
    matters: Array<{ matterNumber: string; practiceArea?: string }>;
  }>;
  matters: Array<{
    matterNumber: string;
    practiceArea?: string;
    jurisdiction?: string;
    status?: string;
  }>;
}

app.post<{ Body: SyncBody }>("/sync", async (req, reply) => {
  if (!connected) {
    return reply.status(503).send({ error: "TypeDB not connected" });
  }
  try {
    await graph.syncFromClients(req.body.clients, req.body.matters);
    return { ok: true };
  } catch (err) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

// ─── Query conflicts ──────────────────────────────────────────────────────────

app.get<{ Querystring: { clientId?: string } }>("/conflicts", async (req, reply) => {
  if (!connected) {
    return reply.status(503).send({ error: "TypeDB not connected" });
  }
  try {
    const result: ConflictReport[] = await graph.queryConflicts(req.query.clientId);
    return result;
  } catch (err) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

// ─── Check new matter ─────────────────────────────────────────────────────────

interface CheckBody {
  clientId: string;
  adversaryIds: string[];
}

app.post<{ Body: CheckBody }>("/check-new-matter", async (req, reply) => {
  if (!connected) {
    return reply.status(503).send({ error: "TypeDB not connected" });
  }
  try {
    const { clientId, adversaryIds } = req.body;
    const out: ConflictReport[] = [];
    for (const advId of adversaryIds) {
      const conflicts = await graph.queryConflicts(advId);
      for (const c of conflicts) {
        if (
          (c.clientAId === clientId && c.clientBId === advId) ||
          (c.clientBId === clientId && c.clientAId === advId)
        ) {
          out.push(c);
        }
      }
    }
    return out;
  } catch (err) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    await graph.connect(typedbUrl);
    connected = true;
    console.log(JSON.stringify({ level: "info", msg: "TypeDB connected", url: typedbUrl }));
  } catch (err) {
    // Server still starts — Go core gets 503 until TypeDB is reachable
    console.log(JSON.stringify({
      level: "warn",
      msg: "TypeDB connect failed — will retry on next request",
      err: (err as Error).message,
    }));
  }

  await app.listen({ port, host: "127.0.0.1" });
  console.log(JSON.stringify({ level: "info", msg: "TypeDB sidecar listening", port }));
}

process.on("SIGTERM", async () => {
  await graph.close();
  await app.close();
  process.exit(0);
});

start().catch((err) => {
  console.error(JSON.stringify({ level: "fatal", msg: String(err) }));
  process.exit(1);
});
