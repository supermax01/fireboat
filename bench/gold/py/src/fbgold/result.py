"""Gold result shapes (the gold record format in bench/GOLD-RULINGS.md) and the record writer."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .fhir import ref_of
from .values import Instant, lexeme_eligible

ITEM_KEYS = ("ref", "value", "value_as_recorded", "unit", "unit_code", "unit_system", "time", "display")


def item(resource: dict[str, Any] | str, vf: dict[str, Any] | None = None,
         time: Instant | str | None = None, display: str | None = None) -> dict[str, Any]:
    ref = resource if isinstance(resource, str) else ref_of(resource)
    t = time.text if isinstance(time, Instant) else time
    out = {k: None for k in ITEM_KEYS}
    out["ref"] = ref
    out["time"] = t
    out["display"] = display
    if vf is not None:
        for k in ("value", "value_as_recorded", "unit", "unit_code", "unit_system"):
            out[k] = vf.get(k)
    return out


def utf8_sorted(values: list[str]) -> list[str]:
    return sorted(set(values), key=lambda s: s.encode("utf-8"))


@dataclass
class Result:
    answer_kind: str | None  # "value" | "list" | "none" | None (unanswerable)
    answer: str | None = None
    answer_list: list[str] | None = None
    value_as_recorded: str | None = None
    unit: str | None = None
    timestamp: str | None = None
    items: list[dict[str, Any]] = field(default_factory=list)
    provenance: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    rule_notes: list[str] = field(default_factory=list)

    @property
    def unanswerable(self) -> bool:
        return self.answer_kind is None


def refs(resources: list[dict[str, Any]]) -> list[str]:
    return [ref_of(r) for r in resources]


def _strip_comparator(s: str) -> str:
    for c in ("<=", ">=", "<", ">"):
        if s.startswith(c):
            return s[len(c):]
    return s


def items_lexeme_eligible(items: list[dict[str, Any]]) -> bool:
    """Question-level flag (bench/GOLD-RULINGS.md, G3): any item's recorded lexeme, comparator removed, is eligible."""
    return any(
        isinstance(it.get("value_as_recorded"), str)
        and lexeme_eligible(_strip_comparator(it["value_as_recorded"]))
        for it in items
    )


def to_record(question: dict[str, Any], res: Result) -> dict[str, Any]:
    depends = sorted(set(res.depends_on))
    prov = sorted(set(res.provenance))
    eligible = items_lexeme_eligible(res.items)
    size = len(depends)
    return {
        "schema": "fbbench.gold/1",
        "question_id": question["id"],
        "dataset": question["dataset"],
        "patient_id": question["patient_id"],
        "implementation": "py",
        "answer_form": question["answer_form"],
        "answer_kind": res.answer_kind,
        "answer": res.answer,
        "answer_list": utf8_sorted(res.answer_list) if res.answer_list is not None else None,
        "value_as_recorded": res.value_as_recorded,
        "unit": res.unit,
        "timestamp": res.timestamp,
        "items": res.items,
        "provenance": prov,
        "depends_on": depends,
        "completeness": {"size": size, "pages_at_100": max(1, math.ceil(size / 100))},
        "lexeme_eligible": eligible,
        "rule_notes": res.rule_notes,
    }
