#!/usr/bin/env python3
"""Offline S5 catalog cap gate (stdlib + hash-locked tiktoken 0.12.0).

Catalog serialization is the frozen guidance §5 boundary, not host rendering.
Wire discovery/SDK metadata and JSON-RPC/LF framing are retained and measured
separately. Complete strings AND conservative original segment sums must pass.
No network API is used. Cache validation precedes importing any tokenizer code;
the loader is replaced with an exact verified-file reader as a second safeguard.
CI additionally enforces --network none and read-only input/cache mounts.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import socket
import sys

BYTE_CAPS = {"fhir_capabilities": 2200, "fhir_search": 1750, "fhir_read": 1400,
             "fhir_page": 1100, "fhir_result": 1650}
TOKEN_CAPS = dict(zip(BYTE_CAPS, [650, 500, 400, 325, 475]))
ENCODINGS = {"cl100k_base", "o200k_base"}
MINIMAL_SCHEMA = {"type": "object", "required": ["schema_version"],
                  "properties": {"schema_version": {"type": "string"}}}


class GateError(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code


def require(condition, code, detail):
    if not condition:
        raise GateError(code, detail)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "INPUT_INVALID", "Duplicate JSON key")
        result[key] = value
    return result


def parse(text):
    return json.loads(text, object_pairs_hook=no_duplicates,
                      parse_constant=lambda _: (_ for _ in ()).throw(GateError("INPUT_INVALID", "Non-JSON number")))


def file_hash(path):
    data = path.read_bytes()
    return {"path": str(path), "bytes": len(data), "sha256": sha(data)}


def verified_file(base, spec):
    path = (base / spec["path"]).resolve()
    require(path.is_relative_to(base.resolve()) and path.is_file(), "INPUT_MISSING", spec["path"])
    data = path.read_bytes()
    require(len(data) == spec["bytes"] and sha(data) == spec["sha256"], "INPUT_HASH_MISMATCH", spec["path"])
    return data.decode("utf-8", errors="strict")


def load_tokenizers(args, report):
    lock = parse(args.lock.read_text(encoding="utf-8"))
    require(lock["format"] == "fireboat-tokenizers/1", "LOCK_INVALID", "Unknown lock format")
    report["lock"] = file_hash(args.lock)
    report["requirements"] = file_hash(args.requirements)
    require(report["requirements"]["sha256"] == lock["requirements"]["sha256"], "REQUIREMENTS_HASH_MISMATCH", "Requirements differ from lock")
    require(lock["tiktoken_version"] == "0.12.0", "LOCK_INVALID", "tiktoken version must be 0.12.0")
    require({e["name"] for e in lock["encodings"]} == ENCODINGS and len(lock["encodings"]) == 2,
            "LOCK_INVALID", "Both exact encoding identities required")
    verified_cache = {}
    report["encodings"] = []
    # Check ALL caches first. Missing/corrupt entries must never invoke a fetch,
    # even if a prior tiktoken process has populated an in-memory encoding.
    for entry in lock["encodings"]:
        require(entry["cache_filename"] == hashlib.sha1(entry["source_url"].encode("utf-8")).hexdigest(),
                "LOCK_INVALID", "Encoding cache identity does not match URL")
        require(entry["tiktoken_version"] == "0.12.0", "LOCK_INVALID", "Encoding version differs")
        path = args.cache / entry["cache_filename"]
        require(path.is_file() and not path.is_symlink(), "CACHE_MISSING", entry["name"])
        data = path.read_bytes()
        require(sha(data) == entry["sha256"] and len(data) == entry["bytes"], "CACHE_HASH_MISMATCH", entry["name"])
        verified_cache[entry["source_url"]] = data
        report["encodings"].append({**entry, "verified": True})

    require(re.fullmatch(r"python:\d+\.\d+\.\d+-slim@sha256:[0-9a-f]{64}", lock["python"]["image"]),
            "LOCK_INVALID", "Unpinned image")
    report["image"] = lock["python"]
    report["interpreter"] = {"version": platform.python_version(), "full_version": sys.version,
                             "implementation": platform.python_implementation(), "platform": sys.platform,
                             "machine": platform.machine(), "executable": file_hash(Path(sys.executable).resolve())}
    if not args.exploratory:
        require(args.image_reference == lock["python"]["image"], "IMAGE_MISMATCH", "Missing or different image reference")
        require(platform.python_version() == lock["python"]["version"] and sys.platform == "linux"
                and platform.machine() == "x86_64" and platform.python_implementation() == "CPython",
                "INTERPRETER_MISMATCH", "Requires pinned Linux amd64 CPython patch")
        # Docker --network none leaves only loopback; fail if orchestration
        # accidentally gave the reference measurement another interface.
        interfaces = {line.split(":", 1)[0].strip() for line in Path("/proc/net/dev").read_text().splitlines() if ":" in line}
        require(interfaces == {"lo"}, "NETWORK_NOT_ISOLATED", "Expected loopback-only network namespace")
        report["network_interfaces"] = sorted(interfaces)
    wheel_names = {w["filename"] for w in lock["wheels"]}
    require({p.name for p in args.wheelhouse.iterdir()} == wheel_names, "WHEELHOUSE_INVALID", "Wheelhouse must contain exactly the locked wheels")
    report["wheels"] = []
    for wheel in lock["wheels"]:
        info = file_hash(args.wheelhouse / wheel["filename"])
        require(info["sha256"] == wheel["sha256"], "WHEEL_HASH_MISMATCH", wheel["filename"])
        require(importlib.metadata.version(wheel["name"]) == wheel["version"], "DEPENDENCY_MISMATCH", wheel["name"])
        report["wheels"].append({**wheel, "verified": True, "installed_version": importlib.metadata.version(wheel["name"])})

    def deny_network(*_args, **_kwargs):
        raise GateError("NETWORK_ATTEMPT", "Tokenizer attempted network access")

    socket.socket = deny_network
    socket.create_connection = deny_network
    os.environ["TIKTOKEN_CACHE_DIR"] = str(args.cache.resolve())
    import tiktoken
    import tiktoken.load

    def exact_cache_read(url, expected_hash=None):
        require(url in verified_cache, "ENCODING_UNMEASURED", "Unpinned encoding URL")
        data = verified_cache[url]
        require(expected_hash == sha(data), "ENCODING_HASH_MISMATCH", "Tokenizer's upstream identity differs from lock")
        return data

    # Prevent tiktoken's normal fetch/delete/replacement cache path altogether.
    tiktoken.load.read_file_cached = exact_cache_read
    encoders = {name: tiktoken.get_encoding(name) for name in sorted(ENCODINGS)}
    report["tokenizer"] = {"version": importlib.metadata.version("tiktoken"), "api": "encode_ordinary",
                           "module": file_hash(Path(tiktoken.__file__)), "network_api": "denied",
                           "serialization": lock["tokenization"]}
    return lock, encoders


def run(args, report):
    lock, encoders = load_tokenizers(args, report)
    count = lambda text, encoding: len(encoders[encoding].encode_ordinary(text))
    manifest = parse((args.catalog / "manifest.json").read_text(encoding="utf-8"))
    require(manifest["format"] == "fireboat-tool-catalog/1", "INPUT_INVALID", "Unknown capture format")
    require(manifest["runtime"]["node"] == "v24.22.0" and manifest["runtime"]["sdk"] == {"client": "2.3.1", "server": "2.3.1"},
            "INPUT_INVALID", "Unpinned capture runtime/SDK")
    require(manifest["upstream_attempts"] == 0, "INPUT_INVALID", "Catalog performed upstream work")
    require(all(re.fullmatch(r"[0-9a-f]{40}", manifest["candidate"][k]) for k in ["commit", "tree"]),
            "INPUT_INVALID", "Missing candidate revision/tree")
    report["candidate"] = manifest["candidate"]
    report["capture_manifest"] = file_hash(args.catalog / "manifest.json")
    report["boundaries"] = {"catalog": manifest["boundary"], "protocol": manifest["protocol_boundary"],
                            "conservative": "max(sum(original prefix/tool/comma/suffix tokens), sum(tool tokens) + empty-tools context tokens + separate comma tokens)"}
    report["profiles"] = manifest["profiles"]
    # Bind the captured tree's lock/requirements and measurement code to inputs
    # mounted for this run; stale captures cannot silently use new gate code.
    recorded_sources = {s["path"]: s["sha256"] for s in manifest["source_inputs"]}
    for name, path in [("scripts/requirements-tokenizers.txt", args.requirements),
                       ("packages/evals/data/tokenizers.lock.json", args.lock),
                       ("scripts/measure-tool-catalog.py", Path(__file__))]:
        require(recorded_sources.get(name) == sha(path.read_bytes()), "CAPTURE_INPUT_MISMATCH", name)
    require(manifest["compiled_inputs"], "INPUT_MISSING", "No compiled production inputs")
    report["input_files"] = [file_hash(p) | {"path": str(p.relative_to(args.catalog))}
                             for p in sorted(args.catalog.rglob("*")) if p.is_file()]
    captures = manifest["captures"]
    require(len({c["id"] for c in captures}) == len(captures), "INPUT_INVALID", "Duplicate capture ID")
    expected = {(era, "full-text-v1", None) for era in ["modern", "legacy"]}
    for entry in manifest["profiles"]["registry"]:
        if entry["verification"] == "verified" and entry["delivery_profile"] == "structured-evidence-v1":
            expected.add((entry["era"], entry["delivery_profile"], entry["id"]))
    require({(c["era"], c["profile"], c.get("host_profile_id")) for c in captures} == expected and len(captures) == len(expected),
            "PROFILE_UNMEASURED", "Incomplete eras/advertised selectable profiles")
    spine = verified_file(args.catalog, manifest["spine"])
    parse(spine)
    checks = report["checks"] = []

    def check(capture, encoding, metric, value, cap, exact=False):
        checks.append({"capture": capture, "encoding": encoding, "metric": metric, "value": value,
                       "cap": cap, "comparison": "==" if exact else "<=", "pass": value == cap if exact else value <= cap})

    check("all", None, "spine_bytes", len(spine.encode("utf-8")), 2000)
    report["measurements"] = []
    for capture in captures:
        cid, era = capture["id"], capture["era"]
        require(capture["protocol_version"] == {"modern": "2026-07-28", "legacy": "2025-11-25"}[era], "INPUT_INVALID", "Wrong negotiated version")
        complete = verified_file(args.catalog, capture["complete"])
        context = verified_file(args.catalog, capture["context"])
        instructions = verified_file(args.catalog, capture["instructions"])
        catalog = parse(complete)
        require(list(catalog) == ["serverInfo", "capabilities", "instructions", "tools"], "INPUT_INVALID", "Catalog boundary changed")
        require(catalog["serverInfo"] and catalog["capabilities"] and catalog["instructions"] == instructions,
                "INPUT_INVALID", "Missing/mismatched advertised context")
        require(parse(context) == {**catalog, "tools": []}, "INPUT_INVALID", "Context projection changed")
        tools = capture["tools"]
        require({t["name"] for t in tools} == set(BYTE_CAPS) and len(tools) == len(BYTE_CAPS), "TOOL_UNMEASURED", "Every listed tool must have a frozen cap")
        tool_texts = [verified_file(args.catalog, t["file"]) for t in tools]
        require([parse(t) for t in tool_texts] == catalog["tools"], "INPUT_INVALID", "Tool capture order/content differs")
        require([t["name"] for t in tools] == list(BYTE_CAPS) == [parse(text)["name"] for text in tool_texts],
                "INPUT_INVALID", "Tool labels must equal the parsed tool names in the frozen listing order")
        segments = [(s["kind"], verified_file(args.catalog, s["file"])) for s in capture["ordered_segments"]]
        expected_segments = [("context-prefix", context[:-2])]
        for i, text in enumerate(tool_texts):
            if i:
                expected_segments.append(("separator", ","))
            expected_segments.append(("tool", text))
        expected_segments.append(("context-suffix", "]}"))
        require(segments == expected_segments and "".join(text for _, text in segments) == complete,
                "INPUT_INVALID", "Original context/tool/separator boundaries changed")
        for tool, text in zip(tools, tool_texts):
            schema_text = verified_file(args.catalog, tool["output_schema"])
            require(parse(schema_text) == MINIMAL_SCHEMA == parse(text)["outputSchema"], "INPUT_INVALID", "Frozen output schema changed")
            check(cid, None, tool["name"] + ".bytes", len(text.encode("utf-8")), BYTE_CAPS[tool["name"]])
            check(cid, None, tool["name"] + ".output_schema_bytes", len(schema_text.encode("utf-8")), 97, exact=True)
            check(cid, None, tool["name"] + ".output_schema_cap_bytes", len(schema_text.encode("utf-8")), 100)
        tools_bytes = sum(len(t.encode("utf-8")) for t in tool_texts)
        complete_bytes = len(complete.encode("utf-8"))
        remaining_bytes = complete_bytes - tools_bytes
        check(cid, None, "tools_total.bytes", tools_bytes, 8100)
        check(cid, None, "instructions.bytes", len(instructions.encode("utf-8")), 160)
        check(cid, None, "context_and_separators.bytes", remaining_bytes, 350)
        check(cid, None, "complete.bytes", complete_bytes, 8450)
        check(cid, None, "conservative.bytes", sum(len(t.encode("utf-8")) for _, t in segments), 8450)
        pages = [verified_file(args.catalog, p) for p in capture["list_pages"]]
        require(pages and [t for page in pages for t in parse(page)["tools"]] == catalog["tools"], "INPUT_INVALID", "Undrained/mismatched list pages")
        require(all(isinstance(parse(p).get("nextCursor"), str) and parse(p)["nextCursor"] for p in pages[:-1])
                and "nextCursor" not in parse(pages[-1]), "INPUT_INVALID", "Listing was not drained")
        metadata = verified_file(args.catalog, capture["sdk_response_metadata"])
        require(parse(metadata) == [{k: v for k, v in parse(p).items() if k != "tools"} for p in pages], "INPUT_INVALID", "SDK fields omitted")
        frames = [(f["direction"], verified_file(args.catalog, f["file"])) for f in capture["rpc_frames"]]
        transcript = parse(verified_file(args.catalog, capture["transcript"]))
        require(transcript == [{"direction": direction, "message": parse(t)} for direction, t in frames], "INPUT_INVALID", "Incomplete RPC transcript")
        requests = {parse(t)["id"]: parse(t) for direction, t in frames if direction == "client" and "method" in parse(t) and "id" in parse(t)}
        responses = [parse(t) for direction, t in frames if direction == "server" and "result" in parse(t)]
        wire_pages = [r["result"] for r in responses if requests.get(r["id"], {}).get("method") == "tools/list"]
        require(wire_pages == [parse(p) for p in pages], "INPUT_INVALID", "Missing wire list page")
        discovery = [r["result"] for r in responses if requests.get(r["id"], {}).get("method") in ["server/discover", "initialize"]]
        require(len(discovery) == 1, "INPUT_INVALID", "Missing/ambiguous discovery")
        discover = discovery[0]
        identity = discover.get("serverInfo", discover.get("_meta", {}).get("io.modelcontextprotocol/serverInfo"))
        require(identity == catalog["serverInfo"] and discover["capabilities"] == catalog["capabilities"]
                and discover["instructions"] == instructions, "INPUT_INVALID", "Advertised discovery context differs")
        for encoding in encoders:
            per_tool = {t["name"]: count(text, encoding) for t, text in zip(tools, tool_texts)}
            total = sum(per_tool.values())
            ordered_counts = [{"kind": kind, "tokens": count(text, encoding)} for kind, text in segments]
            context_tokens = max(count(context, encoding) + sum(count(text, encoding) for kind, text in segments if kind == "separator"),
                                 sum(count(text, encoding) for kind, text in segments if kind != "tool"))
            conservative = max(sum(s["tokens"] for s in ordered_counts), total + context_tokens)
            for name, tokens in per_tool.items():
                check(cid, encoding, name + ".tokens", tokens, TOKEN_CAPS[name])
            check(cid, encoding, "tools_total.tokens", total, 2350)
            check(cid, encoding, "context_and_separators.tokens", context_tokens, 150)
            check(cid, encoding, "complete.tokens", count(complete, encoding), 2500)
            check(cid, encoding, "conservative.tokens", conservative, 2500)
            # Diagnostic protocol counts are deliberately NOT silently discarded
            # or charged to the guidance catalog boundary. They include SDK fields.
            result_texts = [compact(r["result"]) for r in responses]
            report["measurements"].append({"capture": cid, "era": era, "profile": capture["profile"], "encoding": encoding,
                "bytes": {"per_tool": {t["name"]: len(text.encode("utf-8")) for t, text in zip(tools, tool_texts)},
                          "tools_total": tools_bytes, "instructions": len(instructions.encode("utf-8")), "context_and_separators": remaining_bytes, "complete": complete_bytes},
                "tokens": {"per_tool": per_tool, "tools_total": total, "instructions_ordinary": count(instructions, encoding),
                           "context_and_separators": context_tokens, "complete": count(complete, encoding), "conservative": conservative, "ordered_segments": ordered_counts},
                "protocol_separate": {"discovery": [{"bytes": len(compact(d).encode("utf-8")), "tokens": count(compact(d), encoding)} for d in discovery],
                    "list_results": [{"bytes": len(p.encode("utf-8")), "tokens": count(p, encoding)} for p in pages],
                    "sdk_list_metadata": {"bytes": len(metadata.encode("utf-8")), "tokens": count(metadata, encoding)},
                    "messages": [{"direction": d, "bytes": len(t.encode("utf-8")), "tokens": count(t, encoding), "lf_tokens_separate": count("\n", encoding)} for d, t in frames],
                    "rpc_and_lf_framing_bytes": sum(len(t.encode("utf-8")) + 1 for d, t in frames if d == "server") - sum(len(t.encode("utf-8")) for t in result_texts)}})
    maxima = report["maxima_across_eras_profiles_encodings"] = {}
    for c in checks:
        maxima[c["metric"]] = max(maxima.get(c["metric"], 0), c["value"])
    report["breaches"] = [c for c in checks if not c["pass"]]
    report["status"] = "breach" if report["breaches"] else "pass"
    return 1 if report["breaches"] else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ["catalog", "lock", "requirements", "cache", "wheelhouse", "out"]:
        parser.add_argument("--" + flag, type=Path, required=True)
    parser.add_argument("--image-reference")
    parser.add_argument("--exploratory", action="store_true", help="Non-container evidence only; never closes acceptance")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for input_path in [args.catalog, args.cache, args.wheelhouse, args.lock, args.requirements]:
        require(not args.out.resolve().is_relative_to(input_path.resolve()) and not input_path.resolve().is_relative_to(args.out.resolve()),
                "OUTPUT_NOT_SEPARATE", "Output must be separate from every read-only input")
    report = {"format": "fireboat-catalog-caps/1", "status": "unmeasured",
              "execution": "exploratory, non-container; does not close S5" if args.exploratory else "reference offline container"}
    try:
        code = run(args, report)
    except Exception as error:
        report["status"] = "unmeasured"
        report["error"] = {"code": getattr(error, "code", "MISSING_OR_INVALID_TOOLING"), "detail": str(error)}
        code = 2
    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    (args.out / "SHA256SUMS").write_text(f"{sha((args.out / 'report.json').read_bytes())}  report.json\n", encoding="utf-8")
    print(compact({"status": report["status"], "execution": report["execution"], "error": report.get("error"),
                   "breaches": len(report.get("breaches", [])), "report_sha256": sha((args.out / "report.json").read_bytes())}))
    return code


if __name__ == "__main__":
    sys.exit(main())
