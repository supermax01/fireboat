import base64

from fixtures import DRUG, DX, LAB, OTHER, PANEL, PID, gold, obs

C = {"code_system": LAB, "code": "100", "display": "Test 100"}


# ------------------------------------------------------------------ L1 / L10 / L7


def test_L1_latest_by_instant_not_by_clock_text():
    a = obs("100", "2140-01-01T23:00:00-05:00", "12.3400", unit="mg/dL", ucode="mg/dL", oid="late")  # 04:00Z
    b = obs("100", "2140-01-02T03:00:00Z", "9", unit="mg/dL", oid="early")
    g = gold("L1", [a, b], C)
    assert g["answer_kind"] == "value"
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("12.34", "12.3400", "mg/dL")
    assert g["timestamp"] == "2140-01-01T23:00:00-05:00"
    assert g["provenance"] == ["Observation/late"]
    assert g["depends_on"] == ["Observation/early", "Observation/late"]
    assert g["completeness"] == {"size": 2, "pages_at_100": 1}
    assert g["lexeme_eligible"] is True
    assert g["items"][0]["unit_code"] == "mg/dL"


def test_L1_tie_with_differing_values_is_excluded():
    a = obs("100", "2140-01-01T10:00:00Z", "1")
    b = obs("100", "2140-01-01T05:00:00-05:00", "2")
    g = gold("L1", [a, b], C)
    assert g["answer_kind"] is None
    assert g["rule_notes"][0].startswith("unanswerable")


def test_L1_tie_with_equal_values_lists_both():
    a = obs("100", "2140-01-01T10:00:00Z", "2.0", oid="a")
    b = obs("100", "2140-01-01T10:00:00Z", "2", oid="b")
    g = gold("L1", [a, b], C)
    assert g["answer"] == "2"
    assert g["provenance"] == ["Observation/a", "Observation/b"]


def test_L1_unit_falls_back_to_code_and_never_appears_from_nowhere():
    g = gold("L1", [obs("100", "2140-01-01T10:00:00Z", "5", ucode="mmol/L")], C)
    assert g["unit"] == "mmol/L"
    g = gold("L1", [obs("100", "2140-01-01T10:00:00Z", "5")], C)
    assert g["unit"] is None


def test_L1_ignores_other_patient_other_code_and_valueless_records():
    rs = [obs("100", "2140-01-01T10:00:00Z", "5"),
          obs("100", "2141-01-01T10:00:00Z", "6", pid=OTHER),
          obs("101", "2141-01-01T10:00:00Z", "7"),
          obs("100", "2141-01-01T10:00:00Z", None)]
    g = gold("L1", rs, C)
    assert g["answer"] == "5"
    assert g["completeness"]["size"] == 2  # valueless record still a candidate searched for


def test_L1_no_record_is_none():
    g = gold("L1", [], C)
    assert g["answer_kind"] == "none" and g["answer"] is None


def test_L7_takes_latest_non_numeric():
    rs = [obs("100", "2140-01-01T10:00:00Z", string="NEG."),
          obs("100", "2140-02-01T10:00:00Z", "3")]
    g = gold("L7", rs, C)
    assert g["answer"] == "NEG." and g["unit"] is None
    assert g["completeness"]["size"] == 2


def test_L10_survey_score():
    g = gold("L10", [obs("100", "2015-01-01T00:00:00Z", "18.095", unit="{score}")], C, dataset="synthea-dev")
    assert (g["answer"], g["unit"]) == ("18.095", "{score}")


# ------------------------------------------------------------------ windows and counts


def test_L2_half_open_window_with_offsets():
    p = dict(C, window_start="2133-02-01T00:00:00Z", window_end="2133-03-01T00:00:00Z")
    rs = [obs("100", "2133-01-31T19:00:00-05:00", "1", unit="u", oid="start"),   # = start, included
          obs("100", "2133-02-28T19:00:00-05:00", "2", unit="u", oid="end"),     # = end, excluded
          obs("100", "2133-02-15T12:00:00Z", "3.10", unit="u", oid="mid")]
    g = gold("L2", rs, p, form="list")
    assert g["provenance"] == ["Observation/mid", "Observation/start"]
    assert [i["ref"] for i in g["items"]] == ["Observation/start", "Observation/mid"]
    assert g["items"][1]["value"] == "3.1" and g["items"][1]["value_as_recorded"] == "3.10"
    assert g["lexeme_eligible"] is True


