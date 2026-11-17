// bench:medplum:down [-- --purge-volume]
// Stops and removes the Medplum containers. The database volume is kept unless --purge-volume is given.
// Never touches the HAPI stack (compose project fbbench).
import { parseArgs } from 'node:util';
import { log, mustRun, run } from './manifest.js';
import { MEDPLUM_VOLUME, medplumCompose } from './medplum.js';

const { values } = parseArgs({ options: { 'purge-volume': { type: 'boolean' } }, strict: true });
const down = await medplumCompose(['down', '--remove-orphans']);
if (down.code !== 0) throw new Error(`compose down failed: ${down.stderr}`);
log('Medplum stack stopped; volume kept');
if (values['purge-volume'] && (await run('docker', ['volume', 'inspect', MEDPLUM_VOLUME])).code === 0) {
  await mustRun('docker', ['volume', 'rm', MEDPLUM_VOLUME]);
  log(`deleted volume ${MEDPLUM_VOLUME}`);
}
