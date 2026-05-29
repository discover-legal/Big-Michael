# Big Michael

Multi-agent legal AI orchestration platform. Runs DyTopo rounds of granular
epistemic/conceptual/writing agents over a Qdrant vector registry, with a
debate + verification protocol on every finding before final synthesis.

## Quick start

```bash
# 1. Start infrastructure
docker compose up -d          # Qdrant (vector DB) + DocuSeal (e-signature)

# 2. Configure secrets
cp .env.example .env
# Edit .env — at minimum set ANTHROPIC_API_KEY
# Optional: TAVILY_API_KEY (web search), DOCUSEAL_API_KEY (e-signature)
# Optional: INFISICAL_* vars to load all secrets from Infisical instead

# 3. Install deps
npm install
pip install -r requirements.txt   # PyMuPDF, Camelot, Tesseract

# 4. Verify everything works
npm run smoke-test

# 5. Start server (MCP stdio + REST API)
npm start               # production (requires npm run build first)
npm run dev             # dev mode with tsx watch
```

REST API at `http://localhost:3101`.
MCP server on stdio (activated when stdin is not a TTY — i.e. from Claude Code).

## Using from Claude Code

`.mcp.json` at the project root registers Big Michael as an MCP server.
When Claude Code opens this directory, it can call all 13 tools directly:

```
submit_task          — start a multi-agent legal task
get_task             — poll status + findings
list_tasks           — list all tasks
approve_gate / reject_gate  — human review of flagged findings
submit_from_template — run a pre-built workflow (eu-competition-brief etc.)
list_templates       — see available workflow templates
get_round            — inspect a specific DyTopo round
ingest_document      — add a document to the knowledge store
search_knowledge     — semantic search across documents
list_agents          — browse the agent registry
query_memory         — query inter-round memory
get_audit            — retrieve the structured audit log
```

Claude Code actuates Laverne agent configs (from `agents/laverne/*.json`) and
MikeOSS-derived workflow templates (from `src/templates/*.json`) by routing
tasks through Big Michael's DyTopo orchestration engine.

### Example Claude Code session

```
Use big-michael to research whether our planned acquisition of Acme GmbH
triggers a mandatory notification under EU Merger Regulation 139/2004.
Run a full_bench workflow.
```

Claude Code will call `submit_task`, poll `get_task`, approve any human
gates via `approve_gate`, and surface the final synthesis.

## Architecture

```
T0  Root Orchestrator (1)
    ↓ issues RoundGoals each phase
T1  Domain Managers (4)       — research / analysis / drafting / review
    ↓ DyTopo: Need/Offer matching → directed comm graph
T2  Epistemic agents (18)     — reason within a specific EU law framework
T2  Conceptual agents (8)     — own a specific legal concept (dominance, SIEC…)
T2  Writing agents (13)       — produce a specific document type
    ↓ tool_use agentic loop
T3  Tool agents (7)           — web_search, doc retrieval, extraction,
                                translation, citation check, signing (DocuSeal)
```

Each DyTopo round:
1. Every agent generates a Need/Offer descriptor (Haiku, ~10 tokens)
2. Engine cosine-matches Needs → Offers to build a directed comm graph
3. Matched agents receive routed messages from their Need partners
4. Agents process context + run their tool_use loops → produce Findings
5. Findings pass through CitationGate → Debate (Opus) → Verification (Haiku ×10)
6. Low-confidence or challenged Findings go to human gate before final output

## Key files