def test_L2_empty_window_is_none():
    p = dict(C, window_start="2133-02-01T00:00:00Z", window_end="2133-03-01T00:00:00Z")
    g = gold("L2", [obs("100", "2144-01-01T00:00:00Z", "1")], p, form="list")
    assert g["answer_kind"] == "none"


def test_L5_flags_window_size_outside_range():
    p = dict(C, window_start="2133-02-01T00:00:00Z", window_end="2133-03-01T00:00:00Z")
    g = gold("L5", [obs("100", "2133-02-02T00:00:00Z", "1")], p, form="list")
    assert any(n.startswith("L5-b") for n in g["rule_notes"])


def test_L3_and_L4_counts():
    rs = [obs("100", "2140-01-01T00:00:00Z", "1", encounter="Encounter/e1"),
          obs("100", "2140-01-02T00:00:00Z", "1", encounter="Encounter/e2"),
          obs("100", "2140-01-03T00:00:00Z", "1", encounter="Encounter/e1"),
          obs("100", "2140-01-03T00:00:00Z", "1", encounter="Encounter/e1", pid=OTHER)]
    g = gold("L3", rs, C, form="count")
    assert g["answer"] == "3" and g["completeness"]["size"] == 3
    g = gold("L4", rs, dict(C, encounter="Encounter/e1"), form="count")
    assert g["answer"] == "2"


def test_counts_page_at_100():
    rs = [obs("100", f"2140-01-01T00:00:{i % 60:02d}Z", "1") for i in range(101)]
    g = gold("L3", rs, C, form="count")
    assert g["completeness"] == {"size": 101, "pages_at_100": 2}


# ------------------------------------------------------------------ named records


def test_L6_keeps_comparator_and_own_unit():
    r = obs("100", "2140-01-01T00:00:00Z", "300", unit="mg/L", comparator=">", oid="r")
    g = gold("L6", [r], dict(C, record="Observation/r", record_time="2140-01-01T00:00:00Z"))
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == (">300", ">300", "mg/L")


def test_L6_record_of_another_patient_is_not_answered():
    r = obs("100", "2140-01-01T00:00:00Z", "3", pid=OTHER, oid="theirs")
    g = gold("L6", [r], dict(C, record="Observation/theirs"))
    assert g["answer_kind"] is None


def test_L9_data_absent_is_none():
    r = obs("100", "2140-01-01T00:00:00Z", oid="r",
            dataAbsentReason={"coding": [{"code": "unknown", "display": "Unknown"}]})
    g = gold("L9", [r], dict(C, record="Observation/r"))
    assert g["answer_kind"] == "none" and g["provenance"] == ["Observation/r"]


def _bp(when, sys_v, dia_v, oid, diastolic_first=False):
    comps = [{"code": {"coding": [{"code": "8480-6"}]}, "valueQuantity": {"value": sys_v, "unit": "mm[Hg]"}},
             {"code": {"coding": [{"code": "8462-4"}]}, "valueQuantity": {"value": dia_v, "unit": "mm[Hg]"}}]
    if diastolic_first:
        comps.reverse()
    return obs("bp", when, oid=oid, system=PANEL, component=comps)


def test_L8_reads_components_by_code_and_skips_incomplete_panels():
    rs = [_bp("2140-01-01T00:00:00Z", "120", "80", "old"),
          _bp("2140-02-01T00:00:00Z", "131.0", "85", "new", diastolic_first=True),
          obs("bp", "2140-03-01T00:00:00Z", system=PANEL, oid="absent",
              component=[{"code": {"coding": [{"code": "8480-6"}]}, "dataAbsentReason": {"text": "x"}}])]
    g = gold("L8", rs, {"code_system": PANEL, "code": "bp"})
    assert g["answer"] == "131/85" and g["value_as_recorded"] == "131.0/85" and g["unit"] == "mm[Hg]"
    assert [i["display"] for i in g["items"]] == ["systolic", "diastolic"]
    assert g["completeness"]["size"] == 3


