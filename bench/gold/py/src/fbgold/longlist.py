"""Long-list stratum: LS1 and LS2 in bands B1-B4.

Readings chosen where the question text is open are tagged ``LS-*``, ``LS1-*`` and ``LS2-*`` and
listed under "Long-list stratum" in bench/GOLD-RULINGS.md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Callable

from .fhir import concept_name, observation_time, quantity_fields, ref_of
from .result import Result, item, refs
from .values import Instant, canonical, in_half_open, is_number_lexeme, parse_instant, to_decimal

# Band: size of the gold set, inclusive on both ends.
BANDS: dict[str, tuple[int, int]] = {
    "B1": (21, 100),
    "B2": (101, 200),
    "B3": (201, 1000),
    "B4": (4001, 10000),
}


@dataclass(frozen=True)
class TypeRow:
    tokens: dict[str, str]  # search parameter -> element it matches
    code_element: str  # the element LS1 lists
    window: str | None  # dotted path of the window element, or None


_MED = {"code": "medicationCodeableConcept"}

# The type table: each searchable type, its tokens, its code element and its window element.
TYPES: dict[str, TypeRow] = {
    "Observation": TypeRow({"code": "code", "category": "category"}, "code", "effectiveDateTime"),
    "DiagnosticReport": TypeRow({"code": "code", "category": "category"}, "code", "effectiveDateTime"),
    "DocumentReference": TypeRow({"type": "type", "category": "category"}, "type", "date"),
    "Encounter": TypeRow({"type": "type", "class": "class"}, "type", None),
    "Procedure": TypeRow({"code": "code"}, "code", "performedDateTime"),
    "Condition": TypeRow({"code": "code"}, "code", None),
    "MedicationRequest": TypeRow(_MED, "medicationCodeableConcept", "authoredOn"),
    "MedicationAdministration": TypeRow(_MED, "medicationCodeableConcept", "effectiveDateTime"),
    "MedicationDispense": TypeRow(_MED, "medicationCodeableConcept", "whenHandedOver"),
    "Immunization": TypeRow({"vaccine-code": "vaccineCode"}, "vaccineCode", "occurrenceDateTime"),
    "Specimen": TypeRow({"type": "type"}, "type", "collection.collectedDateTime"),
    "Claim": TypeRow({}, "type", "created"),
    "ExplanationOfBenefit": TypeRow({}, "type", "created"),
}

# "a dateTime to the second with an offset" (bench/GOLD-RULINGS.md, LS-c).
FULL_DATETIME = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")


class Excluded(Exception):
    """The question is excluded by a stated rule (gold: unanswerable)."""

    def __init__(self, note: str, depends: list[str] | None = None):
        super().__init__(note)
        self.note = note
        self.depends = depends or []


def get_path(resource: dict[str, Any], path: str) -> Any:
    v: Any = resource
    for part in path.split("."):
        if not isinstance(v, dict):
            return None
        v = v.get(part)
    return v


def all_codings(value: Any) -> list[dict[str, Any]]:
    """Every Coding in an element that is a Coding, a CodeableConcept or a list of either."""
    if isinstance(value, list):
        out: list[dict[str, Any]] = []
        for v in value:
            out.extend(all_codings(v))
        return out
    if not isinstance(value, dict):
        return []
    if "coding" in value:
        cs = value.get("coding")
        return [c for c in cs if isinstance(c, dict)] if isinstance(cs, list) else []
    if "code" in value or "system" in value:
        return [value]  # a bare Coding (for example Encounter.class)
    return []


def has_token(value: Any, system: str, code: str) -> bool:
    """A match on any coding with the stated system and code (shared gold rule)."""
    return any(c.get("system") == system and c.get("code") == code for c in all_codings(value))


def element_name(value: Any) -> str | None:
    """Display for an item: the CodeableConcept name (G8), first of a list, or a Coding's display/code."""
    if isinstance(value, list):
        for v in value:
            n = element_name(v)
            if n is not None:
                return n
        return None
    if isinstance(value, dict) and "coding" not in value and ("code" in value or "display" in value):
        d = value.get("display")
        if isinstance(d, str) and d.strip():
            return d
        c = value.get("code")
        return c if isinstance(c, str) and c else None
    return concept_name(value)


