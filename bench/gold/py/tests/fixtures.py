"""Synthetic FHIR fixtures. No real or de-identified data; code systems are made up."""

from __future__ import annotations

from typing import Any

from fbgold.result import to_record
from fbgold.store import Store
from fbgold.templates import compute

PID = "p1"
OTHER = "p2"
LAB = "http://example.org/lab"
DRUG = "http://example.org/drug"
DX = "http://example.org/dx"
PANEL = "http://example.org/vitals"

_n = 0


def nid(prefix: str) -> str:
    global _n
    _n += 1
    return f"{prefix}{_n}"


def obs(c: str, when: str | None, value: Any = None, *, unit: str | None = None, ucode: str | None = None,
        comparator: str | None = None, string: str | None = None, pid: str = PID, system: str = LAB,
        encounter: str | None = None, oid: str | None = None, **extra) -> dict[str, Any]:
    r: dict[str, Any] = {"resourceType": "Observation", "id": oid or nid("o"),
                         "subject": {"reference": f"Patient/{pid}"},
                         "code": {"coding": [{"system": "http://example.org/other", "code": "x"},
                                             {"system": system, "code": c, "display": f"Test {c}"}]}}
    if when is not None:
        r["effectiveDateTime"] = when
    if value is not None:
        q: dict[str, Any] = {"value": value}
        if unit is not None:
            q["unit"] = unit
        if ucode is not None:
            q["code"] = ucode
        if comparator is not None:
            q["comparator"] = comparator
        r["valueQuantity"] = q
    if string is not None:
        r["valueString"] = string
    if encounter:
        r["encounter"] = {"reference": encounter}
    r.update(extra)
    return r


def patient(pid: str = PID, **extra) -> dict[str, Any]:
    return {"resourceType": "Patient", "id": pid, "birthDate": "2100-01-02", "gender": "female", **extra}


def question(template: str, params: dict[str, str] | None = None, dataset: str = "mimic",
             form: str = "value", pid: str = PID) -> dict[str, Any]:
    return {"id": f"{dataset}.{template}.test", "dataset": dataset, "patient_id": pid,
            "template_id": template, "parameters": params or {}, "answer_form": form}


def gold(template: str, records: list[dict[str, Any]], params: dict[str, str] | None = None,
         dataset: str = "mimic", form: str = "value") -> dict[str, Any]:
    q = question(template, params, dataset, form)
    st = Store.from_records([patient(), patient(OTHER)] + records, {PID, OTHER})
    return to_record(q, compute(q, st))