# ------------------------------------------------------------------ medications


def _ma(when=None, period=None, dose=None, code="K1", enc=None, mid=None, pid=PID, **extra):
    r = {"resourceType": "MedicationAdministration", "id": mid or f"ma-{when}-{dose}",
         "subject": {"reference": f"Patient/{pid}"},
         "medicationCodeableConcept": {"coding": [{"system": DRUG, "code": code}]}}
    if when:
        r["effectiveDateTime"] = when
    if period:
        r["effectivePeriod"] = {"start": period}
    if dose:
        r["dosage"] = {"dose": {"value": dose, "unit": "mEq", "code": "mEq"}}
    if enc:
        r["context"] = {"reference": enc}
    r.update(extra)
    return r


def test_G2_latest_dose_uses_period_start_and_excludes_conflicting_ties():
    P = {"code_system": DRUG, "code": "K1"}
    g = gold("G2", [_ma("2140-01-01T00:00:00Z", dose="20"), _ma(period="2140-01-02T00:00:00Z", dose="10")], P)
    assert (g["answer"], g["unit"], g["timestamp"]) == ("10", "mEq", "2140-01-02T00:00:00Z")
    g = gold("G2", [_ma("2140-01-02T00:00:00Z", dose="20"), _ma("2140-01-02T00:00:00Z", dose="10")], P)
    assert g["answer_kind"] is None


def test_G1_drugs_given_during_stay():
    rs = [_ma("2140-01-01T00:00:00Z", code="A", enc="Encounter/e1", mid="m1"),
          _ma("2140-01-01T01:00:00Z", code="A", enc="Encounter/e1", mid="m2"),
          _ma("2140-01-01T02:00:00Z", code="B", enc="Encounter/e2", mid="m3")]
    g = gold("G1", rs, {"encounter": "Encounter/e1"}, form="list")
    assert g["answer_list"] == ["A"] and len(g["items"]) == 2


def _med(mid, name=None, ingredients=None, ident=None):
    r = {"resourceType": "Medication", "id": mid}
    if name:
        r["identifier"] = [{"system": "http://example.org/medication-name", "value": name}]
    if ident:
        r.setdefault("identifier", []).append(ident)
    if ingredients:
        r["ingredient"] = [{"itemReference": {"reference": f"Medication/{i}"}} for i in ingredients]
    return r


def _mr(mid, med=None, concept=None, when="2140-01-01T00:00:00Z", status="completed", enc=None,
        dose=None, route=None):
    r = {"resourceType": "MedicationRequest", "id": mid, "subject": {"reference": f"Patient/{PID}"},
         "status": status, "authoredOn": when}
    if med:
        r["medicationReference"] = {"reference": f"Medication/{med}"}
    if concept:
        r["medicationCodeableConcept"] = {"text": concept}
    if enc:
        r["encounter"] = {"reference": enc}
    di = {}
    if route:
        di["route"] = {"coding": [{"code": route}]}
    if dose:
        di["doseAndRate"] = [{"doseQuantity": dose}]
    if di:
        r["dosageInstruction"] = [di]
    return r


def test_O1_mimic_names_mixes_by_ingredients_and_lists_medication_records():
    rs = [_med("a", "Drug A"), _med("d", "Diluent B"), _med("mix", ingredients=["a", "d"]),
          _mr("r1", med="mix", enc="Encounter/e1"), _mr("r2", concept="Drug C", enc="Encounter/e1"),
          _mr("r3", med="a", enc="Encounter/e9")]
    g = gold("O1", rs, {"encounter": "Encounter/e1"}, form="list")
    assert g["answer_list"] == ["Drug A + Diluent B", "Drug C"]
    assert "Medication/mix" in g["depends_on"] and "Medication/a" in g["depends_on"]


def test_O1_synthea_active_orders_only():
    rs = [_mr("r1", concept="Drug A", status="active"), _mr("r2", concept="Drug B", status="stopped")]
    g = gold("O1", rs, {}, dataset="synthea-dev", form="list")
    assert g["answer_list"] == ["Drug A"]


