// bench:infra:down [-- --purge-volume --dataset <d>]
// Stops and removes the containers. Volumes are external and kept, so a later up resumes with the loaded data.
// --purge-volume --dataset <d> also deletes that dataset's database volume (a reload is then needed).
import { parseArgs } from 'node:util';
import { rm } from 'node:fs/promises';
import { COMMON_OPTIONS, datasetArg } from '../lib/cli.js';
import { compose, projectContainers, volumeExists } from './docker.js';
import { log, manifestPath, mustRun } from './manifest.js';
import { pgVolume } from './pins.js';

const { values } = parseArgs({ options: { ...COMMON_OPTIONS, 'purge-volume': { type: 'boolean' } }, strict: true });

const volume = (await projectContainers()).find(c => c.service === 'db')?.volume ?? null;
const down = await compose(['down', '--remove-orphans'], volume);
if (down.code !== 0) throw new Error(`compose down failed: ${down.stderr}`);
await rm(manifestPath('active-dataset'), { force: true });
log('stack stopped; volumes kept');

if (values['purge-volume']) {
  const target = pgVolume(datasetArg(values.dataset));
  if (await volumeExists(target)) {
    await mustRun('docker', ['volume', 'rm', target]);
    log(`deleted volume ${target}`);
  }
}
