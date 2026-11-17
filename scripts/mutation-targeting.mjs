/**
 * Candidate selection for the mutation gate's targeted first pass.
 *
 * These helpers only choose which test files and eval eras the judge tries first
 * for a mutant. They never decide a verdict. A targeted kill still needs a named
 * failure that reproduces when the same candidates run a second time
 * (targetedAttempt in scripts/mutation-guards.mjs), and every mutant the
 * candidates do not kill is judged by the unchanged full path. A wrong, stale or
 * missing candidate therefore costs time, never correctness.
 *
 * Candidates come in tiers, each tried only when the ones before it did not
 * kill the mutant:
 *  1. strong: the failing test names a previous shard report recorded for this
 *     mutant id (--hints), the "Killing test(s):" names and *.test.ts files in the
 *     mutant's registry comment, and test files whose `// kills:` comment names it;
 *  2. learned: files whose tests killed other mutants of the same source file,
 *     in the hint reports or earlier in this run;
 *  3. lexical: both eval eras for edits to the eval harness, and test files ranked
 *     by the rare identifiers that the mutation removes;
 *  4. sweep: every remaining unit test file, most likely first (files that killed
 *     mutants of the same source file, then lexical rank, then files that killed
 *     any mutant in this run, then the fastest), in small batches. A batch that
 *     kills the mutant ends the pass, so the rest of the suite is not run.
 * Candidate keys are "unit:<file>", "isolation:<file>", "evals:modern" and
 * "evals:legacy". Isolation files are offered only to mutants that declare the
 * isolation suite.
 */
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export const EVAL_ERAS = Object.freeze(['evals:modern', 'evals:legacy']);
export const TARGET_LIMITS = Object.freeze({
  strongFiles: 12, // strong evidence is run in full, up to this many files
  learnedFiles: 4, learnedBudgetMs: 30_000, // the first learned file always runs
  lexicalFiles: 6, lexicalBudgetMs: 20_000, lexicalMaxFileMs: 20_000, lexicalTopMaxFileMs: 60_000, // the top-ranked file may be slower
  sweepBatchFiles: 12, sweepBatchMs: 45_000, // single-process time; about 15 s at three files at once
  fileOverheadMs: 700, unknownFileMs: 2_000,
  minFragment: 12,
});

