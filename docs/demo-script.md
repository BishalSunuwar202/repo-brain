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
| 5 | `fix --ceiling \| head -n 11` (vite, whole repo) | 0.75–0.78 s |
| 6 | `backtest .cache/repos/fastify/fastify --holdout 30 --pr-limit 300` | 1.21–1.51 s |
| 7 | `repo_fix` over MCP, piped through `jq` (fastify, `.github/workflows`) | 0.53–0.74 s |

No step stalls the video. Every step except the backtest finishes in under 0.8 s, and most of that is
Node and tsx startup. Without the warm-up, the first command of a session takes
about 0.3 s longer (risk took 0.86 s cold), so `demo.sh` warms up before step 1.

⚠️ **Run the backtest once before you record.** Measured 2026-10-18, on the first run
after `docker start repo-brain-db`, step 6 took **15.81 s** — one measurement, but
a 10x blowup that would leave 16 seconds of dead air in a 25-second slot. Three
consecutive runs after it: 1.38 s, 1.14 s, 1.12 s. Step 6 is the only step that
*ingests* — it re-parses the fastify clone's git log and writes a fresh graph — so it
is the only one that pays for a cold container and a cold file cache. The read-only
steps were unaffected in that same cold run (step 1 took 0.557 s). `demo.sh`'s
warm-up covers tsx, not this.

**Avoid pnpm/pnpm on camera.** `fix --ceiling` there took **5.59 s** in a single run
today (spec §16 measured 5.3 s), and its output runs to thousands of lines. If a
step ever needs a bigger repo than fastify, use vite, which takes under 0.8 s.

## Steps and narration

Allow about 3:00 in total. Two steps were dropped to get there: a separate
`review <prNumber>` step (see step 6) and the whole-repo fastify `fix` that used to
sit between steps 4 and 5.

The whole-repo fastify step went rather than step 4, deliberately. Step 4 is where
the min cut is shown to be *actionable* — it prints `projected at risk 0,
bottleneck none` after you act on step 3's diagnosis — and that is the point of the
project. The dropped step was the same shape as step 3 at a bigger N, and step 5
(vite) still covers the whole-repo case while also showing both bottleneck types.

Its figure (32 at risk, 31 reviews for 19 people, projected 1) is now **not on
camera**. It remains in the README and `docs/submission.md`, so nothing on screen
contradicts them — but do not narrate it in another step. Step 1 does print `32
files`, which is the same 32 and is fine to say.

Commands take under 2 s each, so the narration sets the length.

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

### 1:45 — 5. `fix --ceiling` on vite, whole repo (about 20 s)

> "On vite, the same cut gives two different answers. 96 files are waiting on
> reviewer bandwidth, which is a scheduling problem. 10 files have nobody who clears
> the expertise floor, which is a hiring and onboarding problem."

What to notice: the two "left because" lines. Also `top 5 costs 62`: on vite the
shortlist costs 62 files of projected coverage, and `--ceiling` prints that cost
rather than hiding it. Give the numbers with their N (top 5) and budget (2).

### 2:05 — 6. `backtest`: is `review` any good? (about 25 s)

```bash
npm run -s brain -- --repo fastify/fastify backtest .cache/repos/fastify/fastify --holdout 30 --pr-limit 300
```

This is `review`'s only appearance on camera, and it appears measured. There is no
separate `review <prNumber>` step. The demo graphs were ingested without `--prs`, so
they hold no PR nodes and `review` would print nothing for any PR. Re-ingesting with
`--prs` would move the relative `--since` window and every number quoted above.
`backtest` builds its own throwaway `backtest:<uuid>` graph and deletes it, so the
demo graph is untouched.

> "Repo Brain also recommends reviewers for a PR. That's the part other tools do, so
> we measured it instead of demoing it. Thirty real fastify PRs were held out, and
> history was cut at the first one so nothing leaks. `review` finds a real reviewer
> in its top three 30% of the time. Ranking whoever reviews the most gets 43%.
> Random gets 13%. So `review` loses to the trivial baseline, and we publish that.
> It's why the headline is `fix`, not reviewer recommendation."

About 14 `[backtest]`/`[prs]` progress lines print first, on stderr, and the table
comes under them. They stay in, because they show the throwaway graph being built
and the history being cut. They are not suppressed with `2>/dev/null`, which would
also hide a real error mid-take. Wait for the table before speaking.

What to notice: the three-row table and the closing line, "MEASURED on 30 held-out
PRs, not a projection. review does NOT beat the trivial most-active baseline at
k=3." Read that line aloud. Quote only what is on screen: fastify, 30 held out, cut
at 2026-09-22T08:46:53Z. vite's numbers (README) are not on screen, so leave them out
of the narration.

### 2:30 — 7. The same `fix`, asked by an agent over MCP (about 15 s)

This is the only on-camera evidence for the agent track, so keep it in. Timed at
0.53–0.74 s (step 7 in the timings table):

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

### 2:45 — 8. FalkorDB Browser (about 15 s)

Switch to the Browser window and run:

```cypher
MATCH (p:Person)-[t:TOUCHED]->(f:File {module: '.github/workflows'})
WHERE t.doa > 0.2 AND f.alive RETURN p, t, f
```

That draws 5 people, 20 files and 32 edges, a picture you can read at a glance. One
person holds 19 of the 32 edges and the other four hold 7, 4, 1 and 1 (counted
2026-10-17). That is the graph behind steps 3 and 7.
Close on the prior-art credit (CodeScene, Fritz et al. Degree-of-Knowledge,
SofiaWL, RevFinder). The new thing is the assembly: max-flow/min-cut prescribing
reviews on a knowledge graph.

## If a step fails on the day

**Before the first take, run `scripts/preflight.sh`.** It checks the container, both
demo graphs, the fastify clone and the PR cache, pays the backtest's cold-start cost,
fails if a second backtest run takes 3 s or more, and prints the numbers each step
should show.

**Step 8's Browser may not open in Chrome.** Found 2026-10-18: the Browser serves
fine (`curl http://localhost:3100/` returns 200) but Chrome rendered an error page.
The response carries `Strict-Transport-Security: max-age=63072000` on a plain-HTTP
localhost origin, so Chrome tries `https://localhost:3100`, which speaks no TLS.
**Open it manually before recording.** If it errors, use Firefox or Safari, or clear
the entry at `chrome://net-internals/#hsts`. `preflight.sh` cannot catch this — it
checks the database, not the browser.

**First: is the container up?** Every step needs `repo-brain-db`; with it stopped,
each command exits 1. The CLI names it — `cannot reach FalkorDB at
redis://localhost:6379: connect ECONNREFUSED … Is the repo-brain-db container
running?` — so a dead container is unmistakable rather than a bare `error:`.

**Second: having just started it is not enough.** Run the whole script once after
starting the container and throw that take away. The backtest's first run costs ~16 s
(see the timings table); every run after it costs ~1.2 s.

`backtest` needs the fastify clone at `.cache/repos/fastify/fastify` and the cached
GitHub PR responses under `.cache/`. Without the cache it calls the GitHub API.

- Rehearse with `DEMO_PAUSE=0 scripts/demo.sh`. If step 6 errors, cut it in the
  edit rather than narrating numbers that are not on screen.
- To recover the time, slow step 3 down. Spend the extra 20–30 s on the min-cut
  sentence, because that is what the video is for.
- Never put a backtest number in the narration that the command did not print in
  that take. No estimates, no "earlier we measured".
