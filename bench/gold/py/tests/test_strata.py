"""Decimal stratum: CL1 and the DEC-<id> variants. Synthetic data only."""

import json

import pytest

from fbgold.cli import main
from fbgold.values import lexeme_eligible
from fixtures import DRUG, LAB, OTHER, PID, gold, obs

PROC = "http://example.org/proc"
SYN = "synthea-dev"


def claim(cid, created, lines, pid=PID):
    return {"resourceType": "Claim", "id": cid, "patient": {"reference": f"Patient/{pid}"},
            "created": created, "item": lines}


def line(seq, code, name, net=None, currency="USD", extra_codings=()):
    it = {"sequence": seq, "productOrService": {
        "coding": list(extra_codings) + [{"system": PROC, "code": code, "display": name}], "text": name}}
    if net is not None:
        it["net"] = {"value": net, "currency": currency}
    return it


def cl1(created="2004-12-31T12:55:57-05:00", code="200", display="Echo", cref="Claim/c1", seq="2"):
    return {"code_system": PROC, "code": code, "display": display, "claim": cref,
            "claim_created": created, "item_sequence": seq}


# ------------------------------------------------------------------ CL1


def test_CL1_amount_lexeme_and_currency():
    c = claim("c1", "2004-12-31T12:55:57-05:00",
              [line(1, "100", "Visit", "77.49"), line(2, "200", "Echo", "1040.10", currency="EUR")])
    g = gold("DEC-CL1", [c], cl1(), dataset=SYN)
    assert g["answer_kind"] == "value"
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("1040.1", "1040.10", "EUR")
    assert g["timestamp"] == "2004-12-31T12:55:57-05:00"
    it = g["items"][0]
    assert (it["ref"], it["unit"], it["unit_code"], it["display"]) == ("Claim/c1", "EUR", "EUR", "Echo")
    assert g["provenance"] == g["depends_on"] == ["Claim/c1"]
    assert g["lexeme_eligible"] is True
    assert "DEC-a: gold of CL1" in g["rule_notes"] and not any(n.startswith("DEC-b") for n in g["rule_notes"])


def test_CL1_claim_found_by_instant_not_by_lexeme_and_cross_checked():
    c = claim("c9", "2004-12-31T17:55:57Z", [line(2, "200", "Echo", "5.50")])
    other = claim("c1", "2004-12-31T17:55:58Z", [line(2, "200", "Echo", "9.90")])
    theirs = claim("cx", "2004-12-31T17:55:57Z", [line(2, "200", "Echo", "1.00")], pid=OTHER)
    g = gold("DEC-CL1", [c, other, theirs], cl1(), dataset=SYN)
    assert (g["answer"], g["value_as_recorded"]) == ("5.5", "5.50")
    assert g["provenance"] == ["Claim/c9"]
    assert "claim found by creation time differs from the question's claim parameter" in g["rule_notes"]
    assert "claim creation lexeme differs from the question's (same instant)" in g["rule_notes"]


def test_CL1_creation_time_must_be_unique_among_the_patients_claims():
    a = claim("c1", "2004-12-31T12:55:57-05:00", [line(2, "200", "Echo", "5.50")])
    b = claim("c2", "2004-12-31T17:55:57Z", [line(1, "300", "Other", "1.10")])
    g = gold("DEC-CL1", [a, b], cl1(), dataset=SYN)
    assert g["answer_kind"] is None and g["rule_notes"][0].startswith("unanswerable: CL1-b")


def test_CL1_line_name_must_be_unique_on_the_claim():
    c = claim("c1", "2004-12-31T12:55:57-05:00",
              [line(1, "200", "Echo", "5.50"), line(2, "201", "Echo", "6.50")])
    g = gold("DEC-CL1", [c], cl1(), dataset=SYN)
    assert g["answer_kind"] is None and "share the name" in g["rule_notes"][0]


def test_CL1_coding_matches_on_any_coding_and_sequence_is_only_checked():
    c = claim("c1", "2004-12-31T12:55:57-05:00",
              [line(4, "200", "Echo", "0.00", extra_codings=[{"system": "http://example.org/x", "code": "q"}])])
    g = gold("DEC-CL1", [c], cl1(), dataset=SYN)
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("0", "0.00", "USD")
    assert "line sequence 4 differs from the question's item_sequence" in g["rule_notes"]