| Path | What it does |
|---|---|
| `src/index.ts` | Entry point — loads dotenv → Infisical → starts server |
| `src/config.ts` | All configuration, read from environment |
| `src/orchestrator.ts` | Task lifecycle, phase sequencing, synthesis |
| `src/dytopo/engine.ts` | Need/Offer matching, comm graph, round execution |
| `src/agents/definitions.ts` | All 47 agent definitions |
| `src/agents/base.ts` | Agent class — agentic loop, tool dispatch |
| `src/protocols/index.ts` | CitationGate, DebateProtocol, VerificationPipeline |
| `src/routing/model.ts` | Haiku/Sonnet/Opus/Ollama/Local routing by tier+task |
| `src/providers/` | Anthropic + Ollama/LM-Studio provider abstraction |
| `src/tools/index.ts` | All tool implementations + ToolRegistry |
| `src/tools/pdf.ts` | PyMuPDF/Camelot/Tesseract tools (via python subprocess) |
| `src/tools/docuseal.ts` | DocuSeal e-signature tools |
| `src/audit/index.ts` | Append-only JSONL audit log + SSE stream |
| `src/secrets/index.ts` | Infisical REST API loader |
| `src/mcp/server.ts` | MCP stdio server + Fastify REST API |
| `src/templates/*.json` | Task templates (eu-competition-brief etc.) |
| `scripts/pdf_tools.py` | Python PDF backend — called by tools/pdf.ts |
| `docker-compose.yml` | Qdrant + DocuSeal for local dev |

## Model routing

| Condition | Model |
|---|---|
| T0 root orchestrator | Opus |
| debate / synthesis / high complexity | Opus |
| T1 managers, T2 specialists, drafting | Sonnet |
| T3 tool agents, descriptors, extraction | Haiku |
| `OLLAMA_TIERS=3` + `OLLAMA_ENABLED=true` | T3 → local Ollama |
| `LOCAL_INFERENCE_TIERS=all` | Everything → LM Studio / vLLM / Jan |

## Adding a new agent

1. Add an `AgentDefinition` object to `src/agents/definitions.ts`
2. Add it to the `ALL_AGENT_DEFINITIONS` export
3. Set `tier` (0–3), `type`, `domain`, `systemPrompt`, `allowedTools`, `skills`
4. Run `npm run smoke-test` — the `Total agents >= 40` and `No duplicate IDs` checks will catch issues

## Adding a task template

1. Create `src/templates/<id>.json` with:
   ```json
   {
     "id": "my-template",
     "name": "Human-readable name",
     "description": "What this workflow does",
     "workflowType": "roundtable",
     "promptTemplate": "Analyse {{company}} for {{issue}} under EU law.",
     "substitutions": { "company": "...", "issue": "..." }
   }
   ```
2. TemplateStore auto-loads all `*.json` files from `src/templates/` on startup

## Adding Laverne agents

Place Laverne agent config JSON files in `agents/laverne/`.
They are loaded automatically via `LaverneAdapter` on startup and registered in the Qdrant agent registry.

## Local inference (LM Studio / Jan / Ollama)

```bash
# LM Studio — all tiers local
LOCAL_INFERENCE_URL=http://localhost:1234/v1
LOCAL_INFERENCE_MODEL=llama-3.2-3b-instruct
LOCAL_INFERENCE_TIERS=all

# Ollama — T3 tool agents only
OLLAMA_ENABLED=true
OLLAMA_MODEL=llama3.2
OLLAMA_TIERS=3
```

## Secrets (Infisical)

Only these vars need to be in `.env`; everything else lives in Infisical:

```bash
INFISICAL_CLIENT_ID=...
INFISICAL_CLIENT_SECRET=...
INFISICAL_PROJECT_ID=...
```

Self-host: `docker compose -f docker-compose.prod.yml up -d` from the Infisical repo.

## REST API endpoints

```
POST   /tasks                       submit task
GET    /tasks                       list tasks
GET    /tasks/:id                   get task
GET    /tasks/:id/stream            SSE live progress
POST   /tasks/from-template         submit from template
GET    /tasks/:taskId/rounds/:round get round state
POST   /tasks/:taskId/gates/:gateId/approve
POST   /tasks/:taskId/gates/:gateId/reject
POST   /documents                   ingest document
GET    /documents/search            semantic search
GET    /agents                      list agents
GET    /templates                   list templates
GET    /audit                       query audit log (?taskId=&limit=)
GET    /audit/stream                SSE live audit stream
GET    /health                      health check
```

## Known limitations

- **Qdrant required**: all three stores (agent registry, memory, knowledge) require
  Qdrant to be running. `docker compose up -d` before starting Big Michael.
- **Python required**: PDF tools require Python 3.11+ and the packages in
  `requirements.txt`. Install with `pip install -r requirements.txt`.
- **Tesseract required** for OCR: `apt install tesseract-ocr` or `brew install tesseract`.
