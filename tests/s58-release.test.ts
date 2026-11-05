import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import packageJson from '../package.json' with { type: 'json' };
import * as contracts from '../packages/core/src/contracts.js';
import { FhirGateway, SERVER_IDENTITY, toolInputV2Schemas, type GatewayConfig } from '../packages/core/src/index.js';
import { drainToolListing, measureCatalog, ADVERTISED_SERVER_INFO } from '../packages/evals/src/catalog.js';
import { withGateway, withSdk, patient } from './s57-sdk-helpers.js';
import { readReleaseMetadata, versionLine } from '../packages/server/src/release.js';

const config: GatewayConfig = { mode: 'synthetic', source: { alias: 'local', baseUrl: 'http://127.0.0.1:9/fhir' }, patientId: 'synthetic-a' };

test('S58 gateway identity derives only from the root package release; source/client proof inputs stay pinned', () => {
  assert.equal(packageJson.version, '0.2.0-alpha.1');
  assert.equal(packageJson.name, '@fireboat/gateway');
  assert.equal(packageJson.mcpName, 'io.github.supermax01/fireboat');
  assert.deepEqual(packageJson.bin, { fireboat: 'dist/packages/server/src/cli.js' });
  assert.equal(SERVER_IDENTITY.name, 'fireboat');
  assert.equal(SERVER_IDENTITY.version, packageJson.version);
  assert.equal(ADVERTISED_SERVER_INFO, SERVER_IDENTITY);
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.name, packageJson.name); assert.equal(lock.packages[''].name, packageJson.name);
  assert.deepEqual(lock.packages[''].bin, packageJson.bin);
  assert.equal(lock.version, packageJson.version); assert.equal(lock.packages[''].version, packageJson.version);
  assert.equal(execFileSync(process.execPath, ['--import','tsx','packages/server/src/cli.ts','--version'], { encoding: 'utf8' }), `${versionLine(readReleaseMetadata())}\n`);
  // These are separate proof identities, deliberately unchanged by the gateway release.
  assert.match(readFileSync(new URL('../examples/synthetic-server.ts', import.meta.url), 'utf8'), /software: \{ name: 'fhir-mcp synthetic fixture', version: '0\.1\.0-alpha\.1' \}/);
  assert.match(readFileSync(new URL('../examples/demo.ts', import.meta.url), 'utf8'), /name: 'fhir-mcp-demo', version: '0\.1\.0-alpha\.1'/);
});

test('S58 deprecated 0.1 schemas have no exports or imports (W-01)', () => {
  assert.equal('envelopeSchema' in contracts, false); assert.equal('toolSchemas' in contracts, false);
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : /\.(ts|mjs)$/.test(entry.name) ? [join(directory, entry.name)] : []);
  for (const file of [...walk('packages'), ...walk('scripts')]) {
    const source = readFileSync(file, 'utf8');
    for (const imported of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
      assert.ok(!/\b(?:envelopeSchema|toolSchemas)\b/.test(imported[1]!), `${file}: stale schema import`);
    }
  }
});

test('S58 listing drain retains every page/SDK field and rejects missing/duplicate/unknown tools and cursor loops', async () => {
  const tools = ['fhir_capabilities','fhir_search','fhir_read','fhir_page','fhir_result'].map(name => ({ name, sdkField: name }));
  const requested: (string | undefined)[] = [];
  const complete = await drainToolListing(async cursor => {
    requested.push(cursor);
    return cursor === undefined ? { tools: tools.slice(0, 2), nextCursor: 'page-2', sdkPage: 1 } : { tools: tools.slice(2), sdkPage: 2 };
  });
  assert.deepEqual(complete.tools, tools); assert.equal(complete.pages.length, 2);
  assert.deepEqual(requested, [undefined, 'page-2']); assert.equal(complete.pages[1]!.sdkPage, 2);
  await assert.rejects(drainToolListing(async () => ({ tools: tools.slice(0, 2) })), /Missing/);
  await assert.rejects(drainToolListing(async cursor => cursor === undefined ? { tools: tools.slice(0, 2), nextCursor: 'p2' } : { tools }), /Duplicate/);
  await assert.rejects(drainToolListing(async () => ({ tools: [], nextCursor: 'loop' })), /cursor loop/);
  await assert.rejects(drainToolListing(async () => ({ tools: [{ name: 'unknown' }] })), /Unexpected/);
  await assert.rejects(drainToolListing(async () => ({ tools: [], nextCursor: '' })), /invalid cursor/);
  assert.equal(measureCatalog(tools.slice(0, 4), '', {}).withinCaps, false, 'incomplete catalogs never pass caps');
  assert.throws(() => measureCatalog([...tools, tools[0]], '', {}), /Duplicate/);
});

