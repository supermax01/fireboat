// JSONL helpers for bench records. One record per line, UTF-8, LF, append-only.
// A crash or kill during an append can leave a partial last line (a RunRecord can be several MB). Every appender and
// every reader of an append-only file first calls repairPartialTail, which moves such a tail aside, so a partial record
// is never counted, never continued by the next append and never parsed as a record.
import { closeSync, createReadStream, existsSync, fstatSync, ftruncateSync, openSync, readSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { parseLossless, stringifyLossless, type LosslessValue } from './json.js';

/**
 * If `path` does not end with "\n", moves the bytes after the last newline to `<path>.partial-<ts>` and truncates the
 * file there. Returns the path of the moved tail, or null when the file is absent, empty or already ends with a newline.
 */
export function repairPartialTail(path: string): string | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r+');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return null;
    let cut = 0; // offset just after the last newline (0: no complete line at all)
    const chunk = Buffer.alloc(1 << 20);
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - chunk.length);
      const n = readSync(fd, chunk, 0, end - start, start);
      const i = chunk.subarray(0, n).lastIndexOf(0x0a);
      if (i >= 0) { cut = start + i + 1; break; }
      end = start;
    }
    const tail = Buffer.alloc(size - cut);
    readSync(fd, tail, 0, tail.length, cut);
    const aside = `${path}.partial-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    writeFileSync(aside, tail);
    ftruncateSync(fd, cut);
    process.stderr.write(`jsonl: moved a partial last line (${tail.length} bytes) of ${path} to ${aside}\n`);
    return aside;
  } finally {
    closeSync(fd);
  }
}

/** Appends records. Records may hold LosslessNumber values; they are written with their lexemes. */
export async function appendJsonl(path: string, records: readonly unknown[]): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  repairPartialTail(path);
  await appendFile(path, records.map(r => stringifyLossless(r) + '\n').join(''), 'utf8');
}

/** Streams records, parsed lexeme-preserving. Blank lines are an error. A partial last line is moved aside first. */
export async function* readJsonl(path: string): AsyncGenerator<LosslessValue> {
  repairPartialTail(path);
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    n++;
    if (line.length === 0) throw new Error(`${path}:${n}: blank line`);
    yield parseLossless(line);
  }
}

/** Newline-terminated lines of a JSONL text; an unterminated last line is not a record and is dropped. */
export function completeLines(text: string): string[] {
  const end = text.lastIndexOf('\n');
  return end < 0 ? [] : text.slice(0, end).split('\n').filter(l => l.length > 0);
}