def _window_time(row: TypeRow, r: dict[str, Any]) -> Instant | None:
    if row.window is None:
        return None
    v = get_path(r, row.window)
    if isinstance(v, str) and FULL_DATETIME.match(v):
        return parse_instant(v)
    return None


@dataclass
class LSet:
    rtype: str
    row: TypeRow
    records: list[dict[str, Any]]
    token_element: str | None
    windowed: bool


def build_set(ctx: Any, band: str, notes: list[str]) -> LSet:
    """The gold set: one patient-linked type, optionally narrowed by one token and one half-open window."""
    p = ctx.p
    rtype = p.get("resource_type")
    if rtype not in TYPES:
        raise KeyError(f"long-list type {rtype!r} is not in the long-list type table")
    row = TYPES[rtype]
    recs = ctx.mine(rtype)
    token_element = None
    if p.get("search_param"):
        sp = p["search_param"]
        if sp not in row.tokens:
            raise KeyError(f"{rtype} has no long-list token parameter {sp!r}")
        token_element = row.tokens[sp]
        if p.get("field_label") and p["field_label"] != token_element:
            notes.append(f"LS-a: field_label {p['field_label']!r} read as element {token_element}")
        system, code = p["code_system"], p["code"]
        recs = [r for r in recs if has_token(get_path(r, token_element), system, code)]
    windowed = bool(p.get("window_start") or p.get("window_end"))
    if windowed:
        if row.window is None:
            raise Excluded(f"LS-c: {rtype} has no window element", refs(recs))
        a, b = p.get("window_start"), p.get("window_end")
        if not (isinstance(a, str) and FULL_DATETIME.match(a) and isinstance(b, str) and FULL_DATETIME.match(b)):
            raise Excluded("LS-c: a window bound is not a dateTime to the second with an offset", refs(recs))
        q = ctx.question.get("question")
        if isinstance(q, str) and (a not in q or b not in q):
            notes.append("LS-c: window bounds are not written in the question text as in the parameters")
        lacking = [r for r in recs if _window_time(row, r) is None]
        if lacking:
            raise Excluded(
                f"LS-c: {len(lacking)} matching record(s) lack a full dateTime in {row.window} "
                "(the window question is excluded)", refs(recs))
        start, end = parse_instant(a), parse_instant(b)
        if not start.utc < end.utc:
            raise Excluded("LS-c: the window is empty (start is not before end)", refs(recs))
        recs = [r for r in recs if in_half_open(_window_time(row, r), start, end)]
        notes.append(f"LS-c: half-open window on {row.window}")
    lo, hi = BANDS[band]
    n = len(recs)
    if not lo <= n <= hi:
        notes.append(f"LS-b: set holds {n} records, outside band {band} ({lo}-{hi})")
    return LSet(rtype, row, recs, token_element, windowed)


def _excluded(e: Excluded, notes: list[str]) -> Result:
    return Result(answer_kind=None, depends_on=e.depends, rule_notes=["unanswerable: " + e.note] + notes)


def _item_key(it: dict[str, Any]):
    inst = parse_instant(it.get("time"))
    return (0 if inst else 1, inst.utc.isoformat() if inst else "", it["ref"])


# ====================================================================== LS1


def t_LS1(ctx: Any, band: str) -> Result:
    notes = ["LS1-a"]
    try:
        s = build_set(ctx, band, notes)
    except Excluded as e:
        return _excluded(e, notes)
    code_el = s.row.code_element
    if s.token_element == code_el:
        return _excluded(Excluded(f"LS1-b: the set is defined by the {code_el} it asks about",
                                  refs(s.records)), notes)
    pairs: list[str] = []
    contributing: list[str] = []
    without = 0
    partial = 0
    its = []
    for r in s.records:
        value = get_path(r, code_el)
        cs = all_codings(value)
        mine = [f"{c['system']}|{c['code']}" for c in cs
                if isinstance(c.get("system"), str) and isinstance(c.get("code"), str)]
        partial += len(cs) - len(mine)
        if mine:
            contributing.append(ref_of(r))
            pairs.extend(mine)
        else:
            without += 1
        its.append(item(r, time=_window_time(s.row, r), display=element_name(value)))
    its.sort(key=_item_key)
    if without:
        notes.append(f"LS1-c: {without} record(s) carry no coding in {code_el}; they add no code")
    if partial:
        notes.append(f"LS1-d: {partial} coding(s) without both system and code left out")
    depends = refs(s.records)
    if not pairs:
        return Result(answer_kind="none", items=its, provenance=[], depends_on=depends, rule_notes=notes)
    return Result(answer_kind="list", answer_list=pairs, items=its, provenance=contributing,
                  depends_on=depends, rule_notes=notes)


