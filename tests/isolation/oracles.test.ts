import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANARIES, B, CREDENTIAL } from './canaries.js';
import { structural, scan, lintFixturePlacement } from './scanners.js';
import { egressFailures, reportReadiness } from './runner.js';
import type { Backend } from './backend.js';

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
