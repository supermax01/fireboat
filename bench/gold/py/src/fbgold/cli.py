"""fbgold: compute the Python gold for one dataset's questions from the converted files only."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import Counter
from typing import Any

from .result import to_record
from .store import Store
from .datasets import DATASETS
from .templates import compute
from .values import dumps, loads

# The repository root: this file is bench/gold/py/src/fbgold/cli.py inside it.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))))


def results_root() -> str:
    """Where the harness keeps its results, as in bench/lib/paths.ts.

    BENCH_RESULTS_DIR overrides it; otherwise it is <BENCH_LOCAL_DIR>/bench-results, and BENCH_LOCAL_DIR defaults to
    <repo>/.local (git-ignored). Relative values are resolved against the repository root.
    """
    explicit = os.environ.get("BENCH_RESULTS_DIR")
    if explicit:
        return os.path.join(REPO, explicit)
    local = os.path.join(REPO, os.environ.get("BENCH_LOCAL_DIR") or ".local")
    return os.path.join(local, "bench-results")


def default_out(dataset: str) -> str:
    return os.path.join(results_root(), "gold-py", dataset, "gold.py.jsonl")


def read_questions(path: str) -> list[dict[str, Any]]:
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                q = loads(line)
                q.pop("operations", None)  # the first implementation's plan: never used here
                out.append(q)
    return out


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(dataset: str, questions_path: str, converted_dir: str, out_path: str,
        allow_overwrite: bool = False, skip_templates: frozenset[str] = frozenset()) -> dict[str, Any]:
    questions = read_questions(questions_path)
    skipped = Counter(q["template_id"] for q in questions if q["template_id"] in skip_templates)
    questions = [q for q in questions if q["template_id"] not in skip_templates]
    for q in questions:
        if q.get("dataset") != dataset:
            raise SystemExit(f"question {q.get('id')} belongs to {q.get('dataset')}, not {dataset}")
    store = Store(converted_dir, {q["patient_id"] for q in questions})
    records = []
    for q in questions:
        records.append(to_record(q, compute(q, store)))
    if os.path.exists(out_path) and not allow_overwrite:
        raise SystemExit(f"{out_path} exists; pass --force to replace it")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        for r in records:
            fh.write(dumps(r) + "\n")
    os.replace(tmp, out_path)
    kinds = Counter(r["answer_kind"] or "unanswerable" for r in records)
    summary = {
        "schema": "fbbench.gold-py-manifest/1",
        "dataset": dataset,
        "questions": len(records),
        "skipped": sum(skipped.values()),
        "skipped_by_template": dict(sorted(skipped.items())),
        "answered": len(records) - kinds.get("unanswerable", 0),
        "unanswerable": kinds.get("unanswerable", 0),
        "answer_kinds": dict(sorted(kinds.items())),
        "questions_by_template": dict(sorted(Counter(q["template_id"] for q in questions).items())),
        "answered_by_template": dict(sorted(Counter(
            q["template_id"] for q, r in zip(questions, records) if r["answer_kind"] is not None).items())),
        "unanswerable_by_template": dict(sorted(Counter(
            q["template_id"] for q, r in zip(questions, records) if r["answer_kind"] is None).items())),
        "inputs": {"questions": {"path": questions_path, "sha256": sha256(questions_path)}},
        "output": {"path": out_path, "sha256": sha256(out_path)},
        "python": sys.version.split()[0],
        "argv": sys.argv[1:],
    }
    return summary


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fbgold", description=__doc__)
    ap.add_argument("--dataset", required=True, choices=DATASETS)
    ap.add_argument("--out", help="output JSONL (default: .local/bench-results/gold-py/<dataset>/gold.py.jsonl)")
    ap.add_argument("--questions", help="questions.jsonl (default: the dataset's question file)")
    ap.add_argument("--converted", help="converted NDJSON directory (default: the dataset's converted files)")
    ap.add_argument("--pool", action="store_true",
                    help="use the dataset's full candidate pool (questions/<dataset>/pool.jsonl) instead")
    ap.add_argument("--force", action="store_true", help="replace an existing output file")
    ap.add_argument("--skip-template", action="append", default=[], metavar="ID",
                    help="leave out questions of this template (repeatable); counted in the summary")
    a = ap.parse_args(argv)
    qfile = "pool.jsonl" if a.pool else "questions.jsonl"
    questions = a.questions or os.path.join(results_root(), "questions", a.dataset, qfile)
    if a.pool and not a.out:
        raise SystemExit("--pool needs an explicit --out")
    converted = a.converted or os.path.join(results_root(), "converted", a.dataset)
    out = a.out or default_out(a.dataset)
    summary = run(a.dataset, questions, converted, out, a.force, frozenset(a.skip_template))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
