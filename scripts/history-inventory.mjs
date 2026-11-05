#!/usr/bin/env node
/**
 * Public-history inventory (release hygiene, L3).
 *
 * Read-only. Scans the commits that would become public and the tracked tree
 * for things that need a decision before the repository is made public:
 * personal author/committer emails, absolute user paths, retired project
 * names, large or binary tracked files, local-only material, research notes
 * that record unreproduced third-party security observations, and strings
 * shaped like credentials. It changes nothing and makes no network calls.
 *
 * Usage:
 *   node scripts/history-inventory.mjs [--range <rev-range>] [--out <file.md>]
 * Defaults: range = the full history of HEAD; out = .local/history-inventory.md
 * (gitignored, because the report itself quotes the sensitive findings).
 *
 * Exit code 0 always; the report is advisory input to an owner decision.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const range = opt('--range', 'HEAD');
const out = opt('--out', join(root, '.local', 'history-inventory.md'));

const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// 1. Author and committer identities across the range.
const identities = new Map();
for (const line of git('log', '--format=%an <%ae>%x00%cn <%ce>', range).split('\n').filter(Boolean)) {
  for (const who of line.split('\0')) identities.set(who, (identities.get(who) ?? 0) + 1);
}
const commitCount = Number(git('rev-list', '--count', range).trim());

// 2. Commit subjects mentioning retired names.
const retiredNames = ['fhirship', 'fireship', 'chartweir', 'emberhull', 'cinderkeel', 'lanternkeel'];
const retiredSubjects = git('log', '--format=%h %s', range).split('\n')
  .filter(l => retiredNames.some(n => l.toLowerCase().includes(n)));

// 3. Tracked tree scans (current HEAD tree only; history diffs are summarized separately).
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
const textLike = /\.(ts|mjs|js|json|md|txt|yml|yaml|py|sh|html|svg|tsv|csv|toml)$/i;
const read = path => { try { return git('show', `HEAD:${path}`); } catch { return ''; } };

const absolutePaths = [], secretShaped = [], largeFiles = [], localOnly = [], competitorNotes = [];
const secretPatterns = [
  [/-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/, 'private key block'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'API key (sk-)'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, 'JWT-shaped string'],
];
const competitorMarkers = [/traversal/i, /SSRF/i, /replay/i, /comma-OR/i, /vulnerab/i, /exploit/i];

for (const path of tracked) {
  const size = Number(git('cat-file', '-s', `HEAD:${path}`).trim());
  if (size >= 1_000_000) largeFiles.push({ path, size });
  if (/^(\.local|artifacts|mutation-results)\//.test(path) || /\.log$/.test(path)) localOnly.push(path);
  if (!textLike.test(path)) continue;
  const text = read(path);
  const abs = text.match(/\/Users\/[A-Za-z0-9._-]+\/[^\s'"`)>\]]*/g);
  if (abs) absolutePaths.push({ path, count: abs.length, sample: [...new Set(abs)].slice(0, 3) });
  for (const [re, label] of secretPatterns) {
    const m = text.match(re);
    if (m) secretShaped.push({ path, label, sample: `${m[0].slice(0, 12)}…` });
  }
  if (/^research\//.test(path)) {
    const hits = competitorMarkers.filter(re => re.test(text)).map(re => re.source);
    if (hits.length) competitorNotes.push({ path, hits });
  }
}

// 4. Paths that existed at some point in history but are gone now (may still be in objects).
const historicalPaths = new Set(git('log', '--all', '--name-only', '--format=', range === 'HEAD' ? 'HEAD' : range).split('\n').filter(Boolean));
const trackedSet = new Set(tracked);
const deletedSensitive = [...historicalPaths].filter(p => !trackedSet.has(p) && (/\.(env|pem|key|p12)$/i.test(p) || /secret|token|credential/i.test(p)));

// 5. Refs that would need pruning before publishing the full repository.
const localBranches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
const hiddenRefs = git('for-each-ref', '--format=%(refname)', 'refs/t3', 'refs/stash').split('\n').filter(Boolean);
const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length;

const md = [];
md.push(`# Public-history inventory`, '', `- Range: \`${range}\` (${commitCount} commits); generated ${new Date().toISOString()}; tree at ${git('rev-parse', '--short', 'HEAD').trim()}.`, '',
  '## Identities on commits', '', '| Identity | Commits |', '|---|---|');
for (const [who, n] of [...identities].sort((a, b) => b[1] - a[1])) md.push(`| ${who} | ${n} |`);
md.push('', `Decision: a personal email on every commit is visible in a public full history. Options: keep (it is the owner's choice), or publish a curated export with a rewritten author identity.`, '');
md.push('## Commit subjects with retired names', '', retiredSubjects.length ? retiredSubjects.map(s => `- ${s}`).join('\n') : '- none', '');
md.push('## Tracked files containing absolute user paths', '', absolutePaths.length ? absolutePaths.map(a => `- ${a.path} (${a.count}): ${a.sample.join(', ')}`).join('\n') : '- none', '');
md.push('## Credential-shaped strings in tracked text files', '', secretShaped.length ? secretShaped.map(s => `- ${s.path}: ${s.label} (${s.sample})`).join('\n') : '- none found (pattern scan only; not proof of absence)', '');
md.push('## Research files with third-party security observations', '', competitorNotes.length ? competitorNotes.map(c => `- ${c.path}: ${c.hits.join(', ')}`).join('\n') : '- none', '', 'Decision: the owner has not approved publishing competitor security observations; these files need redaction or exclusion from a public export.', '');
md.push('## Large tracked files (>= 1 MB)', '', largeFiles.length ? largeFiles.map(f => `- ${f.path}: ${(f.size / 1e6).toFixed(1)} MB`).join('\n') : '- none', '');
md.push('## Local-only material that is tracked', '', localOnly.length ? localOnly.map(p => `- ${p}`).join('\n') : '- none', '');
md.push('## Sensitive-looking paths that existed in history and are now deleted', '', deletedSensitive.length ? deletedSensitive.map(p => `- ${p}`).join('\n') : '- none', '');
md.push('## Refs and worktrees', '', `- Local branches: ${localBranches.length}`, `- Hidden refs (refs/t3, refs/stash): ${hiddenRefs.length}`, `- Worktrees: ${worktrees}`, '', 'Decision: a public push publishes only the refs pushed; prune or archive candidate/t3 branches locally before any mirror or full export.', '');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, md.join('\n'));
console.log(`history inventory written to ${out}: ${commitCount} commits, ${identities.size} identities, ${absolutePaths.length} files with absolute paths, ${secretShaped.length} credential-shaped hits, ${competitorNotes.length} research files flagged, ${largeFiles.length} large files`);
