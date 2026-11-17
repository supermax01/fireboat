// Test-title index reporter for the mutation gate's clean baselines.
//
// The gate adds this reporter beside the TAP reporter in its baseline runs only.
// Each finished test becomes one JSON line: the file that declared it, its name,
// its nesting and its duration. The gate uses the lines to choose candidate test
// files for its targeted first pass. The index never decides a verdict: a wrong
// or missing line only changes which tests are tried first.
export default async function* mutationTestIndexReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { file, name, nesting, details } = event.data ?? {};
    if (typeof file !== 'string' || typeof name !== 'string') continue;
    const durationMs = Number(details?.duration_ms);
    yield `${JSON.stringify({ file, name, nesting: Number(nesting) || 0, durationMs: Number.isFinite(durationMs) ? durationMs : 0 })}\n`;
  }
}
