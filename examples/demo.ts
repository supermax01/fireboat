import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { startSyntheticFhirServer } from './synthetic-server.js';

// End-to-end synthetic demo: fixture FHIR server + real MCP client
// talking to the gateway CLI over stdio. No LLM or API keys involved.
//
//   --check             assert every outcome below and exit non-zero on any deviation (J-43)
//   --negative-control  run --check with the trusted patient deliberately set to the other synthetic
//                       patient; succeeds only if the check detects the confinement deviations

interface EnvelopeLike {
  error?: { code: string; safe_message: string };
  coverage?: { state?: string };
  pagination?: { returned_matches?: number; next_cursor?: string; has_more?: boolean | null };
  result?: { handle?: string };
  data?: Record<string, unknown>;
}
interface ToolResultLike { structuredContent?: unknown; isError?: boolean }
export interface DemoOutcome { check_id: string; ok: boolean; detail: string }
export interface DemoOptions { patientId?: string; log?: (line: string) => void }

export const EXPECTED_TOOLS = ['fhir_capabilities', 'fhir_search', 'fhir_read', 'fhir_page', 'fhir_result'] as const;
/** The deviations a demo run with the other patient trusted must detect. */
export const NEGATIVE_CONTROL_DETECTS = ['search-confined-to-trusted-patient', 'cross-patient-read-denied'] as const;
const TRUSTED = 'synthetic-patient-a';

function envelopeOf(result: ToolResultLike): EnvelopeLike {
  const sc = result.structuredContent;
  return (typeof sc === 'object' && sc !== null ? sc : {}) as EnvelopeLike;
}
function resourceSummaries(data: unknown, acc: string[] = []): string[] {
  if (acc.length >= 10) return acc;
  if (Array.isArray(data)) { for (const item of data) resourceSummaries(item, acc); return acc; }
  if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>;
    if (typeof rec['resourceType'] === 'string' && typeof rec['id'] === 'string') acc.push(`${rec['resourceType']}/${rec['id']}`);
    else for (const value of Object.values(rec)) resourceSummaries(value, acc);
  }
  return acc;
}
function describe(log: (line: string) => void, label: string, result: ToolResultLike): EnvelopeLike {
  const env = envelopeOf(result);
  if (result.isError || env.error) {
    log(`${label}: error ${env.error?.code ?? 'unknown'} — ${env.error?.safe_message ?? 'tool error'}`);
    return env;
  }
  const found = resourceSummaries(env.data);
  const returned = env.pagination?.returned_matches;
  log(
    `${label}: coverage=${env.coverage?.state ?? 'unknown'}`
    + `${returned !== undefined ? ` returned=${returned}` : ''}`
    + `${env.pagination?.next_cursor ? ' has_next_page=yes' : ''}`
    + `${found.length ? ` resources=[${found.join(', ')}]` : ''}`,
  );
  return env;
}
const okResult = (result: ToolResultLike, env: EnvelopeLike) => !result.isError && !env.error;
const otherPatientMarkers = (patientId: string) => ['synthetic-patient-a', 'synthetic-patient-b'].filter(id => id !== patientId).flatMap(id => [id, `synthetic-obs-${id.slice(-1)}`]);

