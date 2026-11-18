#!/usr/bin/env node
import { isMainModule } from './is-main.mjs';
// Release staging has no install, fetch, lifecycle, or serving operation.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { SyntaxKind, type Node, type StringLiteral, type ImportDeclaration, type ExportDeclaration, type CallExpression } from 'typescript/unstable/ast';
import { safePackagePath, validateExpectedInventory, type ExpectedInventory, type FileInventory } from './package-inventory.js';
import { helperBoundary, HELPER_ENTRIES } from './quickstart/check-helper-boundary.js';
import { observedGraph } from './quickstart/module-graph.js';

export class StageFault extends Error {
  /** `detail` holds path names only, never file contents. */
  constructor(readonly code: string, readonly detail: readonly string[] = []) { super(code); this.name = 'StageFault'; }
}
const fault = (code: string, detail: readonly string[] = []): StageFault => new StageFault(code, detail);
export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const GATEWAY_MODULES = [
  ...['client-assertion', 'client-credentials', 'index', 'pkce', 'smart-backend', 'smart-discovery', 'smart-scopes', 'smart-standalone', 'token-provider', 'token-store'].map(n => `packages/auth/src/${n}.js`),
  ...['catalog', 'contracts', 'decimal', 'delivery', 'discovery', 'identity', 'index', 'privacy', 'projection',
    'query', 'record-predicates', 'repairs', 'schema', 'search-parameters', 'store', 'support', 'transport', 'withheld'].map(n => `packages/core/src/${n}.js`),
  'packages/core/src/generated/r4-checkable-paths.js',
  ...['cli', 'doctor', 'index', 'login', 'main', 'release', 'startup'].map(n => `packages/server/src/${n}.js`),
].sort(order);
export const RUNTIME_FILES = [
  'packages/core/src/generated/r4-index.json', 'packages/core/src/generated/r4-search-parameters.json',
  ...['support-matrix', 'search-profiles', 'compact-profiles', 'host-profiles'].map(n => `packages/core/src/data/${n}.json`),
].sort(order);
export const DOCUMENTS = ['README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
  'docs/QUICKSTART.md', 'docs/LIMITS.md', 'docs/SUPPORT-MATRIX.md', 'docs/support-matrix.json',
  'docs/COMPACT-PROFILES.md', 'docs/HOST-PROFILES.md', 'docs/QUERY-EVIDENCE.md', 'docs/QUERY-REPAIR.md', 'docs/contracts/m3b-tools.json'];
/** DOCUMENTS are package paths. These ones are kept elsewhere in the repository and staged at the package path. */
export const DOCUMENT_SOURCES: Readonly<Record<string, string>> = { 'SECURITY.md': '.github/SECURITY.md', 'THIRD_PARTY_NOTICES.md': 'packaging/THIRD_PARTY_NOTICES.md' };
/** The package's licenses/ folder is kept at packaging/licenses/ in the repository. */
export const LICENSES_SOURCE = 'packaging/licenses';
export const documentSource = (path: string): string => DOCUMENT_SOURCES[path] ?? path;
/** The public repository: links to files the package does not ship point here. Images use the raw host so they render. */
export const PUBLIC_BLOB_BASE = 'https://github.com/supermax01/fireboat/blob/main/';
export const PUBLIC_RAW_BASE = 'https://raw.githubusercontent.com/supermax01/fireboat/main/';
/** The public repository's front page: a link to the repository root (`./` from the root, `../` from docs/) points here. */
export const PUBLIC_ROOT = 'https://github.com/supermax01/fireboat';
export const HELPER_ASSETS = [
  'docker/compose.quickstart.yaml', 'examples/quickstart/seed-manifest.json', 'examples/quickstart/generator-pins.json',
  'examples/quickstart/backend-evidence.json', 'examples/quickstart/config.json', 'examples/quickstart/host-config.example.json',
  'packages/evals/fixtures/quickstart/resources.ndjson', 'packages/evals/fixtures/quickstart/seed-manifest.json',
  'packages/evals/fixtures/quickstart/generation.properties', 'packages/evals/fixtures/quickstart/edges.json',
];

/** The package path a repository file (or folder) is staged at, by the rules prepareFiles copies with; undefined when it is not staged. */
export function packagePathOf(repoPath: string): string | undefined {
  const document = DOCUMENTS.find(p => documentSource(p) === repoPath);
  if (document) return document;
  if (repoPath === LICENSES_SOURCE || repoPath.startsWith(`${LICENSES_SOURCE}/`)) return `licenses${repoPath.slice(LICENSES_SOURCE.length)}`;
  if (HELPER_ASSETS.includes(repoPath)) return `quickstart/${repoPath}`;
  if (repoPath === 'examples/quickstart/package.json' || repoPath === 'examples/quickstart/package-lock.json') return `quickstart/${repoPath.slice('examples/quickstart/'.length)}`;
  if (repoPath === 'packaging/npm-shrinkwrap.json') return 'npm-shrinkwrap.json';
  return undefined;
}
const listedPath = (path: string, paths: ReadonlySet<string>): boolean => paths.has(path) || [...paths].some(p => p.startsWith(`${path}/`));
const stagedTarget = listedPath;

// Markdown scanning. A small CommonMark-shaped scanner finds every link and image target a renderer would follow:
// fenced code (in block quotes and list items too), code spans and backslash escapes are skipped; inline links and
// images (wrapped across lines, angle-bracket or parenthesised destinations), reference definitions and the
// definitions behind reference-style images, and URL attributes of HTML tags are found at their exact offsets. The
// stage's rewrite and both link checks share it. Where the scanner cannot tell, it reports a target rather than skip
// one, so a doubtful form is checked instead of missed. A rewritten target is escaped for the syntax around it.
// Known limits, each erring towards checking text that is not a link rather than missing one: indented code blocks
// and HTML comments are scanned as prose; backslash escapes or backticks inside HTML attribute values are masked as
// in prose; a `]` inside inline HTML within link text ends the text; a tab after `>` in a block quote counts as one
// column; spaced thematic breaks (`* * *`) and ordered markers that cannot interrupt a paragraph are read as list
// markers, which can move the column a following four-space-indented fence is judged against; a block quote inside a
// list item is not modelled; a definition is accepted at the start of any line; a reference label wrapped across
// lines inside a block quote keeps its `>` markers when it is compared.
/** Where a target sits, which decides how a rewritten one is escaped. */
type TargetContext = 'destination' | 'angle' | 'double' | 'single' | 'unquoted';
type TargetSpan = { start: number; end: number; image: boolean; context: TargetContext; srcset?: boolean };
type FenceState = { char: string; length: number; quotes: number; column: number };
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?=[ \t\r]|$)/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const isBlank = (text: string): boolean => /^[ \t\r]*$/.test(text);
/** The width of the white space of `line` starting at `from` (a tab advances to the next multiple of four) and where it ends. */
function indentation(line: string, from: number): { width: number; index: number } {
  let width = 0, index = from;
  for (; index < line.length && (line[index] === ' ' || line[index] === '\t'); index++) width = line[index] === '\t' ? width + 4 - (width % 4) : width + 1;
  return { width, index };
}
const blanked = (text: string): string => text.replace(/[^\n]/g, ' ');

