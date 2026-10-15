# Repo Brain — Design Spec

**Event:** FalkorDB Graph Hacks (Oct 15–18 2026, online)
**Builder:** solo, ~35 working hours
**Status:** approved for build 2026-10-15

---

## 1. The problem

A lead has 23 files that exactly one person has ever touched. Existing tools
(CodeScene, DOE models) will tell them that. **Nothing tells them what to do
about it on Monday.** The naive prescription — "spread knowledge everywhere" —
is unbounded work, so nothing happens.

Repo Brain answers the prescriptive question:

> Assign Dev as reviewer on these **4** PRs over the next two weeks and
> bus-factor-1 drops from 23 files to 4 — without putting anyone on a module
> where they would slow the review down.

The minimal-set-under-a-constraint shape is a **max-flow / min-cut**
computation. That is why this is a graph database project and not a dashboard.

### Prior art (known and acknowledged in the README)
- CodeScene — bus factor simulation + change coupling (diagnosis, not prescription)
- Fritz et al. Degree-of-Knowledge (ICSE 2010) — per-developer per-element knowledge score
- SofiaWL (arXiv 2312.17169) — knowledge-spreading reviewer recommender; found it
  "unacceptably reduce[s] the overall expertise during reviews". **This is why our
  formulation has an expertise floor.**
- RevFinder — reviewer recommendation baseline

Novelty claim is narrow and stated honestly: the **assembly** (expertise graph from
co-change history → minimal knowledge-transfer prescription under an expertise
constraint) has no prior art found. Components are all published.

---

## 2. Ontology

Two layers. **Layer A is load-bearing; Layer B is presentation and is droppable.**

### Layer A — base graph (deterministic, from git)
```
(:Person {login, name, firstSeen, lastSeen})
(:File   {path, module, alive})   // module = first 2 path segments; `loc` dropped (needs file reads, unused)
(:Commit {sha, ts, author})
(:PR     {number, mergedAt, title})

(:Person)-[:TOUCHED  {commits, adds, dels, lastTs, doa}]->(:File)
(:File)  -[:CO_CHANGED {weight, support}]->(:File)
(:PR)    -[:MODIFIED]->(:File)
(:PR)    -[:AUTHORED_BY]->(:Person)
(:PR)    -[:REVIEWED_BY {at}]->(:Person)
```

### Layer B — knowledge units (derived, the "non-obvious node")
```
(:Knowledge {id, label, fileCount, cohesion})

(:Knowledge)-[:EXPRESSED_IN]->(:File)
(:Person)-[:HOLDS {evidence, lastTouched}]->(:Knowledge)
(:Knowledge)-[:ENTANGLED_WITH {weight}]->(:Knowledge)
```

`Knowledge` nodes are connected components / communities over the `CO_CHANGED`
graph, computed with `algo.WCC` (cheap) or `algo.CDLP` (better labels).

**Risk accepted:** Robillard 2010 found change clusters overlapped <1 in 5 tasks.
If cohesion scores come out poor, **drop Layer B from the UI and ship on Layer A**.
All four tools must work on Layer A alone. This is a hard design constraint.

### `doa` — degree of authorship
Per `(Person)-[:TOUCHED]->(File)`, following the DOK paper's spirit:
```
doa = 1.0 * isCreator + 0.5 * ln(1 + commits) + 0.2 * recencyWeight
recencyWeight = exp(-daysSinceLastTouch / 180)
```
Normalised per file so the owner's share is interpretable.

---

## 3. Schema DDL

```cypher
CREATE INDEX FOR (p:Person) ON (p.login);
CREATE INDEX FOR (f:File)   ON (f.path);
CREATE INDEX FOR (f:File)   ON (f.module);
CREATE INDEX FOR (c:Commit) ON (c.sha);
CREATE INDEX FOR (r:PR)     ON (r.number);
CREATE INDEX FOR (k:Knowledge) ON (k.id);
```

**One graph per repo** (`repo:<owner>-<name>`), using FalkorDB's multigraph
topology. Gives tenant isolation for free and sidesteps the documented
limitation that vector index queries do not combine with property filters.

---

## 4. Ingest

Single deterministic pass. No LLM in the ingest path — this is why this project
is buildable in 35 hours.

```bash
git log --no-merges --numstat --date=iso \
  --pretty=format:'__C__%H|%aI|%aE|%aN' --since='2 years ago'
```

- Parse into `Commit`, `Person`, `File`, `TOUCHED`.
- `CO_CHANGED`: for each commit touching files F, emit pairs; weight = count of
  co-occurrences, support = weight / min(touches(a), touches(b)). Drop pairs with
  weight < 3 or commits touching > 50 files (bulk reformats poison the signal).
- PRs + reviews from `gh api` (`/repos/{o}/{r}/pulls?state=closed`, plus
  `/pulls/{n}/reviews`). Cache to disk — rate limits will bite otherwise.
- Batch writes via `UNWIND $rows AS row` to keep round-trips down.

**Landmines to respect** (from FalkorDB known-limitations / cheat sheet):
1. Unreferenced relationships are only existence-checked — add `WHERE ID(e) >= 0`
   when counting over `-[e]->`.
