"""Datasets and their rule families: synthea-dev and synthea-holdout share every Synthea rule."""

from __future__ import annotations

FAMILIES = {"mimic": "mimic", "synthea-dev": "synthea", "synthea-holdout": "synthea"}
DATASETS = tuple(FAMILIES)
