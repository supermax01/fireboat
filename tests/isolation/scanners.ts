import assert from 'node:assert/strict';
import { CANARIES, A } from './canaries.js';
import { CHANNELS, type Channel } from './case-schema.js';
export interface Hit { channel: Channel | 'retained'; marker_id: string; segment_index: number; path: string; encoding: string }
/** Independent oracle: no policy/query/sanitizer imports. Values never enter diagnostics. */
export function scan(channel: Channel | 'retained', value: unknown, allowProse = true): Hit[] {
  const hits: Hit[] = [];
  const visit = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      const variants: [string, string][] = [['raw', v]];
      if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length >= 12) variants.push(['base64', Buffer.from(v, 'base64').toString('utf8')]);
      variants.push(['json-unescaped', v.replace(/\\u([a-f\d]{4})/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))]);
      for (let i = 0; i < 3; i++) {
        try { const decoded = decodeURIComponent(variants.at(-1)![1]); variants.push([`url-${i + 1}`, decoded]); } catch { break; }
      }
      for (const marker of CANARIES) {
        if (marker.kind === 'permitted-prose' && allowProse && !['operational', 'audit', 'stderr'].includes(channel)) continue;
        for (const [index, segment] of marker.segments.entries()) {
          const found = variants.find(([, s]) => s.toLowerCase().includes(segment.toLowerCase()));
          if (found) hits.push({ channel, marker_id: marker.id, segment_index: index, path, encoding: found[0] });
        }
      }
      if (['operational', 'audit', 'stderr'].includes(channel) && v.includes(A)) hits.push({ channel, marker_id: 'bound-patient-id-in-log', segment_index: 0, path, encoding: 'raw' });
    } else if (Array.isArray(v)) v.forEach((child, i) => visit(child, `${path}/${i}`));
    else if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) { visit(key, `${path}/[key]`); const safe = key.length <= 40 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !CANARIES.some(m => m.segments.some(s => key.toLowerCase().includes(s.toLowerCase()))); visit(child, `${path}/${safe ? key : '[property]'}`); }
  };
  visit(value, '$'); return hits;
}
export function scannerSelfTests() {
  let planted = 0;
  for (const channel of CHANNELS) for (const marker of CANARIES) for (const segment of marker.segments) {
    for (const value of [segment, segment.toLowerCase(), `${segment}${'x'.repeat(300)}`.slice(0, 120), `${segment}${'y'.repeat(300)}`.slice(0, 240), [...segment].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''), [...segment].map(c => `%${c.charCodeAt(0).toString(16)}`).join(''), `[link withheld] ${segment} trailing prose`, { [segment]: 'ordinary' }, { warnings: [{ repairs: segment }], locator: segment, pending: { blobs: [segment] } }]) {
      assert.ok(scan(channel, value, false).some(h => h.marker_id === marker.id), 'planted marker must be detected'); planted++;
    }
    assert.equal(scan(channel, 'ordinary clean synthetic output', false).length, 0, 'no false positive');
  }
  for (const channel of CHANNELS) for (const marker of CANARIES) {
    const whole = marker.segments.join('-');
    for (let offset = 0; offset < 120; offset++) {
      const cut = ('x'.repeat(offset) + whole).slice(0, 120);
      const fits = offset + marker.segments[0].length <= 120;
      assert.equal(scan(channel, cut, false).some(h => h.marker_id === marker.id), fits, 'positional 120-character truncation boundary'); planted++;
    }
    assert.ok(scan(channel, Buffer.from(whole).toString('base64'), false).some(h => h.marker_id === marker.id)); planted++;
    const expected = marker.kind === 'permitted-prose' && !['operational', 'audit', 'stderr'].includes(channel) ? 0 : marker.segments.length;
    assert.equal(scan(channel, whole, true).length, expected, 'allowProse exemption applies only to attested prose on non-log channels');
  }
  return { verdict: 'PASS', planted, channels: [...CHANNELS], rule: 'any independent >=8-character segment, case folded, JSON-unescaped and up to three URL decodings' };
}
/** Only known random fields are normalized. Counts, reasons, context, duration and pair multiplicity survive. */
export function normalize(value: unknown): unknown {
  const symbols = new Map<string, string>();
  const walk = (v: unknown, key = '', parent = ''): unknown => {
    if (['request_id', 'retrieved_at', 'elapsed_ms'].includes(key)) return '<random>';
    if (parent !== 'context' && ['handle', 'next_cursor', 'cursor'].includes(key) && typeof v === 'string' && /^(cur|res)_[A-Za-z0-9_-]+$/.test(v)) {
      if (!symbols.has(v)) symbols.set(v, `${v.startsWith('cur_') ? 'cur' : 'res'}-locator-${symbols.size}`);
      return symbols.get(v);
    }
    // Keep expiry duration separate in observations; here normalize absolute timestamps only.
    if (key === 'expires_at') return '<absolute-time>';
    if (Array.isArray(v)) return v.map(child => walk(child, '', key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, walk(child, k, key)]));
    return v;
  };
  return walk(value);
}
/** Traverse Map/Set backing structures without invoking getters or policy. */
export function structural(value: unknown, seen = new Set<unknown>(), depth = 0): unknown {
  if (!value || typeof value !== 'object') return typeof value === 'function' ? '<function>' : value;
  if (depth > 128) throw new Error('state capture depth exceeded');
  if (seen.has(value)) return '<cycle>';
  seen.add(value);
  if (value instanceof Map) return [...value].map(([k, v]) => [structural(k, seen, depth + 1), structural(v, seen, depth + 1)]);
  if (value instanceof Set) return [...value].map(v => structural(v, seen, depth + 1));
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return value.map(v => structural(v, seen, depth + 1));
  return Object.fromEntries(Reflect.ownKeys(value).filter(k => !['timer', 'timers', 'credentials', 'config', 'transport'].includes(String(k))).flatMap(k => {
    const d = Object.getOwnPropertyDescriptor(value, k)!;
    return 'value' in d ? [[String(k), structural(d.value, seen, depth + 1)]] : [];
  }));
}
/** Remove only byte differences mechanically attributable to the approved random fields.
 * Actual wire ceilings must be checked first. The remaining accounting reserve is preserved,
 * so a forged bytes_returned value is still a distinguishable verifier failure. */
