import evidence from './backend-evidence.json' with { type: 'json' };
import { fault, freezeCopy, GENERATOR_PINS, isRecord, sha256 } from './manifest.js';
import type { BackendIdentity } from './manifest.js';

// The saved child/config blobs are local cache evidence. Docker's containerd
// store reports an index/manifest Id, while a classic store reports a config Id.
// Verify the descriptor chain instead of confusing these three identities.
const child: unknown = JSON.parse(evidence.imageManifestJson);
const config: unknown = JSON.parse(evidence.imageConfigJson);
if (evidence.imageIndexDigest !== GENERATOR_PINS.hapi.indexDigest || !isRecord(child) ||
  !isRecord(child.config) || child.config.digest !== `sha256:${sha256(evidence.imageConfigJson)}` ||
  !isRecord(config) || config.os !== 'linux' || config.architecture !== 'arm64') throw fault('BACKEND_MISMATCH');

export const HAPI_IMAGE = `hapiproject/hapi@${GENERATOR_PINS.hapi.indexDigest}`;
export const HAPI_PLATFORM = 'linux/arm64';
export const HELPER_BACKEND: BackendIdentity = freezeCopy({
  imageIndexDigest: evidence.imageIndexDigest,
  imageManifestDigest: `sha256:${sha256(evidence.imageManifestJson)}`,
  imageConfigDigest: `sha256:${sha256(evidence.imageConfigJson)}`,
  softwareName: 'HAPI FHIR Server', softwareVersion: '8.12.0', fhirVersion: '4.0.1'
});
