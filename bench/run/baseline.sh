#!/bin/sh
# Scripted development baseline for one dataset: each arm on its own slot, in parallel, pass 1 then pass 2.
# Usage: sh bench/run/baseline.sh <campaign> <dataset> [arms]   (HAPI must already serve <dataset>: bench:infra:up -- --dataset <dataset>)
# arms: space-separated, default "FB W" (DEFAULT_ARMS in servers/arms.ts). FB, FBd and FBt build fireboat from this checkout
# (bench:install -- --arm FB). Slots: FB0 0, W 1, H 2, M 3, FB 4, FBd 5, FBt 6, Ws 7, Wm 6.
# Ws and Wm run against Medplum (synthea-dev only; bench:medplum:up, bench:medplum:load, bench:medplum:clients first). They use
# only the slot's 1824s port, proxy-medplum-s<slot>.jsonl and their own tmp directory, so Wm on slot 6 does not collide with FBt.
set -eu
CAMPAIGN="$1"
DATASET="$2"
export PATH="$(mise where node@24.22.0)/bin:$PATH"
# The repository root: this script is bench/run/baseline.sh inside it.
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# Same locations as bench/lib/paths.ts: BENCH_LOCAL_DIR (default <repo>/.local, git-ignored) and BENCH_RESULTS_DIR
# (default <BENCH_LOCAL_DIR>/bench-results).
abs() { case "$1" in /*) echo "$1";; *) echo "$REPO/$1";; esac; }  # relative values are taken from the repository root
LOCAL="$(abs "${BENCH_LOCAL_DIR:-.local}")"
RESULTS="$(abs "${BENCH_RESULTS_DIR:-$LOCAL/bench-results}")"
export TMPDIR="$LOCAL/tmp/baseline-$DATASET"
mkdir -p "$TMPDIR" "$RESULTS/scripted/$CAMPAIGN"
LOG="$RESULTS/scripted/$CAMPAIGN"
run() { npm --prefix "$REPO/bench" run --silent bench:scripted -- --campaign "$CAMPAIGN" --dataset "$DATASET" "$@"; }

ARMS="${3:-FB W}"
slot_of() { case "$1" in FB0) echo 0;; W) echo 1;; H) echo 2;; M) echo 3;; FB) echo 4;; FBd) echo 5;; FBt) echo 6;; Ws) echo 7;; Wm) echo 6;; *) echo "unknown arm $1" >&2; exit 2;; esac; }
for A in $ARMS; do case "$A" in Ws|Wm) [ "$DATASET" = synthea-dev ] || { echo "$A runs against Medplum, which holds synthea-dev only" >&2; exit 2; };; esac; done
log_of() { case "$1" in Ws|Wm) echo "$LOG/log-$DATASET-medplum-s$2.txt";; *) echo "$LOG/log-$DATASET-s$2.txt";; esac; }
for A in $ARMS; do
  S=$(slot_of "$A")
  ( for p in 1 2; do run --arm "$A" --cell default --set all --pass $p --slot "$S"; done
    case "$A" in FB0|FB|FBd|FBt|W) for p in 1 2; do run --arm "$A" --cell best_effort --set questions --pass $p --slot "$S"; done;; esac
  ) > "$(log_of "$A" "$S")" 2>&1 &
done
wait
rm -rf "$TMPDIR"
echo "baseline $CAMPAIGN $DATASET finished"
