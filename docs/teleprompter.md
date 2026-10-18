# Teleprompter

Read this while recording. Timings, what to look for on screen, and what to do if
something fails are in `docs/demo-script.md`.

**★ READ VERBATIM** marks an honesty line. Say it word for word.

---

## Before you press record

1. Run `scripts/preflight.sh`.
2. If Docker was just restarted, run the whole demo once and throw that take away.
   The first backtest after a restart is slow.
3. Start `scripts/demo.sh`. It waits for **Enter** between steps.
   Talk at your own pace; nothing is timed against you.

Target: **3:00**.

---

## 1 · 0:00 · risk

```
npm run -s brain -- --repo fastify/fastify risk --limit 10
```

This is fastify, a real repo with real contributors.

Repo Brain read two years of its git history into a FalkorDB graph:
who touched which file, and how much of each file they wrote.

32 files have one person who holds more than half of the knowledge.

That's a bus factor of one.

---

## 2 · 0:25 · impact

```
npm run -s brain -- --repo fastify/fastify impact fastify.js --limit 10
```

The graph also knows what moves together.

Touch fastify.js and these files change with it,
including a docs page at 63% — ranked above lib/route.js —
that a human reviewer would forget.

---

## 3 · 0:45 · fix — THE HEADLINE

```
npm run -s brain -- --repo fastify/fastify fix --module .github/workflows --ceiling
```

**▼ SLOW DOWN. This is the 45 seconds the video exists for. ▼**

Ranking reviewers isn't enough, so here's what nothing else does.

Ten CI workflows are at risk.

`fix` builds a flow network from at-risk files
through qualified reviewers
to a review budget of two per person,
and runs FalkorDB's max-flow on it.

The answer is nine reviews for five people.

If they happen, the projection is that only one file stays at risk.

**★ READ VERBATIM, pointing at the `projected at risk` line:**
**"a projection, not a measurement."**

*(pause)*

Why not ten? The min cut answers that.

It is the certificate that no assignment within these budgets
covers more than nine files.

Each review de-risks one file,
so nine is also the fewest reviews that reach that number.

The cut names the four people whose budget binds.

The last file, lock-threads.yml, can only be reviewed by those four,
and they are full.

**▲ END OF THE PART NOT TO RUSH ▲**

---

## 4 · 1:30 · fix --budget 3

```
npm run -s brain -- --repo fastify/fastify fix --module .github/workflows --budget 3
```

The cut said bandwidth is the limit, not expertise.

So give every reviewer one more slot.

Ten reviews, four people,
and the projection is zero files at risk.

---

## 5 · 1:45 · vite, whole repo

```
npm run -s brain -- --repo vitejs/vite fix --ceiling | head -n 11
```

On vite, the same cut gives two different answers.

96 files are waiting on reviewer bandwidth.
That's a scheduling problem.

10 files have nobody who clears the expertise floor.
That's a hiring and onboarding problem.

---

## 6 · 2:05 · backtest

```
npm run -s brain -- --repo fastify/fastify backtest .cache/repos/fastify/fastify --holdout 30 --pr-limit 300
```

*Progress lines print first. Wait for the table before you speak.*

Repo Brain also recommends reviewers for a PR.
That's the part other tools do, so we measured it instead of demoing it.

Thirty real fastify PRs were held out,
and history was cut at the first one so nothing leaks.

`review` finds a real reviewer in its top three 30% of the time.
Ranking whoever reviews the most gets 43%.
Random gets 13%.

**★ READ VERBATIM, the last line on screen:**
**"MEASURED on 30 held-out PRs, not a projection.**
**review does NOT beat the trivial most-active baseline at k=3."**

So `review` loses to the trivial baseline, and we publish that.

It's why the headline is `fix`, not reviewer recommendation.

---

## 7 · 2:30 · the same fix, over MCP

```
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"repo_fix","arguments":{"repo":"fastify/fastify","module":".github/workflows"}}}' \
  | npm run mcp --silent | tail -n 1 | jq -r '.result.content[0].text' \
  | jq -c '{atRiskBefore, atRiskAfter, atRiskAfterIsProjection, bottleneck, bottleneckReviewers, unserved, reviews: ([.assignments[].files[]] | length)}'
```

An agent gets the same answer.

This is the MCP server, which exposes the four commands as tools.

An agent calls `repo_fix` and gets the same nine reviews,
the same four bottleneck reviewers,
and the same one file left over.

The JSON carries its own warning:

**★ READ VERBATIM, pointing at it:**
**"atRiskAfterIsProjection: true"**

…because an agent never sees the CLI's printed caveat.

---

## 8 · 2:45 · FalkorDB Browser

*Switch to the Browser window at http://localhost:3100, graph `repo:fastify-fastify`.*

*Load it before you record, logged in with the graph already selected. Any browser on this machine works.*

```cypher
MATCH (p:Person)-[t:TOUCHED]->(f:File {module: '.github/workflows'})
WHERE t.doa > 0.2 AND f.alive RETURN p, t, f
```

This is the graph behind that fix answer: five reviewers, twenty CI files.

None of the parts is new.
CodeScene, Fritz et al.'s Degree-of-Knowledge, SofiaWL and RevFinder
got here first, and we credit them.

The new thing is the assembly:
max-flow and min-cut prescribing reviews on a knowledge graph.

**END · about 3:00**