/** Node's TAP reporter escapes a backslash and '#' in test names; undo exactly that. */
export function tapUnescape(name) {
  return String(name).replace(/\\([\\#])/g, '$1');
}

/** One comparable form for names from TAP output, the index and registry comments. */
export function canonicalTestName(name) {
  return tapUnescape(name).replace(/\s+/g, ' ').trim();
}

const IDENTIFIER = /[A-Za-z0-9_$]/;

/** True when `word` occurs in `text` without an adjoining character of the given class. */
export function mentions(text, word, wordChar = IDENTIFIER) {
  if (!word) return false;
  for (let from = 0; ;) {
    const at = text.indexOf(word, from);
    if (at < 0) return false;
    const before = text[at - 1], after = text[at + word.length];
    if ((before === undefined || !wordChar.test(before)) && (after === undefined || !wordChar.test(after))) return true;
    from = at + 1;
  }
}

/**
 * Parse the index reporter's JSON lines. `relativeFile` maps the absolute file a test
 * was declared in to a checkout-relative path (or undefined when it is outside).
 */
export function parseIndexLines(text, relativeFile) {
  const entries = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row.file !== 'string' || typeof row.name !== 'string') continue;
    const file = relativeFile(row.file);
    if (file) entries.push({ file, name: row.name, nesting: Number(row.nesting) || 0, durationMs: Number(row.durationMs) || 0 });
  }
  return entries;
}

/**
 * Build the name index. Only tests declared in one of the suite's own test files are
 * indexed: isolation case tests are declared in a shared helper, so they are never
 * targeted by name and the full path keeps running them.
 */
export function buildTestIndex(suiteEntries, suiteFiles) {
  const byName = new Map(), durationMs = new Map(), names = [];
  for (const [suite, entries] of Object.entries(suiteEntries ?? {})) {
    const files = new Set(suiteFiles?.[suite] ?? []);
    for (const entry of entries ?? []) {
      if (!entry || typeof entry.name !== 'string' || !files.has(entry.file)) continue;
      const key = `${suite}:${entry.file}`, name = canonicalTestName(entry.name);
      if (!name) continue;
      if (!byName.has(name)) { byName.set(name, new Set()); names.push(name); }
      byName.get(name).add(key);
      const own = entry.nesting === 0 ? Math.max(0, Number(entry.durationMs) || 0) : 0;
      durationMs.set(key, (durationMs.get(key) ?? 0) + own);
    }
  }
  return { byName, durationMs, names };
}

/** Map each registry id to the comment lines directly above its M(...) or C(...) entry. */
export function registryComments(source) {
  const comments = new Map();
  let pending = [];
  for (const line of String(source).split('\n')) {
    const text = line.trim();
    if (text.startsWith('//')) { pending.push(text.replace(/^\/\/\s?/, '')); continue; }
    const entry = /^(?:M|C)\(\s*(['"])(.+?)\1/.exec(text);
    if (entry) { comments.set(entry[2], pending.join(' ')); pending = []; }
    else if (text) pending = [];
  }
  return comments;
}

/** The test names a registry comment gives after "Killing test:" or "Killing tests:". */
export function killingTestFragments(comment) {
  const text = String(comment ?? '');
  const start = text.search(/Killing tests?:/i);
  if (start < 0) return [];
  return text.slice(start).split(/\s*Killing tests?:\s*|;\s+/i)
    .map(fragment => fragment.trim().replace(/\.$/, '').trim()).filter(Boolean);
}

/** Test file basenames a registry comment names, such as counting.test.ts. */
export function commentTestFiles(comment) {
  return [...new Set([...String(comment ?? '').matchAll(/([\w.-]+\.test\.ts)\b/g)].map(match => match[1]))];
}

const STOP_WORDS = new Set(('const let var return this true false null undefined await async function typeof instanceof '
  + 'new delete void else break continue throw case default switch while for from import export class extends super '
  + 'length push pop shift unshift map filter some every find includes join split slice keys values entries has get set add '
  + 'String Number Object Array Boolean Error Set Map Math JSON Promise Symbol').split(' '));

/** Identifiers the mutation removes or changes; all identifiers of the anchor when it removes none. */
export function distinctiveTokens(edits) {
  const found = new Set(), kept = new Set();
  for (const edit of edits ?? []) {
    for (const token of String(edit.find).match(/[A-Za-z_$][\w$]{3,}/g) ?? []) found.add(token);
    for (const token of String(edit.replace).match(/[A-Za-z_$][\w$]{3,}/g) ?? []) kept.add(token);
  }
  const usable = [...found].filter(token => !STOP_WORDS.has(token));
  const changed = usable.filter(token => !kept.has(token));
  return changed.length ? changed : usable;
}

/** Previous shard reports as hints: the reproduced failing names of every killed mutant. Never throws. */
export async function readHintReports(dir) {
  const hints = new Map(), errors = [];
  let files = [];
  try {
    files = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  } catch {
    return { hints, files, errors: [`cannot read hint directory ${dir}`] };
  }
  for (const file of files) {
    let report;
    try { report = JSON.parse(await readFile(join(dir, file), 'utf8')); } catch { errors.push(`hint report ${file}: not valid JSON`); continue; }
    for (const result of Array.isArray(report?.results) ? report.results : []) {
      if (result?.verdict !== 'killed' || typeof result.id !== 'string' || !Array.isArray(result.failingTests)) continue;
      const names = result.failingTests.filter(name => typeof name === 'string' && name.trim());
      if (names.length) hints.set(result.id, names);
    }
  }
  return { hints, files, errors };
}

/**
 * Create the candidate planner for one gate run.
 *  index: buildTestIndex() output; comments: registryComments() output;
 *  hints: Map id -> failing names; sources: Map key -> test file text;
 *  edits(mutant) and declaredSuites(mutant) are the gate's mutationEdits and mutationSuites.
 */
export function createTargeting({ index, comments = new Map(), hints = new Map(), sources = new Map(), edits, declaredSuites, limits = TARGET_LIMITS }) {
  const editedFiles = mutant => [...new Set(edits(mutant).map(edit => edit.file))];
  const learned = new Map(), learnedAnywhere = new Map();
  const sourceKeys = [...sources.keys()];
  const documentFrequency = new Map();

  const estimate = key => (index.durationMs.get(key) ?? limits.unknownFileMs) + limits.fileOverheadMs;

  /** Exact names, as TAP reports them. An isolation: prefix selects the isolation suite. */
  const resolveExact = (names, anySuite = false) => {
    const keys = [];
    for (const raw of names ?? []) {
      if (typeof raw !== 'string') continue;
      if (EVAL_ERAS.includes(raw)) { keys.push(raw); continue; }
      const isolation = raw.startsWith('isolation:');
      const name = canonicalTestName(isolation ? raw.slice('isolation:'.length) : raw);
      for (const key of index.byName.get(name) ?? []) {
        if (anySuite || key.startsWith(isolation ? 'isolation:' : 'unit:')) keys.push(key);
      }
    }
    return keys;
  };

  /** Comment names may be abbreviated or joined; match whole names inside them and them inside names. */
  const resolveComment = fragments => {
    const keys = resolveExact(fragments, true);
    for (const fragment of fragments.map(canonicalTestName).filter(text => text.length >= limits.minFragment)) {
      for (const name of index.names) {
        if (name.includes(fragment) || (name.length >= limits.minFragment && fragment.includes(name))) keys.push(...index.byName.get(name));
      }
    }
    return keys;
  };

  // Test files may name the mutants they kill in a `// kills: id, id` comment.
  const annotations = new Map();
  const annotatedKills = text => {
    if (!annotations.has(text)) {
      annotations.set(text, new Set([...text.matchAll(/\/\/\s*kills?:\s*([^\n]+)/gi)].flatMap(match => match[1].split(/[\s,]+/)).filter(Boolean)));
    }
    return annotations.get(text);
  };

  const frequency = token => {
    if (!documentFrequency.has(token)) documentFrequency.set(token, sourceKeys.filter(key => mentions(sources.get(key), token)).length);
    return documentFrequency.get(token);
  };

  /** [key, score] pairs, best first. */
  const lexicalRanking = (mutant, allowed) => {
    const keys = sourceKeys.filter(allowed);
    const total = sourceKeys.length;
    const weights = distinctiveTokens(edits(mutant)).map(token => [token, frequency(token)])
      .filter(([, df]) => df > 0 && df < total).map(([token, df]) => [token, Math.log((total + 1) / (df + 1))]);
    if (!weights.length) return [];
    const scored = keys.map(key => [key, weights.reduce((sum, [token, weight]) => sum + (mentions(sources.get(key), token) ? weight : 0), 0)])
      .filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1] || estimate(a[0]) - estimate(b[0]) || a[0].localeCompare(b[0]));
    return scored;
  };

  const group = (label, keys) => ({
    label,
    unit: keys.filter(key => key.startsWith('unit:')).map(key => key.slice('unit:'.length)),
    isolation: keys.filter(key => key.startsWith('isolation:')).map(key => key.slice('isolation:'.length)),
    evals: EVAL_ERAS.filter(era => keys.includes(era)),
  });

  function plan(mutant) {
    const isolation = declaredSuites(mutant).includes('isolation');
    const allowed = key => key.startsWith('unit:') || EVAL_ERAS.includes(key) || (isolation && key.startsWith('isolation:'));
    const comment = comments.get(mutant.id) ?? '';
    const used = new Set();
    const take = keys => [...new Set(keys)].filter(key => allowed(key) && !used.has(key));

    const strongKeys = take([
      ...resolveExact(hints.get(mutant.id)),
      ...resolveComment(killingTestFragments(comment)),
      ...commentTestFiles(comment).flatMap(file => sourceKeys.filter(key => basename(key) === file)),
      ...sourceKeys.filter(key => annotatedKills(sources.get(key)).has(mutant.id)),
    ]);
    const strong = [...strongKeys.filter(key => EVAL_ERAS.includes(key)), ...strongKeys.filter(key => !EVAL_ERAS.includes(key)).slice(0, limits.strongFiles)];
    strong.forEach(key => used.add(key));

    const files = editedFiles(mutant);
    const counts = new Map();
    for (const file of files) for (const [key, count] of learned.get(file) ?? []) counts.set(key, (counts.get(key) ?? 0) + count);
    const learnedKeys = take([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key));
    const learnedTier = [];
    let budget = 0;
    for (const key of learnedKeys) {
      if (EVAL_ERAS.includes(key)) { learnedTier.push(key); continue; }
      const cost = estimate(key);
      const testFiles = learnedTier.filter(entry => !EVAL_ERAS.includes(entry)).length;
      if (testFiles > 0 && (testFiles >= limits.learnedFiles || budget + cost > limits.learnedBudgetMs)) continue;
      learnedTier.push(key);
      budget += cost;
    }
    learnedTier.forEach(key => used.add(key));

    const lexicalTier = take(files.some(file => file.startsWith('packages/evals/')) ? [...EVAL_ERAS] : []);
    const scored = lexicalRanking(mutant, allowed);
    const ranking = scored.map(([key]) => key);
    const best = scored[0]?.[1] ?? 0;
    budget = 0;
    for (const [rank, key] of take(scored.filter(([, score]) => score >= 0.3 * best).map(([key]) => key)).entries()) {
      const cost = estimate(key);
      if (lexicalTier.filter(entry => !EVAL_ERAS.includes(entry)).length >= limits.lexicalFiles) break;
      const allowedCost = rank === 0 ? limits.lexicalTopMaxFileMs : limits.lexicalMaxFileMs;
      if (cost > allowedCost || (rank > 0 && budget + cost > limits.lexicalBudgetMs)) continue;
      lexicalTier.push(key);
      budget += cost;
    }
    lexicalTier.forEach(key => used.add(key));

    // The sweep: every unit file not tried yet, most likely first, in batches.
    const anywhere = key => learnedAnywhere.get(key) ?? 0;
    const remaining = take(sourceKeys.filter(key => key.startsWith('unit:')));
    const order = new Map([...new Set([...learnedKeys, ...ranking])].filter(key => remaining.includes(key)).map((key, index) => [key, index]));
    remaining.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || anywhere(b) - anywhere(a) || estimate(a) - estimate(b) || a.localeCompare(b));
    const sweep = [];
    for (const key of remaining) {
      const batch = sweep.at(-1);
      const cost = estimate(key);
      if (batch && batch.keys.length < limits.sweepBatchFiles && batch.ms + cost <= limits.sweepBatchMs) { batch.keys.push(key); batch.ms += cost; }
      else sweep.push({ keys: [key], ms: cost });
    }

    return {
      tiers: [group('strong', strong), group('learned', learnedTier), group('lexical', lexicalTier), ...sweep.map(batch => group('sweep', batch.keys))]
        .filter(tier => tier.unit.length || tier.isolation.length || tier.evals.length),
    };
  }

  /** The candidate files that declare every failing name, or undefined when one is not indexed. */
  function declaringFiles(suite, names, files) {
    const declared = new Set();
    for (const raw of names) {
      const name = canonicalTestName(suite === 'isolation' && raw.startsWith('isolation:') ? raw.slice('isolation:'.length) : raw);
      const keys = [...(index.byName.get(name) ?? [])].filter(key => key.startsWith(`${suite}:`)).map(key => key.slice(suite.length + 1)).filter(file => files.includes(file));
      if (!keys.length) return undefined;
      keys.forEach(file => declared.add(file));
    }
    return files.filter(file => declared.has(file));
  }

  /** Record which files and eras killed a mutant, keyed by the source files it edits. */
  function learn(mutant, result) {
    if (result?.status !== 'killed' && result?.verdict !== 'killed') return;
    const keys = [...new Set(resolveExact(result.failingTests))];
    if (!keys.length) return;
    for (const file of editedFiles(mutant)) {
      const counts = learned.get(file) ?? new Map();
      learned.set(file, counts);
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const key of keys) learnedAnywhere.set(key, (learnedAnywhere.get(key) ?? 0) + 1);
  }

  return { plan, learn, learned, declaringFiles, estimate: (suite, file) => estimate(`${suite}:${file}`) };
}