def test_O2_dose_and_route_of_latest_order():
    rs = [_med("m", "Drug M"),
          _mr("r1", med="m", when="2140-01-01T00:00:00Z", dose={"value": "15", "unit": "mg"}, route="PO"),
          _mr("r2", med="m", when="2140-01-02T00:00:00Z", dose={"value": "30.0", "unit": "mg"}, route="IV")]
    g = gold("O2", rs, {"medication": "Medication/m", "display": "Drug M"})
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("30", "30.0", "mg")
    assert g["answer_list"] == ["route: IV"]


def test_O4_dose_without_unit():
    rs = [_mr("r1", concept="Drug A", dose={"value": "1.0"})]
    g = gold("O4", rs, {"record": "MedicationRequest/r1"}, dataset="synthea-dev")
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("1", "1.0", None)
    assert g["lexeme_eligible"] is True


def test_G3_counts_dispensings_matched_through_the_medication_record():
    rs = [_med("m", ident={"system": DRUG, "value": "GG"}),
          {"resourceType": "MedicationDispense", "id": "d1", "subject": {"reference": f"Patient/{PID}"},
           "medicationReference": {"reference": "Medication/m"}},
          {"resourceType": "MedicationDispense", "id": "d2", "subject": {"reference": f"Patient/{PID}"},
           "medicationCodeableConcept": {"coding": [{"system": DRUG, "code": "GG"}]}},
          {"resourceType": "MedicationDispense", "id": "d3", "subject": {"reference": f"Patient/{PID}"},
           "medicationCodeableConcept": {"coding": [{"system": DRUG, "code": "XX"}]}}]
    g = gold("G3", rs, {"code_system": DRUG, "code": "GG"}, form="count")
    assert g["answer"] == "2"


# ------------------------------------------------------------------ microbiology


def _micro():
    spec = {"resourceType": "Specimen", "id": "s1", "subject": {"reference": f"Patient/{PID}"},
            "type": {"coding": [{"display": "SPEC-1"}]},
            "collection": {"collectedDateTime": "2133-02-21T20:00:00-05:00"}}  # UTC 2133-02-22
    test = obs("t", "2133-02-22T01:00:00Z", oid="test", specimen={"reference": "Specimen/s1"},
               system="http://example.org/microbiology-test", hasMember=[{"reference": "Observation/org"}])
    org = obs("o", "2133-02-23T00:00:00Z", oid="org", derivedFrom=[{"reference": "Observation/test"}],
              meta={"profile": ["http://example.org/StructureDefinition/x-micro-org"]},
              code={"coding": [{"display": "ORG-1"}]},
              hasMember=[{"reference": "Observation/s-r"}, {"reference": "Observation/s-s"}])
    sr = obs("abx", "2133-02-24T00:00:00Z", oid="s-r", code={"coding": [{"display": "ABX-1"}]},
             derivedFrom=[{"reference": "Observation/org"}], valueCodeableConcept={"coding": [{"code": "R"}]})
    ss = obs("abx", "2133-02-24T00:00:00Z", oid="s-s", code={"coding": [{"display": "ABX-2"}]},
             derivedFrom=[{"reference": "Observation/org"}], valueCodeableConcept={"coding": [{"code": "S"}]})
    return [spec, test, org, sr, ss]


def test_B1_organisms_by_utc_collection_date():
    g = gold("B1", _micro(), {"date": "2133-02-22"}, form="list")
    assert g["answer_list"] == ["ORG-1 (SPEC-1)"]  # ruling B1
    g = gold("B1", _micro(), {"date": "2133-02-21"}, form="list")
    assert g["answer_kind"] == "none"


def test_B2_resistant_antibiotics():
    g = gold("B2", _micro(), {"record": "Observation/org"}, form="list")
    assert g["answer_list"] == ["ABX-1"]
    assert set(g["depends_on"]) == {"Observation/s-r", "Observation/s-s"}  # G-R1: the organism is not fetched


# ------------------------------------------------------------------ conditions, procedures, encounters


