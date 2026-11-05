import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { PLATFORM, fail } from './inventory.mjs';
const exec = promisify(execFile);

export function dockerEnvironment(input = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT']) if (input[key] !== undefined) env[key] = input[key];
  // The legacy local builder uses the already inspected daemon cache and does
  // not ask a remote BuildKit resolver for digest metadata.
  env.DOCKER_BUILDKIT = '0';
  return env;
}
export async function docker(args, options = {}) {
  try {
    const result = await exec('docker', args, { env: dockerEnvironment(), encoding: 'utf8', shell: false,
      timeout: options.timeout ?? 60_000, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (options.allowFailure && Number.isInteger(error.code)) return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    fail('OCI_DOCKER_FAILED');
  }
}
export const buildArgs = (context, output) => ['build', '--network', 'none', '--pull=false', '--platform', PLATFORM,
  '--iidfile', `${output}/image-id`, '--file', `${context}/Dockerfile`, context];
export function runArgs(image, network, mounts = []) {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !(network === 'none' || /^container:[a-f0-9]{64}$/.test(network))) fail('OCI_RUN_OPTIONS');
  const args = ['run', '--rm', '--pull=never', '--platform', PLATFORM, '--network', network,
    '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--log-driver', 'none'];
  for (const [source, target] of mounts) {
    if (!isAbsolute(source) || !isAbsolute(target) || /[,\x00-\x1f]/.test(source + target)) fail('OCI_MOUNT');
    args.push('--mount', `type=bind,src=${source},dst=${target},readonly`);
  }
  return args;
}
export function flags(argv, required, optional = []) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (![...required, ...optional].includes(key) || result[key] !== undefined || !value || !isAbsolute(value) || /[\x00-\x1f]/.test(value)) fail('OCI_USAGE');
    result[key] = value;
  }
  if (required.some(key => !result[key])) fail('OCI_USAGE');
  return result;
}
