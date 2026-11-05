#!/usr/bin/env node
// Reads installed package-owned texts verbatim; never fetches a license or infers seed rights from a source license.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sorted = items => [...items].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const bytesOf = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export class LicenseFault extends Error {
  constructor(code) { super(code); this.name = 'LicenseFault'; this.code = code; }
}
const fault = code => new LicenseFault(code);
const TEXT = /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/i;
const NOTICE = /^notice(?:[._-].*)?$/i;

/** Recursive package-owned license/NOTICE inventory, excluding other installed packages. */
async function ownedTexts(root) {
  const result = [];
  const walk = async relative => {
    const directory = join(root, relative);
    for (const name of sorted(await readdir(directory))) {
      if (['node_modules', '.git'].includes(name)) continue;
      const path = relative ? `${relative}/${name}` : name, info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw fault('LICENSE_UNSAFE');
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && TEXT.test(name)) {
        const body = await readFile(join(root, path));
        if (body.byteLength < 1 || body.byteLength > 1_048_576) throw fault('LICENSE_UNSAFE');
        result.push({ source: path, kind: NOTICE.test(name) ? 'notice' : 'license', body });
      }
    }
  };
  await walk(''); return result;
}

/** A required upstream NOTICE is distinct from an optional project NOTICE. */
export function requiredNoticeMissing(inventory) {
  return !Array.isArray(inventory?.dependencies) || inventory.dependencies.some(dependency =>
    !Array.isArray(dependency.requiredTexts) || !Array.isArray(dependency.texts) ||
    !dependency.requiredTexts.some(row => row.kind === 'license') ||
    dependency.requiredTexts.some(required => !dependency.texts.some(text => text.source === required.source && text.kind === required.kind &&
      typeof text.path === 'string' && /^[a-f0-9]{64}$/.test(text.sha256) && Number.isSafeInteger(text.bytes) && text.bytes > 0)));
}
export function validateNoticeInventory(inventory) {
  if (requiredNoticeMissing(inventory)) throw fault('NOTICE_MISSING');
  return inventory;
}

/** No identifiers or resource bodies enter the readable dependency/seed inventory. */
async function seedInventory(root) {
  const manifest = await json(join(root, 'examples/quickstart/seed-manifest.json'));
  const pins = await json(join(root, 'examples/quickstart/generator-pins.json'));
  const seed = await readFile(join(root, 'packages/evals/fixtures/quickstart/resources.ndjson'));
  const systems = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value.system === 'string' && typeof value.code === 'string') {
      const row = systems.get(value.system) ?? { codes: new Set(), displays: new Set() };
      row.codes.add(value.code); if (typeof value.display === 'string') row.displays.add(value.display);
      systems.set(value.system, row);
    }
    Object.values(value).forEach(visit);
  };
  for (const line of seed.toString('utf8').trim().split('\n')) visit(JSON.parse(line));
  const origins = {};
  for (const resource of manifest.resources) origins[resource.origin] = (origins[resource.origin] ?? 0) + 1;
  return {
    path: 'quickstart/packages/evals/fixtures/quickstart/resources.ndjson', sha256: sha256(seed), bytes: seed.byteLength,
    resources: manifest.resources.length, origins,
    generator: { name: 'Synthea', tag: pins.synthea.tag, commit: pins.synthea.commit, jarSha256: pins.synthea.sha256,
      distributed: false, sourceLicense: 'Apache-2.0', rightsReview: 'pending-owner-review' },
    terminology: sorted(systems.keys()).map(system => ({ system, codes: systems.get(system).codes.size, displays: systems.get(system).displays.size,
      rightsReview: 'pending-owner-review' })),
    notices: 'licenses/SEED_NOTICES.md',
    runtimeData: { source: 'HL7 FHIR R4 core 4.0.1', declaredLicense: 'CC0-1.0', notices: 'THIRD_PARTY_NOTICES.md' },
  };
}

export async function collectReleaseLicenses(root) {
  const gateway = await json(join(root, 'packaging/npm-shrinkwrap.json'));
  const helper = await json(join(root, 'examples/quickstart/package-lock.json'));
  const packages = new Map(), files = new Map();
  for (const [component, lock] of [['gateway', gateway], ['quickstart', helper]]) {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path) continue;
      const name = path.slice('node_modules/'.length);
      if (path !== `node_modules/${name}` || !/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || entry.dev || entry.link || !entry.integrity) throw fault('LICENSE_DEPENDENCY');
      const known = packages.get(name);
      if (known) {
        if (known.version !== entry.version || known.integrity !== entry.integrity) throw fault('LICENSE_DEPENDENCY');
        known.components.push(component); continue;
      }
      const installed = join(root, path), pkg = await json(join(installed, 'package.json'));
      if (pkg.name !== name || pkg.version !== entry.version || pkg.license !== entry.license) throw fault('LICENSE_DEPENDENCY');
      const texts = await ownedTexts(installed), target = name.replace(/^@/, '').replaceAll('/', '__');
      const rows = texts.map(text => {
        const path = `licenses/dependencies/${target}/${text.source}`;
        files.set(path, text.body);
        return { source: text.source, kind: text.kind, path, bytes: text.body.byteLength, sha256: sha256(text.body) };
      });
      packages.set(name, { name, version: entry.version, integrity: entry.integrity, license: pkg.license, components: [component],
        requiredTexts: texts.map(({ source, kind }) => ({ source, kind })), texts: rows });
    }
  }
  const inventory = validateNoticeInventory({ schema: 1, dependencies: sorted(packages.keys()).map(name => packages.get(name)), seed: await seedInventory(root) });
  return { inventory, files };
}

export async function checkReleaseLicenses(root) {
  const { inventory, files } = await collectReleaseLicenses(root);
  const approved = await json(join(root, 'licenses/inventory.json'));
  validateNoticeInventory(approved);
  if (!isDeepStrictEqual(inventory, approved)) throw fault('LICENSE_INVENTORY_CHANGED');
  for (const [path, body] of files) {
    let actual;
    try {
      const info = await lstat(join(root, path));
      if (!info.isFile() || info.isSymbolicLink()) throw 0;
      actual = await readFile(join(root, path));
    } catch { throw fault(path.split('/').at(-1).toLowerCase().startsWith('notice') ? 'NOTICE_MISSING' : 'LICENSE_MISSING'); }
    if (!actual.equals(body)) throw fault('LICENSE_TEXT_CHANGED');
  }
  const notice = await readFile(join(root, 'licenses/SEED_NOTICES.md'));
  if (!notice.byteLength) throw fault('NOTICE_MISSING');
  return inventory;
}

export async function writeReleaseLicenses(root) {
  const { inventory, files } = await collectReleaseLicenses(root);
  for (const [path, body] of files) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), body); }
  await writeFile(join(root, 'licenses/inventory.json'), bytesOf(inventory));
  return inventory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length && !['--write', '--check'].includes(args[0])) throw fault('LICENSE_USAGE');
    const root = fileURLToPath(new URL('../', import.meta.url));
    const inventory = args[0] === '--write' ? await writeReleaseLicenses(root) : await checkReleaseLicenses(root);
    console.log(`release-licenses: dependencies=${inventory.dependencies.length} seed=${inventory.seed.resources} terminology=${inventory.seed.terminology.length} rights=pending-owner-review`);
  } catch (error) { console.error(`release-licenses: ${error instanceof LicenseFault ? error.code : 'LICENSE_FAILED'}`); process.exitCode = 1; }
}