def _cond(cid, code, enc=None, status=None, name=None, system=DX):
    r = {"resourceType": "Condition", "id": cid, "subject": {"reference": f"Patient/{PID}"},
         "code": {"coding": [{"system": system, "code": code, "display": name or f"Dx {code}"}]}}
    if enc:
        r["encounter"] = {"reference": enc}
    if status:
        r["clinicalStatus"] = {"coding": [{"code": status}]}
    return r


def test_C1_C2_C3():
    rs = [_cond("c1", "250", "Encounter/e1", "active"), _cond("c2", "401", "Encounter/e1", "resolved"),
          _cond("c3", "250", "Encounter/e2", "active")]
    assert gold("C1", rs, {"encounter": "Encounter/e1"}, form="list")["answer_list"] == ["250", "401"]
    yes = gold("C2", rs, {"code_system": DX, "code": "401"}, form="yes_no")
    no = gold("C2", rs, {"code_system": DX, "code": "999"}, form="yes_no")
    assert (yes["answer"], no["answer"], no["answer_kind"]) == ("yes", "no", "value")
    assert gold("C3", rs, {}, dataset="synthea-dev", form="list")["answer_list"] == ["Dx 250"]


def _proc(pid_, code, when=None, period=None, enc=None):
    r = {"resourceType": "Procedure", "id": pid_, "subject": {"reference": f"Patient/{PID}"},
         "code": {"coding": [{"system": DX, "code": code, "display": f"Proc {code}"}]}}
    if when:
        r["performedDateTime"] = when
    if period:
        r["performedPeriod"] = {"start": period}
    if enc:
        r["encounter"] = {"reference": enc}
    return r


def test_P1_P2():
    rs = [_proc("a", "1", "2140-01-02T00:00:00-05:00", enc="Encounter/e1"),
          _proc("b", "1", period="2140-01-02T03:00:00Z", enc="Encounter/e1"),  # earlier instant
          _proc("c", "2", "2139-01-01T00:00:00Z")]
    assert gold("P1", rs, {"encounter": "Encounter/e1"}, form="list")["answer_list"] == ["Proc 1"]
    g = gold("P2", rs, {"code_system": DX, "code": "1"}, form="datetime")
    assert g["answer"] == "2140-01-02T03:00:00Z" and g["provenance"] == ["Procedure/b"]


def _enc(eid, start, end=None, cls="AMB", reason=None, etype=None, locations=None):
    r = {"resourceType": "Encounter", "id": eid, "subject": {"reference": f"Patient/{PID}"},
         "class": {"code": cls}, "period": {"start": start, **({"end": end} if end else {})}}
    if reason:
        r["reasonCode"] = [{"text": reason}]
    if etype:
        r["type"] = [{"coding": [{"system": DX, "code": etype}]}]
    if locations:
        r["location"] = [{"location": {"reference": f"Location/{x}"}} for x in locations]
    return r


def test_E1_to_E5():
    rs = [_enc("e1", "2140-01-01T22:00:00-05:00", "2140-01-02T10:30:00-05:00", "CLS-A",
               reason="Reason 1", etype="chk", locations=["l1"]),
          _enc("e2", "2140-02-01T00:00:00Z", cls="CLS-B", etype="chk"),
          _enc("e3", "2140-02-01T05:00:00Z", cls="CLS-B", reason="Reason 2"),
          {"resourceType": "Location", "id": "l1", "name": "Unit 1"}]
    g = gold("E1", rs, {}, form="list")
    assert g["answer_list"] == ["CLS-A: 1", "CLS-B: 2"] and g["answer"] == "3"
    assert gold("E2", rs, {"encounter": "Encounter/e1"}, form="list")["answer_list"] == ["Unit 1"]
    g = gold("E3", rs, {"encounter": "Encounter/e1"})
    assert (g["answer"], g["unit"]) == ("12.5", "h")
    assert gold("E4", rs, {"date": "2140-01-02"}, dataset="synthea-dev", form="list")["answer_list"] == ["Reason 1"]
    g = gold("E4", rs, {"date": "2140-02-01"}, dataset="synthea-dev", form="list")
    assert g["answer_list"] == ["Reason 2"]
    g = gold("E5", rs, {"code_system": DX, "code": "chk"}, dataset="synthea-dev", form="datetime")
    assert g["answer"] == "2140-02-01T00:00:00Z"


