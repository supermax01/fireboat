# First implementation milestone

> **Historical record.** Historical M1 implementation and ownership record, superseded for current acceptance by PLAN revision 0.4 and the M3a reviews. Five retrieval tools are implemented; the broader eight-tool candidate surface is workflow-gated. Current API: `execute(tool, input, { signal?, deadlineMs?, protocolEra? })`; default tool-result text serializes the same bounded envelope as `structuredContent`, and both copies plus era-specific SDK metadata count toward the byte ceiling. Current status: [M3B-STATUS.md](M3B-STATUS.md); the current reference docs are linked from the README. M3a record: [M3A-STATUS.md](M3A-STATUS.md).


This milestone is a **synthetic-only local stdio vertical slice**, implementing five of the eight planned tools: capabilities, search, exact-ID read, safe continuation, and retained-result inspection/projection. Only implemented interactions are advertised. Production HTTP serving, SMART grants, terminology, clinical context composites, custom operations, history/vread, and multitenant deployment remain subsequent work.

The core configuration is trusted local configuration, `mode: synthetic`, one source alias/base URL, and one explicitly selected synthetic patient. No-auth connections are restricted to literal loopback addresses. Context omission can only infer this single configured binding, never broader access. Remote production URLs fail startup. Temporary results are memory-only, expiring and bounded; restart invalidates handles. Ordinary audit records contain operation/correlation metadata, never bodies or patient identifiers.

## Parallel ownership

- **GPT/Codex:** root package/toolchain, core contracts/transport/policy/projection/store/gateway, adversarial core tests, CI/HAPI configuration, docs and git/GitHub integration.
- **Muse:** `packages/server/src/index.ts`, `packages/server/src/cli.ts`, `examples/synthetic-server.ts`, `examples/demo.ts`, and `tests/mcp.integration.test.ts`. No root manifests, core files, commits, pushes, or other files.

## Shared API

`packages/core/src/index.ts` exports `FhirGateway`, `GatewayConfig`, `GatewayEnvelope`, `ToolName`, `TOOL_NAMES`, `SERVER_IDENTITY`, `toMcpToolResult`. The 0.1 `toolSchemas` export was removed in 0.2 (S5.8a); the strict v2 input schemas live in `packages/core/src/contracts.ts`.

`new FhirGateway(config)` validates trusted configuration. `gateway.execute(toolName, unknownInput): Promise<GatewayEnvelope>` validates arguments and returns bounded success/error envelopes. `gateway.close(): void` clears retained state. `gateway.auditEvents` exposes a bounded metadata-only audit array for tests. The server calls `toMcpToolResult` without duplicating JSON into text. Contract definitions live in `packages/core/src/contracts.ts`.

The synthetic fixture helper exports `startSyntheticFhirServer(): Promise<{baseUrl: string; close(): Promise<void>}>`, bound to 127.0.0.1 on an ephemeral port with base path `/fhir`. It serves metadata, Patient/Observation/Medication read/search with synthetic patient IDs `synthetic-patient-a` and `synthetic-patient-b`; observations have source-local IDs and subject links. It advertises supported query parameters, preserves repeated date parameters and self links, supports bounded `_count`/next paging, and returns OperationOutcome for unsupported parameters under strict handling. It never accesses real data.

The `fireboat` CLI reads a JSON config file with precedence `--config path` > `FIREBOAT_CONFIG` > `FHIR_MCP_CONFIG`. `FHIR_MCP_CONFIG` is a deprecated alias for this release; selecting it emits one note on stderr without the path. Invalid higher-priority paths fail instead of falling back. `--doctor` checks configuration and metadata; `--help` describes synthetic-only scope. Normal stdio stdout is exclusively protocol traffic. The demo starts the fixture and a real MCP client/server connection, calls discovery/search/read/paging as useful, prints a concise synthetic result summary, and cleans up both processes.

Use official SDK v2 installed package types/source to confirm API details; do not copy old v1 framing or invent modern metadata. Add meaningful real-client end-to-end tests. Do not implement remote serving or grant shortcuts to get a demo working. HAPI Docker integration is owned by GPT; the fixture is an executable deterministic stand-in, not proof of HAPI/Medplum/vendor compatibility.
