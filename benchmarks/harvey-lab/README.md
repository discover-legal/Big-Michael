# Harvey LAB driver

Runs BigLaw against [Harvey's Legal Agent Benchmark (LAB)](https://github.com/harveyai/harvey-labs)
— 1,251 long-horizon legal tasks across 24 practice areas, graded by expert-written rubrics.

LAB splits into a **run phase** (an agent produces deliverable files) and an **eval phase**
(a Claude judge grades those files against the task rubric). LAB's own `ModelAdapter` plug-in
point is built for raw chat models, where its harness owns the agentic loop and tools.
BigLaw already *is* the loop, so this driver replaces the run phase instead: it drives the
BigLaw REST API end-to-end and writes results in the exact layout LAB's eval phase reads.
Scoring stays 100% Harvey's code.

```
LAB task.json + documents/          this driver               harvey-labs eval (unchanged)
─────────────────────────  ──────────────────────────────  ───────────────────────────────
instructions, rubric,  →   convert docs → ingest →         evaluation.run_eval reads
.docx/.pdf/.xlsx inputs    submit_task → auto-approve      results/<run-id>/output/ +
                           gates → synthesis → render      metrics.json, writes scores.json
                           real .docx/.xlsx/.pdf into
                           results/<run-id>/output/
```

## Prerequisites

- A [harvey-labs](https://github.com/harveyai/harvey-labs) checkout (the task dataset + eval
  harness; eval needs `uv` and an `ANTHROPIC_API_KEY` for the judge).
- A running BigLaw backend: `bash setup.sh` (Docker, `:3102`) or
  `go run ./biglaw-go/cmd/biglaw` (native, `:3101`) from the repo root, with its own
  `ANTHROPIC_API_KEY` configured.
- Python 3.11+ with this driver's dependencies:

```bash
cd benchmarks/harvey-lab
pip install -r requirements.txt        # requests, python-docx, openpyxl, python-pptx, PyMuPDF
```

`pandoc` on PATH is an optional fallback renderer/converter for formats the Python
libraries don't cover.

## Usage

```bash
# Browse the dataset
python run.py --labs-dir ~/harvey-labs --list

# Run one task through BigLaw (native backend on :3101 by default)
python run.py --labs-dir ~/harvey-labs \
  --task corporate-ma/review-data-room-red-flag-review

# Docker stack
python run.py --labs-dir ~/harvey-labs --task <task> --api http://localhost:3102

# Score with Harvey's eval phase, unchanged (from the harvey-labs checkout):
uv run python -m evaluation.run_eval --run-id <printed-run-id> --task <task>
uv run python -m evaluation.report --run-id <printed-run-id>
```

The driver prints the exact `run_eval` command when a run finishes. Run IDs follow the
harness convention `{task}/biglaw/{timestamp}` and land in `<labs-dir>/results/` so the
eval and dashboard tooling find them without flags.

## What the driver does

1. **Converts** everything under the task's `documents/` to text client-side — `.pdf`
   (PyMuPDF), `.docx` (python-docx), `.xlsx` (openpyxl), `.pptx` (python-pptx), text
   formats as-is, pandoc for the rest. (The Go backend's `/documents/upload` is
   text-only, so conversion cannot be delegated to it.) Unconvertible files are
   skipped and logged, never fatal.
2. **Ingests** each document via `POST /documents` and **submits** one task via
   `POST /tasks` with the LAB instructions plus the deliverables list, the ingested
   document IDs, and `jurisdiction` (default `US`).
3. **Polls** `GET /tasks/:id`, **auto-approving every human gate** so the run is fully
   autonomous; approvals are counted in the metrics (a measure of how often BigLaw's
   protocols flagged findings on that task).
4. **Renders deliverables** from the final synthesis into the filenames `task.json`
   names: `.docx` via python-docx (headings, lists, pipe tables), `.xlsx` via openpyxl
   (preferring the structured `Task.table` from a tabulate run, else markdown tables
   in the synthesis), `.pdf` via PyMuPDF, everything else as text.
5. **Writes the run dir**: `config.json`, `transcript.jsonl` (driver-level event log),
   `metrics.json` (token counts and cost from `GET /tasks/:id/cost`, duration, document
   counts, plus a `biglaw` block with task ID, gates approved, findings count), and
   `output/` with the deliverables.

## Workflow mapping

| LAB `work_type` | BigLaw workflow |
|---|---|
| `analyze` | `roundtable` |
| `draft` | `roundtable` |
| `review` | `review` |
| `research` | `full_bench` |
| any task with an `.xlsx` deliverable | `tabulate` (its structured table feeds the renderer) |

Override per run with `--workflow`.

## Caveats

- **Comparability.** BigLaw runs with its own multi-agent loop, tools, and knowledge
  store — not LAB's sandboxed six-tool environment or turn caps. Scores measure
  BigLaw's work product under identical judging, but are not strictly apples-to-apples
  with leaderboard agents run inside Harvey's harness. For an internal baseline, run
  Harvey's stock agent on the same tasks (`uv run python -m harness.run --model
  anthropic/claude-sonnet-4-6 --task <task>`) and compare under the same judge.
- **Multi-deliverable tasks** get the full synthesis rendered into *each* named file
  rather than per-file content. Fine for the judge's substance criteria; a per-deliverable
  task split is the natural next refinement if structure criteria suffer.
- **`metrics.json` keys** follow the harness conventions best-effort; eval folds them
  into `scores.json` metadata and does not gate on them.
- **Cost.** Every LAB task is a full DyTopo run with Opus debate + synthesis. Start with
  one practice area, watch `GET /cost/summary`, and budget before attempting all 1,251
  tasks. The backend's single-writer vector DB also means one backend process: run tasks
  sequentially through it rather than in parallel driver processes.