def test_CL1_missing_line_or_net():
    c = claim("c1", "2004-12-31T12:55:57-05:00", [line(1, "100", "Visit", "1.00")])
    g = gold("DEC-CL1", [c], cl1(), dataset=SYN)
    assert g["answer_kind"] is None
    c = claim("c1", "2004-12-31T12:55:57-05:00", [line(2, "200", "Echo")])
    g = gold("DEC-CL1", [c], cl1(), dataset=SYN)
    assert g["answer_kind"] == "none" and g["provenance"] == ["Claim/c1"]
    assert any(n.startswith("DEC-b") for n in g["rule_notes"])


def test_CL1_exists_only_as_a_decimal_variant_and_only_for_synthea():
    with pytest.raises(KeyError):
        gold("CL1", [], cl1(), dataset=SYN)
    with pytest.raises(KeyError):
        gold("DEC-CL1", [], cl1(), dataset="mimic")


# ------------------------------------------------------------------ DEC-<id>


def test_DEC_variant_is_the_base_gold_plus_notes():
    rs = [obs("100", "2140-01-01T10:00:00Z", "37.0", unit="Cel", oid="r1")]
    p = {"code_system": LAB, "code": "100", "display": "Test 100", "record": "Observation/r1"}
    base = gold("L6", rs, p)
    dec = gold("DEC-L6", rs, p)
    for k in ("answer_kind", "answer", "value_as_recorded", "unit", "timestamp", "items",
              "provenance", "depends_on", "completeness", "lexeme_eligible"):
        assert dec[k] == base[k], k
    assert dec["rule_notes"] == base["rule_notes"] + ["DEC-a: gold of L6"]
    assert dec["lexeme_eligible"] is True


def test_DEC_variant_notes_an_ineligible_gold_but_keeps_it():
    rs = [obs("100", "2140-01-01T10:00:00Z", "37.5", unit="Cel", oid="r1")]
    p = {"code_system": LAB, "code": "100", "display": "Test 100", "record": "Observation/r1"}
    g = gold("DEC-L6", rs, p)
    assert g["answer"] == "37.5" and g["lexeme_eligible"] is False
    assert any(n.startswith("DEC-b") for n in g["rule_notes"])


def test_DEC_comparator_is_stripped_before_the_eligibility_check():
    rs = [obs("100", "2140-01-01T10:00:00Z", "300.0", unit="mg", comparator=">", oid="r1")]
    p = {"code_system": LAB, "code": "100", "display": "Test 100", "record": "Observation/r1"}
    g = gold("DEC-L6", rs, p)
    assert (g["answer"], g["value_as_recorded"], g["lexeme_eligible"]) == (">300", ">300.0", True)


def test_DEC_F3_zero_payment_and_DEC_O4_dose():
    e = {"resourceType": "ExplanationOfBenefit", "id": "e1", "patient": {"reference": f"Patient/{PID}"},
         "claim": {"reference": "Claim/c1"}, "created": "2004-01-01T00:00:00Z",
         "payment": {"amount": {"value": "0.0", "currency": "USD"}}}
    g = gold("DEC-F3", [e], {"claim": "Claim/c1"}, dataset=SYN)
    assert (g["answer"], g["value_as_recorded"], g["unit"], g["lexeme_eligible"]) == ("0", "0.0", "USD", True)
    mr = {"resourceType": "MedicationRequest", "id": "m1", "subject": {"reference": f"Patient/{PID}"},
          "authoredOn": "2004-01-01T00:00:00Z",
          "medicationCodeableConcept": {"coding": [{"system": DRUG, "code": "5"}]},
          "dosageInstruction": [{"doseAndRate": [{"doseQuantity": {"value": "1.0"}}]}]}
    g = gold("DEC-O4", [mr], {"record": "MedicationRequest/m1", "code_system": DRUG, "code": "5"}, dataset=SYN)
    assert (g["answer"], g["value_as_recorded"], g["unit"], g["lexeme_eligible"]) == ("1", "1.0", None, True)