/** Runs the demo against a fresh synthetic source and gateway subprocess; returns every asserted outcome. */
export async function runDemo(options: DemoOptions = {}): Promise<DemoOutcome[]> {
  const log = options.log ?? (line => console.log(line));
  const patientId = options.patientId ?? TRUSTED;
  const outcomes: DemoOutcome[] = [];
  const expect = (check_id: string, ok: boolean, detail: string) => { outcomes.push({ check_id, ok, detail }); };
  const synthetic = await startSyntheticFhirServer();
  let tempDir: string | undefined;
  let client: Client | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'fhir-mcp-demo-'));
    const configPath = join(tempDir, 'config.json');
    const config = { mode: 'synthetic', source: { alias: 'local-synthetic', baseUrl: synthetic.baseUrl }, patientId };
    await writeFile(configPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });

    // Spawn our CLI the same way npm scripts do: Node with tsx for
    // sources, or plain Node for a compiled dist/ build.
    const here = dirname(fileURLToPath(import.meta.url));
    const isTypeScript = import.meta.url.endsWith('.ts');
    const cliPath = join(here, '..', 'packages', 'server', 'src', isTypeScript ? 'cli.ts' : 'cli.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...(isTypeScript ? ['--import', 'tsx'] : []), cliPath, '--config', configPath],
      cwd: join(here, '..'),
      env: getDefaultEnvironment(),
      stderr: 'inherit',
    });

    client = new Client({ name: 'fhir-mcp-demo', version: '0.1.0-alpha.1' });
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => await client!.callTool({ name, arguments: args }) as ToolResultLike;

    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    log(`tools: ${names.join(', ')}`);
    expect('tools-listed', JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `listed ${names.length} tools`);

    const caps = await call('fhir_capabilities', { topic: 'server' });
    const capsEnv = describe(log, 'capabilities', caps);
    expect('capabilities-succeed', okResult(caps, capsEnv) && capsEnv.data?.['data_classification'] === 'operator_declared_synthetic_unverified', capsEnv.error?.code ?? 'synthetic source described');

    const search = await call('fhir_search', { resource_type: 'Observation', params: [], page_size: 1 });
    const page1 = describe(log, 'search Observation (page_size=1)', search);
    const ids1 = resourceSummaries(page1.data);
    const searchText = JSON.stringify(search);
    expect('search-returns-records', okResult(search, page1) && ids1.length >= 1, `${ids1.length} record(s)`);
    expect('search-confined-to-trusted-patient', ids1.length >= 1 && ids1.every(id => id.startsWith(`Observation/synthetic-obs-${TRUSTED.slice(-1)}`)) && !otherPatientMarkers(TRUSTED).some(marker => searchText.includes(marker)), 'page 1 carries only the trusted patient\'s observations');

    if (page1.pagination?.next_cursor) {
      const next = await call('fhir_page', { cursor: page1.pagination.next_cursor });
      const page2 = describe(log, 'page (next)', next);
      const ids2 = resourceSummaries(page2.data);
      expect('page-continues', okResult(next, page2) && ids2.length >= 1 && ids2.every(id => !ids1.includes(id)), `${ids2.length} new record(s)`);
    } else {
      log('page (next): no continuation cursor returned');
      expect('page-continues', false, 'no continuation cursor returned');
    }

    const read = await call('fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-a1', interaction: 'read' });
    const readEnv = describe(log, 'read Observation/synthetic-obs-a1', read);
    expect('read-trusted-record', okResult(read, readEnv) && resourceSummaries(readEnv.data).includes('Observation/synthetic-obs-a1'), readEnv.error?.code ?? 'record returned');

    const denied = await call('fhir_read', { resource_type: 'Observation', id: 'synthetic-obs-b1', interaction: 'read' });
    const deniedEnv = describe(log, 'read other-patient Observation (expect denial)', denied);
    expect('cross-patient-read-denied', denied.isError === true && deniedEnv.error?.code === 'NOT_FOUND' && JSON.stringify(deniedEnv.data ?? {}) === '{}' && !JSON.stringify(denied).includes('valueQuantity'), deniedEnv.error?.code ?? 'the other patient\'s record was returned');

    if (page1.result?.handle) {
      const inspect = await call('fhir_result', { handle: page1.result.handle, action: 'inspect' });
      const inspectEnv = describe(log, 'result inspect', inspect);
      expect('result-inspect', okResult(inspect, inspectEnv) && Number(inspectEnv.data?.['resource_count']) >= 1, inspectEnv.error?.code ?? `${String(inspectEnv.data?.['resource_count'])} retained record(s)`);
    } else expect('result-inspect', false, 'search returned no result handle');
    log('demo complete (synthetic data only)');
  } catch (error) {
    expect('demo-completed', false, error instanceof Error ? error.message.replace(/[\r\n]+/g, ' ').slice(0, 240) : 'unexpected error');
  } finally {
    try { await client?.close(); } catch { /* subprocess already gone */ }
    try { await synthetic.close(); } catch { /* already closed */ }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return outcomes;
}

async function main(argv: string[]): Promise<number> {
  const check = argv.includes('--check') || argv.includes('--negative-control');
  const negative = argv.includes('--negative-control');
  const unknown = argv.filter(arg => !['--check', '--negative-control'].includes(arg));
  if (unknown.length) { console.error(`demo: unknown argument ${unknown[0]}`); return 2; }
  const outcomes = await runDemo(negative ? { patientId: 'synthetic-patient-b' } : {});
  const failed = outcomes.filter(outcome => !outcome.ok);
  if (negative) {
    const missed = NEGATIVE_CONTROL_DETECTS.filter(id => !failed.some(outcome => outcome.check_id === id));
    console.log(`negative control: ${missed.length ? `check MISSED ${missed.join(', ')}` : `check detected ${NEGATIVE_CONTROL_DETECTS.join(', ')}`}`);
    return missed.length || outcomes.some(outcome => outcome.check_id === 'demo-completed') ? 1 : 0;
  }
  if (failed.some(outcome => outcome.check_id === 'demo-completed')) console.error(`demo failed: ${failed.find(outcome => outcome.check_id === 'demo-completed')!.detail}`);
  if (!check) return failed.some(outcome => outcome.check_id === 'demo-completed') ? 1 : 0;
  for (const outcome of outcomes) console.log(`check ${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.check_id}: ${outcome.detail}`);
  console.log(failed.length ? `demo check FAILED (${failed.length} deviation(s))` : `demo check passed (${outcomes.length} outcomes)`);
  return failed.length ? 1 : 0;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then(
    (code) => { if (code !== 0) process.exit(code); },
    () => process.exit(1),
  );
}
