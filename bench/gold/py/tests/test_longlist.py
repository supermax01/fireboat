"""Long-list stratum: LS1 and LS2. Synthetic data only."""

import pytest

from fixtures import LAB, OTHER, PID, gold, obs

CAT = "http://example.org/category"
ENC = "http://example.org/enc-class"
ETYPE = "http://example.org/enc-type"
CTYPE = "http://example.org/claim-type"
SYN = "synthea-dev"


def cat_obs(code, when, cat="vital", value=None, **kw):
    return obs(code, when, value, category=[{"coding": [{"system": CAT, "code": cat}]}], **kw)


def ls1_params(rtype="Observation", token=None, window=None, code_label="code"):
    p = {"resource_type": rtype, "code_label": code_label}
    if token:
        sp, system, code = token
        p.update({"search_param": sp, "field_label": sp, "code_system": system, "code": code, "display": code})
    if window:
        p.update({"date_label": "effective time", "window_start": window[0], "window_end": window[1]})
    return p


def ls2_obs_params(code="100", window=None):
    p = {"resource_type": "Observation", "search_param": "code", "field_label": "code", "code_system": LAB,
         "code": code, "display": f"Test {code}", "value_kind": "observation"}
    if window:
        p.update({"date_label": "effective time", "window_start": window[0], "window_end": window[1]})
    return p


def many(n, start_day=1, **kw):
    return [cat_obs(str(500 + i % 3), f"2140-01-{start_day + i // 24:02d}T{i % 24:02d}:00:00Z", **kw)
            for i in range(n)]


# ------------------------------------------------------------------ LS1


def test_LS1_distinct_system_code_over_every_coding_of_the_code_element():
    rs = many(21)
    rs[0]["code"]["coding"].append({"system": "http://example.org/third", "code": "z"})
    rs.append(cat_obs("999", "2140-01-01T05:30:00Z", cat="lab"))  # other category: not in the set
    rs.append(cat_obs("998", "2140-01-01T05:30:00Z", pid=OTHER))  # other patient
    g = gold("LS1-B1", rs, ls1_params(token=("category", CAT, "vital")), form="list")
    assert g["answer_kind"] == "list"
    assert g["answer_list"] == sorted([f"{LAB}|500", f"{LAB}|501", f"{LAB}|502",
                                       "http://example.org/other|x", "http://example.org/third|z"])
    assert len(g["items"]) == len(g["depends_on"]) == 21 == g["completeness"]["size"]
    assert not any(n.startswith("LS-b") for n in g["rule_notes"])


def test_LS1_type_set_counts_codings_on_a_bare_coding_token_and_lists_every_record():
    def enc(i, cls, types):
        return {"resourceType": "Encounter", "id": f"e{i}", "subject": {"reference": f"Patient/{PID}"},
                "class": {"system": ENC, "code": cls},
                "type": [{"coding": [{"system": ETYPE, "code": t}]} for t in types]}
    rs = [enc(i, "AMB", ["a", "b"] if i == 0 else ["a"]) for i in range(25)]
    rs += [enc(100 + i, "EMER", ["c"]) for i in range(5)]
    rs.append(enc(200, "AMB", []))  # no type: in the set, adds no code
    g = gold("LS1-B1", rs, ls1_params("Encounter", token=("class", ENC, "AMB"), code_label="type"),
             dataset=SYN, form="list")
    assert g["answer_list"] == [f"{ETYPE}|a", f"{ETYPE}|b"]
    assert g["completeness"]["size"] == 26 and "Encounter/e200" in g["depends_on"]
    assert "Encounter/e200" not in g["provenance"]
    assert any(n.startswith("LS1-c: 1 record") for n in g["rule_notes"])


def test_LS1_window_is_half_open_with_offsets():
    # Window 2140-01-02T00:00:00+05:00 (= 2140-01-01T19:00Z) to 2140-01-02T00:00:00Z.
    a, b = "2140-01-02T00:00:00+05:00", "2140-01-02T00:00:00Z"
    rs = [
        cat_obs("1", "2140-01-01T18:59:59Z"),          # just before the start: out
        cat_obs("2", "2140-01-02T00:00:00+05:00"),     # exactly the start: in
        cat_obs("3", "2140-01-01T21:00:00-02:00"),     # 23:00Z: in
        cat_obs("4", "2140-01-02T00:00:00Z"),          # exactly the end: out
        cat_obs("5", "2140-01-02T01:00:00+01:00"),     # = the end instant: out
        cat_obs("6", "2140-01-01T23:59:59.999Z"),      # in
    ]
    p = ls1_params(window=(a, b))
    g = gold("LS1-B1", rs, p, form="list")
    codes = {s.split("|")[1] for s in g["answer_list"] if s.startswith(LAB)}
    assert codes == {"2", "3", "6"}
    assert g["completeness"]["size"] == 3
    assert any(n.startswith("LS-b: set holds 3") for n in g["rule_notes"])


