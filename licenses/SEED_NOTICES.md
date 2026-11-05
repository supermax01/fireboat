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
Terminology and generated-data redistribution
terms require owner review before public release. No license grant or completed
rights review for those materials is asserted here. No upstream terminology
license text was obtained or reconstructed during offline package staging.

The two derived HL7 FHIR R4 runtime catalogs and their source archive hash are
described in THIRD_PARTY_NOTICES.md. FHIR and HL7 marks are used descriptively;
no affiliation, endorsement, or permission to use a mark is asserted.

HAPI and the JDK are separately acquired container prerequisites. Neither their
images nor Synthea's JAR is included in the npm tarball. The compose recipe and
generator pins identify them; the npm dependency inventory is not their SBOM.
