// Test-only read-only mount. Never copied into the image.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const rows = [];
async function walk(path = '') {
  for (const name of (await readdir(join('/opt/fireboat', path))).sort()) {
    const child = path ? `${path}/${name}` : name, info = await lstat(join('/opt/fireboat', child));
    assert.equal(info.isSymbolicLink(), false);
    if (info.isDirectory()) await walk(child);
    else {
      assert.equal(info.isFile(), true);
      rows.push({ path: child, size: info.size, mode: info.mode & 0o777,
        sha256: createHash('sha256').update(await readFile(join('/opt/fireboat', child))).digest('hex') });
    }
  }
}
if (process.argv[2] === 'files') {
  await walk();
  assert.deepEqual(rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    JSON.parse(await readFile('/s10/image-files.json', 'utf8')));
  assert.equal(await readlink('/usr/local/bin/fireboat'), '/opt/fireboat/node_modules/@fireboat/gateway/dist/packages/server/src/cli.js');
  console.log(JSON.stringify({ files: rows.length, status: 'passed' }));
} else {
  assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000);
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
  assert.equal(process.versions.node, '24.22.0');
  const status = await readFile('/proc/self/status', 'utf8');
  for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) assert.match(status, new RegExp(`^${key}:\\s+0+$`, 'm'));
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  let code;
  // /tmp is writable to UID 1000 on the base filesystem, so EROFS proves the
  // mount restriction rather than an ordinary directory permission denial.
  try { await writeFile('/tmp/s10-write-probe', 'probe', { flag: 'wx' }); } catch (error) { code = error.code; }
  assert.equal(code, 'EROFS');
  console.log(JSON.stringify({ uid: 1000, gid: 1000, os: process.platform, arch: process.arch, node: process.versions.node, readOnly: true,
    capabilities: 'zero', noNewPrivileges: true, namespace: await readlink('/proc/self/ns/net') }));
}
