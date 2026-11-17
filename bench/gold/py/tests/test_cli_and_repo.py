import json
import os
import re

from fbgold.cli import main

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
# fireboat's restricted-terminology pattern, in the repository that holds this harness (bench/gold/py is three levels down).
REPO = os.path.dirname(os.path.dirname(os.path.dirname(PKG)))
EDGES = os.path.join(REPO, "scripts", "quickstart", "edges.ts")


def test_cli_end_to_end(tmp_path):
    conv = tmp_path / "converted"
    conv.mkdir()
    (conv / "Patient.ndjson").write_text(json.dumps({"resourceType": "Patient", "id": "p1"}) + "\n")
    (conv / "Observation.ndjson").write_text("\n".join([
        '{"resourceType":"Observation","id":"o1","subject":{"reference":"Patient/p1"},'
        '"code":{"coding":[{"system":"http://example.org/lab","code":"1"}]},'
        '"effectiveDateTime":"2140-01-01T00:00:00Z","valueQuantity":{"value":7.0,"unit":"g"}}',
        '{"resourceType":"Observation","id":"o2","subject":{"reference":"Patient/p9"},'
        '"code":{"coding":[{"system":"http://example.org/lab","code":"1"}]},'
        '"effectiveDateTime":"2141-01-01T00:00:00Z","valueQuantity":{"value":9,"unit":"g"}}']) + "\n")
    q = {"id": "mimic.L1.x", "dataset": "mimic", "patient_id": "p1", "template_id": "L1", "answer_form": "value",
         "parameters": {"code_system": "http://example.org/lab", "code": "1", "display": "One"},
         "operations": [{"op": "drain"}]}
    qf = tmp_path / "questions.jsonl"
    qf.write_text(json.dumps(q) + "\n")
    out = tmp_path / "out" / "gold.py.jsonl"
    assert main(["--dataset", "mimic", "--questions", str(qf), "--converted", str(conv), "--out", str(out)]) == 0
    rec = json.loads(out.read_text())
    assert (rec["answer"], rec["value_as_recorded"], rec["unit"]) == ("7", "7.0", "g")
    assert rec["implementation"] == "py" and rec["provenance"] == ["Observation/o1"]
    raw = out.read_text()
    assert '"7.0"' in raw  # the lexeme survives as a string


def test_no_file_matches_the_restricted_terminology_pattern():
    if not os.path.exists(EDGES):
        import pytest
        pytest.skip("scripts/quickstart/edges.ts not found in the enclosing repository")
    m = re.search(r"const RESTRICTED_TEXT = /(.+)/([a-z]*);", open(EDGES, encoding="utf-8").read())
    pattern = re.compile(m.group(1), re.I if "i" in m.group(2) else 0)
    hits = []
    for root, dirs, files in os.walk(PKG):
        for f in files:
            p = os.path.join(root, f)
            if os.path.islink(p):
                continue
            with open(p, encoding="latin-1") as fh:
                if pattern.search(fh.read()):
                    hits.append(os.path.relpath(p, PKG))
    assert hits == []
