"""Small FHIR R4 accessors used by the templates. No terminology system is named here."""

from __future__ import annotations

from typing import Any

from .values import Instant, canonical, is_number_lexeme, parse_instant


def ref_of(resource: dict[str, Any]) -> str:
    return f"{resource['resourceType']}/{resource['id']}"


def reference(obj: Any) -> str | None:
    if isinstance(obj, dict):
        r = obj.get("reference")
        if isinstance(r, str):
            return r
    return None


def codings(concept: Any) -> list[dict[str, Any]]:
    if isinstance(concept, dict):
        cs = concept.get("coding")
        if isinstance(cs, list):
            return [c for c in cs if isinstance(c, dict)]
    return []


def concept_has(concept: Any, system: str, code: str) -> bool:
    """A match on any coding with the stated system and code (shared gold rule)."""
    return any(c.get("system") == system and c.get("code") == code for c in codings(concept))


def any_concept_has(concepts: Any, system: str, code: str) -> bool:
    if isinstance(concepts, list):
        return any(concept_has(c, system, code) for c in concepts)
    return concept_has(concepts, system, code)


def concept_name(concept: Any) -> str | None:
    """Human name of a CodeableConcept: text, else the first coding display, else the first code."""
    if not isinstance(concept, dict):
        return None
    text = concept.get("text")
    if isinstance(text, str) and text.strip():
        return text
    cs = codings(concept)
    for c in cs:
        d = c.get("display")
        if isinstance(d, str) and d.strip():
            return d
    for c in cs:
        code = c.get("code")
        if isinstance(code, str) and code:
            return code
    return None


def coding_name(coding: Any) -> str | None:
    if not isinstance(coding, dict):
        return None
    d = coding.get("display")
    if isinstance(d, str) and d.strip():
        return d
    c = coding.get("code")
    return c if isinstance(c, str) and c else None


# ------------------------------------------------------------------ quantities


def quantity_fields(q: Any) -> dict[str, Any] | None:
    """A Quantity as gold fields: value (canonical, comparator kept), lexeme, unit (unit, else code)."""
    if not isinstance(q, dict):
        return None
    lexeme = q.get("value")
    if not is_number_lexeme(lexeme):
        return None
    comparator = q.get("comparator") or ""
    unit = q.get("unit")
    code = q.get("code")
    shown_unit = unit if isinstance(unit, str) else (code if isinstance(code, str) else None)
    return {
        "value": comparator + canonical(lexeme),
        "value_as_recorded": comparator + lexeme,
        "lexeme": lexeme,
        "unit": shown_unit,
        "unit_code": code if isinstance(code, str) else None,
        "unit_system": q.get("system") if isinstance(q.get("system"), str) else None,
    }


def observation_value(obs: dict[str, Any]) -> dict[str, Any] | None:
    """The value[x] of an Observation (or component) as gold fields; None when absent."""
    q = quantity_fields(obs.get("valueQuantity"))
    if q is not None:
        q["kind"] = "quantity"
        return q
    for key in ("valueString", "valueDateTime", "valueTime", "valueBoolean", "valueInteger"):
        if key in obs:
            v = obs[key]
            if key == "valueInteger" and is_number_lexeme(v):
                return {
                    "kind": "quantity",
                    "value": canonical(v),
                    "value_as_recorded": v,
                    "lexeme": v,
                    "unit": None,
                    "unit_code": None,
                    "unit_system": None,
                }
            s = v if isinstance(v, str) else str(v).lower()
            return {"kind": "text", "value": s, "value_as_recorded": s, "lexeme": None,
                    "unit": None, "unit_code": None, "unit_system": None}
    if "valueCodeableConcept" in obs:
        name = concept_name(obs["valueCodeableConcept"])
        return {"kind": "text", "value": name, "value_as_recorded": name, "lexeme": None,
                "unit": None, "unit_code": None, "unit_system": None}
    return None


def is_numeric_value(v: dict[str, Any] | None) -> bool:
    return v is not None and v["kind"] == "quantity"


# ------------------------------------------------------------------ times


def observation_time(obs: dict[str, Any]) -> Instant | None:
    """Clinically relevant time: effective[x] (period start), else issued."""
    for key in ("effectiveDateTime", "effectiveInstant"):
        if key in obs:
            return parse_instant(obs[key])
    p = obs.get("effectivePeriod")
    if isinstance(p, dict) and p.get("start"):
        return parse_instant(p["start"])
    return parse_instant(obs.get("issued"))


def administration_time(ma: dict[str, Any]) -> Instant | None:
    if "effectiveDateTime" in ma:
        return parse_instant(ma["effectiveDateTime"])
    p = ma.get("effectivePeriod")
    if isinstance(p, dict) and p.get("start"):
        return parse_instant(p["start"])
    return None


def procedure_time(proc: dict[str, Any]) -> Instant | None:
    if "performedDateTime" in proc:
        return parse_instant(proc["performedDateTime"])
    p = proc.get("performedPeriod")
    if isinstance(p, dict) and p.get("start"):
        return parse_instant(p["start"])
    return None


def period_start(resource: dict[str, Any], field: str = "period") -> Instant | None:
    p = resource.get(field)
    if isinstance(p, dict):
        return parse_instant(p.get("start"))
    return None
