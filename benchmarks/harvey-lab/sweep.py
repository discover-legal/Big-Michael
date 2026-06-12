#!/usr/bin/env python3
"""Run *every* Harvey LAB task through BigLaw, sequentially and resumably.

The LAB backend owns a single-writer vector DB, so tasks must run one at a time
through one backend — this is that loop. It enumerates the dataset, skips any
task that already has a completed run for the chosen --model-dir, and invokes
run.py once per remaining task in a fresh subprocess (so one task's failure can
never abort the sweep). Progress, per-task duration and cost are appended to a
JSONL log, making the whole sweep safe to Ctrl-C and restart.

    python sweep.py --labs-dir ~/harvey-labs --api http://localhost:3199 \
        --model-dir biglaw-gpt

Re-running the same command resumes: completed tasks are skipped instantly.
Filter the set with --area <prefix> (e.g. corporate-ma) or --limit N. Any extra
arguments after a literal `--` are passed straight through to run.py
(e.g. -- --gate-policy reject --split-mode per-task).

When the run phase is done, score with Harvey's eval (from the harvey-labs
checkout, needs uv + ANTHROPIC_API_KEY for the judge) and compare:

    python sweep.py ... --phase eval        # run_eval over every completed run
    python compare.py --labs-dir ~/harvey-labs
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def all_tasks(labs_dir: Path) -> list[str]:
    """Every task id (path relative to tasks/) that has a task.json, sorted."""
    tasks_root = labs_dir / "tasks"
    if not tasks_root.is_dir():
        sys.exit(f"error: {tasks_root} not found — check --labs-dir")
    return sorted(
        str(tj.parent.relative_to(tasks_root)).replace("\\", "/")
        for tj in tasks_root.rglob("task.json")
    )


def task_meta(labs_dir: Path, task: str) -> dict:
    """Difficulty signals for a task: criteria count (the dominant driver of
    all-pass difficulty, since every criterion must pass), deliverable count,
    work_type, and instruction length as a final tiebreak."""
    try:
        cfg = json.loads((labs_dir / "tasks" / task / "task.json").read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"criteria": 0, "deliverables": 0, "work_type": "?", "ilen": 0}
    return {
        "criteria": len(cfg.get("criteria") or []),
        "deliverables": len(cfg.get("deliverables") or []),
        "work_type": str(cfg.get("work_type", "?")),
        "ilen": len(str(cfg.get("instructions", ""))),
    }


def difficulty_key(meta: dict) -> tuple:
    """Higher tuple == harder to all-pass."""
    return (meta["criteria"], meta["deliverables"], meta["ilen"])


def order_tasks(tasks: list[str], meta: dict[str, dict], order: str) -> list[str]:
    """Reorder tasks for execution. 'extremes' interleaves hardest, easiest,
    next-hardest, next-easiest, ... so the score ceiling and floor are bounded
    early before the median bulk is spent on."""
    if order == "file":
        return tasks
    if order == "area":
        return sorted(tasks)
    by_hard = sorted(tasks, key=lambda t: difficulty_key(meta[t]), reverse=True)
    if order == "hardest":
        return by_hard
    if order == "easiest":
        return list(reversed(by_hard))
    # extremes: pull from both ends of the hardest->easiest list toward the middle.
    out, lo, hi = [], 0, len(by_hard) - 1
    while lo <= hi:
        out.append(by_hard[lo])
        if lo != hi:
            out.append(by_hard[hi])
        lo += 1
        hi -= 1
    return out


def completed_run(results_root: Path, task: str, model_dir: str) -> Path | None:
    """Return a completed run dir for (task, model_dir), or None.

    A run counts as done only when its metrics.json exists and is marked
    completed — a crashed run leaves an output/ dir but no such metrics, so it
    is correctly re-attempted on resume.
    """
    base = results_root / task / model_dir
    if not base.is_dir():
        return None
    for run in sorted(base.iterdir(), reverse=True):
        metrics = run / "metrics.json"
        if not metrics.is_file():
            continue
        try:
            if json.loads(metrics.read_text(encoding="utf-8")).get("completed") is True:
                return run
        except (json.JSONDecodeError, OSError):
            continue
    return None


def backend_alive(api: str) -> bool:
    try:
        with urllib.request.urlopen(api.rstrip("/") + "/health", timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def wait_for_backend(api: str, emit, max_down_s: float = 600.0) -> bool:
    """Block until the backend answers /health, or give up after max_down_s.

    Returns True if healthy, False if it stayed down past the deadline — the
    caller aborts the sweep rather than fast-failing every remaining task
    against a dead backend (which is how a single crash burned the queue).
    """
    if backend_alive(api):
        return True
    print(f"      backend {api} unreachable — pausing (will wait up to "
          f"{int(max_down_s)}s for it to come back)", flush=True)
    emit({"event": "backend_down", "api": api})
    waited = 0.0
    while waited < max_down_s:
        time.sleep(10)
        waited += 10
        if backend_alive(api):
            print(f"      backend back after {int(waited)}s — resuming", flush=True)
            emit({"event": "backend_up", "down_s": int(waited)})
            return True
    return False


def run_cost_usd(run_dir: Path) -> float:
    try:
        m = json.loads((run_dir / "metrics.json").read_text(encoding="utf-8"))
        return float(m.get("biglaw", {}).get("cost_usd", 0.0))
    except (json.JSONDecodeError, OSError, ValueError):
        return 0.0


def run_phase(args: argparse.Namespace, tasks: list[str], results_root: Path,
              progress: Path, passthrough: list[str]) -> None:
    total = len(tasks)
    done = skipped = failed = 0
    cost = 0.0
    sweep_started = time.monotonic()

    def emit(rec: dict) -> None:
        rec = {"ts": now(), **rec}
        with progress.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    meta = getattr(args, "_meta", {})
    emit({"event": "sweep_start", "total": total, "model_dir": args.model_dir,
          "api": args.api, "order": args.order, "gate_passthrough": passthrough})
    print(f"==> sweep: {total} tasks -> {args.model_dir} via {args.api} "
          f"(order={args.order})", flush=True)

    for idx, task in enumerate(tasks, 1):
        existing = completed_run(results_root, task, args.model_dir)
        if existing and not args.force:
            skipped += 1
            c = run_cost_usd(existing)
            cost += c
            print(f"[{idx}/{total}] SKIP  {task}  (done, ${c:.2f})", flush=True)
            emit({"event": "skip", "idx": idx, "task": task, "cost_usd": c})
            continue

        # Gate on backend health so a crash/restart pauses the sweep instead of
        # fast-failing the whole remaining queue against a dead backend.
        if not wait_for_backend(args.api, emit):
            print(f"==> ABORT: backend {args.api} down >10min at task {idx}/{total}. "
                  f"Fix it and re-run to resume (completed tasks are skipped).", flush=True)
            emit({"event": "sweep_abort", "idx": idx, "reason": "backend_down"})
            return

        crit = meta.get(task, {}).get("criteria", 0)
        print(f"[{idx}/{total}] RUN   {task}  ({crit} criteria) ...", flush=True)
        emit({"event": "run_start", "idx": idx, "task": task, "criteria": crit})
        t0 = time.monotonic()
        cmd = [sys.executable, "run.py", "--labs-dir", str(args.labs_dir),
               "--api", args.api, "--task", task, "--model-dir", args.model_dir,
               *passthrough]
        proc = subprocess.run(cmd, cwd=BENCH_DIR)
        dt = time.monotonic() - t0

        run_dir = completed_run(results_root, task, args.model_dir)
        if proc.returncode == 0 and run_dir is not None:
            done += 1
            c = run_cost_usd(run_dir)
            cost += c
            print(f"[{idx}/{total}] OK    {task}  {dt:.0f}s  ${c:.2f}  "
                  f"(cum ${cost:.2f})", flush=True)
            emit({"event": "ok", "idx": idx, "task": task, "criteria": crit,
                  "duration_s": round(dt, 1), "cost_usd": c, "cum_cost_usd": round(cost, 2)})
        else:
            failed += 1
            print(f"[{idx}/{total}] FAIL  {task}  {dt:.0f}s  rc={proc.returncode} "
                  f"(continuing)", flush=True)
            emit({"event": "fail", "idx": idx, "task": task,
                  "duration_s": round(dt, 1), "returncode": proc.returncode})

    wall = time.monotonic() - sweep_started
    print(f"\n==> sweep done: {done} ok, {skipped} skipped, {failed} failed / {total} "
          f"in {wall/3600:.1f}h, ~${cost:.2f}", flush=True)
    emit({"event": "sweep_end", "ok": done, "skipped": skipped, "failed": failed,
          "total": total, "wall_h": round(wall / 3600, 2), "cost_usd": round(cost, 2)})


def eval_phase(args: argparse.Namespace, tasks: list[str], results_root: Path,
               progress: Path) -> None:
    """Score every completed run with Harvey's unchanged eval, via uv."""
    pending = [(t, completed_run(results_root, t, args.model_dir)) for t in tasks]
    pending = [(t, r) for t, r in pending if r is not None]
    total = len(pending)
    print(f"==> eval: scoring {total} completed runs (Harvey judge, needs uv + "
          f"ANTHROPIC_API_KEY)", flush=True)
    ok = failed = 0
    for idx, (task, run_dir) in enumerate(pending, 1):
        if (run_dir / "scores.json").is_file() and not args.force:
            print(f"[{idx}/{total}] SKIP  {task} (scored)", flush=True)
            continue
        run_id = f"{task}/{args.model_dir}/{run_dir.name}"
        cmd = ["uv", "run", "python", "-m", "evaluation.run_eval",
               "--run-id", run_id, "--task", task]
        print(f"[{idx}/{total}] EVAL  {task} ...", flush=True)
        proc = subprocess.run(cmd, cwd=args.labs_dir)
        if proc.returncode == 0:
            ok += 1
        else:
            failed += 1
            print(f"[{idx}/{total}] EVAL-FAIL {task} rc={proc.returncode}", flush=True)
        with progress.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": now(), "event": "eval", "task": task,
                                "returncode": proc.returncode}) + "\n")
    print(f"\n==> eval done: {ok} ok, {failed} failed / {total}", flush=True)
    print("now compare:  python compare.py --labs-dir", args.labs_dir, flush=True)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description="Run/score every Harvey LAB task through BigLaw.")
    p.add_argument("--labs-dir", required=True)
    p.add_argument("--api", default="http://localhost:3199")
    p.add_argument("--model-dir", default="biglaw-gpt")
    p.add_argument("--results-dir", help="results root (default <labs-dir>/results)")
    p.add_argument("--area", help="only tasks whose id starts with this prefix")
    p.add_argument("--work-type", choices=["analyze", "draft", "review", "research"],
                   help="only tasks of this LAB work_type")
    p.add_argument("--order", choices=["extremes", "hardest", "easiest", "area", "file"],
                   default="extremes",
                   help="execution order by difficulty (criteria count). 'extremes' "
                        "(default) alternates hardest/easiest inward to bound the score "
                        "range early; 'file' keeps dataset order")
    p.add_argument("--limit", type=int, help="cap the number of tasks (after ordering)")
    p.add_argument("--phase", choices=["run", "eval", "both"], default="run")
    p.add_argument("--force", action="store_true", help="re-run/re-score even if complete")
    p.add_argument("--progress", help="progress JSONL (default sweep-<model-dir>.jsonl here)")
    # Everything after `--` goes to run.py verbatim.
    p.add_argument("passthrough", nargs="*", help="args for run.py after --")
    args = p.parse_args(argv)

    args.labs_dir = Path(args.labs_dir).expanduser().resolve()
    results_root = (Path(args.results_dir).expanduser().resolve()
                    if args.results_dir else args.labs_dir / "results")
    progress = Path(args.progress) if args.progress else BENCH_DIR / f"sweep-{args.model_dir}.jsonl"

    tasks = all_tasks(args.labs_dir)
    if args.area:
        tasks = [t for t in tasks if t.startswith(args.area)]
    meta = {t: task_meta(args.labs_dir, t) for t in tasks}
    if args.work_type:
        tasks = [t for t in tasks if meta[t]["work_type"] == args.work_type]
    tasks = order_tasks(tasks, meta, args.order)
    if args.limit:
        tasks = tasks[:args.limit]
    if not tasks:
        sys.exit("error: no tasks matched")
    args._meta = meta

    passthrough = list(args.passthrough)
    if passthrough and passthrough[0] == "--":
        passthrough = passthrough[1:]

    if args.phase in ("run", "both"):
        run_phase(args, tasks, results_root, progress, passthrough)
    if args.phase in ("eval", "both"):
        eval_phase(args, tasks, results_root, progress)


if __name__ == "__main__":
    main()
