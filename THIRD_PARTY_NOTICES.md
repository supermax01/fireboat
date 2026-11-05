# Third-party data notices

`packages/core/src/generated/r4-index.json` is a derived type/discovery index from **HL7 FHIR R4 core 4.0.1**, published by HL7 Inc. The source package declares `CC0-1.0` in its `package.json`. Source: <https://packages2.fhir.org/web/hl7.fhir.r4.core-4.0.1.tgz>, SHA-256 `b090bf929e1f665cf2c91583720849695bc38d2892a7c5037c56cb00817fb091`.

FHIR® is a registered trademark of Health Level Seven International (HL7). It is used here descriptively, to refer to the HL7® FHIR® standard that this software reads. This project is not affiliated with or endorsed by HL7, and no permission to use the mark has been sought or granted. This generated index is an implementation aid, not an altered specification or a conformance validator. The authoritative specification and licensing information are at <https://hl7.org/fhir/R4/> and <https://hl7.org/fhir/R4/license.html>.

Regenerate with `python3 scripts/generate-r4-index.py --download`. The script verifies the source hash and only reads StructureDefinition JSON; it does not execute package code.

`packages/core/src/generated/r4-search-parameters.json` is a derived SearchParameter typing catalog from the same **HL7 FHIR R4 core 4.0.1** package and hash. Descriptions in the catalog are reproduced verbatim from HL7 (CC0). Regenerate with `python3 scripts/generate-r4-search-parameters.py`. Regeneration requires the pinned archive at `.local/` (obtain it with `generate-r4-index.py --download`); the search-parameter generator has no download step of its own. The script reads only SearchParameter JSON, excludes the three example-named members, and executes no package code or search expressions. Canonical definition URLs in the catalog are identifiers only; the gateway never fetches them.

The synthetic quickstart seed contains LOINC®, SNOMED CT®, UCUM and HL7® codes and was generated with Synthea™; their credits are in [licenses/SEED_NOTICES.md](licenses/SEED_NOTICES.md).

The rest of this project's original code is licensed under Apache-2.0. Competitor sources inspected during research are not incorporated into the implementation.
