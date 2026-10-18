# Code walkthrough — what I need to be able to explain

Hackathon **rule 12** requires the participant to understand the submitted code and
be able to explain the graph model, the queries, the architecture and the technical
decisions. **Rule 13** says a project generated entirely by AI without meaningful
participant contribution, verification or technical understanding may be rejected.

This file is the study sheet for that: every number and formula below is quoted from
the code, with the file and line to jump to. Nothing here is a summary of a summary.

The short version, in one breath:

> Git history becomes a graph of people, files and commits. `risk` finds files where
> one person holds a majority of the authorship. `fix` turns "who should review what
> to fix that" into a max-flow problem, and reads the bottleneck off the min cut.
> `review` is the weak part and the measurement says so.

---

## 1. Why a graph at all

The honest answer, and the one to give: **`fix` is a flow problem on a bipartite
graph, and the inputs to that graph are two-hop traversals.**

- `risk` needs, per file, every person who touched it with their share — a
  `(Person)-[TOUCHED]->(File)` fan-in, aggregated per file.
- Eligibility needs "does this person know some **other** file in the same module" —
  a second hop out of the person.
- `review` needs the PR's files *and their co-change neighbours* — `(PR)-[MODIFIED]->
  (File)-[CO_CHANGED]-(File)<-[TOUCHED]-(Person)`, which is a 3-hop path.
- `fix` then solves max flow over `SOURCE -> files -> reviewers -> SINK`.

What *not* to claim: that this is impossible in SQL. It isn't. The claim is that the
queries are naturally traversals, the engine ships `algo.maxFlow`, and the headline
answer is a graph-theoretic object (a minimum cut). See README "The graph data model".

## 2. The data model

Four node labels, five relationship types, five indexes (`src/schema/ddl.ts:7`).

| | |
|---|---|
| `(:Person {login, name, firstSeen, lastSeen})` | keyed on **lowercase** login |
| `(:File {path, module, alive})` | `alive` = present at today's HEAD |
| `(:Commit {sha, ts, author})` | |
| `(:PR {number, mergedAt, title})` | only created when ingest is given `--prs` |
| `-[:TOUCHED {commits, bulkCommits, adds, dels, lastTs, isCreator, doa}]->` | Person → File |
| `-[:CO_CHANGED {weight, support}]-` | File → File, one canonical edge, `a < b` |
| `-[:AUTHORED_BY]->`, `-[:MODIFIED]->`, `-[:REVIEWED_BY {at}]->` | PR edges |

Four decisions worth being able to defend:

1. **Lowercase-login Person keying.** GitHub logins are case-insensitive but the API
   returns them cased. Keying on the raw login would create two nodes for the same
   person, and the backtest's hit-rate would read 0 because ground truth and
   predictions would never string-match (`src/eval/backtest.ts:31`).
2. **`TOUCHED.doa` is normalised per file**, so every file's shares sum to 1. That is
   what makes "holds more than 0.5" a definition rather than a tuned dial.
3. **One canonical `CO_CHANGED` edge** in canonical order `a < b`, matched
   undirected. Two directed edges would double every co-change weight.
4. **No email addresses in the graph** (hackathon rule 6). Emails resolve a login
   during ingest and are dropped before loading; `src/ingest/load.ts` writes no
   `emails` property, and `test/load.test.ts:71` asserts no load step can.

## 3. The degree-of-authorship formula

`src/ingest/gitlog.ts:437`:

```ts
doaRaw = commits === 0 ? 0
       : 1.0 * (isCreator ? 1 : 0)
       + 0.5 * Math.log(1 + commits)
       + 0.2 * Math.exp(-days / 180)
