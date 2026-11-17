"""Gold rulings (bench/GOLD-RULINGS.md) in the Python gold: G-R1, G-R2 and the per-template rulings. Synthetic data."""

from fixtures import LAB, PID, gold, obs

P = {"reference": f"Patient/{PID}"}
CS = "http://example.org/cs"
MICRO = "http://example.org/CodeSystem/microbiology"
A1 = {"code_system": LAB, "code": "a1", "display": "A1"}


def refs(items):
    return sorted(i["ref"] for i in items)


def test_G_R2_equal_values_at_the_latest_instant_are_all_items():
    rs = [obs("a1", "2020-01-01T00:00:00Z", "5.0", unit="mg/dL", oid="o1"),
          obs("a1", "2020-02-01T00:00:00Z", "7.0", unit="mg/dL", oid="o3"),
          obs("a1", "2020-02-01T00:00:00+00:00", "7.0", unit="mg/dL", oid="o2")]
    g = gold("L1", rs, A1)
    assert g["answer"] == "7"
    assert refs(g["items"]) == ["Observation/o2", "Observation/o3"]
    assert sorted(g["depends_on"]) == ["Observation/o1", "Observation/o2", "Observation/o3"]


def test_G_R2_differing_values_at_the_latest_instant_exclude_the_candidate():
    rs = [obs("a1", "2020-02-01T00:00:00Z", "7.0", unit="mg/dL", oid="o1"),
          obs("a1", "2020-02-01T00:00:00Z", "7.5", unit="mg/dL", oid="o2")]
    g = gold("L1", rs, A1)
    assert g["answer_kind"] is None and any(n.startswith("unanswerable:") for n in g["rule_notes"])
    enc = lambda i, s: {"resourceType": "Encounter", "id": i, "subject": P, "period": {"start": s},  # noqa: E731
                        "type": [{"coding": [{"system": CS, "code": "chk", "display": "Check"}]}]}
    e = gold("E5", [enc("e1", "2020-01-01T08:00:00Z"), enc("e2", "2020-01-01T08:00:00Z"), enc("e0", "2019-01-01T08:00:00Z")],
             {"code_system": CS, "code": "chk", "display": "Check"}, form="datetime")
    assert e["answer"] == "2020-01-01T08:00:00Z"
    assert refs(e["items"]) == ["Encounter/e1", "Encounter/e2"]


def _ma(i, t, dose):
    return {"resourceType": "MedicationAdministration", "id": i, "status": "completed", "subject": P, "effectiveDateTime": t,
            "medicationCodeableConcept": {"coding": [{"system": CS, "code": "d1", "display": "Drug 1"}]},
            "dosage": {"dose": {"value": dose, "unit": "mg"}}}


def test_G2_ties_follow_G_R2():
    d1 = {"code_system": CS, "code": "d1", "display": "Drug 1"}
    g = gold("G2", [_ma("m1", "2020-01-01T00:00:00Z", "1"), _ma("m2", "2020-03-01T00:00:00Z", "2"),
                    _ma("m3", "2020-03-01T00:00:00Z", "2")], d1)
    assert g["answer"] == "2"
    assert refs(g["items"]) == ["MedicationAdministration/m2", "MedicationAdministration/m3"]
    g = gold("G2", [_ma("m2", "2020-03-01T00:00:00Z", "2"), _ma("m3", "2020-03-01T00:00:00Z", "3")], d1)
    assert g["answer_kind"] is None


def test_E1_answer_is_the_total_and_the_list_is_per_class():
    enc = lambda i, c: {"resourceType": "Encounter", "id": i, "subject": P, "class": {"code": c},  # noqa: E731
                        "period": {"start": "2020-01-01T00:00:00Z"}}
    g = gold("E1", [enc("e1", "AMB"), enc("e2", "AMB"), enc("e3", "EMER")], {}, form="list")
    assert (g["answer"], g["answer_list"], g["answer_kind"]) == ("3", ["AMB: 2", "EMER: 1"], "list")


