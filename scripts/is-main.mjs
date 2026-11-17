import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Compare physical paths so absolute invocations through directory symlinks still execute. */
export function isMainModule(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}