2. `LIMIT` does not restrict eager operations — never `CREATE ... RETURN ... LIMIT`.
3. Indexes do not optimise `<>` filters.
4. No aggregations inside pattern comprehensions.
5. No regex operators — use `CONTAINS` / `STARTS WITH` / `string.matchRegEx()`.
6. No label expressions `(n:A|B)` — use `WHERE n:A OR n:B`.
7. Vector index queries do not combine with property filters.

---

## 5. The four tools

### `impact(path)` — what else moves when I touch this
```cypher
MATCH (f:File {path: $path})-[c:CO_CHANGED]->(g:File)
WHERE g.alive AND c.support > 0.3
RETURN g.path, c.weight, c.support
ORDER BY c.support DESC LIMIT 15
```

### `risk(module?)` — where is knowledge concentrated
Bus-factor-1 files = files where one person holds > 80% of normalised `doa`
and no one else has touched it in 180 days.
```cypher
MATCH (p:Person)-[t:TOUCHED]->(f:File)
WHERE f.alive AND ($module IS NULL OR f.module = $module)
WITH f, collect({login: p.login, doa: t.doa, lastTs: t.lastTs}) AS holders, sum(t.doa) AS total
WITH f, holders, total,
     [h IN holders WHERE h.doa / total > 0.8] AS dominant
WHERE size(dominant) = 1
WITH f, holders, total, dominant[0] AS sole
WITH f, total, sole,
     [h IN holders WHERE h.login <> sole.login AND h.lastTs >= $cutoff] AS recentOthers
WHERE size(recentOthers) = 0
RETURN f.path, f.module, sole.login AS soleHolder, sole.doa / total AS share
ORDER BY share DESC
```

### `review(prNumber)` — who should review this
Score candidates by `doa` on the PR's files + `doa` on co-changed neighbours,
penalised by current open-review load. This is the **baseline being measured**,
not the contribution.

### `fix(module?, budget?)` — THE CONTRIBUTION
Flow network:
```
SOURCE ──cap=1──▶ [at-risk File]
   [at-risk File] ──cap=1──▶ [eligible Reviewer]   (edge exists iff reviewer is
                                                     eligible for that file)
       [Reviewer] ──cap=k_r──▶ SINK                (k_r = review bandwidth)
```
- **Eligibility (the expertise floor, the SofiaWL fix):** reviewer `r` is eligible
  for file `f` iff `r` has `doa > θ` on at least one file co-changed with `f`.
  Someone with zero adjacent context is not a useful reviewer, and this is exactly
  the failure SofiaWL reported. θ tuned on the backtest.
- Max flow = maximum number of at-risk files that can be de-risked within
  everyone's bandwidth. The **min-cut** names the bottleneck: either
  "you are out of reviewer bandwidth" or "nobody is eligible for these files"
  — two different, actionable answers.
- Run with `CALL algo.maxFlow(...)`.

### Verified API (2026-10-15, docs.falkordb.com/algorithms/maxflow.md)

```cypher
CALL algo.maxFlow({
  sourceNodes:       [src],          // Array, REQUIRED
  targetNodes:       [sink],         // Array, REQUIRED
  relationshipTypes: ['FLOWS_TO'],   // Array, REQUIRED
                                     //   NOTE: `relationshipTypes`, NOT `relTypes`
                                     //   (algo.SPpaths uses `relTypes` — inconsistent)
  capacityProperty:  'cap',          // String, optional, default 'capacity'
  nodeLabels:        ['FlowNode']    // Array, optional, default all labels
})
YIELD nodes, edges, edgeFlows, maxFlow
```
- `nodes` / `edges` — only entities carrying **positive** flow (zero-flow edges absent)
- `edgeFlows` — flow per edge, same order as `edges`
- `maxFlow` — Integer, total flow across all sources
- Time complexity O(V·E²) on the selected subgraph. Our network is a few hundred
  nodes, so irrelevant.
- Smoke test from the docs: A-[:PIPE{cap:10}]->B, A-[:PIPE{cap:5}]->C,
  B-[:PIPE{cap:8}]->C, source A sink C ⇒ `maxFlow = 13`.

### Why we materialise an explicit SOURCE and SINK

The procedure supports multiple sources/sinks by adding virtual super-nodes with
**infinite capacity**. That is unusable here: our two binding constraints live
precisely on those edges — `cap=1` on SOURCE→File ("each file counts once") and
`cap=k_r` on Reviewer→SINK ("reviewer bandwidth"). Infinite capacity erases both.

So `fix` builds an explicit network in a **throwaway graph** `flow:<uuid>`:
`(:FlowNode {kind:'source'|'file'|'reviewer'|'sink'})-[:FLOWS_TO {cap}]->(:FlowNode)`,
runs maxFlow with `sourceNodes:[source]`, `targetNodes:[sink]`, derives the cut,
then drops the graph. The multigraph topology makes this cheap, and it keeps the
analysis graph clean.

### Deriving the min-cut (the procedure does NOT return it)

`algo.maxFlow` returns flows only. We compute the cut in TypeScript — trivial at
our scale, and we already hold every edge and capacity because we built the network:

1. `flow(e) = edgeFlows[i]` for returned edges, else `0`.
2. Residual graph: forward residual `cap(e) - flow(e)`, backward residual `flow(e)`.
3. BFS from SOURCE over edges with residual > 0 → reachable set `S`.
4. Min-cut = edges `u→v` with `u ∈ S`, `v ∉ S`. All are saturated.

**The cut is the demo.** Its composition names the bottleneck in plain English:
- cut edges on SOURCE→File ⇒ *"these files have no eligible reviewer"* — a
  hiring/onboarding problem, not a scheduling one
- cut edges on Reviewer→SINK ⇒ *"your reviewers are out of bandwidth"* — a
  capacity problem
Two different, actionable answers. This is the sentence no other tool produces.

---

## 6. Eval — the thing most entries will not have

Backtest, real ground truth, zero hand-labelling.

1. Ingest a real OSS repo, excluding the last **30** merged PRs.
2. For each held-out PR, run `review(pr)`.
3. Compare top-1 and top-3 against who actually reviewed it.
4. Report **precision@1 and precision@3** vs two baselines:
   - random eligible reviewer
   - most-active-reviewer-overall (the "just ask the maintainer" baseline)

For `fix`, report the counterfactual: bus-factor-1 file count before vs. after
the prescribed assignments, and the min-cut's named bottleneck.

A single honest number in the README beats any amount of narrative.

**Candidate repos** (need real review history + multiple contributors): pick 2,
one mid-size one large. Verify review data density before committing — many repos
merge without recorded reviews, which kills the eval.

---

## 7. Stack