# ====================================================================== LS2


def _obs_number(r: dict[str, Any]) -> dict[str, Any] | None:
    q = r.get("valueQuantity")
    if not isinstance(q, dict) or q.get("comparator") is not None:
        return None
    return quantity_fields(q)


def _claim_number(r: dict[str, Any]) -> dict[str, Any] | None:
    m = r.get("total")
    if not isinstance(m, dict) or not is_number_lexeme(m.get("value")):
        return None
    cur = m.get("currency") if isinstance(m.get("currency"), str) else None
    lexeme = m["value"]
    return {"value": canonical(lexeme), "value_as_recorded": lexeme, "lexeme": lexeme,
            "unit": cur, "unit_code": cur, "unit_system": None}


def t_LS2(ctx: Any, band: str) -> Result:
    notes = ["LS2-a"]
    p = ctx.p
    kind = p.get("value_kind")
    if kind == "observation":
        if p.get("resource_type") != "Observation" or p.get("search_param") != "code":
            raise KeyError("LS2 observation sets are one Observation code")
        number: Callable[[dict[str, Any]], dict[str, Any] | None] = _obs_number
    elif kind == "claim":
        if p.get("resource_type") != "Claim" or p.get("search_param"):
            raise KeyError("LS2 claim sets are the Claim type set")
        number = _claim_number
    else:
        raise KeyError(f"unknown LS2 value_kind {kind!r}")
    try:
        s = build_set(ctx, band, notes)
    except Excluded as e:
        return _excluded(e, notes)
    depends = refs(s.records)
    if not s.records:
        return Result(answer_kind="none", depends_on=[], rule_notes=notes + ["empty set"])
    vals = [(r, number(r)) for r in s.records]
    bad = [r for r, v in vals if v is None]
    if bad:
        what = "valueQuantity" if kind == "observation" else "total"
        return _excluded(Excluded(
            f"LS2-b: {len(bad)} record(s) in the set lack a plain number in {what}", depends), notes)
    units = {v["unit"] for _, v in vals}
    if len(units) > 1:
        return _excluded(Excluded(f"LS2-b: the set has {len(units)} different units", depends), notes)
    best: Decimal = max(to_decimal(v["lexeme"]) for _, v in vals)
    holders = [(r, v) for r, v in vals if to_decimal(v["lexeme"]) == best]
    lexemes = sorted({v["lexeme"] for _, v in holders})
    if len(lexemes) > 1:
        return _excluded(Excluded(
            f"LS2-c: the maximum is written {len(lexemes)} ways ({', '.join(lexemes)})", depends), notes)

    def when(r: dict[str, Any]) -> Instant | None:
        return observation_time(r) if kind == "observation" else parse_instant(r.get("created"))

    def display(r: dict[str, Any]) -> str | None:
        return element_name(r.get("code") if kind == "observation" else r.get("type"))

    its = [item(r, v, when(r), display(r)) for r, v in holders]
    its.sort(key=_item_key)
    _, v0 = holders[0]
    times = {it["time"] for it in its}
    timestamp = next(iter(times)) if len(times) == 1 else None
    if len(holders) > 1:
        notes.append(f"LS2-d: {len(holders)} records hold the maximum; all are items")
        if timestamp is None:
            notes.append("LS2-d: tied records differ in time, so timestamp is null")
    if v0["unit"] is None:
        notes.append("LS2-e: the set's records carry no unit")
    return Result(answer_kind="value", answer=v0["value"], value_as_recorded=v0["value_as_recorded"],
                  unit=v0["unit"], timestamp=timestamp, items=its, provenance=refs([r for r, _ in holders]),
                  depends_on=depends, rule_notes=notes)


# ====================================================================== registry

_LS_ID = re.compile(r"^LS([12])-(B[1-4])$")


def long_list_template(template_id: str) -> Callable[[Any], Result] | None:
    m = _LS_ID.match(template_id)
    if not m:
        return None
    form, band = m.group(1), m.group(2)
    fn = t_LS1 if form == "1" else t_LS2
    return lambda ctx: fn(ctx, band)
