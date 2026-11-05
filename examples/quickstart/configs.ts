import { isAbsolute } from 'node:path';
import { fault, freezeCopy, hasKeys, isRecord } from './manifest.js';

export type LaunchTuple = Readonly<{ node: string; cli: string; config: string }>;
export function absoluteLaunchTuple(tuple: LaunchTuple): boolean {
  return [tuple.node, tuple.cli, tuple.config].every(value => typeof value === 'string' && isAbsolute(value));
}
export const quotePosixArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
function quoteCommandArgument(value: string): string {
  return quotePosixArgument(value);
}

// Pure output only: no settings files, host processes, or OCI launch forms.
export function hostConfigurations(tuple: LaunchTuple) {
  if (!isRecord(tuple) || !hasKeys(tuple, ['node', 'cli', 'config']) ||
    !Object.values(tuple).every(value => typeof value === 'string' && value.length <= 8192 && !value.includes('\0')))
    throw fault('LAUNCH_INVALID');
  if (!absoluteLaunchTuple(tuple)) throw fault('LAUNCH_NOT_ABSOLUTE');
  const entry = { command: tuple.node, args: [tuple.cli, '--config', tuple.config] };
  const argv = ['claude', 'mcp', 'add', '--transport', 'stdio', '--scope', 'local', 'fireboat', '--',
    entry.command, ...entry.args];
  return freezeCopy({
    claudeDesktop: { mcpServers: { fireboat: entry } },
    cursor: { mcpServers: { fireboat: entry } },
    vsCode: { servers: { fireboat: { type: 'stdio' as const, ...entry } } },
    claudeCode: { argv, command: argv.map(quoteCommandArgument).join(' '), entry },
    guidance: {
      claudeDesktop: 'Review the mcpServers entry in Claude Desktop settings; restart, then connect.',
      cursor: 'Review the mcpServers entry in Cursor MCP settings; restart, then connect.',
      vsCode: 'Review the servers entry in VS Code mcp.json; restart the server, then connect.',
      claudeCode: 'Review the argv vector and entry; run the registration command, restart, then connect.',
      delivery: 'full-text-v1', verification: 'unverified',
      evidence: 'Generated forms do not verify any host version or protocol-era cell.'
    }
  });
}
