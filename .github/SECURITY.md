# Security policy

## Scope

This repository is a **synthetic-data prototype**: a read-only MCP gateway for one trusted patient's FHIR R4 records, served over local stdio to a loopback FHIR source. It is not for real patient data, is not clinically validated, and has no remote serving. Its SMART on FHIR sign-in is a loopback-only client, tested against a local SMART Launcher only, and is not SMART certified. Security reports are welcome within that scope; reports about real-data deployments describe configurations the project does not support.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). If that is unavailable, open an issue titled "security contact request" with no details, and a maintainer will provide a private channel.

Include: the commit or version, a minimal reproduction using **synthetic** data only, the observed and expected behaviour, and the MCP client or host involved. Never include real patient data, credentials or tokens in a report.

This is a prototype with a single maintainer, so the targets are best effort, not a commitment: the maintainer aims to acknowledge a report within 7 days and to give a disposition within 30 days. Fixes are recorded in the commit history, and in release notes once a release exists.

## Supported versions

| Version | Supported |
| --- | --- |
| The development version, `0.2.0-alpha.x` (unreleased prototype) | Yes, on the latest commit on `main` |
| anything earlier | No |

There is no published release yet: no tag and no npm package. This is a source preview of a prototype, so supported means only that reports about the latest commit on `main` are looked at; it is not a promise of fixes or backports. This table is updated if a release is ever published.

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
