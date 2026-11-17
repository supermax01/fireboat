/** Used only by the qualification scripts after every private control has passed in both eras. */
import { readFileSync, writeFileSync } from 'node:fs';
export function recordSearchQualification(id: string, source: Record<string, unknown>, evidence: Record<string, unknown>): void {
  const file = 'packages/core/src/data/search-profiles.json';
  const text = readFileSync(file, 'utf8'), registry = JSON.parse(text);
  const profile = registry.profiles.find((row: { id: string }) => row.id === id);
  if (!profile || !profile.eligible) throw new Error('Re-qualification requires an existing eligible profile.');
  profile.source = { ...profile.source, ...source }; profile.evidence = evidence;
  // Preserve the registry's reviewed layout, changing only the intended profile's source/evidence and note.
  const start = text.indexOf(`"id": "${id}"`), end = text.indexOf('\n    }', start);
  let block = text.slice(start, end);
  block = block.replace(/"source": \{[^\n]+\}/, `"source": ${JSON.stringify(profile.source)}`)
    .replace(/"evidence": \{[^\n]+\}/, `"evidence": ${JSON.stringify(evidence)}`);
  const baseNote = profile.note.replace(/ Last qualified \d{4}-\d{2}-\d{2} in both protocol eras and every arm\./g, '');
  const note = `${baseNote} Last qualified ${String(evidence.recorded_at).slice(0, 10)} in both protocol eras and every arm.`;
  block = block.replace(/"note": "[^\n]+"/, `"note": ${JSON.stringify(note)}`);
  writeFileSync(file, text.slice(0, start) + block + text.slice(end));
  if (id === 'hapi-r4-labs-v1') {
    const pinFile = 'tests/gbackend-profile-helpers.ts';
    let pins = readFileSync(pinFile, 'utf8');
    pins = pins.replace(/export const HAPI_RECORDED_EVIDENCE = \{[\s\S]+?\n\}/, `export const HAPI_RECORDED_EVIDENCE = ${JSON.stringify(evidence, null, 2)}`);
    pins = pins.replace(/corpus_sha256: '[a-f0-9]{64}'/, `corpus_sha256: '${profile.source.corpus_sha256}'`);
    writeFileSync(pinFile, pins);
    const queryFile = 'tests/query-evidence.test.ts';
    const query = readFileSync(queryFile, 'utf8').replace(/(assert.equal\(hapi.evidence\?\.report_sha256, ')[a-f0-9]{64}/, `$1${evidence.report_sha256}`);
    writeFileSync(queryFile, query);
  }
  console.log(`QUALIFICATION_RECORDED profile=${id} report=${evidence.report_sha256}`);
}
