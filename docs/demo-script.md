# Demo script

The video is 2–3 minutes long. `scripts/demo.sh` runs the commands in order and waits
for Enter after each one, so you narrate while the output is on screen. The headline
is `fix`. Everything before it is setup, and everything after it is evidence.

**The point the video has to make:** `fix` does more than rank reviewers. It computes
the **minimal set of review assignments** that reduces bus-factor risk, and the min
cut proves that no assignment within the same review budgets covers more files.

**What the narration must never say:** that `fix` *measured* an improvement. Its
"projected at risk" number is `atRiskBefore − maxFlow`, the result *if* every
prescribed review happens (spec §16 F3). Say "projected", and say it under the
stated defaults: budget 2, θ 0.2, top 5 candidates. `--ceiling` is on screen, so the
cost of the shortlist is visible too.

## Before recording

- The `repo-brain-db` container must be up, with fastify/fastify and vitejs/vite
  ingested.
- Run `DEMO_PAUSE=0 scripts/demo.sh` once as a rehearsal. It checks every step and
  warms tsx's compile cache.
- Use a terminal at least 110 columns wide. The `fix` header line is about 140
  characters and wraps on narrower terminals, which is legible but untidy.
- Open the FalkorDB Browser at http://localhost:3100 in a second window, on graph
  `repo:fastify-fastify`.
- Real contributor logins appear on screen, which is intended (spec §9). Don't paste
  terminal output into committed docs (CLAUDE.md, "Before making the repo public").
  This file quotes counts only for that reason.

## Measured timings

Wall-clock time per command, measured 2026-10-17 on the shared container with
`DEMO_TIME=1 DEMO_PAUSE=0 scripts/demo.sh`, over two consecutive runs:

| step | command | time |
|---|---|---|
| 1 | `risk --limit 10` (fastify) | 0.56–0.61 s |
| 2 | `impact fastify.js --limit 10` (fastify) | 0.53–0.56 s |
| 3 | `fix --module .github/workflows --ceiling` (fastify) | 0.57–0.60 s |
| 4 | `fix --module .github/workflows --budget 3` (fastify) | 0.54–0.58 s |
| 5 | `fix --ceiling \| head -n 12` (fastify, whole repo) | 0.59–0.61 s |
| 6 | `fix --ceiling \| head -n 11` (vite, whole repo) | 0.75–0.78 s |
| 9 | `repo_fix` over MCP, piped through `jq` (fastify, `.github/workflows`) | 0.53–0.74 s |

No step stalls the video. Every step finishes in under 0.8 s, and most of that is
Node and tsx startup. Without the warm-up, the first command of a session takes
about 0.3 s longer (risk took 0.86 s cold), so `demo.sh` warms up before step 1.

**Avoid pnpm/pnpm on camera.** `fix --ceiling` there took **5.59 s** in a single run
today (spec §16 measured 5.3 s), and its output runs to thousands of lines. If a
step ever needs a bigger repo than fastify, use vite, which takes under 0.8 s.

## Steps and narration

