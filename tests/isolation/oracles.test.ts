import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANARIES, A, B, CREDENTIAL } from './canaries.js';
import { structural, scan, lintFixturePlacement } from './scanners.js';
import { egressFailures, reportReadiness } from './runner.js';
import { directoryReferencesOfA, type Backend, type ServedGrant } from './backend.js';

test('state walk reaches new fields, ledger, nonenumerable own data and symbol values', () => {
  const object = { newlyAdded: { secret: B }, ledger: new Map([[B, new Set([B])]]), credentials: B, config: B, transport: B, timer: B };
  Object.defineProperty(object, 'hiddenOwnData', { value: B });
  Object.defineProperty(object, Symbol('state'), { value: B });
  Object.defineProperty(object, 'getterNotInvoked', { get() { throw new Error('getter invoked'); } });
  const view = structural(object) as Record<string, unknown>;
  assert.ok(scan('state', view).length >= 9);
  assert.equal(view.credentials, undefined); assert.equal(view.config, undefined);
  assert.equal(view.transport, undefined); assert.equal(view.timer, undefined);
  assert.equal(view.hiddenOwnData, B); assert.equal(view['Symbol(state)'], B);
});
test('fixture-placement lint rejects late canaries and accepts capped surviving segments', () => {
  lintFixturePlacement({ display: 'x'.repeat(108) + CANARIES[0].segments[0] });
  assert.throws(() => lintFixturePlacement({ display: 'x'.repeat(112) + B }));
  assert.throws(() => lintFixturePlacement({ ['x'.repeat(112) + B]: 'ordinary' }));
});
test('egress rule rejects a foreign pair even alongside trusted confinement and scopes ingress exceptions', () => {
  const backend = (raw_target: string) => ({ base: 'http://127.0.0.1:1/fhir/', requests: [{ phase: 'target', raw_target, pairs: [...new URL(raw_target, 'http://127.0.0.1:1').searchParams].map(([name, value]) => ({ name, value })) }] }) as Backend;
  assert.ok(egressFailures('B2-SEL-01', backend(`/fhir/Observation?patient=Patient/synthetic-a&patient=Patient/${B}`)).length);
  assert.ok(egressFailures('B2-HPP-01', backend('/fhir/Observation?patient=Patient/synthetic-a&subject=Patient/foreign-unmarked')).length);
  assert.equal(egressFailures('B2-CLS-01', backend(`/fhir/Observation/obs-${B}`)).length, 0);
  assert.ok(egressFailures('B2-CLS-01', backend(`/fhir/Observation/obs-${B}?token=${CREDENTIAL}`)).length);
  assert.ok(egressFailures('B2-SEL-01', backend(`/fhir/Observation/obs-${B}`)).length);
});
test('egress rule: a directory _id passes only for ids an earlier A-bound served record named; everything else on directory paths is flagged', () => {
  const pairs = (raw_target: string) => [...new URL(raw_target, 'http://127.0.0.1:1').searchParams].map(([name, value]) => ({ name, value }));
  const at = (sequence: number, raw_target: string) => ({ sequence, phase: 'target', raw_target, pairs: pairs(raw_target) });
  const backend = (served: ServedGrant[], ...requests: ReturnType<typeof at>[]) => ({ base: 'http://127.0.0.1:1/fhir/', requests, served }) as unknown as Backend;
  const flagged = (served: ServedGrant[], ...requests: ReturnType<typeof at>[]) => egressFailures('B2-SHR-05', backend(served, ...requests));
  for (const type of ['Practitioner', 'Organization', 'Location']) {
    const granted: ServedGrant[] = [{ sequence: 1, boundA: true, references: [`${type}/directory-1`] }];
    const own = at(1, `/fhir/Observation?patient=Patient/${A}&_count=20`);
    // A reachable id named earlier by an A-bound served record passes, with its paging controls.
    assert.deepEqual(flagged(granted, own, at(2, `/fhir/${type}?_id=directory-1&_count=20`)), [], type);
    const cases: [string, ServedGrant[], ReturnType<typeof at>[]][] = [
      ['an id nothing named', granted, [own, at(2, `/fhir/${type}?_id=directory-2&_count=20`)]],
      ['patient B\'s id', granted, [own, at(2, `/fhir/${type}?_id=${B}&_count=20`)]],
      ['an unmarked foreign id', granted, [own, at(2, `/fhir/${type}?_id=foreign-unmarked&_count=20`)]],
      ['a list with one id nothing named', granted, [own, at(2, `/fhir/${type}?_id=directory-1,directory-2&_count=20`)]],
      ['an empty alternative', granted, [own, at(2, `/fhir/${type}?_id=directory-1,&_count=20`)]],
      ['a lookup before the grant', [{ sequence: 3, boundA: true, references: [`${type}/directory-1`] }], [at(2, `/fhir/${type}?_id=directory-1&_count=20`), at(3, `/fhir/Observation?patient=Patient/${A}`)]],
      ['a lookup in the same request as the grant', [{ sequence: 2, boundA: true, references: [`${type}/directory-1`] }], [at(2, `/fhir/${type}?_id=directory-1&_count=20`)]],
      ['a grant from a request without the A pair', [{ sequence: 1, boundA: false, references: [`${type}/directory-1`] }], [at(1, '/fhir/Observation/obs-a.1-x'), at(2, `/fhir/${type}?_id=directory-1`)]],
      ['a grant for another directory type', [{ sequence: 1, boundA: true, references: [`${type === 'Location' ? 'Organization' : 'Location'}/directory-1`] }], [own, at(2, `/fhir/${type}?_id=directory-1`)]],
      ['a patient pair bound to A', granted, [own, at(2, `/fhir/${type}?_id=directory-1&patient=Patient/${A}`)]],
      ['a subject pair bound to A', granted, [own, at(2, `/fhir/${type}?_id=directory-1&subject=Patient/${A}`)]],
      ['a foreign patient pair', granted, [own, at(2, `/fhir/${type}?patient=Patient/${B}`)]],
      ['a foreign subject pair', granted, [own, at(2, `/fhir/${type}?subject=Patient/foreign-unmarked`)]],
      ['another predicate beside a reachable _id', granted, [own, at(2, `/fhir/${type}?_id=directory-1&name=Synthetic`)]],
      ['another predicate alone', granted, [own, at(2, `/fhir/${type}?identifier=urn:synthetic:directory|x`)]],
    ];
    for (const [label, served, requests] of cases) assert.ok(flagged(served, ...requests).length > 0, `${type}: ${label}`);
    // Without any journal the rule fails closed.
    assert.ok(egressFailures('B2-SHR-05', ({ base: 'http://127.0.0.1:1/fhir/', requests: [at(2, `/fhir/${type}?_id=directory-1`)] }) as unknown as Backend).length > 0, `${type}: no journal`);
  }
  // `_id` on any other path keeps the bound-A rule.
  assert.ok(flagged([{ sequence: 1, boundA: true, references: ['Practitioner/directory-1'] }], at(2, '/fhir/Observation?_id=directory-1&patient=Patient/' + A)).length > 0);
  // The journal takes directory references only from records whose subject or patient is A, contained resources included.
  assert.deepEqual(directoryReferencesOfA([
    { resourceType: 'Observation', subject: { reference: `Patient/${A}` }, performer: [{ reference: 'Practitioner/p-1' }, { reference: 'Patient/' + A }], contained: [{ resourceType: 'Location', id: 'c', managingOrganization: { reference: 'Organization/o-1' } }], focus: [{ reference: 'Location/l-1' }, { reference: 'Location/../x' }, { reference: 'PractitionerRole/r-1' }] },
    { resourceType: 'Observation', subject: { reference: `Patient/${B}` }, performer: [{ reference: 'Practitioner/p-foreign' }] },
    { resourceType: 'Practitioner', id: 'p-1', name: [{ family: 'x' }] },
  ]), ['Location/l-1', 'Organization/o-1', 'Practitioner/p-1']);
});
test('report fails closed for each missing/failed prerequisite and fixture mismatch', () => {
  const ids = ['manifest_and_verifier', 'scanners', 'server_traffic', 'backend_liveness', 'operational_sinks', 'barrier_schedule'];
  const ready = Object.fromEntries(ids.map(id => [id, { verdict: 'PASS' }]));
  assert.equal(reportReadiness(ready, true), 'DIAGNOSTIC');
  assert.equal(reportReadiness(ready, false), 'INCONCLUSIVE');
  for (const id of ids) {
    const absent = { ...ready }; delete absent[id]; assert.equal(reportReadiness(absent, true), 'INCONCLUSIVE');
    assert.equal(reportReadiness({ ...ready, [id]: { verdict: 'FAIL' } }, true), 'INCONCLUSIVE');
  }
});
