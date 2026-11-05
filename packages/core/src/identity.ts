import packageJson from '../../../package.json' with { type: 'json' };

/** One gateway identity for registration, delivery accounting, CLI and release artifacts. */
export const SERVER_IDENTITY = Object.freeze({ name: 'fireboat', version: packageJson.version });