doa    = doaRaw / (sum of doaRaw over everyone on that file)
```

Three terms: **you created it**, **how often you have changed it** (log, so the 50th
commit counts far less than the 2nd), **how recently** (exponential decay, 180-day
half-life-ish). Then normalised per file.

- This is **adapted from Fritz et al.'s Degree-of-Knowledge**, credited in the README.
  The original fits coefficients from interaction data (IDE telemetry) we do not have;
  these three weights are hand-set, which is a real limitation to state plainly.
- `commits === 0` means **bulk-commit-only**: a commit touching more than
  `BULK_COMMIT_FILES = 50` files (`src/ingest/gitlog.ts:234`) is a structural event,
  not an authorship event. It still produces a `TOUCHED` row (a fact) and still
  resolves renames, but adds nothing to `doa` and sets no `isCreator`. Without this,
  whoever ran a formatter owns the repo.

## 4. `risk` — where knowledge is concentrated

`RISK_CYPHER`, `src/tools/risk.ts:32`. Definition: **one person holds more than
`threshold` (default 0.5) of a file's normalised doa, among files with at least
`minCommits` (default 3) authorship commits.**

- At any threshold ≥ 0.5 **at most one person can exceed it**, so `size(dominant) = 1`
  is redundant at the default — kept only so a threshold below 0.5 still behaves.
- `minCommits` is the activity floor. Without it the list is cold files touched once
  by one person, which is not concentrated knowledge.
- **No recency filter.** Measured inert at 0.8 on fastify and FalkorDB, and recency is
  already inside `doa`. "Days since anyone else touched it" is *reported* instead —
  the information is given to the human rather than used to silently drop rows.
- Landmine 8: FalkorDB has no `EXISTS { MATCH … }`, so the other holders' timestamps
  come out of a **list comprehension over the collected holders**, not a subquery.

Live on fastify: 32 at-risk files; by kind `source 1/28`, `test 13/84`, `ci 11/17`,
`docs 7/37`, `types 0/10`. The interesting part is that **ci is the worst segment** —
11 of 17 active workflow files are bus-factor-1, nearly all held by one person.

## 5. `fix` — the contribution

### The network

`buildNetwork`, `src/tools/fix.ts:191`:

```
SOURCE --cap=1--> [at-risk file] --cap=1--> [eligible reviewer] --cap=k_r--> SINK
```

Read the capacities out loud, because they *are* the model:

- `cap=1` out of SOURCE: **each file needs one review to be de-risked.** Max flow
  therefore counts *files*, which is why `atRiskAfter = atRiskBefore - maxFlow`.
- `cap=1` file→reviewer: one reviewer covers a file once.
- `cap=k_r` reviewer→SINK: **`--budget`, default 2** — how many extra reviews one
  person can absorb. This is the scarce resource, and it is what makes the answer
  non-trivial: without it, everyone reviews everything.

A file with **no** eligible reviewer still gets its SOURCE edge. Dropping it would
make max flow look healthy and make the "nobody is eligible" bottleneck unreportable.

### Eligibility — the expertise floor

`eligibleByFile`, `src/tools/fix.ts:280`, fed by `ELIGIBLE_CYPHER` at line 436.

A reviewer `r` is eligible for file `f` iff `r` is **not** `f`'s sole holder **and**
`r` has `doa > θ` (default 0.2) on some **other** alive, non-excluded file in `f`'s
module. Both exclusions carry weight: the sole holder already owns the file, and
someone whose only expertise *is* that file learns nothing by reviewing it.

Two things to be able to explain here:

1. **Why the Cypher returns one row per module, not per (file, reviewer) pair.**
   FalkorDB truncates reads at `RESULTSET_SIZE = 10000` **silently** — no error. On
   pnpm the pair list is tens of thousands of rows, so it would come back quietly
   wrong. Every read in the codebase goes through `underCap()` (`src/db/client.ts`),
   which throws when a result is exactly at the cap. The per-file rules then run in
   TypeScript, which is also cheaper: the obvious `UNWIND $files … WHERE g.module =
   f.module` join timed out on pnpm even with the index.
2. **Why there is a 5-candidate shortlist (`--candidates`).** `algo.maxFlow`
   minimises cardinality and is **indifferent between equally-sized assignments** —
   with every eligible pair in the network it returned whoever sorted first
   alphabetically (measured: `acoluzzi`, `agustin18` on fastify; `0xnoramiya` on
   pnpm). Keeping each file's strongest 5 by doa means every reachable assignment
   comes from someone who demonstrably knows the module.

   The shortlist is **not free**, and the README publishes the cost
   (`src/tools/fix.ts:280` carries the table): on vite, `atRiskAfter` is 106 at N=5
   and 44 unrestricted. Unrestricted scores better because a long tail of
   barely-qualified reviewers absorbs the overflow once the strong ones hit budget —
   **a better number from worse advice.** `--ceiling` exposes the gap rather than
   hiding it.

### Deriving the min cut

This is the part most likely to be probed, because the engine does not do it.

`algo.maxFlow` returns `edges`, `edgeFlows`, `maxFlow` — **only positive-flow edges,
and never the cut.** So:

1. `mergeFlows` (`src/tools/fix.ts:356`) merges the returned flows back onto the
   *whole* built network, keeping zeros. The cut needs unsaturated edges — an edge
   with residual capacity is exactly what keeps a node inside the reachable set.
   Two fatal consistency checks here: a flow on an edge we never built, and
   `maxFlow ≠ flow leaving SOURCE`. Either means the round-trip renamed something and
   every reported number is wrong by an unknown amount.
2. `minCut` (`src/tools/fix.ts:84`) builds the **residual graph** — forward edge where
   `cap > flow`, backward edge where `flow > 0` — BFSes from SOURCE to get the
   reachable set `S`, and returns every edge from `S` to outside `S`. By the
   max-flow min-cut theorem their total capacity equals the max flow; the tests
   assert exactly that.
3. `bottleneckReviewers` (`src/tools/fix.ts:166`) takes the cut edges ending at SINK. Those are
   the saturated budgets holding max flow down, so **those are the people to raise
   `k_r` for, and the cut's capacity proves no smaller set would do.** This is the
   one recommendation that follows from the cut itself rather than from counting.

**A mistake worth being able to describe**, because it shows the reasoning was
checked: `classifyBottleneck` (`src/tools/fix.ts:142`) does **not** read the cut's
composition. A saturated `SOURCE->file` edge crossing the cut means that file **was**
served; a file nobody can review keeps residual capacity on its SOURCE edge, stays
inside `S`, and never crosses the cut at all. Counting cut edges gets it exactly
backwards — measured on fastify, it reported "eligibility" for a file whose four
candidates were every one at budget. So the classification reads the **unserved
files** instead: no candidate edges at all → `eligibility` (more budget cannot help);
candidates but all saturated → `bandwidth` (raising `k_r` can).

### Why a throwaway graph

`solveMaxFlow`, `src/tools/fix.ts:474`. The network is materialised as
`(:FlowNode {name})-[:FLOWS_TO {cap}]->` in a graph named `flow:<uuid>`, solved, and
deleted in a `finally`.

It cannot live in the repo graph: **`algo.maxFlow`'s multi-source mode uses
infinite-capacity virtual super-nodes**, which would erase `cap=1` and `k_r` — the
whole model. So SOURCE and SINK have to be real nodes with real capacities. Both
terminals are `MERGE`d up front so a network where nothing can reach SINK solves to
0 rather than matching no rows for accidentally the right reason.

### The one sentence that must never be overstated

`atRiskAfter` is **`atRiskBefore - maxFlow`**. It is a **projection**: it assumes
every listed review happens *and* transfers enough knowledge. Nothing re-reads the
graph afterwards. The CLI prints "IF every review below happens — a projection, not a
measurement"; the MCP payload carries the same disclaimer inside the JSON
(`src/mcp/tools.ts:198`) because an agent never sees the CLI's text.

Live on fastify `.github/workflows`: **10 at risk, all 10 coverable, projected 1,
bottleneck `bandwidth`** — 9 reviews across 5 reviewers, and `lock-threads.yml` is
left because `climba03003`, `eomm`, `mcollina` and `uzlopak` are all at budget.
Raise `--budget` to 3 and it clears: 10 reviews, 4 reviewers. **That is the cut being
actionable**, and it is the best 20 seconds of the demo.

## 6. `review` — and why it is the honest weak spot

`REVIEW_CYPHER`, `src/tools/review.ts:74`. Score = doa on the PR's files **plus** doa
on their co-change neighbours weighted by co-change support, author excluded.

Two bugs avoided that are worth describing, both of which produce *plausible output
rather than an error*:

1. **Landmine 10.** `RETURN direct + sum(t2.doa * c.support)` — mixing a
   `WITH`-carried value with a fresh aggregate — is **accepted by FalkorDB and
   returns null for every row**, and `ORDER BY` then sorts nulls. So the two legs
   never meet in Cypher: it is a `UNION ALL` of one row per person per leg, summed in
   TypeScript by `mergeLegs` (`src/tools/review.ts:61`).
2. A co-change neighbour the PR **also** modifies would be counted twice, once as
   direct and again as co-change. Hence `WHERE NOT (pr)-[:MODIFIED]->(g)`.

### The measurement, and what it says

`src/eval/backtest.ts`. **hit-rate@1/@3, not precision@k** — a PR usually has one or
two reviewers, so precision@3 is capped near 0.67 by the ground truth itself and
would understate every predictor equally.

| fastify (30 held out, cut `2026-09-22`) | @1 | @3 |
|---|---|---|
| `review` | 13% | 30% |
| most-active baseline | **17%** | **43%** |
| random | 7% | 13% |

| vite (30 held out, 28 scored, cut `2026-10-09`) | @1 | @3 |
|---|---|---|
| `review` | 64% | 79% |
| most-active baseline | **71%** | **100%** |
| random | 18% | 36% |

**`review` beats random and loses to the trivial most-active baseline on both repos.**
On vite the baseline is perfect at k=3 because ten people do all the reviewing. This
is published as measured — and it is *why* the headline is `fix`'s counterfactual and
not review precision. Co-change nomination (letting someone who only touched a
neighbouring file be a candidate, not just a tie-breaker) was tried and **did not move
the number on either repo**; that negative result is reported as-is.

### How leakage is closed

The thing to be able to say precisely:

- `splitHoldout` (`src/eval/backtest.ts:76`) sorts merged PRs newest-first, takes the
  last 30 **non-bot-authored** ones, and sets the cutoff to the oldest held-out PR's
  `mergedAt`. The comparison is **strict `<`**: a PR merged exactly at the cutoff
  belongs to the holdout, never to training.
- Git history is re-parsed with `git log --until=<cutoff>`, and **`doa` is recomputed
  with `asOf = cutoff`** (`finish(asOf)` in `src/ingest/gitlog.ts:430`) so the recency
  term is not computed from today.
- `withheldReviews` (line 93) keeps each held-out PR's node, author and `MODIFIED`
  edges — `review` legitimately needs to know which files changed — but **strips its
  `REVIEWED_BY` edges**, which are the answer being predicted.
- Bot-authored PRs stay in *training* as evidence of activity but are barred from the
  *holdout*: 17 of fastify's last 50 merged PRs are github-actions backports, and
  predicting a reviewer for an automated cherry-pick measures nothing.
- The whole thing runs in a throwaway `backtest:<uuid>` graph, so the demo graph is
  untouched. **One known leak, stated in the code:** `File.alive` still comes from
  today's HEAD. `review` does not read `alive`, so it cannot affect this number —
  but it is a leak in the graph, not an absence of one, and that is the honest way
  to put it.

## 7. Architecture, in one pass

```
git log ──> gitlog.ts (pure parser + model builder) ──┐
                                                      ├──> load.ts ──> FalkorDB