def _micro():
    return [
        {"resourceType": "Specimen", "id": "s1", "subject": P, "type": {"coding": [{"display": "URINE"}]},
         "collection": {"collectedDateTime": "2133-02-21T20:00:00-05:00"}},
        obs("a1", "2133-02-22T01:00:00Z", "1.0", unit="mg/dL", oid="chem", specimen={"reference": "Specimen/s1"}),
        {"resourceType": "Observation", "id": "test", "subject": P, "specimen": {"reference": "Specimen/s1"},
         "code": {"coding": [{"system": f"{MICRO}-test", "code": "t", "display": "Culture"}]}, "effectiveDateTime": "2133-02-22T01:00:00Z"},
        {"resourceType": "Observation", "id": "org", "subject": P, "derivedFrom": [{"reference": "Observation/test"}],
         "code": {"coding": [{"system": f"{MICRO}-organism", "code": "o", "display": "E. COLI"}]}, "effectiveDateTime": "2133-02-23T00:00:00Z"},
        {"resourceType": "Observation", "id": "sr", "subject": P, "derivedFrom": [{"reference": "Observation/org"}],
         "code": {"coding": [{"system": f"{MICRO}-antibiotic", "code": "a", "display": "ABX-R"}]},
         "valueCodeableConcept": {"coding": [{"code": "R"}]}, "effectiveDateTime": "2133-02-24T00:00:00Z"},
        {"resourceType": "Observation", "id": "ss", "subject": P, "derivedFrom": [{"reference": "Observation/org"}],
         "code": {"coding": [{"system": f"{MICRO}-antibiotic", "code": "b", "display": "ABX-S"}]},
         "valueCodeableConcept": {"coding": [{"code": "S"}]}, "effectiveDateTime": "2133-02-24T00:00:00Z"},
    ]


def test_B1_microbiology_records_the_plan_reaches_and_organism_specimen_entries():
    g = gold("B1", _micro(), {"date": "2133-02-22"}, form="list")
    assert g["answer_list"] == ["E. COLI (URINE)"]
    assert sorted(g["depends_on"]) == ["Observation/org", "Observation/test", "Specimen/s1"]  # no chemistry, no susceptibilities


def test_B2_organism_stays_out_of_depends_on():
    g = gold("B2", _micro(), {"record": "Observation/org", "display": "E. COLI", "date": "2133-02-23"}, form="list")
    assert g["answer_list"] == ["ABX-R"]
    assert sorted(g["depends_on"]) == ["Observation/sr", "Observation/ss"]


def test_E2_items_are_the_locations_and_the_encounter_stays_in_depends_on():
    enc = {"resourceType": "Encounter", "id": "icu", "subject": P, "period": {"start": "2020-01-01T00:00:00Z"},
           "location": [{"location": {"reference": "Location/l1"}, "period": {"start": "2020-01-01T01:00:00Z"}},
                        {"location": {"reference": "Location/l2"}, "period": {"start": "2020-01-02T01:00:00Z"}}]}
    locs = [{"resourceType": "Location", "id": "l1", "name": "MICU"}, {"resourceType": "Location", "id": "l2", "name": "SICU"}]
    g = gold("E2", [enc] + locs, {"encounter": "Encounter/icu", "encounter_start": "2020-01-01T00:00:00Z"}, form="list")
    assert g["answer_list"] == ["MICU", "SICU"]
    # G-R3: a Location carries no time, so its item is untimed.
    assert [(i["ref"], i["time"]) for i in g["items"]] == [("Location/l1", None), ("Location/l2", None)]
    assert sorted(g["depends_on"]) == ["Encounter/icu", "Location/l1", "Location/l2"]


def test_O2_medication_and_ingredients_in_depends_on_and_route_in_answer_list():
    def mr(i, t):
        return {"resourceType": "MedicationRequest", "id": i, "status": "completed", "subject": P, "authoredOn": t,
                "medicationReference": {"reference": "Medication/mix"},
                "dosageInstruction": [{"route": {"text": "IV"}, "doseAndRate": [{"doseQuantity": {"value": "500", "unit": "mg"}}]}]}
    meds = [{"resourceType": "Medication", "id": "mix", "ingredient": [{"itemReference": {"reference": "Medication/a"}},
                                                                     {"itemReference": {"reference": "Medication/b"}}]},
            {"resourceType": "Medication", "id": "a", "code": {"text": "Drug A"}},
            {"resourceType": "Medication", "id": "b", "code": {"text": "Drug B"}}]
    g = gold("O2", [mr("r1", "2020-01-01T00:00:00Z"), mr("r2", "2020-02-01T00:00:00Z")] + meds,
             {"medication": "Medication/mix", "display": "Drug A + Drug B"})
    assert (g["answer"], g["answer_list"]) == ("500", ["route: IV"])
    assert refs(g["items"]) == ["MedicationRequest/r2"]
    assert sorted(g["depends_on"]) == ["Medication/a", "Medication/b", "Medication/mix",
                                       "MedicationRequest/r1", "MedicationRequest/r2"]


def test_K1_depends_on_every_active_care_plan():
    def plan(i, status, cat):
        return {"resourceType": "CarePlan", "id": i, "status": status, "subject": P, "category": [{"text": cat}],
                "period": {"start": "2020-01-01T00:00:00Z"}, "activity": [{"detail": {"code": {"text": f"{cat} activity"}}}]}
    g = gold("K1", [plan("c1", "active", "Diet"), plan("c2", "active", "Exercise"), plan("c3", "completed", "Diet")],
             {"record": "CarePlan/c1", "display": "Diet"}, form="list")
    assert g["answer_list"] == ["Diet activity"]
    assert sorted(g["depends_on"]) == ["CarePlan/c1", "CarePlan/c2"]
