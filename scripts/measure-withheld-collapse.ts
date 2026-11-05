/**
 * S5b measurement: how much the withheld-entry collapse saves on synthetic Observation pages whose
 * records each carry repeated policy manifests (/subject/display companion, signed /meta/source link),
 * with and without a schema Attachment (url + metadata-free data) and an unknown-origin vendor link per record.
 * Renders real pages through the production gateway and SDK in both eras and both delivery profiles. For
 * full-text-v1 the uncollapsed envelope is reconstructed by expanding every counted entry, so "before" is
 * exact for the same records. For structured-evidence-v1 the S5 text aggregator (one `xN` line per shape,
 * origin-blind) is gone, so the attachment-line growth is reported against a merged-line equivalent.
 * Development-only evidence on the synthetic fixture; it is not the C.3 frozen-stratum measurement.
 *   node --import tsx scripts/measure-withheld-collapse.ts [out.md]
 */
import { writeFileSync } from 'node:fs';
import { toMcpToolResult02 } from '../packages/core/src/contracts.js';
import { patient, withGateway, withSdk } from '../tests/s57-sdk-helpers.js';

type Rec = Record<string, unknown>;
const obs = (id: string, extra: Rec = {}) => ({ resourceType: 'Observation', id, status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '4548-4' }], text: 'HbA1c' },
  subject: { reference: `Patient/${patient}`, display: 'Synthetic A' }, meta: { source: 'https://example.invalid/src?sig=synthetic' },
  effectiveDateTime: '2025-01-01T00:00:00Z', valueQuantity: { value: 6.1, unit: '%' }, ...extra });
const ATTACHMENT_EXTRA: Rec = { extension: [{ url: 'http://example.invalid/att', valueAttachment: { url: 'https://example.invalid/x.pdf', data: 'AAAA' } }],
  vendorDocument: { url: 'https://example.invalid/doc.pdf?sig=synthetic' } };
