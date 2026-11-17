"""Read-only access to the converted NDJSON files of one dataset.

Patient-linked types are loaded lazily, one type at a time, keeping only resources whose
patient reference belongs to the requested patients. Shared types are loaded whole.
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from typing import Any, Iterable

from .values import loads

SHARED_TYPES = frozenset({"Medication", "Location", "Organization", "Practitioner"})

_PATIENT_REF = re.compile(r"Patient/([A-Za-z0-9\-.]{1,64})")


def patient_of(resource: dict[str, Any]) -> str | None:
    """The patient id a patient-linked resource belongs to (subject or patient), or None."""
    if resource.get("resourceType") == "Patient":
        return resource.get("id")
    for field in ("subject", "patient"):
        ref = resource.get(field)
        if isinstance(ref, dict):
            r = ref.get("reference")
            if isinstance(r, str) and r.startswith("Patient/"):
                return r[len("Patient/") :]
    return None


class Store:
    def __init__(self, directory: str, patient_ids: Iterable[str]):
        self.directory = directory
        self.patient_ids = frozenset(patient_ids)
        self._by_patient: dict[str, dict[str, list[dict[str, Any]]]] = {}
        self._by_ref: dict[str, dict[str, Any]] = {}
        self._loaded: set[str] = set()

    @classmethod
    def from_records(cls, records: Iterable[dict[str, Any]], patient_ids: Iterable[str]) -> "Store":
        """Build an in-memory store (tests)."""
        st = cls("", patient_ids)
        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in records:
            grouped[r["resourceType"]].append(r)
        for rtype, rs in grouped.items():
            st._ingest(rtype, rs)
        st._memory = True  # type: ignore[attr-defined]
        return st

    def _path(self, rtype: str) -> str:
        return os.path.join(self.directory, f"{rtype}.ndjson")

    def _ingest(self, rtype: str, records: Iterable[dict[str, Any]]) -> None:
        bucket: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for r in records:
            self._by_ref[f"{rtype}/{r['id']}"] = r
            pid = patient_of(r)
            if pid is not None:
                bucket[pid].append(r)
        self._by_patient[rtype] = bucket
        self._loaded.add(rtype)

    def _load(self, rtype: str) -> None:
        if rtype in self._loaded:
            return
        if getattr(self, "_memory", False):
            self._by_patient[rtype] = defaultdict(list)
            self._loaded.add(rtype)
            return
        path = self._path(rtype)
        records: list[dict[str, Any]] = []
        if os.path.exists(path):
            shared = rtype in SHARED_TYPES
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    if not line.strip():
                        continue
                    if not shared and rtype != "Patient":
                        ids = set(_PATIENT_REF.findall(line))
                        if not ids & self.patient_ids:
                            continue
                    r = loads(line)
                    if shared or patient_of(r) in self.patient_ids:
                        records.append(r)
        self._ingest(rtype, records)

    def for_patient(self, rtype: str, patient_id: str) -> list[dict[str, Any]]:
        self._load(rtype)
        return list(self._by_patient[rtype].get(patient_id, []))

    def get(self, ref: str | None) -> dict[str, Any] | None:
        if not isinstance(ref, str) or "/" not in ref:
            return None
        rtype = ref.split("/", 1)[0]
        self._load(rtype)
        return self._by_ref.get(ref)
