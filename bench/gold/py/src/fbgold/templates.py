"""One function per question template. Each reads the question's parameters and the store only.

Readings chosen where the template text is open are listed in bench/GOLD-RULINGS.md and cited in
``rule_notes`` by their tag (for example ``L1-a``).
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from typing import Any, Callable

from . import fhir
from .datasets import FAMILIES
from .fhir import concept_has, concept_name, ref_of, reference
from .result import Result, item, items_lexeme_eligible, refs
from .store import Store
from .values import (
    Instant,
    canonical,
    hours_between,
    in_half_open,
    parse_instant,
    round_half_up,
    utc_date,
)


@dataclass
class Ctx:
    question: dict[str, Any]
    store: Store

    @property
    def pid(self) -> str:
        return self.question["patient_id"]

    @property
    def p(self) -> dict[str, str]:
        return self.question.get("parameters") or {}

    def mine(self, rtype: str) -> list[dict[str, Any]]:
        return self.store.for_patient(rtype, self.pid)

    def record(self, ref: str) -> dict[str, Any] | None:
        """A referenced record, only if it belongs to the question's patient (or is shared)."""
        r = self.store.get(ref)
        if r is None:
            return None
        from .store import SHARED_TYPES, patient_of

        if r.get("resourceType") in SHARED_TYPES:
            return r
        return r if patient_of(r) == self.pid else None


def unanswerable(note: str, depends: list[str] | None = None) -> Result:
    return Result(answer_kind=None, depends_on=depends or [], rule_notes=["unanswerable: " + note])


def none_result(depends: list[str], notes: list[str] | None = None,
                items: list[dict[str, Any]] | None = None,
                provenance: list[str] | None = None) -> Result:
    return Result(answer_kind="none", depends_on=depends, rule_notes=notes or [],
                  items=items or [], provenance=provenance or [])