def test_LS1_window_excluded_when_a_matching_record_lacks_a_full_datetime():
    rs = many(30)
    rs.append(cat_obs("7", "2140-01-01"))  # a date only, outside the window too
    g = gold("LS1-B1", rs, ls1_params(window=("2140-01-01T00:00:00Z", "2140-01-02T00:00:00Z")), form="list")
    assert g["answer_kind"] is None and g["rule_notes"][0].startswith("unanswerable: LS-c: 1 matching")
    rs[-1]["effectiveDateTime"] = "2140-01-01T10:00Z"  # no seconds
    g = gold("LS1-B1", rs, ls1_params(window=("2140-01-01T00:00:00Z", "2140-01-02T00:00:00Z")), form="list")
    assert g["answer_kind"] is None
    # Without a window the same record is simply in the set.
    g = gold("LS1-B1", rs, ls1_params(), form="list")
    assert g["answer_kind"] == "list" and g["completeness"]["size"] == 31


def test_LS1_never_asks_about_the_code_that_defines_the_set():
    rs = many(30)
    g = gold("LS1-B1", rs, ls1_params(token=("code", LAB, "500")), form="list")
    assert g["answer_kind"] is None and "LS1-b" in g["rule_notes"][0]


def test_LS1_medication_reference_adds_no_code():
    rx = "http://example.org/rx"
    rs = [{"resourceType": "MedicationRequest", "id": f"m{i}", "subject": {"reference": f"Patient/{PID}"},
           "authoredOn": "2140-01-01T00:00:00Z",
           **({"medicationReference": {"reference": "Medication/x"}} if i % 2 else
              {"medicationCodeableConcept": {"coding": [{"system": rx, "code": "9"}]}})} for i in range(22)]
    g = gold("LS1-B1", rs, ls1_params("MedicationRequest", code_label="medication code"), form="list")
    assert g["answer_list"] == [f"{rx}|9"] and g["completeness"]["size"] == 22
    assert any(n.startswith("LS1-c: 11 record") for n in g["rule_notes"])


# ------------------------------------------------------------------ LS2


def test_LS2_maximum_compared_as_decimals_with_lexeme_kept():
    rs = [obs("100", f"2140-01-01T{i:02d}:00:00Z", v, unit="mg/dL", oid=f"r{i}")
          for i, v in enumerate(["9.5", "10.20", "1E1", "-3", "10.1"] + ["4"] * 20)]
    g = gold("LS2-B1", rs, ls2_obs_params())
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("10.2", "10.20", "mg/dL")
    assert g["timestamp"] == "2140-01-01T01:00:00Z" and g["provenance"] == ["Observation/r1"]
    assert len(g["items"]) == 1 and g["completeness"]["size"] == 25
    assert g["lexeme_eligible"] is True


def test_LS2_maximum_ties_are_all_items():
    rs = [obs("100", "2140-01-01T03:00:00Z", "12", unit="g", oid="a"),
          obs("100", "2140-01-02T03:00:00Z", "12", unit="g", oid="b")] + \
         [obs("100", f"2140-01-03T{i:02d}:00:00Z", "11.9", unit="g") for i in range(20)]
    g = gold("LS2-B1", rs, ls2_obs_params())
    assert (g["answer"], g["value_as_recorded"]) == ("12", "12")
    assert [it["ref"] for it in g["items"]] == ["Observation/a", "Observation/b"]
    assert g["provenance"] == ["Observation/a", "Observation/b"]
    assert g["timestamp"] is None and any(n.startswith("LS2-d") for n in g["rule_notes"])


def test_LS2_maximum_written_two_ways_excludes_the_candidate():
    rs = [obs("100", "2140-01-01T03:00:00Z", "7", unit="g"),
          obs("100", "2140-01-02T03:00:00Z", "7.0", unit="g")] + \
         [obs("100", f"2140-01-03T{i:02d}:00:00Z", "6.5", unit="g") for i in range(20)]
    g = gold("LS2-B1", rs, ls2_obs_params())
    assert g["answer_kind"] is None and g["rule_notes"][0].startswith("unanswerable: LS2-c")
    assert g["completeness"]["size"] == 22
    # The same two spellings below the maximum do not matter.
    rs.append(obs("100", "2140-01-04T03:00:00Z", "8", unit="g"))
    g = gold("LS2-B1", rs, ls2_obs_params())
    assert (g["answer"], g["answer_kind"]) == ("8", "value")