const KINDS = ['policy-only', 'attachment-heavy'] as const;
const pageFor = (kind: typeof KINDS[number], n: number) => Array.from({ length: n }, (_, i) => obs(`synthetic-m${i}`, kind === 'attachment-heavy' ? ATTACHMENT_EXTRA : {}));
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const pct = (a: number, b: number) => `${(100 * (b - a) / b).toFixed(1)}%`;
const expand = (envelope: Rec): Rec => {
  const copy = structuredClone(envelope) as Rec;
  const transform = copy.transform as { withheld_payloads: Rec[] };
  transform.withheld_payloads = transform.withheld_payloads.flatMap(m => typeof m.count === 'number' ? Array.from({ length: m.count as number }, () => ({ path: m.path, reason: m.reason })) : [m]);
  return copy;
};
const render = (envelope: Rec, era: 'modern' | 'legacy', serverIdentity: unknown) => {
  const e = structuredClone(envelope) as Rec & { budget: { bytes_returned: number } };
  const draw = () => ({ ...toMcpToolResult02(e as never), ...(era === 'modern' ? { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': serverIdentity } } : {}) });
  for (let i = 0; i < 8; i++) e.budget.bytes_returned = bytes(draw());
  return e.budget.bytes_returned;
};
type Sdk = Parameters<Parameters<typeof withSdk>[2]>[0];
const search = (sdk: Sdk, n: number) =>
  sdk.call('fhir_search', { resource_type: 'Observation', page_size: Math.min(n, 100), output: { format: 'fhir', max_bytes: 131072 } }) as unknown as Promise<{ e: Rec & { error?: unknown; budget: { bytes_returned: number } }; capture: { serverIdentity: unknown; renderedText: string } }>;

const fullText: string[] = ['| page | N | era | records delivered | structuredContent after (B) | before (B) | saved | result bytes after (B) | before (B) | saved | withheld share after | before |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
const structured: string[] = ['| page | N | era | records delivered | result bytes (B) | withheld lines | counted lines | attachment lines | attachment-line bytes (B) | merged-line equivalent (B) | growth (B) | growth share |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
for (const kind of KINDS) for (const n of [20, 100]) for (const era of ['modern', 'legacy'] as const) {
  await withGateway({ pages: [pageFor(kind, n)] }, gateway => withSdk(gateway, era, async sdk => {
    const r = await search(sdk, n);
    if (r.e.error) throw new Error(`search failed: ${JSON.stringify(r.e.error)}`);
    const after = r.e as Rec, before = expand(after);
    const sAfter = bytes(after), sBefore = bytes(before);
    const rAfter = (after.budget as { bytes_returned: number }).bytes_returned, rBefore = render(before, era, r.capture.serverIdentity);
    const wAfter = bytes((after.transform as Rec).withheld_payloads), wBefore = bytes((before.transform as Rec).withheld_payloads);
    fullText.push(`| ${kind} | ${n} | ${era} | ${(after.data as { resources: unknown[] }).resources.length} | ${sAfter} | ${sBefore} | ${pct(sAfter, sBefore)} | ${rAfter} | ${rBefore} | ${pct(rAfter, rBefore)} | ${(100 * wAfter / sAfter).toFixed(1)}% | ${(100 * wBefore / sBefore).toFixed(1)}% |`);
  }));
  await withGateway({ pages: [pageFor(kind, n)], structured: true }, gateway => withSdk(gateway, era, async sdk => {
    const r = await search(sdk, n);
    if (r.e.error) throw new Error(`structured search failed: ${JSON.stringify(r.e.error)}`);
    const lines = r.capture.renderedText.split('\n');
    const withheldLines = lines.filter(line => line.startsWith('withheld'));
    const counted = withheldLines.filter(line => /^withheld x\d+: /.test(line));
    const attachment = withheldLines.filter(line => line.startsWith('withheld: {"path":"/extension/0/valueAttachment/'));
    const lineBytes = (line: string) => Buffer.byteLength(line) + 1;
    const attachmentBytes = attachment.reduce((sum, line) => sum + lineBytes(line), 0);
    // S5 merged the metadata-free attachment lines by shape: one `withheld xN:` line per distinct line.
    const merged = [...new Set(attachment)].reduce((sum, line) => sum + lineBytes(line) + ` x${attachment.filter(l => l === line).length}`.length, 0);
    const total = r.e.budget.bytes_returned;
    structured.push(`| ${kind} | ${n} | ${era} | ${(r.e.data as { resources: unknown[] }).resources.length} | ${total} | ${withheldLines.length} | ${counted.length} | ${attachment.length} | ${attachmentBytes} | ${merged} | ${attachmentBytes - merged} | ${(100 * (attachmentBytes - merged) / total).toFixed(1)}% |`);
  }));
}
const report = ['# S5b withheld-entry collapse: measured savings (synthetic Observation pages)', '',
  'Each record carries two repeated policy manifests (`/subject/display` companion, signed `/meta/source` link). The attachment-heavy page adds, per record, a schema Attachment (`extension[0].valueAttachment` with a url and a metadata-free `data` payload) and an unknown-origin vendor link; none of those three entries may collapse.', '',
  '## full-text-v1', '',
  '"Before" expands every counted entry back to one entry per occurrence on the same delivered records, so the comparison holds the record set fixed; the full-text channel repeats the JSON in `content[0].text`, so result bytes move about as much as structuredContent.', '',
  ...fullText, '',
  '## structured-evidence-v1', '',
  'The slim text prints one `withheld` line per delivered entry and `withheld xN:` for counted entries. The S5 renderer merged metadata-free attachment lines by shape regardless of origin; S5b keeps them one per occurrence, so attachment-heavy pages grow by the difference shown (`growth`), measured against a merged-line equivalent of the same lines.', '',
  ...structured, '', `Generated ${new Date().toISOString()} by scripts/measure-withheld-collapse.ts.`, ''].join('\n');
if (process.argv[2]) writeFileSync(process.argv[2], report);
console.log(report);
