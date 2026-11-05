import { registerFamily } from './shard.js';
// B2-0 family shard: one static file per family so the judge's parallel test runner sees independent units.
await registerFamily('XRF');
