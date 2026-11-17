// A loopback stand-in for the Messages API, so the whole agent pipeline (host, MCP config, server, proxy, stream
// parsing, scoring) can be exercised at no cost and with no data leaving the machine. It is never a model:
// it follows a fixed plan (call the planned MCP tools, then submit a fixed StructuredOutput) and logs what the host
// sent, which answers several setup questions (which tools are listed, what a tool result looks like).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LosslessNumber, parseLossless, parseNumbersAsStrings, stringifyLossless, utf8Bytes, type LosslessValue } from '../lib/json.js';
import { sha256Hex } from '../lib/hash.js';
import { MCP_TOOL_PREFIX, STRUCTURED_OUTPUT_TOOL } from './stream.js';

type Obj = { [key: string]: LosslessValue };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof LosslessNumber);
const arr = (v: unknown): LosslessValue[] => (Array.isArray(v) ? v : []);

export interface MockPlan {
  /** MCP tool calls to make in order. A function gets the MCP tool names the host listed. */
  calls: { name: string; input: Record<string, unknown> }[] | ((mcpTools: string[]) => { name: string; input: Record<string, unknown> }[]);
  /** The StructuredOutput input submitted after the calls. */
  answer: Record<string, unknown>;
}

export interface MockRequestLog {
  seq: number;
  path: string;
  model: string | null;
  stream: boolean;
  messages: number;
  tool_names: string[];
  thinking: unknown;
  max_tokens: number | null;
  system_sha256: string | null;
  system_bytes: number;
  injected_date: string | null;
  first_user_text_head: string; // local log only: what the host put before the prompt
  message_roles: string[];
  system_head: string; // local log only
  tool_results: { tool_use_id: string; is_error: boolean; content_types: string[]; text_bytes: number }[];
  reply: string;
}

export interface MockApi { baseUrl: string; requests: MockRequestLog[]; close(): Promise<void> }

const systemText = (s: LosslessValue | undefined): string =>
  typeof s === 'string' ? s : arr(s).map(b => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n');

export async function startMockApi(plan: MockPlan): Promise<MockApi> {
  const requests: MockRequestLog[] = [];
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      try { handle(req, res, Buffer.concat(chunks).toString('utf8')); } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `mock: ${(err as Error).message}` } }));
      }
    });
  });

  function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) }));
      return;
    }
    if (!(req.method === 'POST' && path.endsWith('/v1/messages'))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `mock: ${req.method} ${path}` } }));
      return;
    }
    const b = parseLossless(body);
    if (!isObj(b)) throw new Error('body is not an object');
    const model = typeof b.model === 'string' ? b.model : 'mock';
    const toolNames = arr(b.tools).flatMap(t => (isObj(t) && typeof t.name === 'string' ? [t.name] : []));
    const messages = arr(b.messages).filter(isObj);
    const sys = systemText(b.system);
    const toolResults: MockRequestLog['tool_results'] = [];
    let mcpToolUses = 0;
    let structuredDone = false;
    const nameById = new Map<string, string>();
    for (const m of messages) {
      for (const c of arr(m.content)) {
        if (!isObj(c)) continue;
        if (m.role === 'assistant' && c.type === 'tool_use' && typeof c.name === 'string') {
          nameById.set(String(c.id), c.name);
          if (c.name.startsWith(MCP_TOOL_PREFIX)) mcpToolUses++;
        }
        if (m.role === 'user' && c.type === 'tool_result') {
          const id = String(c.tool_use_id);
          if (nameById.get(id) === STRUCTURED_OUTPUT_TOOL) structuredDone = true;
          const content = c.content;
          const types = typeof content === 'string' ? ['string'] : arr(content).map(x => (isObj(x) ? String(x.type) : typeof x));
          const text = typeof content === 'string' ? content : arr(content).map(x => (isObj(x) && typeof x.text === 'string' ? x.text : '')).join('');
          toolResults.push({ tool_use_id: id, is_error: c.is_error === true, content_types: types, text_bytes: utf8Bytes(text) });
        }
      }
    }
    const mcpTools = toolNames.filter(n => n.startsWith(MCP_TOOL_PREFIX));
    const calls = typeof plan.calls === 'function' ? plan.calls(mcpTools) : plan.calls;
    let block: { type: 'tool_use'; name: string; input: Record<string, unknown> } | { type: 'text'; text: string };
    if (toolNames.length === 0) block = { type: 'text', text: 'ok' }; // ancillary request
    else if (structuredDone) block = { type: 'text', text: 'Done.' };
    else if (mcpToolUses < calls.length) block = { type: 'tool_use', ...calls[mcpToolUses]! };
    else if (toolNames.includes(STRUCTURED_OUTPUT_TOOL)) block = { type: 'tool_use', name: STRUCTURED_OUTPUT_TOOL, input: plan.answer };
    else block = { type: 'text', text: JSON.stringify(plan.answer) };

    const n = ++seq;
    // --exclude-dynamic-system-prompt-sections moves env info (and the date) into the first user message.
    const firstUser = messages.find(m => m.role === 'user');
    const firstUserText = firstUser ? systemText(firstUser.content) : '';
    const dateMatch = /(?:Today's date is|today is|current date[^:\n]*:)\s*([^\n]{4,40}?)\.?(?:\n|$)/i.exec(`${sys}\n${firstUserText}`);
    requests.push({
      seq: n, path, model, stream: b.stream === true, messages: messages.length, tool_names: toolNames,
      thinking: b.thinking === undefined ? null : parseNumbersAsStrings(stringifyLossless(b.thinking)),
      max_tokens: b.max_tokens instanceof LosslessNumber ? Number(b.max_tokens.lexeme) : null,
      system_sha256: sys ? sha256Hex(sys) : null, system_bytes: utf8Bytes(sys), injected_date: dateMatch?.[1]?.trim() ?? null,
      first_user_text_head: firstUserText.slice(0, 3000),
      message_roles: messages.map(m => `${String(m.role)}:${typeof m.content === 'string' ? 'text' : arr(m.content).map(c => (isObj(c) ? String(c.type) : '?')).join('+')}`),
      system_head: sys.slice(0, 1000),
      tool_results: toolResults, reply: block.type === 'tool_use' ? `tool_use:${block.name}` : `text:${block.text.slice(0, 20)}`,
    });

    const id = `msg_mock_${n}`;
    const usage = { input_tokens: Math.ceil(body.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
    const stopReason = block.type === 'tool_use' ? 'tool_use' : 'end_turn';
    const contentBlock = block.type === 'tool_use'
      ? { type: 'tool_use', id: `toolu_mock_${n}`, name: block.name, input: block.input }
      : { type: 'text', text: block.text };
    if (b.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_mock_${n}` });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [contentBlock], stop_reason: stopReason, stop_sequence: null, usage: { ...usage, output_tokens: 20 } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_mock_${n}` });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
    if (block.type === 'tool_use') {
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_mock_${n}`, name: block.name, input: {} } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } });
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
  }

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