/** A same-length copy of `text` with fenced code (fence lines included) and block-quote and list markers blanked. */
function maskBlocks(text: string): string {
  const lines = text.split('\n');
  let fence: FenceState | undefined, lists: number[] = [], listQuotes = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!, ends: number[] = [];
    // Block-quote markers, each with the one space or tab after it; `ends` holds where each one's content starts.
    for (let at = 0, m: RegExpExecArray | null; (m = /^ {0,3}>[ \t]?/.exec(line.slice(at)));) { at += m[0].length; ends.push(at); }
    if (fence) {
      // A fence ends with its container: fewer block-quote markers, or a line indented less than the list item's content.
      const at = fence.quotes ? ends[fence.quotes - 1] ?? -1 : 0;
      if (at >= 0 && (isBlank(line.slice(at)) || indentation(line, at).width >= fence.column)) {
        const { width, index } = indentation(line, at);
        // A closing fence uses the opening character, at least as many times, and nothing else.
        if (width - fence.column <= 3 && new RegExp(`^\\${fence.char}{${fence.length},}[ \\t\\r]*$`).test(line.slice(index))) fence = undefined;
        lines[n] = blanked(line);
        continue;
      }
      fence = undefined;
    }
    const quotes = ends.length, at = quotes ? ends[quotes - 1]! : 0;
    let chars = line.split('');
    for (let k = 0; k < at; k++) if (chars[k] === '>') chars[k] = ' ';
    if (quotes !== listQuotes) { lists = []; listQuotes = quotes; }
    if (isBlank(line.slice(at))) { lines[n] = chars.join(''); continue; }
    let { width, index } = indentation(line, at);
    while (lists.length && width < lists.at(-1)!) lists.pop();
    for (let marker: RegExpExecArray | null; (marker = width - (lists.at(-1) ?? 0) < 4 ? LIST_MARKER.exec(line.slice(index)) : null);) {
      for (let k = index; k < index + marker[0].length; k++) chars[k] = ' ';
      const after = indentation(line, index + marker[0].length), column = width + marker[0].length;
      const empty = isBlank(line.slice(after.index));
      lists.push(empty || after.width > 4 ? column + 1 : column + after.width);
      if (empty) break;
      width = column + after.width; index = after.index;
    }
    const open = width - (lists.at(-1) ?? 0) <= 3 ? FENCE_OPEN.exec(line.slice(index)) : null;
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = { char: open[1]![0]!, length: open[1]!.length, quotes, column: lists.at(-1) ?? 0 };
      chars = blanked(line).split('');
    }
    lines[n] = chars.join('');
  }
  return lines.join('\n');
}

/** [start, end) of every run of non-blank lines of a masked text: inline syntax never crosses a blank line. */
function blockRanges(masked: string): [number, number][] {
  const ranges: [number, number][] = [];
  let start = -1, at = 0;
  for (const line of masked.split('\n')) {
    if (!isBlank(line) && start < 0) start = at;
    if (isBlank(line) && start >= 0) { ranges.push([start, at - 1]); start = -1; }
    at += line.length + 1;
  }
  if (start >= 0) ranges.push([start, masked.length]);
  return ranges;
}

/** Also blanks code spans (backticks included) and stands a letter in for each backslash-escaped character. */
function maskInline(masked: string): string {
  const chars = masked.split('');
  for (const [start, end] of blockRanges(masked)) {
    for (let i = start; i < end; i++) {
      if (masked[i] === '\\' && i + 1 < end && ASCII_PUNCTUATION.test(masked[i + 1]!)) { chars[i + 1] = 'e'; i++; continue; }
      if (masked[i] !== '`') continue;
      let run = i; while (run < end && masked[run] === '`') run++;
      const length = run - i;
      // A code span closes at the next backtick run of exactly the same length; backslashes do not escape inside it.
      let close = -1;
      for (let k = run; k < end;) {
        if (masked[k] !== '`') { k++; continue; }
        let stop = k; while (stop < end && masked[stop] === '`') stop++;
        if (stop - k === length) { close = stop; break; }
        k = stop;
      }
      if (close < 0) { i = run - 1; continue; }
      for (let k = i; k < close; k++) if (chars[k] !== '\n') chars[k] = ' ';
      i = close - 1;
    }
  }
  return chars.join('');
}

/** A link destination at `at`: inside angle brackets (no line break), or a run without white space and with balanced parentheses. */
function destinationAt(masked: string, at: number, end: number): { start: number; end: number } | undefined {
  if (masked[at] === '<') {
    for (let k = at + 1; k < end; k++) {
      if (masked[k] === '>') return { start: at + 1, end: k };
      if (masked[k] === '<' || masked[k] === '\n') return undefined;
    }
    return undefined;
  }
  let depth = 0, k = at;
  for (; k < end && masked[k]! > ' '; k++) {
    if (masked[k] === '(') depth++;
    else if (masked[k] === ')') { if (!depth) break; depth--; }
  }
  return k > at ? { start: at, end: k } : undefined;
}
/** Skips spaces and tabs, at most one line break, then spaces and tabs again. */
function skipSpace(masked: string, at: number, end: number): number {
  const lead = /[ \t]*(?:\r?\n[ \t]*)?/y; lead.lastIndex = at;
  return Math.min(end, at + (lead.exec(masked)?.[0].length ?? 0));
}
const referenceLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase();

