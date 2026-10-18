#!/usr/bin/env bash
# Demo sequence for the 2-3 minute screen recording. Narration, timings and the
# fallback path are in docs/demo-script.md; run this from anywhere in the repo.
#
#   scripts/demo.sh             wait for Enter after each step (narrate, then press)
#   DEMO_PAUSE=6 scripts/demo.sh  sleep 6s after each step instead (rehearsal)
#   DEMO_TIME=1 scripts/demo.sh   print each command's wall-clock time (re-measuring)
#
# Needs the repo-brain-db container up with fastify/fastify and vitejs/vite ingested.
# Every number fix prints after "projected" is a projection, never a measurement.

set -euo pipefail
cd "$(dirname "$0")/.."

PAUSE="${DEMO_PAUSE:-}"
TIMEFORMAT=$'\e[2m  (%3Rs)\e[0m'

pause() {
  if [[ -n "$PAUSE" ]]; then sleep "$PAUSE"; else read -r -s -p $'\e[2m  ⏎\e[0m' _; echo; fi
}

# step "title" "command" : print the title and the command exactly as it runs, run it.
step() {
  clear || true
  printf '\e[1;36m# %s\e[0m\n' "$1"
  printf '\e[1m$ %s\e[0m\n\n' "$2"
  if [[ -n "${DEMO_TIME:-}" ]]; then time eval "$2"; else eval "$2"; fi
  echo
  pause
}

# Needs the container: every step fails otherwise. The CLI now names the container in
# that error rather than printing a bare "error:" (see connectionErrorMessage).
#
# Warm tsx's compile cache so step 1 is as fast as the rest (first run ~0.3s slower).
npm run -s brain -- --help >/dev/null

# 1. Where knowledge is concentrated. Other tools can do this part.
step "Who is the only person who knows each file?" \
  'npm run -s brain -- --repo fastify/fastify risk --limit 10'

# 2. The graph carries co-change: what else moves when you touch a file.
step "What else changes when you touch fastify.js?" \
  'npm run -s brain -- --repo fastify/fastify impact fastify.js --limit 10'

# 3. The headline: the minimal set of review assignments, on one module that fits a screen.
step "fix: the fewest reviews that de-risk .github/workflows" \
  'npm run -s brain -- --repo fastify/fastify fix --module .github/workflows --ceiling'

# 4. The min cut said bandwidth is what binds; raise every reviewer's budget to 3 and the last file clears.
step "The cut said: budget. Raise it to 3." \
  'npm run -s brain -- --repo fastify/fastify fix --module .github/workflows --budget 3'

# 5. Whole repo, and a contrast: vite has BOTH bottlenecks, bandwidth and nobody-eligible.
step "vite: two different answers from one cut" \
  'npm run -s brain -- --repo vitejs/vite fix --ceiling | head -n 11'

# 6. review appears as its MEASURED backtest, not a single PR: the demo graph has no PR nodes.
# backtest builds its own throwaway graph from cached PRs and a fixed seed (fastify, 30 held out:
# review 13%/30%, most-active 17%/43%, random 7%/13%); it leaves repo:fastify-fastify untouched.
step "Is review any good? Measured on 30 held-out PRs" \
  'npm run -s brain -- --repo fastify/fastify backtest .cache/repos/fastify/fastify --holdout 30 --pr-limit 300'

# 7. The same fix answer, asked by an agent over the MCP server. The jq filters only make the
# reply legible; the numbers must match step 3 (10 before, projected 1, 9 reviews).
# read, not $(cat <<EOF): bash 3.2 drops the backslash-newlines inside $( ).
read -r -d '' MCP_FIX <<'EOF' || true
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"repo_fix","arguments":{"repo":"fastify/fastify","module":".github/workflows"}}}' \
  | npm run mcp --silent | tail -n 1 | jq -r '.result.content[0].text' \
  | jq -c '{atRiskBefore, atRiskAfter, atRiskAfterIsProjection, bottleneck, bottleneckReviewers, unserved, reviews: ([.assignments[].files[]] | length)}'
EOF
step "An agent asks the same question over MCP" "$MCP_FIX"

# 8. FalkorDB Browser (manual): open http://localhost:3100, graph repo:fastify-fastify, run:
#   MATCH (p:Person)-[t:TOUCHED]->(f:File {module: '.github/workflows'})
#   WHERE t.doa > 0.2 AND f.alive RETURN p, t, f
clear || true
printf '\e[1;36m# Now: FalkorDB Browser at http://localhost:3100 (query in this script, step 8)\e[0m\n'
