// Later delivery/deadline guards mask the old admission fixtures; this case
// observes completed-call release directly before unrelated tests can stall.
// The 00- prefix is load-bearing: the judge sorts its explicit file list, so
// this named discriminator starts before slot-leak mutants stall other files.
// Its own 3 s deadline (plus abort/fixture cleanup) is independent of suite caps.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withGateway } from './s57-sdk-helpers.js';

// kills: slot-release
test('mutation discriminator: completed production calls release an idle admission slot', async () => {
  await withGateway({}, async gateway => {
    const internal = gateway as any;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new assert.AssertionError({ message: 'completed production calls must release admission within 3 seconds' }));
        controller.abort();
      }, 3_000);
    });
    try {
      await Promise.race([deadline, (async () => {
        assert.equal(internal.active, 0);
        for (let call = 0; call < 2; call++) {
          const envelope = await gateway.execute('fhir_capabilities', { topic: 'server' }, { signal: controller.signal });
          assert.equal(envelope.error, undefined);
          assert.equal(internal.waiters.length, 0);
          assert.equal(internal.active, 0);
        }
      })()]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
});
