# Seed and terminology notice inventory

The quickstart seed is synthetic. Its natural resources derive from Synthea v4.0.0,
commit 0185c09ea9d10a822c6f5f3ef9bdcbcbe960c813. The pinned generator JAR and its
dependencies are not distributed in this package. The helper also includes
explicit synthetic edge fixtures. The resource counts, seed hash, generator
pins, and unique coding-system/code/display counts appear in inventory.json.

The dependency license texts under dependencies/ are copied verbatim from the
installed packages. They cover those packages; they do not establish rights to
every terminology code or display in generated data.

The selected seed includes LOINC, SNOMED CT, HL7-defined coding systems, UCUM,
and BCP 47 language coding. No RxNorm coding occurs in the selected seed's
coding-system inventory; Synthea's broader output is not distributed here.

## Credits

The codes and display names in the synthetic seed belong to their owners. This
project claims no rights in them and includes them only so the synthetic
quickstart records look like real FHIR data. No separate licence agreement with
these owners is asserted, and no formal rights review has been completed.

- **LOINC®.** This material contains content from LOINC® (https://loinc.org).
  LOINC is copyright © Regenstrief Institute, Inc. and the Logical Observation
  Identifiers Names and Codes (LOINC) Committee and is available at no cost
  under the license at https://loinc.org/license. LOINC® is a registered United
  States trademark of Regenstrief Institute, Inc.
- **SNOMED CT®.** The seed contains concept identifiers and descriptions from
  SNOMED Clinical Terms® (SNOMED CT®), which is owned and maintained by SNOMED
  International (https://www.snomed.org). SNOMED CT® is a registered trademark
  of SNOMED International. Using SNOMED CT in your own systems is governed by
  SNOMED International's licence terms, which can require a licence depending
  on your country.
- **UCUM.** Units come from the Unified Code for Units of Measure
  (https://ucum.org), copyright © Regenstrief Institute, Inc.
- **HL7® code systems.** HL7-defined code systems are published by Health Level
  Seven International (https://terminology.hl7.org).
- **BCP 47.** Language tags follow IETF BCP 47.
- **Synthea™.** The natural records were generated with Synthea
  (https://github.com/synthetichealth/synthea), © The MITRE Corporation,
  licensed under Apache-2.0. Synthea output is synthetic and describes no real
  person.

The two derived HL7 FHIR R4 runtime catalogs and their source archive hash are
described in THIRD_PARTY_NOTICES.md. FHIR and HL7 marks are used descriptively;
no affiliation, endorsement, or permission to use a mark is asserted.

HAPI and the JDK are separately acquired container prerequisites. Neither their
images nor Synthea's JAR is included in the npm tarball. The compose recipe and
generator pins identify them; the npm dependency inventory is not their SBOM.