def extreme(cands: list[dict[str, Any]], time_fn: Callable[[dict[str, Any]], Instant | None],
            latest: bool = True) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Records at the latest (or earliest) parsed instant, and records without a usable time."""
    timed = [(time_fn(r), r) for r in cands]
    untimed = [r for t, r in timed if t is None]
    timed2 = [(t, r) for t, r in timed if t is not None]
    if not timed2:
        return [], untimed
    pick = max if latest else min
    best = pick(t.utc for t, _ in timed2)
    top = [r for t, r in timed2 if t.utc == best]
    top.sort(key=lambda r: r["id"])
    return top, untimed


def list_result(names: list[str], items: list[dict[str, Any]], provenance: list[str],
                depends: list[str], notes: list[str] | None = None) -> Result:
    names = [n for n in names if n is not None]
    if not names:
        return none_result(depends, notes, items, provenance)
    return Result(answer_kind="list", answer_list=names, items=items, provenance=provenance,
                  depends_on=depends, rule_notes=notes or [])


def count_result(records: list[dict[str, Any]], time_fn=None, notes: list[str] | None = None) -> Result:
    its = [item(r, time=time_fn(r) if time_fn else None) for r in records]
    its.sort(key=_item_sort)
    rs = refs(records)
    return Result(answer_kind="value", answer=str(len(records)), items=its, provenance=rs,
                  depends_on=rs, rule_notes=notes or [])


def _item_sort(it: dict[str, Any]):
    inst = parse_instant(it.get("time"))
    return (0 if inst else 1, inst.utc.isoformat() if inst else "", it["ref"])


def coded(ctx: Ctx, rtype: str, field: str) -> list[dict[str, Any]]:
    system, code = ctx.p["code_system"], ctx.p["code"]
    return [r for r in ctx.mine(rtype) if fhir.any_concept_has(r.get(field), system, code)]


def value_result(res_rec: dict[str, Any], vf: dict[str, Any] | None, t: Instant | None,
                 depends: list[str], notes: list[str], display: str | None = None) -> Result:
    if vf is None:
        return none_result(depends, notes + ["no value[x] on the record"],
                           [item(res_rec, time=t, display=display)], [ref_of(res_rec)])
    return Result(answer_kind="value", answer=vf["value"], value_as_recorded=vf["value_as_recorded"],
                  unit=vf["unit"], timestamp=t.text if t else None,
                  items=[item(res_rec, vf, t, display)], provenance=[ref_of(res_rec)],
                  depends_on=depends, rule_notes=notes)


# ====================================================================== Observations


def latest_value(ctx: Ctx, cands: list[dict[str, Any]], depends: list[str], notes: list[str]) -> Result:
    top, untimed = extreme(cands, fhir.observation_time)
    if untimed:
        notes = notes + [f"G5: {len(untimed)} candidate(s) without a time ignored"]
    if not top:
        return none_result(depends, notes + ["no candidate record"])
    vals = {(fhir.observation_value(r) or {}).get("value") for r in top}
    units = {(fhir.observation_value(r) or {}).get("unit") for r in top}
    if len(vals) > 1 or len(units) > 1:
        return unanswerable("latest-instant tie with differing values (G-R2: excluded)", depends)
    first = top[0]
    vf = fhir.observation_value(first)
    t = fhir.observation_time(first)
    r = value_result(first, vf, t, depends, notes)
    if len(top) > 1:
        r.rule_notes.append(f"G6: {len(top)} records tie at the latest instant with equal values; all are listed")
        r.items = [item(x, fhir.observation_value(x), fhir.observation_time(x)) for x in top]
        r.provenance = refs(top)
    return r


def t_L1(ctx: Ctx) -> Result:
    allx = coded(ctx, "Observation", "code")
    cands = [r for r in allx if fhir.observation_value(r) is not None]
    return latest_value(ctx, cands, refs(allx), ["L1-a"])


def t_L10(ctx: Ctx) -> Result:
    allx = coded(ctx, "Observation", "code")
    cands = [r for r in allx if fhir.observation_value(r) is not None]
    return latest_value(ctx, cands, refs(allx), ["L1-a", "L10-a"])


def t_L7(ctx: Ctx) -> Result:
    allx = coded(ctx, "Observation", "code")
    cands = [r for r in allx
             if (v := fhir.observation_value(r)) is not None and v["kind"] == "text"]
    return latest_value(ctx, cands, refs(allx), ["L7-a"])


def window_list(ctx: Ctx, notes: list[str]) -> Result:
    start = parse_instant(ctx.p["window_start"])
    end = parse_instant(ctx.p["window_end"])
    allx = coded(ctx, "Observation", "code")
    inside = []
    for r in allx:
        t = fhir.observation_time(r)
        if t is not None and in_half_open(t, start, end):
            inside.append(r)
    its = [item(r, fhir.observation_value(r), fhir.observation_time(r)) for r in inside]
    its.sort(key=_item_sort)
    names = []
    for it in its:
        v = it["value"] if it["value"] is not None else "(no value)"
        names.append(f"{v} {it['unit']} @ {it['time']}" if it["unit"] else f"{v} @ {it['time']}")
    if not inside:
        return none_result([], notes + ["no record in the window"])
    return Result(answer_kind="list", answer_list=names, items=its, provenance=refs(inside),
                  depends_on=refs(inside), rule_notes=notes)


def t_L2(ctx: Ctx) -> Result:
    return window_list(ctx, ["L2-a"])


def t_L5(ctx: Ctx) -> Result:
    r = window_list(ctx, ["L2-a", "L5-a"])
    n = len(r.items)
    if not 51 <= n <= 300:
        r.rule_notes.append(f"L5-b: window holds {n} results, outside 51-300")
    return r


def t_L3(ctx: Ctx) -> Result:
    cands = coded(ctx, "Observation", "code")
    return count_result(cands, fhir.observation_time, ["L3-a"])


def t_L4(ctx: Ctx) -> Result:
    enc = ctx.p["encounter"]
    cands = [r for r in coded(ctx, "Observation", "code") if reference(r.get("encounter")) == enc]
    return count_result(cands, fhir.observation_time, ["L4-a"])


def t_L6(ctx: Ctx) -> Result:
    rec = ctx.record(ctx.p["record"])
    if rec is None:
        return unanswerable("named record not found for this patient")
    notes = ["L6-a"]
    if not concept_has(rec.get("code"), ctx.p["code_system"], ctx.p["code"]):
        notes.append("named record does not carry the stated code")
    t = fhir.observation_time(rec)
    if t is not None and ctx.p.get("record_time") and parse_instant(ctx.p["record_time"]).utc != t.utc:
        notes.append("record time differs from the question's time")
    return value_result(rec, fhir.observation_value(rec), t, [ref_of(rec)], notes)


def t_L9(ctx: Ctx) -> Result:
    rec = ctx.record(ctx.p["record"])
    if rec is None:
        return unanswerable("named record not found for this patient")
    t = fhir.observation_time(rec)
    vf = fhir.observation_value(rec)
    if vf is not None:
        return value_result(rec, vf, t, [ref_of(rec)], ["L9-a: record unexpectedly has a value"])
    dar = concept_name(rec.get("dataAbsentReason"))
    return none_result([ref_of(rec)], ["L9-a", f"dataAbsentReason: {dar}"],
                       [item(rec, time=t, display=dar)], [ref_of(rec)])


def _bp_component(obs: dict[str, Any], code: str) -> dict[str, Any] | None:
    for comp in obs.get("component") or []:
        if any(c.get("code") == code for c in fhir.codings(comp.get("code"))):
            return fhir.quantity_fields(comp.get("valueQuantity"))
    return None


SYSTOLIC, DIASTOLIC = "8480-6", "8462-4"


def t_L8(ctx: Ctx) -> Result:
    allx = coded(ctx, "Observation", "code")
    cands = [r for r in allx if _bp_component(r, SYSTOLIC) and _bp_component(r, DIASTOLIC)]
    notes = ["L8-a"]
    top, _ = extreme(cands, fhir.observation_time)
    if not top:
        return none_result(refs(allx), notes + ["no panel with both component values"])
    pairs = {(_bp_component(r, SYSTOLIC)["value"], _bp_component(r, DIASTOLIC)["value"]) for r in top}
    if len(pairs) > 1:
        return unanswerable("latest-instant tie with differing values (G-R2: excluded)", refs(allx))
    rec = top[0]
    s, d = _bp_component(rec, SYSTOLIC), _bp_component(rec, DIASTOLIC)
    t = fhir.observation_time(rec)
    unit = s["unit"] if s["unit"] == d["unit"] else f"{s['unit']}/{d['unit']}"
    if s["unit"] != d["unit"]:
        notes.append("component units differ")
    its = []
    for x in top:
        its.append(item(x, _bp_component(x, SYSTOLIC), t, "systolic"))
        its.append(item(x, _bp_component(x, DIASTOLIC), t, "diastolic"))
    return Result(answer_kind="value", answer=f"{s['value']}/{d['value']}",
                  value_as_recorded=f"{s['value_as_recorded']}/{d['value_as_recorded']}",
                  unit=unit, timestamp=t.text, items=its, provenance=refs(top),
                  depends_on=refs(allx), rule_notes=notes)


# ====================================================================== medications


def medication_name(ctx: Ctx, med: dict[str, Any] | None, depth: int = 0) -> str | None:
    if med is None or depth > 3:
        return None
    code = med.get("code")
    if isinstance(code, dict):
        if isinstance(code.get("text"), str) and code["text"].strip():
            return code["text"]
        for c in fhir.codings(code):
            if isinstance(c.get("display"), str) and c["display"].strip():
                return c["display"]
    for ident in med.get("identifier") or []:
        if str(ident.get("system", "")).endswith("medication-name") and ident.get("value"):
            return ident["value"]
    parts = []
    for ing in med.get("ingredient") or []:
        if "itemReference" in ing:
            parts.append(medication_name(ctx, ctx.record(reference(ing["itemReference"]) or ""), depth + 1))
        elif "itemCodeableConcept" in ing:
            parts.append(concept_name(ing["itemCodeableConcept"]))
    parts = [x for x in parts if x]
    if parts:
        return " + ".join(parts)
    return concept_name(code)


def med_refs(ctx: Ctx, med: dict[str, Any] | None) -> list[str]:
    """The Medication record and, for a mix, its ingredient Medications."""
    if med is None:
        return []
    out = [ref_of(med)]
    for ing in med.get("ingredient") or []:
        r = reference(ing.get("itemReference"))
        if r and ctx.record(r):
            out.append(r)
    return out


def drug_of(ctx: Ctx, rec: dict[str, Any]) -> tuple[str | None, list[str]]:
    """Drug name of a Medication* record and the Medication records it was read from."""
    if "medicationCodeableConcept" in rec:
        return concept_name(rec["medicationCodeableConcept"]), []
    ref = reference(rec.get("medicationReference"))
    med = ctx.record(ref) if ref else None
    return medication_name(ctx, med), med_refs(ctx, med)


def drugs_list(ctx: Ctx, recs: list[dict[str, Any]], time_fn, notes: list[str]) -> Result:
    names, its, extra = [], [], []
    for r in recs:
        n, mrefs = drug_of(ctx, r)
        extra += mrefs
        names.append(n)
        its.append(item(r, time=time_fn(r), display=n))
    its.sort(key=_item_sort)
    prov = refs(recs) + extra
    return list_result(names, its, prov, prov, notes)


def t_G1(ctx: Ctx) -> Result:
    enc = ctx.p["encounter"]
    recs = [r for r in ctx.mine("MedicationAdministration") if reference(r.get("context")) == enc]
    return drugs_list(ctx, recs, fhir.administration_time, ["G1-a"])


def t_O3(ctx: Ctx) -> Result:
    enc = ctx.p["encounter"]
    recs = [r for r in ctx.mine("MedicationAdministration") if reference(r.get("context")) == enc]
    return drugs_list(ctx, recs, fhir.administration_time, ["G1-a"])


def _drug_matches(ctx: Ctx, rec: dict[str, Any]) -> bool:
    system, code = ctx.p["code_system"], ctx.p["code"]
    if concept_has(rec.get("medicationCodeableConcept"), system, code):
        return True
    med = ctx.record(reference(rec.get("medicationReference")) or "")
    if med is None:
        return False
    if concept_has(med.get("code"), system, code):
        return True
    return any(i.get("system") == system and i.get("value") == code for i in med.get("identifier") or [])


def t_G2(ctx: Ctx) -> Result:
    cands = [r for r in ctx.mine("MedicationAdministration") if _drug_matches(ctx, r)]
    depends = refs(cands)
    notes = ["G2-a"]
    top, _ = extreme(cands, fhir.administration_time)
    if not top:
        return none_result(depends, notes + ["no administration of the drug"])
    doses = {(d or {}).get("value") for d in (fhir.quantity_fields((r.get("dosage") or {}).get("dose")) for r in top)}
    units = {(d or {}).get("unit") for d in (fhir.quantity_fields((r.get("dosage") or {}).get("dose")) for r in top)}
    if len(doses) > 1 or len(units) > 1:
        return unanswerable("latest-instant tie with differing doses (G-R2: excluded)", depends)
    rec = top[0]
    t = fhir.administration_time(rec)
    vf = fhir.quantity_fields((rec.get("dosage") or {}).get("dose"))
    if vf is None:
        r = none_result(depends, notes + ["G2-b: latest administration records no dose"],
                        [item(x, time=t) for x in top], refs(top))
        return r
    res = value_result(rec, vf, t, depends, notes)
    if len(top) > 1:
        res.rule_notes.append(f"G6: {len(top)} administrations tie at the latest instant with equal doses")
        res.items = [item(x, vf, t) for x in top]
        res.provenance = refs(top)
    return res


def t_G3(ctx: Ctx) -> Result:
    cands = [r for r in ctx.mine("MedicationDispense") if _drug_matches(ctx, r)]

    def when(r):
        return parse_instant(r.get("whenHandedOver")) or parse_instant(r.get("whenPrepared"))

    return count_result(cands, when, ["G3-a"])


def authored(r: dict[str, Any]) -> Instant | None:
    return parse_instant(r.get("authoredOn"))


def t_O1_mimic(ctx: Ctx) -> Result:
    enc = ctx.p["encounter"]
    recs = [r for r in ctx.mine("MedicationRequest") if reference(r.get("encounter")) == enc]
    return drugs_list(ctx, recs, authored, ["O1-a"])


def t_O1_synthea(ctx: Ctx) -> Result:
    recs = [r for r in ctx.mine("MedicationRequest") if r.get("status") == "active"]
    return drugs_list(ctx, recs, authored, ["O1-b"])


def _dose_route(mr: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    dose, route = None, None
    for di in mr.get("dosageInstruction") or []:
        if route is None and di.get("route"):
            route = concept_name(di["route"])
        for dr in di.get("doseAndRate") or []:
            if dose is None and "doseQuantity" in dr:
                dose = fhir.quantity_fields(dr["doseQuantity"])
    return dose, route


def t_O2(ctx: Ctx) -> Result:
    med_ref = ctx.p["medication"]
    cands = [r for r in ctx.mine("MedicationRequest") if reference(r.get("medicationReference")) == med_ref]
    # Ruling O2: the Medication the orders reference is in depends_on, with a mix's ingredients (they name the drug).
    depends = refs(cands) + med_refs(ctx, ctx.record(med_ref))
    notes = ["O2-a", "O2-ruling"]
    top, _ = extreme(cands, authored)
    if not top:
        return none_result(depends, notes + ["no order for the medication"])
    combos = set()
    for r in top:
        d, rt = _dose_route(r)
        combos.add(((d or {}).get("value"), (d or {}).get("unit"), rt))
    if len(combos) > 1:
        return unanswerable("latest-instant tie with differing dose or route (G-R2: excluded)", depends)
    rec = top[0]
    dose, route = _dose_route(rec)
    t = authored(rec)
    if dose is None and route is None:
        return none_result(depends, notes + ["latest order records neither dose nor route"],
                           [item(rec, time=t)], refs(top))
    res = Result(answer_kind="value", answer=dose["value"] if dose else None,
                 value_as_recorded=dose["value_as_recorded"] if dose else None,
                 unit=dose["unit"] if dose else None, timestamp=t.text if t else None,
                 answer_list=[f"route: {route}"] if route else None,
                 items=[item(x, dose, t, f"route: {route}" if route else None) for x in top],
                 provenance=refs(top), depends_on=depends, rule_notes=notes)
    if dose is None:
        res.rule_notes.append("latest order records no dose")
    return res


def t_O4(ctx: Ctx) -> Result:
    rec = ctx.record(ctx.p["record"])
    if rec is None:
        return unanswerable("named record not found for this patient")
    notes = ["O4-a"]
    if ctx.p.get("code_system") and not _drug_matches(ctx, rec):
        notes.append("named order does not carry the stated code")
    dose, _ = _dose_route(rec)
    t = authored(rec)
    if dose is None:
        return none_result([ref_of(rec)], notes + ["order records no dose quantity"],
                           [item(rec, time=t)], [ref_of(rec)])
    return value_result(rec, dose, t, [ref_of(rec)], notes)


# ====================================================================== microbiology


def t_B1(ctx: Ctx) -> Result:
    day = ctx.p["date"]
    specimens = []
    for s in ctx.mine("Specimen"):
        coll = s.get("collection") or {}
        when = coll.get("collectedDateTime") or (coll.get("collectedPeriod") or {}).get("start")
        if when and utc_date(when) == day:
            specimens.append(s)
    spec_refs = {ref_of(s) for s in specimens}
    obs = ctx.mine("Observation")
    # Ruling B1 (with G-R1): microbiology tests on those specimens and the organisms derived from them; chemistry on the
    # same specimens is excluded, and susceptibilities (derived from organisms) are not reached by the question's plan.
    tests = [o for o in obs if reference(o.get("specimen")) in spec_refs and _is_microbiology(o)]
    test_refs = {ref_of(o) for o in tests}
    orgs = [o for o in obs if any(reference(d) in test_refs for d in o.get("derivedFrom") or [])]
    names, its, prov = [], [], []
    for o in orgs:
        test = next(t for t in tests if ref_of(t) in {reference(d) for d in o.get("derivedFrom") or []})
        spec = ctx.record(reference(test.get("specimen")) or "")
        stype = concept_name((spec or {}).get("type"))
        org = concept_name(o.get("code"))
        label = f"{org} ({stype})"
        names.append(label)
        its.append(item(o, time=fhir.observation_time(o), display=label))
        prov += [ref_of(o), ref_of(test)] + ([ref_of(spec)] if spec else [])
    its.sort(key=_item_sort)
    depends = refs(specimens) + refs(tests) + refs(orgs)
    return list_result(names, its, prov, depends, ["B1-a", "B1-ruling"])


def _is_microbiology(o: dict[str, Any]) -> bool:
    """A microbiology record: its code system or its profile says so (MIMIC: mimic-microbiology-*, mimic-observation-micro-*)."""
    profiles = (o.get("meta") or {}).get("profile") or []
    return (any("microbiology" in (c.get("system") or "") for c in fhir.codings(o.get("code")))
            or any("micro" in p for p in profiles if isinstance(p, str)))


def t_B2(ctx: Ctx) -> Result:
    org_ref = ctx.p["record"]
    org = ctx.record(org_ref)
    if org is None:
        return unanswerable("named organism record not found for this patient")
    members = {reference(h) for h in org.get("hasMember") or []}
    susc = [o for o in ctx.mine("Observation")
            if ref_of(o) in members or any(reference(d) == org_ref for d in o.get("derivedFrom") or [])]
    resistant = [o for o in susc if any(c.get("code") == "R" for c in fhir.codings(o.get("valueCodeableConcept")))]
    names = [concept_name(o.get("code")) for o in resistant]
    its = [item(o, time=fhir.observation_time(o), display=concept_name(o.get("code"))) for o in resistant]
    its.sort(key=_item_sort)
    # G-R1 (ruling B2): the organism record is the question's given, not fetched by the plan; depends_on is the
    # susceptibilities the plan's derived-from search returns.
    depends = refs([o for o in susc if any(reference(d) == org_ref for d in o.get("derivedFrom") or [])])
    return list_result(names, its, refs(resistant), depends, ["B2-a", "G-R1"])


# ====================================================================== conditions, procedures


def t_C1(ctx: Ctx) -> Result:
    enc = ctx.p["encounter"]
    recs = [r for r in ctx.mine("Condition") if reference(r.get("encounter")) == enc]
    names, its = [], []
    for r in recs:
        codes = [c.get("code") for c in fhir.codings(r.get("code")) if c.get("code")]
        names += codes[:1]
        its.append(item(r, display=codes[0] if codes else None))
    its.sort(key=lambda i: i["ref"])
    return list_result(names, its, refs(recs), refs(recs), ["C1-a"])


def t_C2(ctx: Ctx) -> Result:
    matches = coded(ctx, "Condition", "code")
    if matches:
        its = [item(r, display=concept_name(r.get("code"))) for r in matches]
        return Result(answer_kind="value", answer="yes", items=its, provenance=refs(matches),
                      depends_on=refs(matches), rule_notes=["C2-a"])
    return Result(answer_kind="value", answer="no", rule_notes=["C2-a"])


def t_C3(ctx: Ctx) -> Result:
    recs = [r for r in ctx.mine("Condition")
            if any(c.get("code") == "active" for c in fhir.codings(r.get("clinicalStatus")))]
    names = [concept_name(r.get("code")) for r in recs]
    its = [item(r, display=concept_name(r.get("code"))) for r in recs]
    its.sort(key=lambda i: i["ref"])
    return list_result(names, its, refs(recs), refs(recs), ["C3-a"])


def t_P1(ctx: Ctx) -> Result:
    enc = ctx.p["encounter"]
    recs = [r for r in ctx.mine("Procedure") if reference(r.get("encounter")) == enc]
    names = [concept_name(r.get("code")) for r in recs]
    its = [item(r, time=fhir.procedure_time(r), display=concept_name(r.get("code"))) for r in recs]
    its.sort(key=_item_sort)
    return list_result(names, its, refs(recs), refs(recs), ["P1-a"])


def datetime_result(top: list[dict[str, Any]], t: Instant, depends: list[str], notes: list[str]) -> Result:
    return Result(answer_kind="value", answer=t.text, timestamp=t.text,
                  items=[item(x, time=t) for x in top], provenance=refs(top),
                  depends_on=depends, rule_notes=notes)


def t_P2(ctx: Ctx) -> Result:
    cands = coded(ctx, "Procedure", "code")
    top, _ = extreme(cands, fhir.procedure_time, latest=False)
    if not top:
        return none_result(refs(cands), ["P2-a", "no such procedure"])
    texts = {fhir.procedure_time(r).text for r in top}
    notes = ["P2-a"] + (["equal instants recorded with different lexemes"] if len(texts) > 1 else [])
    return datetime_result(top, fhir.procedure_time(top[0]), refs(cands), notes)


# ====================================================================== encounters


def t_E1(ctx: Ctx) -> Result:
    encs = ctx.mine("Encounter")
    counts: dict[str, int] = {}
    for e in encs:
        cls = e.get("class") or {}
        key = cls.get("code") or "(no class)"
        counts[key] = counts.get(key, 0) + 1
    names = [f"{k}: {v}" for k, v in counts.items()]
    its = [item(e, time=fhir.period_start(e), display=(e.get("class") or {}).get("code")) for e in encs]
    its.sort(key=_item_sort)
    res = list_result(names, its, refs(encs), refs(encs), ["E1-a"])
    if encs:
        res.answer = str(len(encs))
    return res


def t_E2(ctx: Ctx) -> Result:
    enc = ctx.record(ctx.p["encounter"])
    if enc is None:
        return unanswerable("named encounter not found for this patient")
    names, its, locs = [], [], []
    for loc in enc.get("location") or []:
        lref = reference(loc.get("location"))
        lrec = ctx.record(lref) if lref else None
        name = (lrec or {}).get("name") or (loc.get("location") or {}).get("display")
        names.append(name)
        if lrec:
            locs.append(lref)
            # An item's time must be one its own record carries; a Location has none (GOLD-RULINGS G-R3).
            its.append(item(lrec, time=None, display=name))
    its.sort(key=_item_sort)
    prov = [ref_of(enc)] + locs
    return list_result(names, its, prov, prov, ["E2-a"])


def t_E3(ctx: Ctx) -> Result:
    enc = ctx.record(ctx.p["encounter"])
    if enc is None:
        return unanswerable("named encounter not found for this patient")
    p = enc.get("period") or {}
    s, e = parse_instant(p.get("start")), parse_instant(p.get("end"))
    if s is None or e is None:
        return none_result([ref_of(enc)], ["E3-a", "encounter period lacks a start or an end"])
    hours = round_half_up(hours_between(s, e), 2)
    vf = {"value": canonical(hours), "value_as_recorded": None, "unit": "h",
          "unit_code": "h", "unit_system": None}
    res = Result(answer_kind="value", answer=vf["value"], unit="h", timestamp=s.text,
                 items=[item(enc, vf, s)], provenance=[ref_of(enc)], depends_on=[ref_of(enc)],
                 rule_notes=["E3-a"])
    return res


def t_E4(ctx: Ctx) -> Result:
    day = ctx.p["date"]
    encs = [e for e in ctx.mine("Encounter")
            if (s := fhir.period_start(e)) is not None and utc_date(s.text) == day]
    if not encs:
        return unanswerable("no encounter starts on that UTC date")
    names, its, prov = [], [], []
    for e in encs:
        reasons = [concept_name(c) for c in e.get("reasonCode") or []]
        for rr in e.get("reasonReference") or []:
            target = ctx.record(reference(rr) or "")
            reasons.append(concept_name((target or {}).get("code")) or rr.get("display"))
        reasons = [x for x in reasons if x]
        names += reasons
        if reasons:
            prov.append(ref_of(e))
        its.append(item(e, time=fhir.period_start(e), display="; ".join(reasons) or None))
    its.sort(key=_item_sort)
    notes = ["E4-a"] + ([f"{len(encs)} encounters start on that date"] if len(encs) > 1 else [])
    return list_result(names, its, prov, refs(encs), notes)


def t_E5(ctx: Ctx) -> Result:
    cands = coded(ctx, "Encounter", "type")
    top, _ = extreme(cands, fhir.period_start)
    if not top:
        return none_result(refs(cands), ["E5-a", "no encounter of that type"])
    return datetime_result(top, fhir.period_start(top[0]), refs(cands), ["E5-a"])


def t_D1(ctx: Ctx) -> Result:
    pats = ctx.mine("Patient")
    if not pats:
        return unanswerable("patient record not found")
    p = pats[0]
    if "deceasedDateTime" in p:
        death = p["deceasedDateTime"]
    elif p.get("deceasedBoolean") in (True, "true"):
        death = "deceased, date not recorded"
    else:
        death = "alive"
    names = [f"birth date: {p.get('birthDate')}", f"sex: {p.get('gender')}", f"date of death: {death}"]
    its = [item(p, display="; ".join(names))]
    return Result(answer_kind="list", answer_list=names, items=its, provenance=[ref_of(p)],
                  depends_on=[ref_of(p)], rule_notes=["D1-a"])


# ====================================================================== Synthea-only groups


def note_text(doc: dict[str, Any]) -> str | None:
    for c in doc.get("content") or []:
        att = c.get("attachment") or {}
        if att.get("data") and str(att.get("contentType", "text/plain")).startswith("text/plain"):
            return base64.b64decode(att["data"]).decode("utf-8", errors="replace")
    return None


_HISTORY = re.compile(r"Patient has a history of (.+?)\.(?=\s|$)")
_PRESENTING = re.compile(r"Patient is presenting with (.+?)\.(?=\s|$)")


def split_condition_list(segment: str, known: set[str]) -> list[str]:
    """Split "a, b, c" greedily on known condition names, so names containing commas survive."""
    parts = [x.strip() for x in segment.split(", ")]
    out, i = [], 0
    while i < len(parts):
        took = False
        for j in range(len(parts), i, -1):
            cand = ", ".join(parts[i:j])
            if cand.lower() in known:
                out.append(cand)
                i = j
                took = True
                break
        if not took:
            out.append(parts[i])
            i += 1
    return [x for x in out if x]


def note_conditions(text: str, known: set[str]) -> list[str]:
    names: list[str] = []
    for rx in (_HISTORY, _PRESENTING):
        for m in rx.finditer(text):
            names += split_condition_list(m.group(1), known)
    return names


def doc_time(doc: dict[str, Any]) -> Instant | None:
    return parse_instant(doc.get("date")) or fhir.period_start(doc.get("context") or {})


def t_N1(ctx: Ctx) -> Result:
    return count_result(ctx.mine("DocumentReference"), doc_time, ["N1-a"])


def t_N2(ctx: Ctx) -> Result:
    docs = ctx.mine("DocumentReference")
    known = set()
    for c in ctx.mine("Condition"):
        for n in [concept_name(c.get("code"))] + [x.get("display") for x in fhir.codings(c.get("code"))]:
            if n:
                known.add(n.lower())
    top, _ = extreme(docs, doc_time)
    if not top:
        return none_result(refs(docs), ["N2-a", "no clinical note"])
    lists = {tuple(sorted(set(note_conditions(note_text(d) or "", known)))) for d in top}
    if len(lists) > 1:
        return unanswerable("latest-instant tie between notes listing different conditions", refs(docs))
    doc = top[0]
    names = note_conditions(note_text(doc) or "", known)
    its = [item(d, time=doc_time(d), display="; ".join(names) or None) for d in top]
    return list_result(names, its, refs(top), refs(docs), ["N2-a"])


def t_N3(ctx: Ctx) -> Result:
    system, code = ctx.p["code_system"], ctx.p["code"]
    reports = [r for r in ctx.mine("DiagnosticReport") if fhir.any_concept_has(r.get("category"), system, code)]
    top, _ = extreme(reports, fhir.observation_time)
    if not top:
        return none_result(refs(reports), ["N3-a", "no laboratory report"])

    def result_names(rep):
        out = []
        for res in rep.get("result") or []:
            target = ctx.record(reference(res) or "")
            out.append((reference(res), concept_name((target or {}).get("code")) or res.get("display"), target))
        return out

    sets = {tuple(sorted(n for _, n, _ in result_names(r))) for r in top}
    if len(sets) > 1:
        return unanswerable("latest-instant tie between laboratory reports with different results", refs(reports))
    rep = top[0]
    triples = result_names(rep)
    names = [n for _, n, _ in triples]
    its = [item(t, fhir.observation_value(t), fhir.observation_time(t), n) for _, n, t in triples if t]
    its.sort(key=_item_sort)
    obs_refs = [r for r, _, t in triples if t]
    return list_result(names, its, refs(top) + obs_refs, refs(reports) + obs_refs, ["N3-a"])


def _money(m: Any) -> dict[str, Any] | None:
    if not isinstance(m, dict):
        return None
    lexeme = m.get("value")
    if lexeme is None:
        return None
    cur = m.get("currency") if isinstance(m.get("currency"), str) else None
    return {"value": canonical(lexeme), "value_as_recorded": lexeme, "unit": cur,
            "unit_code": cur, "unit_system": None}


def t_F1(ctx: Ctx) -> Result:
    enc = ctx.p["encounter"]
    claims = [c for c in ctx.mine("Claim")
              if any(reference(e) == enc for it in c.get("item") or [] for e in it.get("encounter") or [])]
    depends = refs(claims)
    if not claims:
        return none_result(depends, ["F1-a", "no claim for the encounter"])
    if len(claims) > 1:
        return unanswerable(f"F1-a: {len(claims)} claims reference the encounter", depends)
    c = claims[0]
    vf = _money(c.get("total"))
    return value_result(c, vf, parse_instant(c.get("created")), depends, ["F1-a"])


def t_F2(ctx: Ctx) -> Result:
    year = ctx.p["year"]
    claims = [c for c in ctx.mine("Claim") if (d := utc_date(c.get("created"))) and d[:4] == year]
    return count_result(claims, lambda c: parse_instant(c.get("created")), ["F2-a"])


def t_F3(ctx: Ctx) -> Result:
    claim = ctx.p["claim"]
    eobs = [e for e in ctx.mine("ExplanationOfBenefit") if reference(e.get("claim")) == claim]
    depends = refs(eobs)
    if not eobs:
        return none_result(depends, ["F3-a", "no explanation of benefit for the claim"])
    if len(eobs) > 1:
        return unanswerable(f"F3-a: {len(eobs)} benefits reference the claim", depends)
    e = eobs[0]
    vf = _money((e.get("payment") or {}).get("amount"))
    return value_result(e, vf, parse_instant(e.get("created")), depends, ["F3-a"])


def t_I1(ctx: Ctx) -> Result:
    return count_result(ctx.mine("Immunization"), lambda r: parse_instant(r.get("occurrenceDateTime")), ["I1-a"])


def t_I2(ctx: Ctx) -> Result:
    cands = coded(ctx, "Immunization", "vaccineCode")
    when = lambda r: parse_instant(r.get("occurrenceDateTime"))  # noqa: E731
    top, _ = extreme(cands, when)
    if not top:
        return none_result(refs(cands), ["I2-a", "no dose of the vaccine"])
    return datetime_result(top, when(top[0]), refs(cands), ["I2-a"])


def t_A1(ctx: Ctx) -> Result:
    recs = ctx.mine("AllergyIntolerance")
    names = [concept_name(r.get("code")) for r in recs]
    its = [item(r, time=parse_instant(r.get("recordedDate")), display=concept_name(r.get("code"))) for r in recs]
    its.sort(key=_item_sort)
    return list_result(names, its, refs(recs), refs(recs), ["A1-a"])


def t_K1(ctx: Ctx) -> Result:
    plan = ctx.record(ctx.p["record"])
    if plan is None:
        return unanswerable("named care plan not found for this patient")
    notes = ["K1-a"]
    if plan.get("status") != "active":
        notes.append(f"care plan status is {plan.get('status')!r}, not 'active'")
    names = []
    for act in plan.get("activity") or []:
        det = act.get("detail") or {}
        n = concept_name(det.get("code"))
        if n is None and act.get("reference"):
            n = (act["reference"] or {}).get("display")
        names.append(n)
    its = [item(plan, time=fhir.period_start(plan), display="; ".join(sorted({n for n in names if n})) or None)]
    # Ruling K1: depends_on is every CarePlan the search for active care plans returns (needed to know the named plan is
    # the one active plan of that name).
    active = [c for c in ctx.mine("CarePlan") if c.get("status") == "active"]
    return list_result(names, its, [ref_of(plan)], refs(active), notes + ["K1-ruling"])


def t_K2(ctx: Ctx) -> Result:
    team = ctx.record(ctx.p["record"])
    if team is None:
        return unanswerable("named care team not found for this patient")
    names, prov = [], [ref_of(team)]
    for part in team.get("participant") or []:
        member = part.get("member") or {}
        who = member.get("display")
        target = ctx.record(reference(member) or "") if reference(member) else None
        if not who and target is not None:
            nm = (target.get("name") or [{}])[0]
            who = " ".join((nm.get("prefix") or []) + (nm.get("given") or []) + [nm.get("family", "")]).strip()
        roles = [concept_name(r) for r in part.get("role") or []]
        role = "; ".join(r for r in roles if r) or None
        names.append(f"{who} | {role}")
    its = [item(team, time=fhir.period_start(team), display=None)]
    return list_result(names, its, prov, prov, ["K2-a"])


def t_M1(ctx: Ctx) -> Result:
    studies = ctx.mine("ImagingStudy")
    when = lambda s: parse_instant(s.get("started"))  # noqa: E731
    top, _ = extreme(studies, when)
    if not top:
        return none_result(refs(studies), ["M1-a", "no imaging study"])

    def parts(s):
        mods = [fhir.coding_name(m) for m in s.get("modality") or []]
        sites = []
        for se in s.get("series") or []:
            mods.append(fhir.coding_name(se.get("modality")))
            sites.append(fhir.coding_name(se.get("bodySite")))
        return ([f"modality: {m}" for m in mods if m] + [f"body site: {b}" for b in sites if b])

    sets = {tuple(sorted(set(parts(s)))) for s in top}
    if len(sets) > 1:
        return unanswerable("latest-instant tie between imaging studies with different answers", refs(studies))
    names = parts(top[0])
    its = [item(s, time=when(s), display="; ".join(sorted(set(names)))) for s in top]
    return list_result(names, its, refs(top), refs(studies), ["M1-a"])


def t_M2(ctx: Ctx) -> Result:
    st = ctx.record(ctx.p["record"])
    if st is None:
        return unanswerable("named imaging study not found for this patient")
    notes = ["M2-a"]
    series = st.get("series") or []
    counted_series = len(series)
    counted_inst = sum(len(se.get("instance") or []) for se in series)
    ns = st.get("numberOfSeries")
    ni = st.get("numberOfInstances")
    ns = canonical(ns) if ns is not None else str(counted_series)
    ni = canonical(ni) if ni is not None else str(counted_inst)
    if ns != str(counted_series) or ni != str(counted_inst):
        notes.append(f"declared counts {ns}/{ni} differ from listed {counted_series}/{counted_inst}")
    names = [f"series: {ns}", f"instances: {ni}"]
    its = [item(st, time=parse_instant(st.get("started")), display="; ".join(names))]
    return Result(answer_kind="list", answer_list=names, items=its, provenance=[ref_of(st)],
                  depends_on=[ref_of(st)], rule_notes=notes)


def t_V1(ctx: Ctx) -> Result:
    devs = ctx.mine("Device")
    names = []
    for d in devs:
        n = concept_name(d.get("type"))
        if n is None:
            dn = d.get("deviceName") or []
            n = dn[0].get("name") if dn else None
        names.append(n)
    its = [item(d, display=n) for d, n in zip(devs, names)]
    its.sort(key=lambda i: i["ref"])
    return list_result(names, its, refs(devs), refs(devs), ["V1-a"])


# ====================================================================== decimal stratum


def t_CL1(ctx: Ctx) -> Result:
    """Net amount of a named line on the patient's claim created at t (decimal stratum only)."""
    notes = ["CL1-a"]
    created = parse_instant(ctx.p["claim_created"])
    if created is None:
        return unanswerable("CL1-a: question gives no claim creation time")
    claims = ctx.mine("Claim")
    at = [c for c in claims if (t := parse_instant(c.get("created"))) is not None and t.utc == created.utc]
    if not at:
        return unanswerable("CL1-a: no claim of the patient was created at that instant")
    if len(at) > 1:
        return unanswerable(f"CL1-b: {len(at)} claims of the patient were created at that instant", refs(at))
    claim = at[0]
    depends = [ref_of(claim)]
    if ctx.p.get("claim") and ctx.p["claim"] != ref_of(claim):
        notes.append("claim found by creation time differs from the question's claim parameter")
    if claim.get("created") != ctx.p["claim_created"]:
        notes.append("claim creation lexeme differs from the question's (same instant)")
    lines = [it for it in claim.get("item") or [] if isinstance(it, dict)]
    system, code = ctx.p["code_system"], ctx.p["code"]
    matched = [it for it in lines if concept_has(it.get("productOrService"), system, code)]
    if not matched:
        return unanswerable("CL1-a: no line on the claim carries the stated coding", depends)
    if len(matched) > 1:
        return unanswerable(f"CL1-b: {len(matched)} lines on the claim carry the stated coding", depends)
    line = matched[0]
    name = concept_name(line.get("productOrService"))
    same_name = [it for it in lines if concept_name(it.get("productOrService")) == name]
    if len(same_name) > 1:
        return unanswerable(f"CL1-b: {len(same_name)} lines on the claim share the name {name!r}", depends)
    if ctx.p.get("display") and ctx.p["display"] != name:
        notes.append("line name differs from the question's display")
    seq = line.get("sequence")
    if ctx.p.get("item_sequence") and str(seq) != ctx.p["item_sequence"]:
        notes.append(f"line sequence {seq} differs from the question's item_sequence")
    t = parse_instant(claim.get("created"))
    vf = _money(line.get("net"))
    if vf is not None and not fhir.is_number_lexeme(vf["value_as_recorded"]):
        vf = None
    return value_result(claim, vf, t, depends, notes, display=name)