- **TypeScript** throughout (deadline is the wrong place to learn Python)
- `falkordb-ts` client
- MCP server via `@modelcontextprotocol/sdk`, stdio transport
- FalkorDB via Docker, **with a volume** (the docs' `--rm` example discards data):
  ```bash
  docker run -p 6379:6379 -p 3000:3000 \
    -v $(pwd)/.falkordata:/data falkordb/falkordb:latest
  ```
  Browser at **`http://localhost:3100`** — the container's 3000 is remapped with
  `-p 3100:3000`. Ports 3000 AND 3001 are both held by unrelated `node` dev servers
  from the user's work projects. **Never kill those processes.**
- CLI first (`npm run brain -- risk --module auth`). MCP wrapper second. No web UI
  unless everything else is done.

---

## 8. Schedule (hard stops)

| Block | When | Hours | Deliverable |
|---|---|---|---|
| 0 | Oct 15 PM | 3 | Docker up, `algo.maxFlow` signature **verified**, repo scaffold, git-log parser emitting JSON |
| 1 | Oct 16 AM | 6 | Full ingest + schema + indexes, one real repo loaded, counts sanity-checked |
| 2 | Oct 16 PM | 4 | `impact` + `risk` working from CLI |
| 3 | Oct 17 AM | 6 | `review` + backtest harness → **a real precision@1 number** |
| 4 | Oct 17 PM | 5 | `fix` — max-flow + min-cut, with the before/after counterfactual |
| 5 | Oct 18 AM | 6 | MCP server, agent loop, Knowledge layer **only if time** |
| 6 | Oct 18 PM | 5 | Demo video, README with the number + prior-art section, submit |

**HARD STOP: submission in by Oct 18 18:00 IST.** Deadline is 23:59 IST; five
hours of buffer is not optional, it is the plan.

### Cut order if behind
Knowledge layer (B) → MCP server → `impact` → web UI. **Never cut:** `fix`,
the backtest number, or the video.

---

## 9. Demo script (3 min)

1. (0:00) Real repo, real contributor names on screen. "One person has ever
   touched these 23 files."
2. (0:40) `risk` output. This is the part other tools can do.
3. (1:10) `fix` output — 4 named review assignments. "This is the part nothing
   else does."
4. (1:50) The min-cut, named: *why* it can't do better than 4.
5. (2:20) The backtest number vs. both baselines.
6. (2:40) The graph in FalkorDB Browser, and the prior-art slide — honest about
   CodeScene and DOK, clear about what is new.

---

## 10. Tracks

One project, three tracks (allowed and encouraged by rule 3):
- **01 Investigation & Risk** — `risk` + `fix` are literally risk analysis
- **02 Agentic AI** — MCP server, agent calls the four tools, one graph per repo
- **03 GraphRAG SDK** — only if Block 5 finishes early; do not force it

## 11. Open risks

| Risk | Mitigation |
|---|---|
| Min-cut derivation in TS is buggy | unit-test against the docs' A/B/C example (maxFlow=13) and a hand-computed bipartite case before wiring to real data |
| Co-change clusters incoherent (Robillard) | drop Layer B, ship on Layer A (§2) |
| Chosen repo has no recorded reviews | verify density in Block 0, keep a second candidate |
| GitHub rate limits | cache every API response to disk on first fetch |
| Reads as "CodeScene with a chatbot" | lead with `fix`; prior-art slide pre-empts it |

---

## 12. Decision log — 2026-10-15, post-scaffold review

Twelve issues were raised after the scaffold and repo-vetting pass. Resolutions,
all binding:

**D1 — Eval metric is hit-rate@k, not |hits|/k.** With 1–2 real reviewers per PR,
`|hits|/3` caps at 0.33–0.67 and is unreadable. Use **hit-rate@k**: did any of the
top-k recommendations appear among the PR's actual reviewers. This matches the
convention in the reviewer-recommendation literature (RevFinder's "79% within
top-10"). Report hit-rate@1 and hit-rate@3.

**D2 — `fix` carries the headline, not `review`.** Vetting found the trivial
most-active baseline covers 69–100% of reviewed PRs across every candidate. So
`review` may tie or lose, and that is acceptable: §5 already declared `review` "the
baseline being measured, not the contribution". The README leads with `fix`'s
counterfactual (bus-factor-1 count before/after + the named min-cut bottleneck) and
reports review hit-rate as a secondary number **printed next to the most-active
baseline**, stating plainly that reviewer prediction is a well-served problem.
Do not bury a weak number and do not inflate it.

**D3 — Identity resolution is mandatory, not optional.** Git gives emails; one human
already splits into two Person nodes locally (noreply vs personal). This is a
**correctness bug on the core metric**: one person appearing as two makes a
bus-factor-1 file look safe. Resolve via GitHub GraphQL `author.user.login`
(`scripts/vet-repos.ts` has the working query), fall back to normalised email
local-part. `Person.login` stays the key; store `emails` as an array.

**D4 — Exclude lockfiles and generated paths from CO_CHANGED.** Lockfiles co-change
with everything and currently top the pair list. Exclude by glob:
`*-lock.yaml`, `*-lock.json`, `*.lock`, `yarn.lock`, `go.sum`, `Cargo.lock`,
`__snapshots__/**`, `dist/**`, `build/**`, `vendor/**`, `*.min.*`, `*.generated.*`.

**D5 — Bots excluded from co-change and from reviewer ground truth.** Bots author
13–79% of PRs in the candidates, and in some repos bot reviews are ~95% of all
reviews. Exclude bot-authored commits from CO_CHANGED entirely (they are mechanical),
and exclude bot reviewers from the backtest's ground truth — otherwise the eval
measures our ability to predict CodeRabbit.

**D6 — CO_CHANGED is written once, matched undirected.** Write a single edge per pair
with canonical ordering (`path_a < path_b`); all queries use `-[c:CO_CHANGED]-`, not
`->`. Halves edge count and removes the directed/symmetric mismatch.

**D7 — `k_r` (reviewer bandwidth) is a CLI budget parameter, not inferred.** Default
2 extra reviews per reviewer, `--budget` to override. Dropping the `review()` open-PR
load penalty for v1: it requires data ingest does not fetch, and it is not the
contribution. Say so in the README rather than faking it.

**D8 — Repo split for the demo.**
- **Backtest number: `fastify/fastify`** (100% review coverage, 15 distinct
  reviewers, 16% concentration, top-3 on only 72% of PRs — the most beatable
  baseline of the qualifying set; small ingest at 758 commits / 396 files).
  Backup: `getsentry/sentry-javascript` (the "large" repo; re-verify reviewer count
  over the real holdout window, its 8 reviewers came from a 6-day sample).
- **`risk` + `fix` demo: `FalkorDB/FalkorDB`.** No FalkorDB repo qualifies for the
  backtest (DvirDukhan alone is on 60% of PRs; top-3 cover 91%, so `review` would
  lose to "just ask Dvir" in front of their own judges). But `risk` and `fix` need
  **only git history**, no review data — so we still get their own contributors'
  names on screen, which is the demo value, without the eval weakness.
  **Verify co-change density on FalkorDB/FalkorDB before committing to this**; if the
  eligibility check finds no candidates, fall back to fastify for the whole demo.

**D9 — `isCreator` keeps `--summary`.** Already applied by the scaffold, plus
`-c core.quotePath=false`. Files created before the 2-year window yield no create
event and therefore no creator bonus, which is the correct behaviour, not a bug.

**D10 — `support` denominator documented, not changed.** `support` counts touches
over non-bulk commits only (consistent with pair counts) while `TOUCHED.commits`
counts all commits. Two different denominators on purpose; note it in the README so
no one reads it as an inconsistency.

### Still unverified
- Streaming at 100k+ commits (no local repo that large; sentry at 6.3k is the
  largest real test).
- Whether `FalkorDB/FalkorDB` has enough co-change density for `fix` (see D8).

### Rulings on the parser-hardening pass (2026-10-15)

**D11 — Lowercased logins: accepted.** `Person.login` is lowercase everywhere. The
backtest MUST lowercase actual reviewer logins before comparing, or every hit-rate
is silently zero. Add a test that would fail if the lowercasing were removed.

**D12 — `File.module` = first two *directory* segments: accepted.** `src/tools/fix.ts`
→ `src/tools`; `src/cli.ts` → `src`; `README.md` → `.`. The literal reading, where a
top-level file becomes its own module, is worse. This is the intended behaviour.

**D13 — `*bot` login heuristic: accepted, with an audit requirement.** Missing a bot
pollutes the eval's ground truth, which is worse than misclassifying one human, and
`eslintbot` is a machine account of GitHub type *User* — so `__typename == 'Bot'`
alone cannot catch it. Keep the suffix rule, but **print every login classified as a
bot in the parse summary** so a human can eyeball it in one glance. That makes the
"talbot" failure mode visible rather than silent. Prefer the authoritative
`__typename`/`type == 'Bot'` signal where available; heuristic is the fallback.

**D14 — Exclusion-list gaps: fix, and extend the filter to `risk` output.** Add
`bun.lockb` and `*.snap` to `CO_CHANGE_EXCLUDE`. Make the list overridable from the
CLI (`--no-exclude <glob>`) so a repo with a real `build/` source directory is not
silently gutted. **Most important:** lockfiles still get `TOUCHED` rows, so `risk`
can currently report `pnpm-lock.yaml` as the top bus-factor-1 file. A demo whose
headline knowledge risk is a lockfile is a disaster. Apply the same exclusion to
`risk` output (filter at query/presentation time — keep the TOUCHED rows, they are
factual).

**D15 — `--repo owner/name` is REQUIRED for any run that produces a reported number.**
The local fallback cannot merge `bishalsunuwar202` with `bishalsunuwar24`, and worse,
it can wrongly *merge* two different humans (`john@a.com` + `john@b.com` → `john`).
Only the GitHub mapping is trustworthy. Without `--repo`, print a loud warning that
the output is not suitable for reporting. Never quote a number from a fallback run.

**D16 — `impact` excludes test files from the ranked list by default.** 47% and 46%
of surviving pairs involve a test/spec file. "Your own test file also changed" is not
an insight, and it would lead the demo output. Default: rank source↔source pairs and
append a collapsed count (`+4 test files`). `--include-tests` restores them. This is
presentation only — the edges stay in the graph.

**D17 — Lockfile noise was small but top-ranked: no further action.** 413→412 and
275→265. The counts barely moved, but the dropped pairs sat at ranks 1 and 5, which
is exactly where a demo looks. The top 8 pairs are now genuine source↔source and
source↔test pairs. Signal confirmed real; D4 earned its place by rank, not count.

---

## 13. Live verification against FalkorDB (2026-10-15)

Container `repo-brain-db` up: `-p 6379:6379 -p 3100:3000`, volume `.falkordata/`,
image 747MB. Seven checks run directly against the engine.

| # | Check | Result |
|---|---|---|
| A | `algo.maxFlow` returns 13 on the docs' A/B/C fixture | **PASS** (5.5ms) |
| B | per-edge flows A→B 8, A→C 5, B→C 8 | **PASS** — min-cut derivation has its inputs |
| C | `MERGE … ON CREATE SET` | **PASS** |
| D | string array as a property value (`Person.emails`) | **PASS** — returns `[b@x.com, b@y.com]`, size 2 |
| E | duplicate index error text | **PASS** — exactly `Attribute 'login' is already indexed`, so `/already indexed/i` matches |
| F | `NOT EXISTS { MATCH … }` in `WHERE` | **FAIL — not supported** |
| G | `GRAPH.DELETE` on a missing graph | `ERR Invalid graph operation on empty key` |

### Landmine 8 — no `EXISTS { }` subqueries

```
errMsg: Invalid input '(': expected ':', ',' or '}' line: 1, column: 64
```
FalkorDB does not parse `EXISTS { MATCH ... }`. This was **my error** — the clause
was written into §5 unverified. Replacement pattern, now verified live: collect the
rows you need in the aggregation, then filter with a **list comprehension**. The
`risk` query in §5 uses this form.

`$cutoff` is a precomputed UTC ISO string (`now - 180 days`) passed from TypeScript.
Do NOT use `duration.inDays()` / `datetime()` — also unverified, and unnecessary:
string comparison on normalised UTC ISO timestamps gives correct ordering, which is
exactly why ingest normalises them.

Verified with a three-file fixture: `solo.ts` (alice only, old) is returned;
`shared-recent.ts` (alice 0.9 but bob touched it inside the window) is correctly
excluded; `split.ts` (50/50, no dominant holder) is correctly excluded. Removing the
clause makes `shared-recent.ts` reappear — so the clause is doing real work, not
decorating.

### Note on G

`GRAPH.DELETE` on a missing graph returns `ERR Invalid graph operation on empty key`.
`--fresh` should match **that text specifically** rather than swallowing every error
at that point, or a genuine connection failure will be hidden.

---

## 14. Rulings after the first live ingest (2026-10-15)

Ingest ran clean: every step applied, zero engine rejections, 1.36s wall-clock for
518 commits. Counts verified in-graph with the `ID(e) >= 0` guard. Re-ingest is
idempotent. The predicted 674 TOUCHED came out as 672, correctly — the earlier 674
was from a pre-identity-resolution run where one human was split in two.

### D18 — `risk` has NOT been shown to discriminate. This is now the critical path.

Every number produced so far comes from a **single-author repo**, where every file
is trivially bus-factor-1 (641 of 642 alive files; the one exclusion is a lockfile).
A threshold sweep on that graph returns **642 files at 0.6, 0.7, 0.8, 0.9 and 0.95
alike** — completely flat, because every share is exactly 1.0. The plumbing is
proven; the *scoring* is not.

Consequences, all binding:
1. *(Default superseded by §15 R1: 0.5 plus a 3-commit floor.)* The dominance threshold becomes `--threshold`, default 0.8. It is a tuning
   parameter, not a constant, and the README must not present 0.8 as principled
   without evidence.
2. The demo and README must include a **sensitivity table** — bus-factor-1 counts at
   0.7 / 0.8 / 0.9 on a multi-author repo. A judge will ask "why 0.8?" and the only
   good answer is a table.
3. **Measure whether the recency clause does any work.** On a multi-author repo,
   report how many files it excludes that the dominance rule did not already
   exclude. If that number is ~0, say so plainly in the README, or drop the clause.
   Do not ship a condition that appears to do something and does nothing.

### D19 — `doa`'s log term makes 80% dominance harder to reach than it looks

A creator with one commit plus one other person with one recent touch leaves the
creator **below 0.8**, so the file is not flagged. Worked example:
`1.0 + 0.5·ln(2) ≈ 1.35` against `0.5·ln(2) + 0.2 ≈ 0.55` → share 0.71.

This is arguably correct behaviour — two people have touched it — but it means the
dominance rule and the recency clause **overlap heavily**, which is why D18.3 must be
measured rather than assumed. It also means **backtest and demo fixtures must assert
the doa they intend**, or a test can pass for the wrong reason. (This was caught by
`start` mutation-testing its own live test: the recency assertion passed even with
the clause removed, because the file was already failing the 80% rule.)

### D20 — `migration_lock.toml` added to the exclusion list

`*.lock` does not match `apps/api/prisma/migrations/migration_lock.toml`, so it is
currently reported as a knowledge risk. Add `migration_lock.toml` and `*_lock.toml`.
The list stays CLI-overridable per D14.

### D21 — Cloning the demo and eval repos: approved

`risk` and `fix` cannot be validated without multi-author history, and the backtest
needs `fastify/fastify`. Clone both, under these constraints:

- Each into **its own new, empty directory** under `.cache/repos/<name>/`.
- `git clone --single-branch` (full history needed; `--numstat` requires blobs, so a
  blobless clone would refetch them one at a time and be slower).
- **Never run `npm install`, a build, or any script inside a cloned repo.** They are
  untrusted third-party checkouts. The only permitted interaction is `git log` with
  the path passed as an argument, which is what the parser already does.
- Ingest with `--repo FalkorDB/FalkorDB` and `--repo fastify/fastify` so identity
  resolution is real (D15: never quote a number from a fallback run).

Priority: **FalkorDB/FalkorDB first** — it is both the D8 demo repo and the first
multi-author discrimination test, and D8 requires its co-change density be verified
before committing to it. `fastify` second, for the backtest.

## 15. Rulings after calibrating on multi-author repos (2026-10-15)

These supersede §5 (risk rule, fix eligibility) and §14 D18.1's default where they
conflict. Every number here is reportable (ingested with `--repo`, real identity
resolution; D15). Numbers use a relative 2-year window, so they drift a little with
wall-clock time; pin `--since` to an absolute date for anything published.

### What the calibration found

- **At 0.8, `risk` meant "exactly one person touched it".** fastify had 0 of 266
  multi-holder files at ≥ 0.8, and FalkorDB 2 of 238. Log-damped commit counts
  cap the top share near 0.7–0.8 once a second person touches a file (D19 at
  scale).
- **Those files were cold, not concentrated.** 62 of fastify's 78 had a single
  commit in the window, and 57 were tests.
- **The recency clause was inert at 0.8.** It excluded 0 additional files on
  fastify at 2-, 5- and 10-year windows alike, and 2 on FalkorDB.
- **The co-change eligibility floor made `fix` nearly empty.** Only 5 of 78
  at-risk fastify files had any alive co-change partner (FalkorDB: 4 of 318).
  This is structural: a file touched once by one person cannot reach the
  weight ≥ 3 co-change threshold.

### R1 — threshold 0.5, activity floor of 3 commits, 2-year window kept

A file is bus-factor-1 when one person holds **more than 0.5** of its normalised
`doa` and it has **at least 3 authorship commits** in the window.

- **0.5 is a definition, not a tuned value.** At any threshold ≥ 0.5 at most one
  person can exceed it, so the rule reads "one person holds a strict majority".
  The `size(dominant) = 1` guard stays for thresholds below 0.5.
- **CLI:** `--threshold` (default 0.5) and `--min-commits` (default 3). Both are
  printed in the output header.

Sensitivity on fastify, after R5. Each cell is at-risk files, multi-holder files
in parentheses:

| min commits | 0.5 | 0.6 | 0.7 | 0.8 |
|---|---|---|---|---|
| 1  | 190 (98) | 112 (20) | 100 (8) | 92 (0) |
| 3  | 32 (27)  | 17 (12)  | 5 (0)   | 5 (0)  |
| 5  | 11 (8)   | 5 (2)    | 3 (0)   | 3 (0)  |
| 10 | 1 (1)    | 1 (1)    | 0       | 0      |

A longer window helped less than the floor. At 5 years and 0.6, 42 of 82 flagged
files (51%) had several contributors, against 27 of 32 (84%) at 2 years with
floor 3 and 0.5.

### R2 — segment by file kind; do not hide tests

`risk` rows carry `kind`: source, test, ci, docs or types. `fileKind()` in
`paths.ts` checks them in the order test > ci (any path starting with ".") >
docs > types > source. Output leads with at-risk / active files per kind, and
`--kind` filters.

- **fastify at the defaults:** source 1/28, test 13/84, ci 11/17 (fdawgs holds 10
  of the 11), docs 7/37, types 0/10.
- **Tests stay in.** In `impact`, a test moving with its source is mechanical
  coupling (D16). In `risk`, a test only one person understands is genuine risk.

### R3 — fix eligibility uses a module floor; co-change only ranks

This replaces §5's co-change rule. Reviewer `r` is eligible for at-risk file `f`
when **both** hold:

- `r ≠ soleHolder(f)`;
- `r` has `doa > θ` on some *other* alive file `g` with `g.module = f.module`,
  `t.commits > 0`, and `g` not excluded by the D14 list.

`doa` is already normalised per file, so `t.doa` is the share. Co-change evidence
may raise a reviewer's rank within the eligible set, but it never gates
eligibility.

**θ default: 0.2, provisional.** No ruling set it. §5 says θ is tuned on the
backtest, so expose it as `--theta`. Coverage barely moves with θ. At-risk files
coverable (distinct eligible reviewers in parentheses):

| repo | θ = 0.2 |
|---|---|
| fastify | 32/32 (67) |
| undici | 82/82 (110) |
| vite | 179/189 (122) |
| pnpm | 1572/1593 (294) |
| FalkorDB | 84/86 (13) |

**Query shape.** Fetch experts **once per module**, then decide per file in TS:

```cypher
MATCH (r:Person)-[t:TOUCHED]->(g:File)
WHERE g.alive AND t.commits > 0 AND t.doa > $theta
RETURN g.module AS module, collect({login: r.login, via: g.path}) AS experts
```

In TS, drop experts where `via = f.path`, where `login = soleHolder`, or where
`via` is a D14 path. Two shapes fail:

- one row per (file, reviewer) truncates silently on pnpm (landmine 9);
- `UNWIND $files … WHERE g.module = f.module` **timed out** on pnpm, even with
  the `File.module` index.

The per-module shape runs in 20–263 ms on every repo above.

### R4 — recency is an output column, not a filter

The 180-day "no one else recently" clause is removed. It was inert at the default,
and recency is already inside `doa`. `RiskRow.daysSinceOther` reports days since
anyone other than the sole holder last touched the file, or `null` if no one ever
did.

### R5 — bulk commits are not authorship

A commit touching more than 50 files (counted before exclusion) is structural.

- It still writes TOUCHED rows (`t.bulkCommits`) and still resolves renames.
- It sets no `isCreator` and adds nothing to `doa`, not even the recency term.
- A person whose only touches on a file are bulk has `t.commits = 0` and
  `doa = 0`. `risk` and fix eligibility filter on `t.commits > 0`.
- A file touched only by bulk commits is never reported.

On FalkorDB, the August 2026 Rust-engine import (commit 1665fbd98) had made its
author the sole holder of 274 files under the old 0.8 rule. After R5 that is 69
under the same rule, and 19 at the R1 defaults.

### R6 — `diff.renameLimit`: documented, not fixed

Huge commits skip exhaustive rename detection, so a rename there can appear as
delete plus add. After R5 this affects only alive-tracking, not authorship. It is
listed in the README as a known limitation.

### D8 update — demo repos

- **fastify/fastify** is the demo and backtest repo: healthy source, CI bus factor.
- **vitejs/vite** is the source-concentrated counterpart for the README side by
  side: 380 people, source 94/239 at risk, sapphi-red holds 77.
- **FalkorDB/FalkorDB is dropped.** Its HEAD is a 2.5-month-old import, and only 49
  of 556 alive files have any co-change partner.
- **Also vetted:**
  - nodejs/undici: source 21/88, a mild case.
  - pnpm/pnpm: source 1146/1912, zkochan holds 970. It is a known
    single-maintainer project, and 1593 rows is too long to demo.

### Landmine 9 — reads are silently truncated at 10,000 rows

FalkorDB's `RESULTSET_SIZE` defaults to 10000, verified with
`GRAPH.CONFIG GET` and with `UNWIND range(1, 12345) AS x RETURN x`, which returns
10000 rows with no error. A per-touch read on pnpm (21,451 alive TOUCHED rows)
silently lost data.

- Shape reads to return one row per file or module, never per edge.
- Wrap results in `underCap()` (`src/db/client.ts`), which throws at the cap.
- Do not raise the server setting: the container is shared, and a raised cap
  hides the problem.


---

## 16. `fix` as built (2026-10-15)

`fix` solves the §5 network in a throwaway `flow:<uuid>` graph and drops it
afterwards, even when the solve throws. No `flow:` graph was left behind after
runs on all five repos. Eligibility is §15 R3. The two implementations were
written independently and give the same coverage on every repo.

### F1 — the solver gets a shortlist of each file's strongest reviewers

`algo.maxFlow` maximises the *number* of files covered and does not care which
reviewers it uses. With every eligible pair in the network, it picked whoever
sorted first: on fastify, acoluzzi and agustin18; on pnpm, 0xnoramiya and 3w36zj6.
The count was optimal, but the advice was noise.

Each file now offers the solver only its `--candidates` strongest eligible
reviewers. Reviewers are ranked by their best `doa` in the module, and ties break
on login, so runs are reproducible. Under the shortlist, fastify prescribes
climba03003, eomm, fdawgs and mcollina, among others.

**Shortlisting costs coverage.** Projected files still at risk, at the risk
defaults with `--budget 2` (measured twice, by independent runs):

| repo | N=1 | 2 | 3 | 5 | 10 | all |
|---|---|---|---|---|---|---|
| fastify | 20 | 11 | 6 | **1** | 1 | 1 |
| FalkorDB | 78 | 74 | 72 | **63** | 60 | 60 |
| undici | 49 | 30 | 24 | **13** | 4 | 2 |
| pnpm | 1533 | 1498 | 1471 | **1411** | 1327 | 1029 |
| vite | 152 | 132 | 121 | **106** | 90 | 44 |

With no shortlist the number is better, because barely qualified reviewers soak up
the overflow once the strong ones reach their budget. That is a better number from
worse advice.

**Default N = 5, provisional, same status as θ.** It is the smallest N at which
fastify reaches its floor, and that is exactly how a value picked to flatter the
demo would look. Two things argue against that reading: undici, vite and pnpm also
gain substantially from N = 3 to N = 5, and on fastify N = 5 and "all" give the same
result. Even so, any projected number we publish must state N. N is tuned on the
backtest alongside θ.

**`--ceiling` is why N does not rest on trust.** It solves a second time with the
shortlist lifted and prints both numbers, for example "106 projected; 44 with no
shortlist; top 5 costs 62" on vite. That shows the cost of N wherever the number is
used, so a reader can judge the choice without relying on either implementer's
reasoning. The eligibility read happens once and only the solve repeats: 100 ms on
fastify and 203 ms on vite. Published projections are quoted with their ceiling.
`FixResult.unserved` names the files left over; on fastify that is
`.github/workflows/lock-threads.yml`.

### F2 — the bottleneck is read from the unserved files, not from the cut

The first version classified the bottleneck from what was in the min cut. That gets
it backwards:

- a saturated SOURCE→file edge that crosses the cut means the file **was** served;
- a file nobody can review keeps spare capacity on its SOURCE edge, so it stays on
  the SOURCE side and never crosses the cut at all.

On fastify, the first version reported "eligibility" for
`.github/workflows/lock-threads.yml`, whose four candidates were all at budget. Its
test passed for the wrong reason.

The classification now uses the unserved files directly:

- a file with no candidate edges is an **eligibility** shortfall;
- a file whose candidates are all saturated is a **bandwidth** shortfall;
- the label goes to whichever explains more files, and ties go to eligibility.

The min cut is still load-bearing in two ways. It names `bottleneckReviewers`, the
people whose budget binds. And its capacity equalling maxFlow proves that no
smaller set of reviews would cover as much.

The CLI does not depend on the label alone. It prints the exact split: files with no
eligible reviewer (`atRiskBefore − coverable`) can never be served, so every other
unserved file is waiting on someone's budget. At the defaults:

| repo | at risk | have a reviewer | projected after | at budget | nobody eligible |
|---|---|---|---|---|---|
| fastify | 32 | 32 | 1 | 1 | 0 |
| undici | 82 | 82 | 13 | 13 | 0 |
| vite | 189 | 179 | 106 | 96 | 10 |
| FalkorDB | 86 | 84 | 63 | 61 | 2 |
| pnpm | 1593 | 1572 | 1411 | 1390 | 21 |

### F3 — "projected after" is a counterfactual

`atRiskAfter = atRiskBefore − maxFlow`. It is not measured again after the reviews.
The graph cannot know whether the reviews happened, so the CLI, the README and the
video must call it a projection.

### Verified live for §13

- `startNode(e)` and `endNode(e)` work on the edges `algo.maxFlow` yields, so the
  flows come back keyed by our own node names, with no internal-ID mapping.
- `algo.maxFlow` returns **only positive-flow edges**. When nothing can flow,
  `UNWIND range(0, size(edges) - 1)` yields zero rows instead of failing, so
  `maxFlow` is read from row 0 and defaults to 0. `mergeFlows` puts the zero-flow
  edges back, because the min cut needs the whole network.
- `mergeFlows` stops with an error if a flow lands on an edge we never built, or if
  maxFlow differs from the flow leaving SOURCE.
- Every read goes through `underCap`. The largest, pnpm's flow edges, is about 3.4k
  rows.
- End-to-end CLI wall-clock times: fastify, undici, vite and FalkorDB 0.6–0.9 s;
  pnpm 2.4 s.