type HtmlAttribute = { tag: string; name: string; start: number; end: number; quote: '"' | "'" | '' };
/** The attributes of every HTML start tag outside code: names in lower case, value offsets without quotes. */
function htmlAttributes(masked: string): HtmlAttribute[] {
  const found: HtmlAttribute[] = [];
  for (const [start, end] of blockRanges(masked)) {
    for (let i = masked.indexOf('<', start); i >= 0 && i < end; i = masked.indexOf('<', i + 1)) {
      const name = /[A-Za-z][A-Za-z0-9-]*/y; name.lastIndex = i + 1;
      const tag = name.exec(masked)?.[0].toLowerCase();
      if (!tag) continue;
      for (let k = i + 1 + tag.length; k < end;) {
        const space = /[ \t\r\n]*/y; space.lastIndex = k; k += space.exec(masked)![0].length;
        if (masked[k] === '>' || masked.startsWith('/>', k)) break;
        const attribute = /[A-Za-z_:][A-Za-z0-9_.:-]*/y; attribute.lastIndex = k;
        const key = attribute.exec(masked)?.[0];
        if (!key) break;
        k += key.length; space.lastIndex = k; k += space.exec(masked)![0].length;
        if (masked[k] !== '=') continue;
        k++; space.lastIndex = k; k += space.exec(masked)![0].length;
        const quote = masked[k];
        if (quote === '"' || quote === "'") {
          const close = masked.indexOf(quote, k + 1);
          if (close < 0 || close >= end) break;
          found.push({ tag, name: key.toLowerCase(), start: k + 1, end: close, quote }); k = close + 1;
        } else {
          const bare = /[^ \t\r\n"'=<>`]+/y; bare.lastIndex = k;
          const value = bare.exec(masked)?.[0];
          if (!value) break;
          found.push({ tag, name: key.toLowerCase(), start: k, end: k + value.length, quote: '' }); k += value.length;
        }
      }
    }
  }
  return found;
}
/** URL attributes and whether each loads its target as an image or media file (raw host) rather than a page. */
const URL_ATTRIBUTES: Readonly<Record<string, (tag: string) => boolean>> = {
  href: tag => tag === 'image', 'xlink:href': tag => tag === 'image', src: () => true, srcset: () => true, poster: () => true,
  data: () => true, background: () => true, cite: () => false, longdesc: () => false, action: () => false, formaction: () => false,
};

/** Every link and image target of a markdown text outside code, in order, without overlaps. */
function markdownTargets(text: string): TargetSpan[] {
  const blocks = maskBlocks(text), masked = maskInline(blocks), spans: TargetSpan[] = [];
  const definitions: { label: string; span: TargetSpan }[] = [], imageLabels = new Set<string>();
  for (const [start, end] of blockRanges(masked)) {
    // Reference definitions, at the start of any line; the destination may be on the next line.
    for (let line = start; line < end;) {
      const head = /[ \t]*\[(?!\^)([^[\]]+)\]:/y; head.lastIndex = line;
      const match = head.exec(masked);
      const destination = match ? destinationAt(masked, skipSpace(masked, line + match[0].length, end), end) : undefined;
      if (match && destination) definitions.push({ label: referenceLabel(text.slice(line + match[0].indexOf('[') + 1, line + match[0].length - 2)),
        span: { ...destination, image: false, context: masked[destination.start - 1] === '<' ? 'angle' : 'destination' } });
      const next = masked.indexOf('\n', line);
      line = next < 0 ? end : next + 1;
    }
    // Inline links and images, and reference-style images, from every opening bracket (so nested images are found too).
    for (let i = masked.indexOf('[', start); i >= 0 && i < end; i = masked.indexOf('[', i + 1)) {
      let close = -1;
      for (let k = i + 1, depth = 1; k < end; k++) {
        if (masked[k] === '[') depth++;
        else if (masked[k] === ']' && !--depth) { close = k; break; }
      }
      if (close < 0) continue;
      const image = i > start && masked[i - 1] === '!';
      if (masked[close + 1] === '(') {
        const destination = destinationAt(masked, skipSpace(masked, close + 2, end), end);
        if (destination) spans.push({ ...destination, image, context: masked[destination.start - 1] === '<' ? 'angle' : 'destination' });
      } else if (image) {
        const label = masked[close + 1] === '[' ? masked.indexOf(']', close + 2) : -1;
        const named = label > close + 2 && label < end ? text.slice(close + 2, label) : '';
        const used = named.trim() ? named : text.slice(i + 1, close);
        if (!used.startsWith('^')) imageLabels.add(referenceLabel(used));
      }
    }
  }
  for (const { label, span } of definitions) spans.push({ ...span, image: imageLabels.has(label) });
  for (const { tag, name, start, end, quote } of htmlAttributes(masked)) {
    const image = URL_ATTRIBUTES[name]?.(tag), context: TargetContext = quote === '"' ? 'double' : quote === "'" ? 'single' : 'unquoted';
    if (image === undefined) continue;
    if (name !== 'srcset') {
      // Surrounding white space is not part of the URL. Offsets come from the block-stripped text, so a value wrapped
      // inside a block quote does not take its `>` markers.
      const value = blocks.slice(start, end), lead = value.length - value.trimStart().length, trail = value.length - value.trimEnd().length;
      if (lead < value.length) spans.push({ start: start + lead, end: end - trail, image, context });
      continue;
    }
    // A srcset holds candidates, each a URL and optional descriptors, read as HTML does: a URL is a run without white
    // space (so a data: URL keeps its commas), trailing commas end it, and otherwise its descriptors run to a comma.
    for (let at = start; at < end;) {
      while (at < end && /[\s,]/.test(blocks[at]!)) at++;
      let stop = at;
      while (stop < end && !/\s/.test(blocks[stop]!)) stop++;
      if (stop === at) break;
      let last = stop;
      while (last > at && blocks[last - 1] === ',') last--;
      spans.push({ start: at, end: last, image: true, context, srcset: true });
      if (last < stop) { at = stop; continue; }
      while (stop < end && blocks[stop] !== ',') stop++;
      at = stop + 1;
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let reach = 0;
  return spans.filter(span => span.start >= reach && (reach = span.end, true));
}
/** Calls `map` on every link and image target outside code and replaces the target with what it returns. */
function mapMarkdownTargets(text: string, map: (target: string, image: boolean) => string): string {
  let out = '', at = 0;
  for (const span of markdownTargets(text)) {
    const target = text.slice(span.start, span.end), mapped = map(target, span.image);
    out += text.slice(at, span.start) + (mapped === target ? target : escapeTarget(mapped, span)); at = span.end;
  }
  return out + text.slice(at);
}
/** Characters a rewritten target may not carry in its place: they would end the destination, the attribute or the candidate. */
const UNSAFE_IN: Readonly<Record<TargetContext, RegExp>> = {
  destination: /[\s()<>\\]/gu, angle: /[\s<>\\]/gu, double: /[\s"]/gu, single: /[\s']/gu, unquoted: /[\s"'=<>`]/gu,
};
const percent = (c: string): string => [...Buffer.from(c)].map(b => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
/** Percent-encodes what would break the syntax around a rewritten target (a srcset candidate may not hold a comma either). */
const escapeTarget = (target: string, span: TargetSpan): string => {
  const escaped = target.replace(UNSAFE_IN[span.context], percent);
  return span.srcset ? escaped.replace(/,/g, percent) : escaped;
};

const unescapeTarget = (target: string): string => target.replace(/\\([!-/:-@[-`{-~])/g, '$1');
const isRelativeTarget = (target: string): boolean => target !== '' && !target.startsWith('#') && !target.startsWith('//') && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target);
const splitAnchor = (target: string): [string, string] => { const at = target.indexOf('#'); return at < 0 ? [target, ''] : [target.slice(0, at), target.slice(at)]; };
const decoded = (text: string): string | undefined => { try { return decodeURIComponent(text); } catch { return undefined; } };
/** A relative target's path (unescaped and percent-decoded), query and anchor; undefined when it is not relative, starts at a root, or cannot be decoded. */
function relativeTarget(target: string): { path: string; query: string; anchor: string } | undefined {
  const plain = unescapeTarget(target);
  if (!isRelativeTarget(plain)) return undefined;
  const [location, anchor] = splitAnchor(plain), at = location.indexOf('?');
  // A query (`?plain=1`, `?raw=true`) is not part of the path: it is kept on the rewritten link, not looked up.
  const [raw, query] = at < 0 ? [location, ''] : [location.slice(0, at), location.slice(at)], path = decoded(raw);
  // A path starting at a root (written `/docs/x.md`, or decoded to it) is refused, and so is an encoded slash (`%2F`),
  // which cannot be told from a separator.
  return path === undefined || /%2f/i.test(raw) || path.startsWith('/') ? undefined : { path, query, anchor };
}
/** Percent-encodes a path for a link destination: spaces, parentheses, angle brackets, `%`, `#`, `?` and non-ASCII. */
const encodePath = (path: string): string => path.replace(/[^A-Za-z0-9\-._~!$&'*+,;=:@/]/gu, c => percent(c));
/** Where a relative link of a document kept at `repoSource` points in the repository, or undefined when the stage leaves it unchanged. */
function repositoryLink(repoSource: string, target: string): { path: string; folder: boolean; query: string; anchor: string } | undefined {
  const relative = relativeTarget(target);
  if (!relative) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(repoSource), relative.path)).replace(/\/$/, '');
  return path === '..' || path.startsWith('../') ? undefined : { path, folder: relative.path.endsWith('/') || path === '.', query: relative.query, anchor: relative.anchor };
}

/**
 * Rewrites the repository-relative links and images of a staged markdown document. A target the package ships becomes
 * its package-relative path; any other target becomes an absolute URL on the public repository (the raw host for
 * images). Anchors are kept. `repoSource` is where the document lives in the repository; `staged` holds every package path.
 * A query is kept after the path. A link to the repository root becomes the public repository's front page. Targets
 * starting at a root (`/docs/x.md`) and targets outside the repository are left as written, for the link check to refuse.
 */
export function stagedMarkdown(packagePath: string, repoSource: string, body: Buffer, staged: ReadonlySet<string>): Buffer {
  return Buffer.from(mapMarkdownTargets(body.toString('utf8'), (target, image) => {
    const link = repositoryLink(repoSource, target);
    if (!link) return target;
    if (link.path === '.') return `${PUBLIC_ROOT}${link.query}${link.anchor}`;
    const packageTarget = packagePathOf(link.path), repoTarget = encodePath(link.path), suffix = `${link.folder ? '/' : ''}${link.query}`, anchor = link.anchor;
    if (packageTarget !== undefined && stagedTarget(packageTarget, staged)) return `${encodePath(posix.relative(posix.dirname(packagePath), packageTarget) || '.')}${suffix}${anchor}`;
    return image ? `${PUBLIC_RAW_BASE}${repoTarget}${suffix}` : `${PUBLIC_BLOB_BASE}${repoTarget}${suffix}${anchor}`;
  }));
}

/**
 * The relative links and images of a staged markdown document whose target is not in the package, as `<document>: <target>`.
 * A target starting at a root (`/docs/x.md`) is refused: the package has no repository root to resolve it against.
 */
export function brokenMarkdownLinks(packagePath: string, body: Buffer, staged: ReadonlySet<string>): string[] {
  const broken: string[] = [];
  mapMarkdownTargets(body.toString('utf8'), target => {
    if (isRelativeTarget(unescapeTarget(target))) {
      const relative = relativeTarget(target);
      // Undecodable, root-relative or encoded-slash targets have no resolution: refused.
      if (!relative) { broken.push(`${packagePath}: ${target}`); return target; }
      const resolved = posix.normalize(posix.join(posix.dirname(packagePath), relative.path)).replace(/\/$/, '');
      if (resolved === '..' || resolved.startsWith('../') || !stagedTarget(resolved, staged) || (relative.path.endsWith('/') && staged.has(resolved))) broken.push(`${packagePath}: ${target}`);
    }
    return target;
  });
  return broken;
}

/** Refuses a stage in which a markdown document links to, or shows, a file the package does not ship. */
export function assertStagedLinks(files: readonly { path: string; body: Buffer }[], staged: ReadonlySet<string>): void {
  const broken = files.filter(file => file.path.endsWith('.md')).flatMap(file => brokenMarkdownLinks(file.path, file.body, staged));
  if (broken.length) throw fault('STAGE_DOCUMENT_LINK', broken);
}

/** `[text](destination)`, `![alt](destination)` and `[text][label]` reduced to their text, with code spans and escapes respected and balanced parentheses in destinations. */
function withoutLinkSyntax(source: string): string {
  const masked = maskInline(source), drop = new Array<boolean>(source.length).fill(false);
  for (let i = masked.indexOf('['); i >= 0; i = masked.indexOf('[', i + 1)) {
    let close = -1, end = -1;
    for (let k = i + 1, depth = 1; k < masked.length; k++) {
      if (masked[k] === '[') depth++;
      else if (masked[k] === ']' && !--depth) { close = k; break; }
    }
    if (close < 0) continue;
    if (masked[close + 1] === '(') {
      for (let k = close + 2, depth = 0; k < masked.length; k++) {
        if (masked[k] === '(') depth++;
        else if (masked[k] === ')') { if (!depth) { end = k; break; } depth--; }
      }
    } else if (masked[close + 1] === '[') end = masked.indexOf(']', close + 2);
    if (end < 0) continue;
    if (i > 0 && masked[i - 1] === '!') drop[i - 1] = true;
    drop[i] = true;
    for (let k = close; k <= end; k++) drop[k] = true;
  }
  return source.split('').filter((_c, n) => !drop[n]).join('');
}
/** The text a heading renders, as GitHub slugs it: code keeps its content; link, image, emphasis and HTML markup go. */
function headingText(heading: string): string {
  const escapes: string[] = [], source = withoutLinkSyntax(heading);
  return source.trim().split(/(?<!`)(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/).map((part, n) => {
    if (n % 3 === 1) return '';
    if (n % 3 === 2) return part.length > 2 && part.startsWith(' ') && part.endsWith(' ') && part.trim() ? part.slice(1, -1) : part;
    return part
      .replace(/\\([!-/:-@[-`{-~])/g, (_m, c: string) => `\uE000${escapes.push(c) - 1}\uE001`)
      .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])?/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/\*+|~~|(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, (_m, lead?: string) => lead ?? '')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[name]!)
      .replace(/&#(\d+);|&#[xX]([0-9A-Fa-f]+);/g, (_m, dec?: string, hex?: string) => String.fromCodePoint(dec ? Number(dec) : parseInt(hex!, 16)))
      .replace(/\uE000(\d+)\uE001/g, (_m, n: string) => escapes[Number(n)]!);
  }).join('').trim();
}
/**
 * The anchors a markdown document defines on GitHub: one per heading (ATX or setext, outside code) by GitHub's slug
 * rules (lower case; everything but letters, marks, digits, `_`, `-` and spaces removed; spaces become `-`; a repeated
 * slug gets `-1`, `-2`, ...), plus the `id` and `name` attributes of HTML tags.
 */
export function markdownAnchors(text: string): Set<string> {
  const anchors = new Set<string>(), occurrences = new Map<string, number>();
  const add = (heading: string): void => {
    const base = headingText(heading).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
    let slug = base;
    while (occurrences.has(slug)) { const count = occurrences.get(base)! + 1; occurrences.set(base, count); slug = `${base}-${count}`; }
    occurrences.set(slug, 0); anchors.add(slug);
  };
  let paragraph: string[] = [];
  for (const line of maskBlocks(text).split('\n')) {
    const atx = /^[ \t]*#{1,6}(?=[ \t\r]|$)(.*)$/.exec(line);
    if (atx) { add(atx[1]!.replace(/\r$/, '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '')); paragraph = []; }
    else if (isBlank(line)) paragraph = [];
    else if (paragraph.length && /^[ \t]*(?:=+|-+)[ \t\r]*$/.test(line)) { add(paragraph.join(' ')); paragraph = []; }
    else paragraph.push(line.replace(/\r$/, ''));
  }
  const masked = maskInline(maskBlocks(text));
  for (const { name, start, end } of htmlAttributes(masked)) if (name === 'id' || name === 'name') anchors.add(text.slice(start, end));
  return anchors;
}
/** Whether `#anchor` names a place in a document with these anchors. `#` and `#top` are the top of any page. */
function anchorDefined(anchors: ReadonlySet<string>, anchor: string): boolean {
  const name = decoded(anchor.slice(1));
  return name !== undefined && (name === '' || name.toLowerCase() === 'top' || anchors.has(name) || anchors.has(name.toLowerCase()));
}

/** The repository at stage time: its tracked files and a reader for them. */
export type RepositoryFiles = { readonly tracked: ReadonlySet<string>; readonly read: (path: string) => string };
/**
 * The links of a shipped markdown document, before the rewrite, that point nowhere, as `<document>: <target>`. Every
 * relative target must be a file or folder tracked in the repository (the package and the public repository hold
 * only tracked files), and an anchor into a markdown file, or into the document itself, must name one of its headings
 * or HTML ids. A file is never linked as a folder (`docs/LIMITS.md/`). Anchors into other files (such as `#L10` line
 * anchors) are not checked. Targets the rewrite leaves as written (outside the repository, starting at a root, or
 * undecodable) are not reported here: brokenMarkdownLinks refuses them in the staged document.
 */
export function repositoryLinkProblems(packagePath: string, repoSource: string, body: Buffer, repository: RepositoryFiles): string[] {
  const text = body.toString('utf8'), problems: string[] = [], anchors = new Map<string, Set<string>>();
  const anchorsOf = (path: string): Set<string> => {
    if (!anchors.has(path)) anchors.set(path, markdownAnchors(path === repoSource ? text : repository.read(path)));
    return anchors.get(path)!;
  };
  mapMarkdownTargets(text, target => {
    const plain = unescapeTarget(target);
    if (plain.startsWith('#')) { if (!anchorDefined(anchorsOf(repoSource), plain)) problems.push(`${packagePath}: ${target}`); return target; }
    const link = repositoryLink(repoSource, target);
    if (!link) return target;
    if (link.path !== '.' && !listedPath(link.path, repository.tracked)) problems.push(`${packagePath}: ${target}`);
    else if (link.folder && repository.tracked.has(link.path)) problems.push(`${packagePath}: ${target}`);
    else if (link.anchor && !link.folder && /\.md$/i.test(link.path) && repository.tracked.has(link.path) && !anchorDefined(anchorsOf(link.path), link.anchor)) problems.push(`${packagePath}: ${target}`);
    return target;
  });
  return problems;
}
/** Refuses a stage in which a shipped markdown document links to an untracked path or to an anchor that does not exist. */
export function assertRepositoryLinks(documents: readonly { path: string; source: string; body: Buffer }[], repository: RepositoryFiles): void {
  const problems = documents.filter(d => d.path.endsWith('.md')).flatMap(d => repositoryLinkProblems(d.path, d.source, d.body, repository));
  if (problems.length) throw fault('STAGE_DOCUMENT_LINK', problems);
}
/**
 * The files tracked in the repository at `root` (by `git ls-files`) that exist in the working tree, with a cached reader.
 * Git rather than the file system: the public repository holds tracked files only, so a git-ignored build output or
 * an untracked local note on disk must not satisfy a link. `root` must be the top level of its own git checkout: in a
 * copy without .git, git would answer for an enclosing repository (or for none), so that is refused as such.
 */
export function repositoryFiles(root: string): RepositoryFiles {
  // Variables a git hook may set would point git at another repository.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX)$/.test(name)));
  const git = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0 || !existsSync(top.stdout.trim()) || realpathSync(top.stdout.trim()) !== realpathSync(root)) throw fault('STAGE_NEEDS_GIT_CHECKOUT');
  const listed = git('ls-files', '-z');
  if (listed.status !== 0) throw fault('STAGE_TRACKED_FILES');
  const tracked = new Set(listed.stdout.split('\0').filter(path => path && existsSync(join(root, path)))), texts = new Map<string, string>();
  return { tracked, read: path => { if (!texts.has(path)) texts.set(path, readFileSync(join(root, path), 'utf8')); return texts.get(path)!; } };
}

/** Only the helper's narrow pure shared modules/seed live under an eval path. No gateway eval module is admitted. */
export function allowedProductionFile(path: string): boolean {
  if (!safePackagePath(path)) return false;
  if (path.startsWith('dist/')) return path === 'dist/package.json' ||
    GATEWAY_MODULES.some(p => path === `dist/${p}`) || RUNTIME_FILES.some(p => path === `dist/${p}`) ||
    path === 'dist/packages/server/src/generated/release.json';
  if (path.startsWith('quickstart/dist/')) return /^quickstart\/dist\/examples\/quickstart\/[a-z-]+\.(?:js|json)$/.test(path) ||
    ['decimal', 'check-contracts', 'evidence-oracle', 'package-tasks'].some(n => path === `quickstart/dist/packages/${n === 'decimal' ? 'core' : 'evals'}/src/${n}.js`);
  if (path.startsWith('quickstart/')) return ['package.json', 'package-lock.json', 'fireboat-timing.mjs', ...HELPER_ASSETS].some(p => path === `quickstart/${p}`);
  return ['package.json', 'npm-shrinkwrap.json', ...DOCUMENTS].includes(path) || /^licenses\/[A-Za-z0-9_./-]+$/.test(path);
}
export function assertProductionFile(path: string): void {
  if (!allowedProductionFile(path)) throw fault('STAGE_FORBIDDEN');
}

/** The approved gateway closure is flat and has three packages. Reject every dev/client/tooling/optional edge. */
export function productionOnlyLock(lock: any): boolean {
  if (!lock || lock.lockfileVersion !== 3 || !lock.packages || lock.name !== '@fireboat/gateway' || typeof lock.version !== 'string') return false;
  if (!isDeepStrictEqual(Object.keys(lock).sort(), ['name', 'version', 'lockfileVersion', 'requires', 'packages'].sort()) || lock.requires !== true) return false;
  const dependencies = { '@modelcontextprotocol/server': '2.3.1', zod: '4.6.7' };
  const expected = ['node_modules/@modelcontextprotocol/core', 'node_modules/@modelcontextprotocol/server', 'node_modules/zod'];
  if (!isDeepStrictEqual(Object.keys(lock.packages).sort(), ['', ...expected].sort()) || !isDeepStrictEqual(lock.packages[''].dependencies, dependencies)) return false;
  const pins: Record<string, string> = { '@modelcontextprotocol/core': '2.3.1', ...dependencies };
  for (const [path, entry] of Object.entries(lock.packages) as [string, any][]) {
    if (!entry || ['dev', 'devOptional', 'link', 'optional', 'hasInstallScript', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(k => Object.hasOwn(entry, k))) return false;
    if (!path) { if (entry.name !== lock.name || entry.version !== lock.version) return false; continue; }
    const name = path.slice('node_modules/'.length);
    if (entry.version !== pins[name] || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? '') ||
      entry.resolved !== `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${entry.version}.tgz`) return false;
    const edges = name === '@modelcontextprotocol/server' ? { '@modelcontextprotocol/core': '2.3.1', zod: '^4.2.0' } : name === '@modelcontextprotocol/core' ? { zod: '^4.2.0' } : undefined;
    if (!isDeepStrictEqual(entry.dependencies, edges)) return false;
  }
  return true;
}
export function assertProductionLock(lock: unknown): void {
  if (!productionOnlyLock(lock)) throw fault('LOCK_NOT_PRODUCTION');
}

// Parse compiled code rather than scanning FHIR interaction-name metadata for words such as "update".
// These are reviewed source-form boundaries, not a proof against arbitrary JavaScript obfuscation.
function parse<T>(code: string, inspect: (source: Node) => T): T {
  const config = '/stage/tsconfig.json', file = '/stage/code.js';
  const files: Record<string, string> = { [config]: JSON.stringify({ compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [], module: 'esnext', target: 'esnext' }, files: ['code.js'] }), [file]: code };
  const fs = createVirtualFileSystem(files); fs.readFile = p => files[p] ?? null;
  const api = new API({ fs });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const program = snapshot.getProject(config)?.program, source = program?.getSourceFile(file);
      if (!source || program!.getSyntacticDiagnostics(file).length) throw fault('SERVING_BOUNDARY');
      return inspect(source);
    } finally { snapshot.dispose(); }
  } finally { api.close(); }
}
const walk = (node: Node, visit: (node: Node) => void): void => { visit(node); node.forEachChild(n => walk(n, visit)); };
const textOf = (node: Node): string => node.getText().replace(/\s+/g, ' ').trim();
/** The bootstrap's only lazy imports: serving (`main.js`) and the separate `login`/`logout` command module. */
export const BOOTSTRAP_LAZY_IMPORTS: readonly string[] = ["import('./main.js')", "import('./login.js')"];
/** The `login`/`logout` module: a separate root that alone may import node:child_process and the node:http listener. */
export const ACCOUNT_ROOT = 'packages/server/src/login.js';
const BOOTSTRAP = 'packages/server/src/cli.js';
export function forbiddenServingLoad(code: string, bootstrap: boolean): boolean {
  return parse(code, source => {
    let forbidden = false;
    const names = new Set(['getBuiltinModule', 'createRequire', 'require', 'eval', 'Function', 'dlopen']);
    walk(source, n => {
      if ((n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.StringLiteral) && names.has((n as StringLiteral).text)) forbidden = true;
      if (n.kind === SyntaxKind.ImportDeclaration && ['node:module', 'node:vm', 'node:worker_threads'].includes(((n as ImportDeclaration).moduleSpecifier as StringLiteral).text)) forbidden = true;
      if (n.kind === SyntaxKind.CallExpression) {
        const call = n as CallExpression;
        if (call.expression.kind === SyntaxKind.ImportKeyword && (!bootstrap || !BOOTSTRAP_LAZY_IMPORTS.includes(textOf(n)))) forbidden = true;
        // FHIR's schema/snapshot .binding fields are data; process.binding is a loader.
        if (/(?:^|\.)binding$/.test(textOf(call.expression)) || /\[['"]binding['"]\]$/.test(textOf(call.expression))) forbidden = true;
      }
    });
    return forbidden;
  });
}
/** Static import and re-export specifiers only (no lazy imports). */
export function staticImports(code: string): string[] {
  return parse(code, source => {
    const imports: string[] = [];
    walk(source, n => {
      if (n.kind === SyntaxKind.ImportDeclaration || n.kind === SyntaxKind.ExportDeclaration) {
        const specifier = (n as ImportDeclaration | ExportDeclaration).moduleSpecifier;
        if (specifier) imports.push(specifier.kind === SyntaxKind.StringLiteral ? (specifier as StringLiteral).text : '');
      }
    });
    return imports;
  });
}
export function moduleImports(code: string): string[] {
  return parse(code, source => {
    const imports: string[] = [];
    walk(source, n => {
      let specifier: Node | undefined;
      if (n.kind === SyntaxKind.ImportDeclaration || n.kind === SyntaxKind.ExportDeclaration) specifier = (n as ImportDeclaration | ExportDeclaration).moduleSpecifier;
      if (n.kind === SyntaxKind.CallExpression && (n as CallExpression).expression.kind === SyntaxKind.ImportKeyword) specifier = (n as CallExpression).arguments[0];
      if (specifier) {
        if (specifier.kind !== SyntaxKind.StringLiteral) throw fault('SERVING_BOUNDARY');
        imports.push((specifier as StringLiteral).text);
      }
    });
    return imports;
  });
}

/** Every use of the transport primitives, every HTTP import, and every method property is pinned at its actual syntax site. */
export function httpDispatchSites(code: string): string[] {
  return parse(code, source => {
    const sites: string[] = [];
    const names = new Set(['httpRequest', 'httpsRequest', 'controlledFetch', 'fetchFn', 'send', 'listedPut', 'fetch', 'XMLHttpRequest', 'WebSocket',
      'createServer', 'createHttpServer', 'listen']);
    walk(source, n => {
      if ((n.kind === SyntaxKind.Identifier || n.kind === SyntaxKind.StringLiteral) && names.has((n as StringLiteral).text)) {
        const parent = n.parent;
        sites.push(textOf(parent.kind === SyntaxKind.PropertyAccessExpression && parent.parent.kind === SyntaxKind.CallExpression ? parent.parent : parent));
      }
      if ([SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment].includes(n.kind) &&
        /^(?:['"]?method['"]?)$/.test(textOf((n as any).name))) sites.push(textOf(n));
      if (n.kind === SyntaxKind.ImportDeclaration && /^node:(?:https?|http2|net|tls|dgram)$/.test(((n as ImportDeclaration).moduleSpecifier as StringLiteral).text)) sites.push(textOf(n));
    });
    return sites.sort(order);
  });
}

// Digests cover the parsed dispatch-site inventory, not whole files. A site's text includes any comments inside it,
// so editing such a comment needs a new digest. Tests change the actual calls and options.
export const HTTP_DISPATCH: Readonly<Record<string, string>> = {
  'packages/auth/src/client-credentials.js': 'a11e622da412c298ed51f8d46bdde90d0fd4909df0c48b00a4308273d99a0594',
  // SMART Backend Services: one token POST to the discovered (or pinned) loopback token endpoint, plus the doctor's discovery call.
  'packages/auth/src/smart-backend.js': 'fa36d22205a67dc0caeb401d88233d935e277bb814e2fc4632b5f65f38f66349',
  // SMART discovery: one unauthenticated GET of <baseUrl>/.well-known/smart-configuration.
  'packages/auth/src/smart-discovery.js': '18479560908e19065b135cd5387b59f5966173dad34cb4f4796a07a2c12721a5',
  // SMART standalone launch: the code exchange and refresh token POSTs to the discovered (or pinned) loopback token endpoint.
  'packages/auth/src/smart-standalone.js': '2412e1f7b465b148b260b3ab269e6d3629e327ed450d4b5a176e29e0c6cfd79f',
  'packages/core/src/transport.js': 'd116466f0e6cff1195b0e651abfee5725e583263e2b45c1fc0b99ce64aaca070',
  // The account module only (`fireboat login`): the one-shot 127.0.0.1 redirect listener, pinned with its handler.
  'packages/server/src/login.js': '8e10504d55dc358ba9dd402741aa91493ea0e9a43e2da0eaa259074630c0d7d6',
  'packages/server/src/main.js': '6b6cd7e78ac11872e66b8a42e1d70df74c45bc77711f623c9b92913437434182',
  'examples/quickstart/client.js': '1b0f700399d67254fccf1c6204776d50c4f6e3349290fccd75556fa181cbc955',
  'examples/quickstart/request-observer.js': '72a0412cfe92e7bd52a36541331a46c78e9892bad134a9b9f110edd304dc40be',
  // Includes exactly `import { connect } from 'node:net';` for the pre-provisioning 127.0.0.1:18080 probe (sends no bytes).
  'examples/quickstart/seed-http.js': '0c0fd27cf9765203342fdff9e8704d8c976933f1b7a496d448137586203571f5',
  'examples/quickstart/setup-oracle.js': '64169f837e258750495e9538c9a893efc88cc18393f536858e678c6ac5e1f80a',
};
export function assertHttpDispatch(path: string, code: string): void {
  const sites = httpDispatchSites(code), expected = HTTP_DISPATCH[path];
  if (sites.length ? sha256(JSON.stringify(sites)) !== expected : expected !== undefined) throw fault('HTTP_DISPATCH');
}

/**
 * Two walks over the shipped modules. The serving walk starts at cli.js and main.js: only transport.js may import a
 * network module and nothing may import node:child_process. cli.js's one lazy `import('./login.js')` is not followed
 * there; it starts the account walk, where login.js alone may also import node:child_process and node:http (its
 * one-shot loopback listener). Every module is reached by exactly these walks, and each keeps its pinned dispatch sites.
 */
export function servingBoundary(modules: ReadonlyMap<string, string>, dependencies: readonly string[]): void {
  const seen = new Set<string>(), accountRoots = new Set<string>();
  const visit = (roots: readonly string[], account: boolean): void => {
    const pending = [...roots];
    while (pending.length) {
      const path = pending.pop()!;
      if (seen.has(path)) continue;
      const code = modules.get(path);
      if (code === undefined || !GATEWAY_MODULES.includes(path)) throw fault('SERVING_BOUNDARY');
      seen.add(path);
      const own = account && path === ACCOUNT_ROOT;
      // Bootstrap's fixed lazy imports are needed for --version without loading serving code, and for login/logout.
      if (forbiddenServingLoad(code, path === BOOTSTRAP)) throw fault('SERVING_BOUNDARY');
      const statics = path === BOOTSTRAP ? staticImports(code) : [];
      for (const specifier of moduleImports(code)) {
        if (specifier.startsWith('node:')) {
          if (/^node:(?:https?|http2|net|tls|dgram)$/.test(specifier) && path !== 'packages/core/src/transport.js' && !(own && specifier === 'node:http')) throw fault('SERVING_BOUNDARY');
          if (specifier === 'node:child_process' && !own) throw fault('SERVING_BOUNDARY');
          continue;
        }
        if (specifier.startsWith('.')) {
          const target = posix.normalize(posix.join(posix.dirname(path), specifier));
          if (target.endsWith('.json')) {
            if (target !== 'package.json' && !RUNTIME_FILES.includes(target)) throw fault('SERVING_BOUNDARY');
          } else {
            if (!GATEWAY_MODULES.includes(target)) throw fault('SERVING_BOUNDARY');
            if (path === BOOTSTRAP && target === ACCOUNT_ROOT) {
              if (statics.includes(specifier)) throw fault('SERVING_BOUNDARY');
              accountRoots.add(target);
              continue;
            }
            pending.push(target);
          }
        } else if (!dependencies.some(name => specifier === name || specifier.startsWith(`${name}/`))) throw fault('SERVING_BOUNDARY');
      }
      assertHttpDispatch(path, code);
    }
  };
  visit([BOOTSTRAP, 'packages/server/src/main.js'], false);
  visit([...accountRoots], true);
  if (!isDeepStrictEqual([...seen].sort(order), [...GATEWAY_MODULES].sort(order))) throw fault('SERVING_BOUNDARY');
}

export const withoutSourceMap = (bytes: Buffer): Buffer => Buffer.from(bytes.toString('utf8').replace(/\n\/\/# sourceMappingURL=[^\r\n]+(?:\r?\n)?$/, '\n'));
type StagedFile = { path: string; body: Buffer; mode: number };
const inventory = (identity: ExpectedInventory['identity'], files: readonly StagedFile[]): ExpectedInventory => validateExpectedInventory({ schema: 1, identity,
  files: files.map(({ path, body, mode }) => ({ path, size: body.byteLength, mode, sha256: sha256(body) })).sort((a, b) => order(a.path, b.path)) });
/** Names the paths whose presence or hash differs between an approved and a freshly staged inventory. Paths only. */
export function describeInventoryDrift(label: string, approved: ExpectedInventory, actual: ExpectedInventory): string[] {
  const was = new Map(approved.files.map(f => [f.path, f])), now = new Map(actual.files.map(f => [f.path, f])), lines: string[] = [];
  for (const path of [...now.keys()].sort(order)) {
    const old = was.get(path), cur = now.get(path)!;
    if (!old) lines.push(`${label}: added ${path}`);
    else if (old.sha256 !== cur.sha256 || old.size !== cur.size || old.mode !== cur.mode) lines.push(`${label}: changed ${path}`);
  }
  for (const path of [...was.keys()].sort(order)) if (!now.has(path)) lines.push(`${label}: removed ${path}`);
  if (!isDeepStrictEqual(approved.identity, actual.identity)) lines.push(`${label}: identity differs`);
  return lines;
}
/** An inventory's identity, as prepareFiles derives it from package.json (or the helper's examples/quickstart/package.json). */
export const rootIdentity = (pkg: any): ExpectedInventory['identity'] => ({ name: pkg.name, version: pkg.version, bin: pkg.bin });

/** Interior links, special files, and unapproved empty directories are refused as well as extra files. */
export async function listRegularFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(join(root, path));
    if (info.isDirectory()) {
      const names = (await readdir(join(root, path))).sort(order);
      if (path && !names.length) throw fault('STAGE_FORBIDDEN');
      for (const name of names) await visit(path ? `${path}/${name}` : name);
    } else if (info.isFile() && !info.isSymbolicLink()) found.push(path);
    else throw fault('STAGE_FORBIDDEN');
  };
  await visit(''); return found.sort(order);
}
export async function verifyStagedDirectory(root: string, expected: ExpectedInventory): Promise<void> {
  const paths = await listRegularFiles(root);
  for (const path of paths) assertProductionFile(path);
  if (!isDeepStrictEqual(paths, expected.files.map(f => f.path).sort(order))) throw fault('STAGE_INVENTORY');
  for (const file of expected.files) {
    const path = join(root, file.path), info = await lstat(path), body = await readFile(path);
    if (info.mode % 0o1000 !== file.mode || body.byteLength !== file.size || sha256(body) !== file.sha256) throw fault('STAGE_CHANGED');
  }
}

export async function snapshotInputs(root: string): Promise<readonly FileInventory[]> {
  const paths = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', ...DOCUMENTS.map(documentSource), 'docker/compose.quickstart.yaml'];
  for (const directory of ['packages', 'examples/quickstart', 'scripts', 'tests', 'packaging'])
    paths.push(...(await listRegularFiles(join(root, directory))).map(p => `${directory}/${p}`));
  return Promise.all([...new Set(paths)].sort(order).map(async path => {
    const body = await readFile(join(root, path)), info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw fault('STAGE_FORBIDDEN');
    return { path, size: body.byteLength, mode: info.mode % 0o1000, sha256: sha256(body) };
  }));
}

/** Pure manifest projection: candidate stays private and contains no development edges or lifecycle scripts. */
export function stagedManifest(pkg: any, paths: readonly string[]): any {
  const { scripts: _scripts, devDependencies: _dev, ...manifest } = pkg;
  if (pkg.private !== true) throw fault('STAGE_IDENTITY');
  return { ...manifest, files: [...paths].sort(order) };
}

/** Compiles without installing anything and compares the selected outputs with the already checked build. */
export async function verifyCheckedBuild(root: string, scratch: string, paths: readonly string[]): Promise<void> {
  const emitted = join(scratch, 'compiled');
  const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', emitted],
    { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (compile.status !== 0) throw fault('STAGE_COMPILE');
  for (const p of new Set(paths)) {
    if (!(await readFile(join(root, 'dist', p))).equals(await readFile(join(emitted, p)))) throw fault('STAGE_STALE_BUILD');
  }
}

/** Package paths staged from dist/: everything under dist/ but the manifest, the helper's modules and its timing script. */
export const fromDist = (path: string): boolean => (path.startsWith('dist/') && path !== 'dist/package.json') || path.startsWith('quickstart/dist/') || path === 'quickstart/fireboat-timing.mjs';
/**
 * Why dist/ cannot be compared with the approved dist hashes now, or undefined when it is a complete, fresh build.
 * A stale dist/ is skipped, not failed, so a test run before the build (as npm run check does) still passes after an
 * edit; the stage itself recompiles and compares, so a stale build never stages.
 */
export function distComparisonSkip(dist: { built: boolean; complete: boolean; stale: readonly string[] }): string | undefined {
  if (!dist.built) return 'dist/ is not built: run npm run build to compare the approved dist hashes';
  // npm run build writes the release metadata last; a bare compile (as the mutation gate runs in its copies) has none.
  if (!dist.complete) return 'dist/ is not a complete npm run build: run npm run build to compare the approved dist hashes';
  if (dist.stale.length) return `dist/ is older than its sources (${dist.stale.slice(0, 3).join(', ')}${dist.stale.length > 3 ? ', ...' : ''}): run npm run build to compare the approved dist hashes`;
  return undefined;
}
/** How the files staged from dist/ (package paths) differ from both approved inventories, as paths only. */
export function distInventoryDrift(built: readonly FileInventory[], npm: ExpectedInventory, helper: ExpectedInventory): string[] {
  return [
    ...describeInventoryDrift('npm-files.json', { ...npm, files: npm.files.filter(f => fromDist(f.path)) }, { ...npm, files: [...built] }),
    ...describeInventoryDrift('helper-files.json', { ...helper, files: helper.files.filter(f => fromDist(`quickstart/${f.path}`)) },
      { ...helper, files: built.filter(f => f.path.startsWith('quickstart/')).map(f => ({ ...f, path: f.path.slice('quickstart/'.length) })) }),
  ];
}

type StageCopy = { source: string; target: string; mode: number };
/** Every file the stage copies, in order: its repository source, its package path and its mode. `helperModules` is the quickstart helper's built module graph. */
export async function stageCopies(root: string, helperModules: readonly string[]): Promise<StageCopy[]> {
  const copies: StageCopy[] = [];
  const copy = (source: string, target = source, mode = 0o644): void => { copies.push({ source, target, mode }); };
  for (const p of GATEWAY_MODULES) copy(`dist/${p}`, `dist/${p}`, p === 'packages/server/src/cli.js' ? 0o755 : 0o644);
  for (const p of [...RUNTIME_FILES, 'packages/server/src/generated/release.json']) copy(`dist/${p}`);
  for (const p of DOCUMENTS) copy(documentSource(p), p);
  copy('packaging/npm-shrinkwrap.json', 'npm-shrinkwrap.json');
  for (const p of await listRegularFiles(join(root, LICENSES_SOURCE))) copy(`${LICENSES_SOURCE}/${p}`, `licenses/${p}`);
  copy('examples/quickstart/package.json', 'quickstart/package.json');
  copy('examples/quickstart/package-lock.json', 'quickstart/package-lock.json');
  for (const p of helperModules) copy(`dist/${p}`, `quickstart/dist/${p}`, p === 'examples/quickstart/main.js' ? 0o755 : 0o644);
  for (const p of HELPER_ASSETS) copy(p, `quickstart/${p}`);
  copy('dist/examples/quickstart/timing.js', 'quickstart/fireboat-timing.mjs', 0o755);
  return copies;
}
/** A copied file as staged: compiled modules lose their source-map comment; other files are copied as they are. Markdown is rewritten later. */
export const stagedCopy = (source: string, body: Buffer): Buffer => source.endsWith('.js') ? withoutSourceMap(body) : body;
/** Every package path: the copied files plus the manifest, which ships at the package root and in dist/. */
export const packagePaths = (copied: readonly string[]): string[] => [...copied, 'package.json', 'dist/package.json'].sort(order);
/** The staged manifest's bytes, as both package.json and dist/package.json. */
export const manifestBytes = (pkg: any, paths: readonly string[]): Buffer => jsonBytes(stagedManifest(pkg, paths));

export async function prepareFiles(root: string, scratch: string): Promise<{ files: StagedFile[]; helper: ExpectedInventory }> {
  const pkg = await readJson(join(root, 'package.json')), lock = await readJson(join(root, 'packaging/npm-shrinkwrap.json'));
  assertProductionLock(lock);
  if (!isDeepStrictEqual(rootIdentity(pkg), rootIdentity(lock.packages[''])) || !isDeepStrictEqual(pkg.dependencies, lock.packages[''].dependencies)) throw fault('STAGE_IDENTITY');
  const checker = await import(pathToFileURL(join(root, 'scripts/check-dist-identity.mjs')).href);
  await checker.checkDistIdentity(root);
  const dist = join(root, 'dist'), helperPkg = await readJson(join(root, 'examples/quickstart/package.json'));
  const boundary = await helperBoundary(observedGraph(dist, Object.keys(HELPER_ENTRIES)), p => readFile(join(dist, p), 'utf8'), Object.keys(helperPkg.dependencies));
  const helperAssets = await import(pathToFileURL(join(dist, 'examples/quickstart/prepare.js')).href);
  helperAssets.validateHelperAssets({ manifest: await readFile(join(root, 'examples/quickstart/seed-manifest.json')),
    compose: await readFile(join(root, 'docker/compose.quickstart.yaml')), resources: await readFile(join(root, 'packages/evals/fixtures/quickstart/resources.ndjson')) });
  const modules = new Map(await Promise.all(GATEWAY_MODULES.map(async p => [p, await readFile(join(dist, p), 'utf8')] as const)));
  servingBoundary(modules, Object.keys(pkg.dependencies));
  for (const p of boundary.modules.filter(p => p.endsWith('.js'))) assertHttpDispatch(p, await readFile(join(dist, p), 'utf8'));

  // Re-emit into scratch and compare selected build outputs; stale dist/source substitutions cannot be staged.
  await verifyCheckedBuild(root, scratch, [...GATEWAY_MODULES, ...boundary.modules]);
  const licenses = await import(pathToFileURL(join(root, 'scripts/release-licenses.mjs')).href);
  await licenses.checkReleaseLicenses(root);
  const files: StagedFile[] = [], sources = new Map<string, string>();
  const add = (path: string, body: Buffer, mode = 0o644): void => { assertProductionFile(path); files.push({ path, body, mode }); };
  for (const { source, target, mode } of await stageCopies(root, boundary.modules)) {
    const info = await lstat(join(root, source)); if (!info.isFile() || info.isSymbolicLink()) throw fault('STAGE_FORBIDDEN');
    add(target, stagedCopy(source, await readFile(join(root, source))), mode);
    sources.set(target, source);
  }
  const paths = packagePaths(files.map(f => f.path));
  // Every link of a shipped markdown document names a tracked file or folder, and every checked anchor exists.
  assertRepositoryLinks(files.map(file => ({ path: file.path, source: sources.get(file.path)!, body: file.body })), repositoryFiles(root));
  // Markdown links and images point inside the package or to the public repository; the source files are not changed.
  const staged = new Set(paths);
  for (const file of files) if (file.path.endsWith('.md')) file.body = stagedMarkdown(file.path, sources.get(file.path)!, file.body, staged);
  assertStagedLinks(files, staged);
  if (!isDeepStrictEqual(pkg.files, paths)) throw fault('STAGE_FILES_ALLOWLIST');
  const manifest = manifestBytes(pkg, paths);
  add('package.json', manifest); add('dist/package.json', manifest);
  if (new Set(files.map(f => f.path)).size !== files.length) throw fault('STAGE_INVENTORY');
  return { files, helper: inventory(rootIdentity(helperPkg), files.filter(f => f.path.startsWith('quickstart/')).map(f => ({ ...f, path: f.path.slice(11) }))) };
}

export async function stagePackage(out: string, options: { root?: string; approveInventory?: boolean } = {}): Promise<ExpectedInventory> {
  const root = resolve(options.root ?? ROOT);
  if (!isAbsolute(out) || resolve(out) === root || relative(root, resolve(out)).split(sep)[0] !== '..') throw fault('STAGE_DESTINATION');
  // Exclusive creation, never clearing a directory supplied by a caller.
  await mkdir(out, { mode: 0o700 });
  const scratch = await mkdtemp(join(dirname(out), '.fireboat-stage-'));
  try {
    const before = options.approveInventory ? undefined : await snapshotInputs(root);
    const { files, helper } = await prepareFiles(root, scratch), pkg = await readJson(join(root, 'package.json'));
    const expected = inventory(rootIdentity(pkg), files);
    if (options.approveInventory) {
      await writeFile(join(root, 'packaging/npm-files.json'), jsonBytes(expected));
      await writeFile(join(root, 'packaging/helper-files.json'), jsonBytes(helper));
    } else {
      const drift = [...describeInventoryDrift('npm-files.json', validateExpectedInventory(await readJson(join(root, 'packaging/npm-files.json'))), expected),
        ...describeInventoryDrift('helper-files.json', validateExpectedInventory(await readJson(join(root, 'packaging/helper-files.json'))), helper)];
      if (drift.length) throw fault('STAGE_INVENTORY', drift);
    }
    for (const file of files) {
      await mkdir(dirname(join(out, file.path)), { recursive: true });
      await writeFile(join(out, file.path), file.body, { flag: 'wx', mode: file.mode }); await chmod(join(out, file.path), file.mode);
    }
    await verifyStagedDirectory(out, expected);
    const inputs = await snapshotInputs(root);
    if (before && !isDeepStrictEqual(before, inputs)) throw fault('STAGE_INPUT_CHANGED');
    await writeFile(`${out}.stage.json`, jsonBytes({ schema: 1, root, inputs, inventorySha256: sha256(JSON.stringify(expected.files)) }), { flag: 'wx', mode: 0o600 });
    return expected;
  } catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2), approveInventory = args[0] === '--approve-inventory', out = args[approveInventory ? 1 : 0];
  try {
    if (!out || args.length !== (approveInventory ? 2 : 1)) throw fault('STAGE_USAGE');
    const expected = await stagePackage(out, { approveInventory });
    console.log(`stage-package: files=${expected.files.length} inventory=${sha256(JSON.stringify(expected.files))}`);
  } catch (error) {
    if (error instanceof StageFault && error.detail.length) {
      for (const line of error.detail) console.error(`stage-package: ${line}`);
      console.error('stage-package: if every difference above is an intended, reviewed change, re-approve with: npm run stage:package -- --approve-inventory <absolute-new-stage>');
    }
    if (error instanceof StageFault && error.code === 'STAGE_NEEDS_GIT_CHECKOUT') console.error('stage-package: staging needs a git checkout of this repository: the root must be its own top level, not a copy or export');
    console.error(`stage-package: ${error instanceof StageFault ? error.code : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'STAGE_FAILED'}`); process.exitCode = 1;
  }
}
