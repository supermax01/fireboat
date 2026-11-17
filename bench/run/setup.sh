#!/bin/sh
# Rebuilds the scripted development baseline from scratch, in order, stopping at the first failure:
#   toolchain (mise install) -> root npm ci -> bench typecheck and tests -> install arms (hashed locks) -> per dataset:
#   infra up (colima 4 CPU / 8 GiB) -> verify input checksums and convert -> load (repeated while it exits 3) ->
#   questions -> gold -> arms-check -> baseline (arms FB and W) ; then score and report.
# Usage: sh bench/run/setup.sh <campaign> [dataset ...]      (default datasets: mimic synthea-dev)
# Env: LOAD_FORCE=1 starts each load over (needed after the converted files change); SKIP_INSTALL=1 keeps installed arms.
# Writes manifests/setup-<campaign>.json (argv, toolchain, every step with exit status and seconds) and setup-<campaign>.log.
# Data acquisition is not scripted: the MIMIC demo and the 99 Synthea bundles must already be under DATA_ROOT
# (lib/paths.ts); bench:convert verifies every file against SHA256SUMS.txt and the sums files against their pinned digests.
set -eu
CAMPAIGN="$1"; shift
DATASETS="${*:-mimic synthea-dev}"
# The repository root: this script is bench/run/setup.sh inside it.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# Same locations as bench/lib/paths.ts: BENCH_LOCAL_DIR (default <repo>/.local, git-ignored) and BENCH_RESULTS_DIR
# (default <BENCH_LOCAL_DIR>/bench-results). BENCH_DATA_DIR is read by the TypeScript steps only.
abs() { case "$1" in /*) echo "$1";; *) echo "$REPO/$1";; esac; }  # relative values are taken from the repository root
LOCAL="$(abs "${BENCH_LOCAL_DIR:-.local}")"
RESULTS="$(abs "${BENCH_RESULTS_DIR:-$LOCAL/bench-results}")"
MANIFEST="$RESULTS/manifests/setup-$CAMPAIGN.json"
LOGFILE="$RESULTS/manifests/setup-$CAMPAIGN.log"
STEPS="$LOCAL/tmp/setup-$CAMPAIGN.steps.tsv"
mkdir -p "$RESULTS/manifests" "$LOCAL/tmp"
: > "$STEPS"
: > "$LOGFILE"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mise install node@24.22.0 python@3.12.16 python@3.13.18 uv@0.13.7 >> "$LOGFILE" 2>&1
NODE_DIR="$(mise where node@24.22.0)"
export PATH="$NODE_DIR/bin:$PATH"
export TMPDIR="$LOCAL/tmp/setup-$CAMPAIGN"
mkdir -p "$TMPDIR"

write_manifest() {
  status="$1"
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    const [stepsPath, out, campaign, started, status, log, ...argv] = process.argv.slice(1);
    const steps = readFileSync(stepsPath, "utf8").split("\n").filter(Boolean).map(l => { const [exit, seconds, ...cmd] = l.split("\t"); return { cmd: cmd.join(" "), exit: Number(exit), seconds: Number(seconds) }; });
    writeFileSync(out, JSON.stringify({ schema: "fbbench.manifest.setup/1", campaign, argv, started_at: started, finished_at: new Date().toISOString(), status, log, steps }, null, 2) + "\n");
  ' "$STEPS" "$MANIFEST" "$CAMPAIGN" "$STARTED" "$status" "$LOGFILE" "$0" "$CAMPAIGN" $DATASETS
}

# step <command...>: runs it, logs output, records exit status and duration; stops the driver on failure.
step() {
  t0=$(date +%s)
  echo "== $*" >> "$LOGFILE"
  set +e; "$@" >> "$LOGFILE" 2>&1; code=$?; set -e
  printf '%s\t%s\t%s\n' "$code" "$(( $(date +%s) - t0 ))" "$*" >> "$STEPS"
  if [ "$code" -ne 0 ]; then
    echo "setup: step failed (exit $code): $*  (log: $LOGFILE)" >&2
    write_manifest failed
    exit "$code"
  fi
}

bench() { npm --prefix "$REPO/bench" run --silent "$@"; }

# bench:load exits 3 when its time budget is spent; run it again until it finishes (0) or fails (1).
load_until_done() {
  d="$1"; force=""
  [ "${LOAD_FORCE:-0}" = 1 ] && force="--force"
  while :; do
    set +e; bench bench:load -- --dataset "$d" $force; code=$?; set -e
    force=""
    [ "$code" -eq 3 ] || return "$code"
  done
}

step node --version
step bench bench:toolchain
step sh -c "cd '$REPO' && { [ -d node_modules ] || npm ci --prefer-offline --no-audit --no-fund; }"
step bench typecheck
step bench test
[ "${SKIP_INSTALL:-0}" = 1 ] || step bench bench:install -- --arm FB,W  # DEFAULT_ARMS in servers/arms.ts; baseline.sh runs the same arms
for d in $DATASETS; do
  step bench bench:infra:up -- --dataset "$d" --force
  step bench bench:convert -- --dataset "$d"
  step load_until_done "$d"
  step bench bench:questions -- --dataset "$d" --force
  step bench bench:gold -- --dataset "$d" --force
  step bench bench:arms-check -- --dataset "$d"
  step sh "$REPO/bench/run/baseline.sh" "$CAMPAIGN" "$d"
done
step bench bench:score -- --campaign "$CAMPAIGN"
step bench bench:scripted-report -- --campaign "$CAMPAIGN"
write_manifest ok
rm -rf "$TMPDIR"
echo "setup $CAMPAIGN finished; manifest $MANIFEST"
