#!/usr/bin/env bash
# Run before recording so the first take of scripts/demo.sh is usable. Exits non-zero
# with the reason on the first check that fails; prints the on-camera numbers last.
#
#   scripts/preflight.sh
#
# The backtest's first run after `docker start` costs ~16 s; every run after it ~1.2 s.
# This script pays that cost here, then proves the next run is fast.

set -euo pipefail
cd "$(dirname "$0")/.."

FASTIFY_CLONE=.cache/repos/fastify/fastify
PR_CACHE=.cache/github/fastify-fastify
BACKTEST=(npm run -s brain -- --repo fastify/fastify backtest "$FASTIFY_CLONE" --holdout 30 --pr-limit 300)
MAX_WARM_S=3

ok() { printf '\e[32mok\e[0m    %s\n' "$1"; }
fail() {
  printf '\e[1;31mFAIL\e[0m  %s\n' "$1" >&2
  [[ -n "${2:-}" ]] && printf '%s\n' "$2" | sed 's/^/      /' >&2
  exit 1
}

# timed <logfile> <command...> : run it with stdout discarded and stderr to logfile; print seconds.
timed() {
  local log="$1" t
  shift
  TIMEFORMAT=%R
  t=$( { time "$@" >/dev/null 2>"$log"; } 2>&1 ) || return 1
  echo "$t"
}

log=$(mktemp)
trap 'rm -f "$log"' EXIT

# 0. demo.sh's MCP step pipes through jq.
command -v jq >/dev/null || fail "jq not found; step 7 (MCP) pipes its reply through it"
ok "jq present"

# 1. Container reachable. The CLI names repo-brain-db in a connection failure.
npm run -s brain -- --repo fastify/fastify risk --limit 1 >/dev/null 2>"$log" ||
  fail "cannot run risk on fastify" "$(cat "$log")"
ok "FalkorDB reachable"

# 2. Both demo graphs present (the CLI refuses a missing graph) and non-empty.
for repo in fastify/fastify vitejs/vite; do
  active=$(npm run -s brain -- --repo "$repo" risk --json 2>"$log" | jq '[.segments[].active] | add // 0') ||
    fail "graph for $repo is missing or unreadable" "$(cat "$log")"
  [[ "$active" -gt 0 ]] || fail "graph for $repo has no active files; re-ingest it"
  ok "graph $repo: $active active files"
done

# 3. The backtest's inputs: the clone, and the cached GitHub PR pages.
[[ -d "$FASTIFY_CLONE/.git" ]] || fail "no fastify clone at $FASTIFY_CLONE (clones are one level deeper than they look)"
ok "fastify clone at $FASTIFY_CLONE"
[[ -f "$PR_CACHE/prs-first.json" ]] || fail "no cached PR pages under $PR_CACHE; step 6 would call the GitHub API mid-take"
ok "PR cache present ($(ls "$PR_CACHE" | wc -l | tr -d ' ') files)"

# 4. Warm the backtest, then prove the next run is fast and never touches the API.
t=$(timed "$log" "${BACKTEST[@]}") || fail "backtest warm-up failed" "$(cat "$log")"
if grep -q 'fetching' "$log"; then
  ok "backtest warm-up: ${t}s (cache was incomplete; filled from the GitHub API now)"
else
  ok "backtest warm-up: ${t}s"
fi
t=$(timed "$log" "${BACKTEST[@]}") || fail "backtest second run failed" "$(cat "$log")"
grep -q 'fetching' "$log" && fail "backtest second run still fetched from GitHub; step 6 would stall" "$(grep fetching "$log")"
awk -v t="$t" -v max="$MAX_WARM_S" 'BEGIN { exit !(t < max) }' ||
  fail "backtest second run took ${t}s (want < ${MAX_WARM_S}s): step 6 will stall the take"
ok "backtest second run: ${t}s"

# 5. What the take should show. Compare against the screen before narrating.
cat <<'EOF'

Expected on camera (checked against a live run 2026-10-18):
  step 3  fix .github/workflows   at risk 10, projected 1, bottleneck bandwidth, 9 reviews for 5 reviewers
  step 4  fix --budget 3          projected 0, bottleneck none, 10 reviews for 4 reviewers
  step 5  fix vite                at risk 189, have a reviewer 179, projected 106, with no shortlist 44
  step 6  backtest                review 13% 30%, most-active 17% 43%, random 7% 13%
  step 7  MCP repo_fix            atRiskBefore 10, atRiskAfter 1, reviews 9
Every "projected" number is a projection, never a measurement. The backtest is measured.
EOF