def test_D1_alive_and_dead():
    g = gold("D1", [], {}, form="list")
    assert g["answer_list"] == ["birth date: 2100-01-02", "date of death: alive", "sex: female"]


# ------------------------------------------------------------------ Synthea groups


def _doc(did, when, text):
    return {"resourceType": "DocumentReference", "id": did, "subject": {"reference": f"Patient/{PID}"},
            "date": when, "content": [{"attachment": {"contentType": "text/plain",
                                                       "data": base64.b64encode(text.encode()).decode()}}]}


def test_N1_N2_note_parsing_keeps_names_with_commas():
    note = ("# History of Present Illness\nAnn\n is a 50 year-old. Patient has a history of "
            "localized, primary osteoarthritis of the hand, sprain of ankle.\n\n# Assessment and Plan\n"
            "Patient is presenting with viral sinusitis (disorder). \n")
    rs = [_doc("old", "2000-01-01T00:00:00Z", "Patient has a history of gout."),
          _doc("new", "2001-01-01T00:00:00-05:00", note),
          _cond("c1", "1", name="Localized, primary osteoarthritis of the hand")]
    assert gold("N1", rs, {}, dataset="synthea-dev", form="count")["answer"] == "2"
    g = gold("N2", rs, {}, dataset="synthea-dev", form="list")
    assert g["answer_list"] == ["localized, primary osteoarthritis of the hand", "sprain of ankle",
                                "viral sinusitis (disorder)"]
    assert g["provenance"] == ["DocumentReference/new"]


def test_N3_latest_lab_report_results():
    cat = {"coding": [{"system": "http://example.org/cat", "code": "LAB"}]}
    rs = [obs("g", "2001-01-01T00:00:00Z", "5", oid="r1", code={"text": "Glucose"}),
          obs("n", "2001-01-01T00:00:00Z", "7", oid="r2", code={"text": "Sodium"}),
          {"resourceType": "DiagnosticReport", "id": "dr1", "subject": {"reference": f"Patient/{PID}"},
           "category": [cat], "effectiveDateTime": "2001-01-01T00:00:00Z",
           "result": [{"reference": "Observation/r1"}, {"reference": "Observation/r2"}]},
          {"resourceType": "DiagnosticReport", "id": "dr0", "subject": {"reference": f"Patient/{PID}"},
           "category": [cat], "effectiveDateTime": "2000-01-01T00:00:00Z", "result": []}]
    g = gold("N3", rs, {"code_system": "http://example.org/cat", "code": "LAB"}, dataset="synthea-dev", form="list")
    assert g["answer_list"] == ["Glucose", "Sodium"]


def _claim(cid, created, enc=None, total="10.50"):
    r = {"resourceType": "Claim", "id": cid, "patient": {"reference": f"Patient/{PID}"}, "created": created,
         "total": {"value": total, "currency": "USD"}}
    if enc:
        r["item"] = [{"encounter": [{"reference": enc}]}]
    return r


def test_F1_F2_F3():
    rs = [_claim("c1", "1998-12-31T20:00:00-05:00", "Encounter/e1"),   # UTC 1999-01-01
          _claim("c2", "1998-06-01T00:00:00Z", "Encounter/e2"), _claim("c3", "1998-06-02T00:00:00Z", "Encounter/e2"),
          {"resourceType": "ExplanationOfBenefit", "id": "x1", "patient": {"reference": f"Patient/{PID}"},
           "claim": {"reference": "Claim/c1"}, "payment": {"amount": {"value": "0.0", "currency": "USD"}}}]
    g = gold("F1", rs, {"encounter": "Encounter/e1"}, dataset="synthea-dev")
    assert (g["answer"], g["value_as_recorded"], g["unit"]) == ("10.5", "10.50", "USD")
    assert gold("F1", rs, {"encounter": "Encounter/e2"}, dataset="synthea-dev")["answer_kind"] is None
    assert gold("F2", rs, {"year": "1998"}, dataset="synthea-dev", form="count")["answer"] == "2"
    assert gold("F2", rs, {"year": "1999"}, dataset="synthea-dev", form="count")["answer"] == "1"
    g = gold("F3", rs, {"claim": "Claim/c1"}, dataset="synthea-dev")
    assert (g["answer"], g["value_as_recorded"], g["lexeme_eligible"]) == ("0", "0.0", True)