def test_synthea_holdout_uses_the_synthea_rules():
    from fbgold.cli import DATASETS
    from fbgold.templates import t_O1_synthea, template_for
    assert "synthea-holdout" in DATASETS
    assert template_for("synthea-holdout", "O1") is t_O1_synthea
    e = {"resourceType": "ExplanationOfBenefit", "id": "e1", "patient": {"reference": f"Patient/{PID}"},
         "claim": {"reference": "Claim/c1"}, "created": "2004-01-01T00:00:00Z",
         "payment": {"amount": {"value": "0.0", "currency": "USD"}}}
    held = gold("DEC-F3", [e], {"claim": "Claim/c1"}, dataset="synthea-holdout")
    dev = gold("DEC-F3", [e], {"claim": "Claim/c1"}, dataset=SYN)
    assert held == dev | {"dataset": "synthea-holdout", "question_id": "synthea-holdout.DEC-F3.test"}
    with pytest.raises(KeyError):
        gold("DEC-F3", [], {}, dataset="synthea-test")


def test_DEC_unknown_base_is_refused():
    with pytest.raises(KeyError):
        gold("DEC-L3", [], {}, dataset="mimic")
    with pytest.raises(KeyError):
        gold("DEC-F3", [], {}, dataset="mimic")


@pytest.mark.parametrize("lexeme,eligible", [
    ("0.0", True), ("0.00", True), ("-0.0", True), ("-0", True), ("0", False), ("1.10", True),
    ("100", False), ("1E2", True), ("1e21", True), ("1.5e-7", False), ("0.00000015", True),
    ("0.30000000000000004", False),  # 17 digits, already the shortest double form
    ("0.30000000000000001", True),   # 17 digits, round trips to 0.3
    ("123456789012345678", True),    # integer beyond 2^53 changes
    ("77.49", False), ("1040.1", False),
])
def test_decimal_lexeme_eligibility(lexeme, eligible):
    assert lexeme_eligible(lexeme) is eligible


# ------------------------------------------------------------------ CLI


def test_cli_skips_named_templates_and_counts_them(tmp_path, capsys):
    conv = tmp_path / "converted"
    conv.mkdir()
    (conv / "Patient.ndjson").write_text(json.dumps({"resourceType": "Patient", "id": "p1"}) + "\n")
    (conv / "Claim.ndjson").write_text(
        '{"resourceType":"Claim","id":"c1","patient":{"reference":"Patient/p1"},'
        '"created":"2004-12-31T12:55:57-05:00","item":[{"sequence":2,"productOrService":'
        '{"coding":[{"system":"http://example.org/proc","code":"200"}],"text":"Echo"},'
        '"net":{"value":12.50,"currency":"USD"}}]}\n')
    base = {"dataset": SYN, "patient_id": "p1", "answer_form": "value", "operations": [{"op": "read"}]}
    qs = [dict(base, id="synthea-dev.DEC-CL1.x", template_id="DEC-CL1", parameters=cl1()),
          dict(base, id="synthea-dev.LL1.x", template_id="LL1", answer_form="count",
               parameters={"resource_type": "Claim"}),
          dict(base, id="synthea-dev.LL2.x", template_id="LL2", answer_form="count", parameters={})]
    qf = tmp_path / "questions.jsonl"
    qf.write_text("".join(json.dumps(q) + "\n" for q in qs))
    out = tmp_path / "out" / "gold.py.jsonl"
    assert main(["--dataset", SYN, "--questions", str(qf), "--converted", str(conv), "--out", str(out),
                 "--skip-template", "LL1", "--skip-template", "LL2"]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert (summary["questions"], summary["skipped"]) == (1, 2)
    assert summary["skipped_by_template"] == {"LL1": 1, "LL2": 1}
    recs = [json.loads(x) for x in out.read_text().splitlines()]
    assert [r["question_id"] for r in recs] == ["synthea-dev.DEC-CL1.x"]
    assert (recs[0]["answer"], recs[0]["value_as_recorded"]) == ("12.5", "12.50")
