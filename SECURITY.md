# Security policy

## Scope

This repository is a **synthetic-data prototype**: a read-only MCP gateway for one trusted patient's FHIR R4 records, served over local stdio to a loopback FHIR source. It is not for real patient data, is not clinically validated, and has no SMART authorization or remote serving. Security reports are welcome within that scope; reports about real-data deployments describe configurations the project does not support.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). If that is unavailable, open an issue titled "security contact request" with no details, and a maintainer will provide a private channel.

Include: the commit or version, a minimal reproduction using **synthetic** data only, the observed and expected behaviour, and the MCP client or host involved. Never include real patient data, credentials or tokens in a report.

We acknowledge reports within 7 days and aim to give a disposition within 30 days. Fixed issues are recorded in the release notes of the version that fixes them.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.2.0-alpha.x` (current candidate) | Yes, on the latest commit of the candidate branch |
| anything earlier | No |

There is no published release yet; this table is updated when one exists.

## What counts as a security issue here

- Any path by which a tool argument can select or reach a patient other than the configured one, including through contained resources, continuation links or retained results.
- Any returned record that was not independently authorized against the trusted patient binding.
- Inline `Attachment.data`, `Binary.data` or a protected link reaching model output or retention without a withheld-manifest entry.
- Outbound requests to anything other than the configured literal-loopback source, or redirect following.
- Resource bodies, credentials or patient identifiers appearing in ordinary logs.
- A serialized MCP result exceeding the effective byte ceiling, including error and fallback paths.

## What is out of scope by design

- Prompt-injection "immunity": returned clinical text is data and may contain instructions; the gateway does not claim to filter them.
- Timing, page-topology and count side channels that the isolation design explicitly excludes.
- Host-side behaviour: a local stdio gateway returns data to a host that may send it to a remote model.
