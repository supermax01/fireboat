#!/usr/bin/env python3
"""S11 offline message tokenization. Reuses S5's hash-locked, network-denying loader.

Exploratory execution produces descriptive tokens only. Reference execution
requires the existing pinned Linux/amd64 Python image with --network none.
No installation, cache replacement, fetch or tokenizer substitution occurs.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("s5_tokenizers", Path(__file__).resolve().parents[1] / "measure-tool-catalog.py")
s5 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s5)


def tokenize(args):
    report = {"schema": "fireboat-s11-tokens/1", "status": "unmeasured",
              "execution": "exploratory" if args.exploratory else "reference offline container",
              "capture_boundary": "scripted full-text evaluation host; each delivered tool message independently; LF between text blocks; no inter-message merge credit",
              "attempts": []}
    lock, encoders = s5.load_tokenizers(args, report)
    if args.preflight:
        report["status"] = "exploratory-ready" if args.exploratory else "reference-ready"
        return report
    ids = set()
    for manifest in sorted(args.captures.rglob("attempts.json")):
        s5.require(not manifest.is_symlink(), "INPUT_INVALID", "Capture symlink")
        capture = s5.parse(manifest.read_text(encoding="utf-8"))
        s5.require(capture["schema"] == "fireboat-s11-capture/1", "INPUT_INVALID", "Unknown capture format")
        for attempt in capture["attempts"]:
            s5.require(attempt["id"] not in ids, "INPUT_INVALID", "Duplicate attempt")
            ids.add(attempt["id"])
            texts = [(s["kind"], s5.verified_file(manifest.parent, s["file"])) for s in attempt["segments"]]
            s5.require(all(k in {"catalog", "request", "model", "wire"} for k, _ in texts), "INPUT_INVALID", "Unknown message boundary")
            s5.require(sum(len(t.encode("utf-8")) for k, t in texts if k == "model") == attempt["model_bytes"], "INPUT_INVALID", "Model byte accounting mismatch")
            s5.require(sum(len(t.encode("utf-8")) for k, t in texts if k == "wire") == attempt["wire_result_bytes"], "INPUT_INVALID", "Wire byte accounting mismatch")
            counts = {}
            for encoding, encoder in encoders.items():
                by_kind = {kind: sum(len(encoder.encode_ordinary(text)) for k, text in texts if k == kind)
                           for kind in ["catalog", "request", "model", "wire"]}
                counts[encoding] = {**by_kind, "combined_task": by_kind["catalog"] + by_kind["request"] + by_kind["model"]}
            report["attempts"].append({"id": attempt["id"], "tokens": counts,
                                       "capture_manifest": s5.file_hash(manifest),
                                       "segments_sha256": s5.sha(s5.compact(attempt["segments"]).encode("utf-8"))})
    s5.require(ids, "INPUT_MISSING", "No attempts captured")
    report["status"] = "exploratory" if args.exploratory else "measured"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ["captures", "lock", "requirements", "cache", "wheelhouse", "out"]:
        parser.add_argument("--" + key, required=True, type=Path)
    parser.add_argument("--exploratory", action="store_true")
    parser.add_argument("--image-reference")
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    for source in [args.captures, args.lock, args.requirements, args.cache, args.wheelhouse]:
        s5.require(not args.out.resolve().is_relative_to(source.resolve()) and not source.resolve().is_relative_to(args.out.resolve()), "OUTPUT_NOT_SEPARATE", "Output overlaps input")
    report = {"schema": "fireboat-s11-tokens/1", "status": "unmeasured"}
    code = 0
    try:
        report = tokenize(args)
    except Exception as error:
        report["error"] = {"code": getattr(error, "code", "MISSING_OR_INVALID_TOOLING")}
        code = 2
    args.out.mkdir(mode=0o700, parents=False, exist_ok=False)
    data = (json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
    path = args.out / "tokens.json"
    path.write_bytes(data)
    path.chmod(0o600)
    print(s5.compact({"status": report["status"], "attempts": len(report.get("attempts", [])), "sha256": s5.sha(data), "error": report.get("error")}))
    return code


if __name__ == "__main__":
    sys.exit(main())