# MIMIC L1, L6, L8, G2, O2; Synthea L1, L6, L8, L10, O4, F1, F3, CL1. Keyed by rule family.
DEC_BASES = {
    "mimic": ("L1", "L6", "L8", "G2", "O2"),
    "synthea": ("L1", "L6", "L8", "L10", "O4", "F1", "F3", "CL1"),
}
STRATA_ONLY: dict[str, Callable[[Ctx], Result]] = {"CL1": t_CL1}


def decimal_variant(base_fn: Callable[[Ctx], Result], base_id: str) -> Callable[[Ctx], Result]:
    """DEC-<id>: the base template's gold, unchanged; eligibility is checked and noted, never enforced."""

    def run(ctx: Ctx) -> Result:
        res = base_fn(ctx)
        res.rule_notes = res.rule_notes + [f"DEC-a: gold of {base_id}"]
        if not res.unanswerable and not items_lexeme_eligible(res.items):
            res.rule_notes.append("DEC-b: gold is not lexeme-eligible (the stratum keeps eligible candidates only)")
        return res

    return run


# ====================================================================== registry

COMMON: dict[str, Callable[[Ctx], Result]] = {
    "L1": t_L1, "L2": t_L2, "L3": t_L3, "L4": t_L4, "L5": t_L5, "L6": t_L6, "L7": t_L7,
    "L8": t_L8, "L9": t_L9, "L10": t_L10,
    "G1": t_G1, "G2": t_G2, "G3": t_G3, "O2": t_O2, "O3": t_O3, "O4": t_O4,
    "B1": t_B1, "B2": t_B2,
    "C1": t_C1, "C2": t_C2, "C3": t_C3, "P1": t_P1, "P2": t_P2,
    "E1": t_E1, "E2": t_E2, "E3": t_E3, "E4": t_E4, "E5": t_E5, "D1": t_D1,
    "N1": t_N1, "N2": t_N2, "N3": t_N3,
    "F1": t_F1, "F2": t_F2, "F3": t_F3,
    "I1": t_I1, "I2": t_I2, "A1": t_A1, "K1": t_K1, "K2": t_K2, "M1": t_M1, "M2": t_M2, "V1": t_V1,
}


def template_for(dataset: str, template_id: str) -> Callable[[Ctx], Result]:
    if template_id.startswith("DEC-"):
        base = template_id[len("DEC-"):]
        if base not in DEC_BASES.get(FAMILIES.get(dataset, ""), ()):
            raise KeyError(f"no decimal variant {template_id} for {dataset}")
        fn = STRATA_ONLY[base] if base in STRATA_ONLY else template_for(dataset, base)
        return decimal_variant(fn, base)
    from .longlist import long_list_template

    ls = long_list_template(template_id)
    if ls is not None:
        return ls
    if template_id == "O1":
        return t_O1_mimic if FAMILIES.get(dataset) == "mimic" else t_O1_synthea
    if template_id not in COMMON:
        raise KeyError(f"no gold rule for template {template_id}")
    return COMMON[template_id]


def compute(question: dict[str, Any], store: Store) -> Result:
    fn = template_for(question["dataset"], question["template_id"])
    return fn(Ctx(question, store))