export function stableEnvelope(call: { envelope: unknown; wire: Record<string, unknown>; bytes: number }): unknown {
  const env = normalize(call.envelope) as Record<string, unknown>;
  const wire = { ...call.wire };
  if (wire.structuredContent) wire.structuredContent = env;
  if (Array.isArray(wire.content)) wire.content = wire.content.map(item => {
    const value = item as { type: string; text?: string };
    if (value.type !== 'text' || !value.text) return value;
    try { return { ...value, text: JSON.stringify(normalize(JSON.parse(value.text))) }; } catch { return value; }
  });
  const budget = env.budget as { bytes_returned?: number } | undefined;
  if (typeof budget?.bytes_returned === 'number') budget.bytes_returned -= call.bytes - Buffer.byteLength(JSON.stringify(wire));
  return env;
}

/** Lint the actual fixture fields before serialization/caps, including property names. */
export function lintFixturePlacement(value: unknown): void {
  const walk = (v: unknown): void => {
    if (typeof v === 'string') for (const marker of CANARIES) {
      const offsets = marker.segments.map(s => v.toLowerCase().indexOf(s.toLowerCase())).filter(n => n >= 0);
      if (offsets.length) assert.ok(Math.min(...offsets) < 112 && offsets.some(n => marker.segments.some(s => v.toLowerCase().indexOf(s.toLowerCase()) === n && n + s.length <= 120)), 'fixture marker segment must survive 120-character cap');
    }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, child] of Object.entries(v)) { walk(k); walk(child); }
  }; walk(value);
}