GitHub GraphQL ──> github.ts (cached under .cache/) ──┘              repo:<owner>-<name>
                                                                            │
                        ┌───────────────────────────────────────────────────┤
                        │                                                   │
          src/tools/{impact,risk,review,fix}.ts                   src/eval/backtest.ts
                        │                                            (backtest:<uuid>)
          ┌─────────────┴─────────────┐
      CLI (commander)            src/mcp/{tools,server}.ts  ──  npm run mcp
```

The shape to point at: **every tool splits into a pure part and a thin database
part.** `minCut`, `buildNetwork`, `eligibleByFile`, `classifyBottleneck`,
`mergeLegs`, `hitRate`, `splitHoldout` are all pure functions with no database, which
is why 167 tests run in under two seconds without a container. Ingest is deterministic
git parsing — **no LLM anywhere in the ingest path**, so the same repo at the same
`--since` always yields the same graph.

The MCP server is hand-rolled JSON-RPC over stdio, no SDK: the four methods a client
needs (`initialize`, `tools/list`, `tools/call`, `ping`) are about 120 lines. One MCP
detail worth knowing: **a failing tool is `isError` in the *result*, not a JSON-RPC
error**, so the model can read the message and retry. And every MCP tool **requires
`repo`** at the schema level — the CLI can warn on stderr when `--repo` is missing,
but an MCP client never sees stderr, so the unquotable state is made unreachable
instead of merely discouraged.

## 8. Known limitations — say these before you are asked

1. **`atRiskAfter` is a projection, never a measurement.** Always quoted with
   `--budget`, `--theta`, `--candidates` and `--ceiling`.
2. **`review` loses to a trivial baseline** on both measured repos.
3. **The doa coefficients (1.0 / 0.5 / 0.2, 180 days) are hand-set**, not fitted.
   θ = 0.2 and the 5-candidate shortlist are explicitly provisional in the spec.
4. **Reviewing a file is a proxy for learning it.** The model assumes a review
   transfers enough knowledge to lift bus-factor-1. Nothing measures that.
5. **Minimality is within the network**, not over all possible assignments: same
   shortlist, same budget. Lifting the shortlist covers more, which is what
   `--ceiling` reports (vite 106 vs 44).
6. **One measurement per claim.** Nothing was re-tuned after measuring and then
   re-reported as if measured once.
7. **`File.alive` is computed from today's HEAD**, including inside the backtest.

## 9. Fast self-test before recording

If any of these feels shaky, re-read the section above it.

- [ ] Why does `cap=1` out of SOURCE mean max flow counts *files*?
- [ ] Why can't the flow network live in the repo graph?
- [ ] Why is `classifyBottleneck` computed from unserved files rather than cut edges?
- [ ] What exactly does `atRiskAfter` assume, and what re-checks it? (Nothing.)
- [ ] Why hit-rate@k and not precision@k?
- [ ] What is strictly excluded from the training set, and what deliberately isn't?
- [ ] Why is `Person.login` lowercased, and what breaks if it isn't?
- [ ] What does FalkorDB do at 10,000 rows, and where is that handled?
- [ ] Why are `review`'s two legs summed in TypeScript instead of in Cypher?
- [ ] Which number here is the honest weak result, and why publish it?
