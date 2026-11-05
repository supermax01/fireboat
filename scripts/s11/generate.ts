import { GENERATOR_PINS, validateGeneratorPins } from '../../examples/quickstart/manifest.js';
import { STUDY, hash, requireS11, pool, type Split, type Stratum } from './study.js';
// This is the existing reviewed, dependency-free Docker adapter; it has no acquisition operation.
// @ts-expect-error The reused .mjs generator is intentionally a JavaScript entry point.
import { createLocalExecutor, generationCommand, generationProperties, sameExports } from '../quickstart/generate-synthea.mjs';

export interface GeneratorExecutor {
  inspectJar(path: string): Promise<{ path: string; sha256: string; bytes: number }>;
  createWorkspace(path: string): Promise<{ first: string; second: string; config: string }>;
  writeProperties(path: string, text: string): Promise<void>;
  run(command: { file: string; args: string[] }): Promise<{ code: number }>;
  readExports(path: string): Promise<Map<string, Uint8Array>>;
}
export function candidatePins(split: Split, stratum: Stratum, seed: number) {
  validateGeneratorPins(GENERATOR_PINS);
  requireS11(pool(split, stratum).includes(seed), 'SEED_OUTSIDE_POOL');
  const ages = STUDY.ages[STUDY.strata.indexOf(stratum)]!;
  return { ...GENERATOR_PINS, generation: { ...GENERATOR_PINS.generation,
    seed, clinicianSeed: seed, population: 1, ages: { min: ages[0], max: ages[1] } } };
}
/** Two empty workspaces, raw file/byte equality before any transform or screening. */
export async function generateCandidate(input: { split: Split; stratum: Stratum; seed: number; jar: string; out: string }, executor: GeneratorExecutor = createLocalExecutor()) {
  const pins = candidatePins(input.split, input.stratum, input.seed), jar = await executor.inspectJar(input.jar);
  requireS11(jar.sha256 === pins.synthea.sha256 && jar.bytes === pins.synthea.bytes, 'JAR_MISMATCH');
  const dirs = await executor.createWorkspace(input.out), properties = generationProperties(pins) as string;
  await executor.writeProperties(dirs.config, properties);
  const snapshots: Map<string, Uint8Array>[] = [];
  for (const out of [dirs.first, dirs.second]) {
    const result = await executor.run(generationCommand(pins, jar.path, dirs.config, out));
    requireS11(result.code === 0, 'GENERATION_FAILED');
    const exported = await executor.readExports(out);
    requireS11(exported.size > 0 && exported.size <= 4096 && [...exported].every(([name, bytes]) => /^fhir\/[A-Za-z0-9_.-]+\.json$/.test(name) && bytes instanceof Uint8Array)
      && [...exported.values()].reduce((n, b) => n + b.length, 0) <= 268435456, 'EXPORT_INVALID');
    snapshots.push(new Map([...exported].map(([name, bytes]) => [name, Buffer.from(bytes)])));
  }
  requireS11(sameExports(snapshots[0], snapshots[1]), 'EXPORTS_DIFFER');
  const files = [...snapshots[0]!].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: hash(bytes) }));
  return { pins, configSha256: hash(properties), rawExportsSha256: hash(JSON.stringify(files)), files, runs: 2,
    exports: [...snapshots[0]!].map(([name, bytes]) => ({ name: name.slice(5), bytes })) };
}