def test_I1_I2_A1():
    def imm(i, when, code):
        return {"resourceType": "Immunization", "id": i, "patient": {"reference": f"Patient/{PID}"},
                "occurrenceDateTime": when, "vaccineCode": {"coding": [{"system": DRUG, "code": code}]}}
    rs = [imm("i1", "2001-01-01T00:00:00Z", "140"), imm("i2", "2002-01-01T00:00:00Z", "140"),
          imm("i3", "2003-01-01T00:00:00Z", "08")]
    assert gold("I1", rs, {}, dataset="synthea-dev", form="count")["answer"] == "3"
    assert gold("I2", rs, {"code_system": DRUG, "code": "140"}, dataset="synthea-dev",
                form="datetime")["answer"] == "2002-01-01T00:00:00Z"
    g = gold("A1", rs, {}, dataset="synthea-dev", form="list")
    assert g["answer_kind"] == "none" and g["answer_list"] is None


def test_K1_K2():
    plan = {"resourceType": "CarePlan", "id": "cp", "subject": {"reference": f"Patient/{PID}"}, "status": "active",
            "activity": [{"detail": {"code": {"text": "Diet"}}}, {"detail": {"code": {"text": "Diet"}}},
                         {"detail": {"code": {"text": "Exercise"}}}]}
    team = {"resourceType": "CareTeam", "id": "ct", "subject": {"reference": f"Patient/{PID}"},
            "participant": [{"role": [{"text": "Doctor"}], "member": {"display": "Dr. A"}},
                            {"role": [{"text": "Patient"}], "member": {"reference": f"Patient/{PID}", "display": "Ms. B"}}]}
    assert gold("K1", [plan], {"record": "CarePlan/cp"}, dataset="synthea-dev", form="list")["answer_list"] == ["Diet", "Exercise"]
    assert gold("K2", [team], {"record": "CareTeam/ct"}, dataset="synthea-dev",
                form="list")["answer_list"] == ["Dr. A | Doctor", "Ms. B | Patient"]


def test_M1_M2_V1():
    def study(sid, started, mod, site, n_inst):
        return {"resourceType": "ImagingStudy", "id": sid, "subject": {"reference": f"Patient/{PID}"},
                "started": started, "numberOfSeries": "1", "numberOfInstances": str(n_inst),
                "series": [{"modality": {"code": mod, "display": mod + " name"}, "bodySite": {"display": site},
                            "instance": [{"uid": str(i)} for i in range(n_inst)]}]}
    rs = [study("s1", "2000-01-01T00:00:00Z", "MR", "Head", 2), study("s2", "2001-01-01T00:00:00Z", "US", "Heart", 3),
          {"resourceType": "Device", "id": "d1", "patient": {"reference": f"Patient/{PID}"}, "type": {"text": "Stent"}}]
    assert gold("M1", rs, {}, dataset="synthea-dev", form="list")["answer_list"] == ["body site: Heart", "modality: US name"]
    assert gold("M2", rs, {"record": "ImagingStudy/s1"}, dataset="synthea-dev",
                form="list")["answer_list"] == ["instances: 2", "series: 1"]
    assert gold("V1", rs, {}, dataset="synthea-dev", form="list")["answer_list"] == ["Stent"]


def test_answer_list_is_utf8_byte_sorted_and_deduplicated():
    rs = [_cond("c1", "b", status="active", name="Zeta"), _cond("c2", "a", status="active", name="alpha"),
          _cond("c3", "c", status="active", name="Émile"), _cond("c4", "d", status="active", name="Zeta")]
    g = gold("C3", rs, {}, dataset="synthea-dev", form="list")
    assert g["answer_list"] == ["Zeta", "alpha", "Émile"]
    assert g["implementation"] == "py" and g["schema"] == "fbbench.gold/1"
    assert PID == g["patient_id"]
