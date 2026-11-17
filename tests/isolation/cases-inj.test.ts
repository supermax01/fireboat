import { registerFamily } from './shard.js';
// Family shard: one static file per family, so the parallel test runner sees independent units.
await registerFamily('INJ');
