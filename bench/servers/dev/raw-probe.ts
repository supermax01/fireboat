// Development aid: launch one arm, list tools, make the given raw tool calls, print raw lines.
// tsx servers/dev/raw-probe.ts <arm> <dataset> <patientId> <baseUrl> '<json array of {tool, arguments}>' [outDir]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArmId, DatasetId, ToolCall } from '../../lib/types.js';
import { tmpDir } from '../../lib/paths.js';
import { launch } from '../launch.js';

const [arm, dataset, patientId, base, callsJson, outDir] = process.argv.slice(2);
const runRoot = tmpDir(`probe-${arm!.toLowerCase()}`);
rmSync(runRoot, { recursive: true, force: true });
const s = await launch({ arm: arm as ArmId, dataset: dataset as DatasetId, patientId: patientId!, slot: 0, fhirBaseUrl: base!,
  runDir: join(runRoot, 'run'), runTmp: join(runRoot, 'tmp') });
const out: Record<string, unknown> = { coldStartMs: s.coldStartMs, protocolVersion: s.protocolVersion, serverInfo: s.serverInfo,
  instructionsBytes: s.instructionsBytes, toolsListBytes: s.toolsListBytes, tools: s.tools, noise: s.stdoutNoise, calls: [] };
for (const c of JSON.parse(callsJson ?? '[]') as ToolCall[]) (out.calls as unknown[]).push(await s.call(c, 60_000));
out.exit = await s.close();
out.validationIssues = s.validationIssues;
const text = JSON.stringify(out, null, 2);
if (outDir) { mkdirSync(outDir, { recursive: true }); writeFileSync(join(outDir, `${arm}.json`), text); }
process.stdout.write(text.slice(0, 200000) + '\n');