Allow about 3:15 in total with `review`, `backtest` and the MCP step, or about 2:35
without `review` and `backtest` (see [Fallback](#fallback-if-review-or-backtest-is-not-ready)).
That is over the 3-minute target. The MCP step (step 9) adds 15 s, and nothing else
was trimmed to make room for it. Commands take under 1 s each, so the narration sets
the length.

### 0:00 — 1. `risk` (about 25 s)

> "This is fastify, a real repo with real contributors. Repo Brain read two years of
> its git history into a FalkorDB graph: who touched which file, and how much of
> each file they wrote. 32 files have one person who holds more than half of the
> knowledge. That's a bus factor of one."

What to notice: the by-kind table. One person holds **10 of the 11** at-risk CI
files. Point at the `others-last` column, where several files show `never`. Say
plainly that other tools do this part (CodeScene, Degree-of-Knowledge). That is
honest, and it sets up the contrast with `fix`.

### 0:25 — 2. `impact fastify.js` (about 20 s)

> "The graph also knows what moves together. Touch fastify.js and these files change
> with it, including two docs pages a human reviewer would forget."

What to notice: `docs/Reference/Warnings.md` and `docs/Reference/Errors.md` appear
next to the source files. Co-change is an edge in the graph, not a guess. Keep this
step short, because it is context and not the headline.

### 0:45 — 3. `fix --module .github/workflows --ceiling` (about 45 s) — THE HEADLINE

> "Ranking reviewers isn't enough, so here's what nothing else does. Ten CI
> workflows are at risk. `fix` builds a flow network from at-risk files through
> qualified reviewers to a review budget of two per person, and runs FalkorDB's
> max-flow on it. The answer is nine reviews for five people. If they happen, the
> projection is that only one file stays at risk."

Then the part that has to land:

> "Why not ten? The min cut answers that. It is the certificate that no assignment
> within these budgets covers more than nine files. Each review de-risks one file,
> so nine is also the fewest reviews that reach that number. The cut names the
> four people whose budget binds. The last file, lock-threads.yml, can only be
> reviewed by those four, and they are full."

What to notice: `projected at risk 1` with the words "a projection, not a
measurement" printed beside it; read that line aloud. `with no shortlist 1 … costs
0` shows that shortlisting to the top 5 cost nothing here. Also `bottleneck
bandwidth`, the four named reviewers, and `9 reviews for 5 reviewers (the minimum
that achieves the projection)`.

### 1:30 — 4. `fix … --budget 3` (about 15 s)

> "The cut said bandwidth is the limit, not expertise. So give every reviewer one
> more slot. Ten reviews, four people, and the projection is zero files at risk."

What to notice: `projected at risk 0`, `bottleneck none`. The cut's diagnosis was
actionable, and acting on it closed the gap. This is still a projection.

### 1:45 — 5. `fix --ceiling` on all of fastify (about 15 s)

> "Across the whole repo: 32 files at risk, every one has a qualified reviewer, and
> 31 reviews for 19 people bring the projection down to one."

What to notice: the summary only. `head -n 12` cuts the 31-review list, so say that.

### 2:00 — 6. `fix --ceiling` on vite (about 20 s)

> "On vite, the same cut gives two different answers. 96 files are waiting on
> reviewer bandwidth, which is a scheduling problem. 10 files have nobody who clears
> the expertise floor, which is a hiring and onboarding problem."

What to notice: the two "left because" lines. Also `top 5 costs 62`: on vite the
shortlist costs 62 files of projected coverage, and `--ceiling` prints that cost
rather than hiding it. Give the numbers with their N (top 5) and budget (2).

### 2:20 — 7. `review <prNumber>` (slot, about 10 s)

Not built yet. `demo.sh` prints a SLOT marker. When it works, fill in the command in
`demo.sh` step 7 and narrate who the tool suggests for a real merged PR. `review` is
the baseline being measured, not the contribution.

### 2:30 — 8. `backtest` (slot, about 15 s)

Not built yet. When it works, show the **measured** hit-rate@1/@3 against both
baselines (spec §12 D1). Say honestly that the trivial most-active baseline already
covers most PRs (CLAUDE.md), which is why the headline is `fix` and not review
precision. Quote only numbers the backtest printed.

### 2:45 — 9. The same `fix`, asked by an agent over MCP (about 15 s)

This is the only on-camera evidence for the agent track, so keep it in. Step 9 was
timed at 0.53–0.74 s (step 9 row in the timings table):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"repo_fix","arguments":{"repo":"fastify/fastify","module":".github/workflows"}}}' \
  | npm run mcp --silent | tail -n 1 | jq -r '.result.content[0].text' \
  | jq -c '{atRiskBefore, atRiskAfter, atRiskAfterIsProjection, bottleneck, bottleneckReviewers, unserved, reviews: ([.assignments[].files[]] | length)}'
```

The two `jq` filters only make the reply legible on screen. Without them the reply
is about 2 KB of escaped JSON. The server itself needs no `jq`.

> "An agent gets the same answer. This is the MCP server, which exposes the four
> commands as tools. An agent calls `repo_fix` and gets the same nine reviews,
> the same four bottleneck reviewers, and the same one file left over. The JSON
> carries its own warning, `atRiskAfterIsProjection: true`, because an agent never
> sees the CLI's printed caveat."

What to notice: the numbers match step 3 exactly (10 before, projected 1, 9
reviews), and the `atRiskAfterIsProjection: true` flag. Every MCP tool takes a
required `repo`, so an agent cannot get the unquotable fallback identities.

### 3:00 — 10. FalkorDB Browser (about 15 s)

Switch to the Browser window and run:

```cypher
MATCH (p:Person)-[t:TOUCHED]->(f:File {module: '.github/workflows'})
WHERE t.doa > 0.2 AND f.alive RETURN p, t, f
```

That draws 5 people, 20 files and 32 edges, a picture you can read at a glance. One
person holds 19 of the 32 edges and the other four hold 7, 4, 1 and 1 (counted
2026-10-17). That is the graph behind steps 3 and 9.
Close on the prior-art credit (CodeScene, Fritz et al. Degree-of-Knowledge,
SofiaWL, RevFinder). The new thing is the assembly: max-flow/min-cut prescribing
reviews on a knowledge graph.

## Fallback if `review` or `backtest` is not ready

The demo lands without them, because `fix` is the headline and it works today.

- Leave `slot` lines 7 and 8 in `demo.sh`, but **cut those frames in the edit**. Or
  comment them out before recording so no SLOT marker reaches the video.
- Go straight from step 6 to MCP (step 9), then the Browser (step 10). Total runtime
  is then about 2:35.
- To recover the time, slow step 3 down. Spend the extra 20–30 s on the min-cut
  sentence, because that is what the video is for.
- Don't put a backtest number on screen or in the narration until the command has
  printed it. No estimates, no "early results".
- If `backtest` lands but `review` doesn't (or the reverse), keep whichever works.
  The order of steps 7 and 8 doesn't matter to the story.