for (const field of ['defaultBytes','maxBytes'] as const) test(`S58 configured ${field} admits 8192..131072 only`, () => {
  for (const value of [8191, 8192.5, 131073]) assert.throws(() => new FhirGateway({ ...config, limits: { [field]: value } }), /Invalid synthetic gateway configuration/);
  for (const value of [8192, 131072]) {
    const gateway = new FhirGateway({ ...config, limits: { [field]: value } }); gateway.close();
  }
});

test('S58 explicit configured default greater than ceiling is rejected', () => {
  assert.throws(() => new FhirGateway({ ...config, limits: { defaultBytes: 8193, maxBytes: 8192 } }), /Invalid synthetic gateway configuration/);
  const gateway = new FhirGateway({ ...config, limits: { defaultBytes: 8192, maxBytes: 8192 } }); gateway.close();
});

for (const era of ['modern','legacy'] as const) {
  test(`S58 effective default caps to a ceiling-only config; omitted default stays 24576 (${era})`, async () => {
    for (const [limits, expected] of [[undefined, 24576], [{ maxBytes: 8192 }, 8192], [{ defaultBytes: 8192, maxBytes: 16384 }, 8192]] as const) {
      await withGateway({ limits }, gateway => withSdk(gateway, era, async sdk => {
        const { e } = await sdk.call('fhir_capabilities', { topic: 'context' });
        assert.equal(e.error, undefined); assert.equal(e.budget.byte_limit, expected);
      }));
    }
  });
  test(`S58 explicit 4096 minimal read/search succeed under configured 8192 minima (${era})`, async () => {
    const row = { resourceType: 'Observation', id: 'synthetic-minimal', subject: { reference: `Patient/${patient}` } };
    await withGateway({ pages: [[row]], limits: { defaultBytes: 8192, maxBytes: 8192 } }, gateway => withSdk(gateway, era, async sdk => {
      for (const tool of ['fhir_read','fhir_search'] as const) {
        const { e } = await sdk.call(tool, { resource_type: 'Observation', ...(tool === 'fhir_read' ? { id: row.id } : {}), output: { max_bytes: 4096 } });
        assert.equal(e.error, undefined); assert.deepEqual(e.data.resources, [row]); assert.equal(e.budget.byte_limit, 4096);
        assert.ok(e.budget.bytes_returned <= 4096); assert.equal(e.transform.format, 'fhir');
        assert.ok(!('requested_format' in e.transform));
      }
    }));
  });
}

test('S58 every query-repair and discovery example validates with actual issued controls in both eras', async () => {
  const directory = new URL('../examples/', import.meta.url);
  const files = ['query-repair-calls.json','discovery-calls.json'];
  let validated = 0;
  for (const era of ['modern','legacy'] as const) await withGateway({ pages: [[
    { resourceType: 'Observation', id: 'synthetic-example-a', subject: { reference: `Patient/${patient}` }, code: { coding: [{system:'http://loinc.org',code:'4548-4'}] } },
    { resourceType: 'Observation', id: 'synthetic-example-b', subject: { reference: `Patient/${patient}` }, code: { coding: [{system:'http://loinc.org',code:'4548-4'}] } },
  ]] }, gateway => withSdk(gateway, era, async sdk => {
    for (const file of files) {
      const examples = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
      // Example placeholders refer to a bounded sibling of the original HbA1c query.
      // page_size is a mechanical request; use an actually issued local remainder.
      const query = examples.calls.find((call: any) => call.id === 'hba1c-search')?.input;
      const controls = query ? (await sdk.call('fhir_search', { ...query, page_size: 1 })).e : undefined;
      const resolve = (value: unknown): any => {
        if (value === '{{cursor:hba1c-search}}') { assert.ok(controls?.pagination.next_cursor); return controls.pagination.next_cursor; }
        if (value === '{{handle:hba1c-search}}') { assert.ok(controls?.result.handle); return controls.result.handle; }
        if (Array.isArray(value)) return value.map(resolve);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
        return value;
      };
      for (const call of examples.calls) {
        const tool = call.tool as keyof typeof toolInputV2Schemas, input = resolve(call.input);
        assert.equal(toolInputV2Schemas[tool].safeParse(input).success, true, `${file}: ${call.id ?? tool}`);
        const { e } = await sdk.call(tool, input);
        assert.equal(e.error?.code, call.id === 'unsupported-code-text' ? 'UNSUPPORTED_MODIFIER' : undefined, `${file}: ${call.id ?? tool}`);
        validated++;
      }
    }
  }));
  assert.equal(validated, 22);
});
