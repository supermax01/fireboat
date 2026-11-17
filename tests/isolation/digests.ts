import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
/** Content digest, including assets and symlinked installed packages. Ancestor cycles are explicit, never followed. */
export function treeDigest(root: string, omit: (relative: string) => boolean = () => false): string {
  const digest = createHash('sha256');
  const feed = (name: string, bytes: Buffer | string) => { digest.update(`${Buffer.byteLength(name)}:${name}${Buffer.byteLength(bytes)}:`).update(bytes); };
  const visit = (relative: string, ancestors: Set<string>) => {
    if (omit(relative)) return;
    const path = join(root, relative), real = realpathSync(path);
    if (statSync(path).isDirectory()) {
      if (ancestors.has(real)) { feed(relative, '<ancestor-cycle>'); return; }
      const next = new Set(ancestors).add(real);
      for (const name of readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name, next);
    } else feed(relative, readFileSync(path));
  };
  visit('', new Set()); return digest.digest('hex');
}
export function dependencyDigests(root = '.') {
  const file = (path: string) => existsSync(join(root, path)) ? createHash('sha256').update(readFileSync(join(root, path))).digest('hex') : 'unavailable';
  const tree = (path: string) => existsSync(join(root, path)) ? treeDigest(join(root, path)) : 'unavailable';
  return { lock_hash: file('package-lock.json'), installed_tree_hash: tree('node_modules'), sdk_client_hash: tree('node_modules/@modelcontextprotocol/client'), sdk_server_hash: tree('node_modules/@modelcontextprotocol/server') };
}