def test_LS2_needs_one_unit_and_a_plain_number_on_every_record():
    base = [obs("100", f"2140-01-03T{i:02d}:00:00Z", "6", unit="g") for i in range(21)]
    g = gold("LS2-B1", base + [obs("100", "2140-01-04T00:00:00Z", "1", unit="kg")], ls2_obs_params())
    assert g["answer_kind"] is None and "different units" in g["rule_notes"][0]
    # Unit falls back to code, so unit "g" and code-only "g" are one unit.
    g = gold("LS2-B1", base + [obs("100", "2140-01-04T00:00:00Z", "9", ucode="g")], ls2_obs_params())
    assert (g["answer"], g["unit"]) == ("9", "g")
    g = gold("LS2-B1", base + [obs("100", "2140-01-04T00:00:00Z", "99", unit="g", comparator=">")],
             ls2_obs_params())
    assert g["answer_kind"] is None and "plain number" in g["rule_notes"][0]
    g = gold("LS2-B1", base + [obs("100", "2140-01-04T00:00:00Z", string="high")], ls2_obs_params())
    assert g["answer_kind"] is None and "plain number" in g["rule_notes"][0]


def test_LS2_observation_window():
    rs = [obs("100", f"2140-01-01T{i:02d}:00:00Z", str(i), unit="g") for i in range(24)]
    rs.append(obs("100", "2140-01-02T00:00:00Z", "500", unit="g"))  # at the end bound: out
    rs.append(obs("100", "2140-01-01T00:00:00Z", "kg?", unit="kg", code={"text": "x"}))  # other code
    g = gold("LS2-B1", rs, ls2_obs_params(window=("2140-01-01T00:00:00Z", "2140-01-02T00:00:00Z")))
    assert (g["answer"], g["timestamp"]) == ("23", "2140-01-01T23:00:00Z")
    assert g["completeness"]["size"] == 24


def claim(cid, created, total=None, currency="USD", pid=PID):
    c = {"resourceType": "Claim", "id": cid, "patient": {"reference": f"Patient/{pid}"}, "created": created,
         "type": {"coding": [{"system": CTYPE, "code": "professional"}]}}
    if total is not None:
        c["total"] = {"value": total, "currency": currency} if currency else {"value": total}
    return c


def test_LS2_claim_total_with_currency():
    cs = [claim(f"c{i}", f"2004-01-{i + 1:02d}T10:00:00-05:00", f"{100 + i}.00") for i in range(25)]
    cs.append(claim("big", "2005-06-01T10:00:00+02:00", "1040.50"))
    cs.append(claim("theirs", "2005-06-01T10:00:00Z", "99999.00", pid=OTHER))
    p = {"resource_type": "Claim", "value_kind": "claim"}
    g = gold("LS2-B1", cs, p, dataset=SYN)
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("1040.5", "1040.50", "USD")
    assert g["timestamp"] == "2005-06-01T10:00:00+02:00"
    assert g["items"][0]["ref"] == "Claim/big" and g["items"][0]["unit_code"] == "USD"
    assert g["completeness"]["size"] == 26 and "Claim/theirs" not in g["depends_on"]
    assert g["lexeme_eligible"] is True
    # A claim in another currency, or without a total, excludes the candidate.
    g = gold("LS2-B1", cs + [claim("eur", "2006-01-01T00:00:00Z", "1.00", currency="EUR")], p, dataset=SYN)
    assert g["answer_kind"] is None and "different units" in g["rule_notes"][0]
    g = gold("LS2-B1", cs + [claim("nil", "2006-01-01T00:00:00Z")], p, dataset=SYN)
    assert g["answer_kind"] is None and "plain number in total" in g["rule_notes"][0]


def test_LS2_claim_window_on_created():
    cs = [claim(f"c{i}", f"2004-01-01T{i:02d}:00:00Z", f"{i}.00") for i in range(24)]
    cs.append(claim("late", "2004-01-02T00:00:00Z", "999.00"))
    p = {"resource_type": "Claim", "value_kind": "claim", "date_label": "creation time",
         "window_start": "2003-12-31T19:00:00-05:00", "window_end": "2004-01-02T00:00:00Z"}
    g = gold("LS2-B1", cs, p, dataset=SYN)
    assert (g["answer"], g["value_as_recorded"]) == ("23", "23.00") and g["completeness"]["size"] == 24


def test_band_bounds_are_checked_and_noted_not_enforced():
    rs = many(101)
    g = gold("LS1-B1", rs, ls1_params(), form="list")
    assert g["answer_kind"] == "list" and "LS-b: set holds 101 records, outside band B1 (21-100)" in g["rule_notes"]
    g = gold("LS1-B2", rs, ls1_params(), form="list")
    assert not any(n.startswith("LS-b") for n in g["rule_notes"])
    assert g["completeness"]["pages_at_100"] == 2


@pytest.mark.parametrize("tid", ["LS3-B1", "LS1-B5", "LL1"])
def test_unknown_long_list_ids_are_refused(tid):
    with pytest.raises(KeyError):
        gold(tid, [], ls1_params(), form="list")
