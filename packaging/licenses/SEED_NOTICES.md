# Seed and terminology notice inventory

The quickstart seed is synthetic. Its natural resources derive from Synthea v4.0.0,
commit 0185c09ea9d10a822c6f5f3ef9bdcbcbe960c813. The pinned generator JAR and its
dependencies are not distributed in this package. The helper also includes
explicit synthetic edge fixtures. The resource counts, seed hash, generator
pins, and unique coding-system/code/display counts appear in inventory.json.

The dependency license texts under dependencies/ are copied verbatim from the
installed packages. They cover those packages; they do not establish rights to
every terminology code or display in generated data.

The selected seed includes LOINC, HL7 Terminology (THO) code systems, UCUM, and
BCP 47 language coding. No RxNorm coding occurs in the selected seed's
coding-system inventory; Synthea's broader output is not distributed here.

The repository's data contains no SNOMED CT codes or descriptions. The seed
and test fixtures use other code systems or clearly synthetic codes instead.
Only HL7 specification metadata in the generated R4 index mentions that
terminology.

## Status of the rights review

The codes and display names in the synthetic data belong to their owners. This
project claims no rights in them and grants none; it includes them only so the
synthetic records look like real FHIR data. The notices below follow the
licences cited for each source. No formal rights review of the generated output
has been completed beyond those sources, so inventory.json records
`pending-owner-review` for the generator and for every coding system.

## LOINC

The seed and many test fixtures contain LOINC codes and display names. Section
10.1 of the LOINC Copyright Notice and License (https://loinc.org/license, read
2026-11-12) requires this notice:

> This material contains content from LOINC (http://loinc.org). LOINC is
> copyright © Regenstrief Institute, Inc. and the Logical Observation
> Identifiers Names and Codes (LOINC) Committee and is available at no cost
> under the license at http://loinc.org/license. LOINC® is a registered United
> States trademark of Regenstrief Institute, Inc.

The LOINC display strings are as Synthea or the fixture authors wrote them.
They have not yet been checked against the LOINC display names that section
10.3 of the licence permits.

## UCUM

Unit codes are literal codes from the Unified Code for Units of Measure (UCUM),
copyright © 1999-2024 Regenstrief Institute, Inc., made available under the
UCUM Copyright Notice and License, Version 1.1
(https://unitsofmeasure.org/license). UCUM is provided "AS IS", without
warranties of any kind; see the licence for the full disclaimer. This project
does not include the UCUM specification or unit table.

## HL7 Terminology (THO)

The HL7 code systems used (listed in inventory.json) are part of the HL7
Terminology. Content developed by HL7 is copyright © 1989+ HL7 and is made
available under the Creative Commons Zero (CC0) designation
(https://terminology.hl7.org/license.html). HL7® and FHIR® are registered
trademarks of Health Level Seven International; their use here does not
constitute endorsement by HL7.

## BCP 47

The seed uses one IETF BCP 47 language tag. IANA publishes the Language
Subtag Registry under CC0 (https://www.iana.org/help/licensing-terms). Only the
tag is used; no RFC text is reproduced.

## Synthea™

277 of the 282 seed resources were generated with Synthea
(https://github.com/synthetichealth/synthea) v4.0.0, commit 0185c09e, by The
MITRE Corporation. Synthea is licensed under Apache-2.0. The other 5 resources
are hand-made synthetic edge fixtures. Synthea output is synthetic and
describes no real person. Synthea's maintainers ask that it be cited as:

Walonoski J, Kramer M, Nichols J, et al. Synthea: An approach, method, and
software mechanism for generating synthetic patients and the synthetic
electronic health care record. J Am Med Inform Assoc. 2018;25(3):230-238.
https://doi.org/10.1093/jamia/ocx079

The name Synthea is used only to say where the records came from; MITRE does
not endorse this project. Synthea publishes no separate licence for its output,
and MITRE has not been asked to confirm that generated output may be
redistributed. Synthea's Apache-2.0 licence covers the generator; it is not a
licence for the terminology in its output.

## Other content

The two derived HL7 FHIR R4 runtime catalogs and their source archive hash are
described in THIRD_PARTY_NOTICES.md. FHIR and HL7 marks are used descriptively;
no affiliation, endorsement, or permission to use a mark is asserted.

HAPI and the JDK are separately acquired container prerequisites. Neither their
images nor Synthea's JAR is included in the npm tarball. The compose recipe and
generator pins identify them; the npm dependency inventory is not their SBOM.
