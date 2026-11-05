import assert from 'node:assert/strict';
import { afterEach, type TestContext } from 'node:test';

/**
 * Stream-teardown regressions surface as process-level `uncaughtException`s (for example a
 * web-stream adapter enqueueing into a closed controller from a `'data'` listener), which no
 * caller try/catch can observe. These helpers turn any such escape into a test failure.
 */
const describe = (error: unknown): string => error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);

/** Captures uncaught escapes for one test so it can assert none fired, instead of crashing the file. */
export function captureUncaught(t: TestContext): { assertNone: () => Promise<void> } {
  const seen: string[] = [];
  const onUncaught = (error: Error) => { seen.push(`uncaughtException: ${describe(error)}`); };
  const onUnhandled = (error: unknown) => { seen.push(`unhandledRejection: ${describe(error)}`); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => { process.off('uncaughtException', onUncaught); process.off('unhandledRejection', onUnhandled); });
  return {
    assertNone: async () => {
      // A late chunk delivered after cancellation escapes on a later tick; let queued ticks drain first.
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.deepEqual(seen, [], 'no uncaughtException/unhandledRejection may escape stream teardown');
    },
  };
}

/** File-level guard: fails whichever test was running when an uncaught escape fires. */
export function guardAgainstUncaught(): void {
  const seen: string[] = [];
  process.on('uncaughtExceptionMonitor', error => { seen.push(`uncaughtException: ${describe(error)}`); });
  process.on('unhandledRejection', error => { seen.push(`unhandledRejection: ${describe(error)}`); });
  afterEach(() => { assert.deepEqual(seen.splice(0), [], 'no uncaughtException/unhandledRejection may escape during a test'); });
}
