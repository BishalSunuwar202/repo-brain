# Repo Brain

Repo Brain reads a repository's git history into a FalkorDB graph: who wrote which
files, how much of each file they know, and which files change together. Its
headline command, `fix`, uses max-flow / min-cut to prescribe the **smallest** set of
code-review assignments that spreads knowledge out of files only one person
understands, without assigning anyone who lacks the expertise to review well.

Built for FalkorDB Graph Hacks, October 2026.

## Run it

You need Node ≥ 22, the GitHub CLI (`gh`, logged in: ingest uses it to resolve
commit emails to GitHub logins), and FalkorDB at `redis://localhost:6379`
(override with `FALKORDB_URL`).

```bash
npm i
docker run -d -p 6379:6379 -p 3100:3000 -v "$(pwd)/.falkordata:/data" falkordb/falkordb:latest

git clone --single-branch https://github.com/fastify/fastify /tmp/fastify
npm run brain -- --repo fastify/fastify ingest /tmp/fastify --fresh
npm run brain -- --repo fastify/fastify risk
npm run brain -- --repo fastify/fastify fix --ceiling
```

`--repo owner/name` picks the graph (`repo:<owner>-<name>`) and turns on identity
resolution. Without it, people are identified by email local-part only, and one
person can split into two. Do not quote numbers from a run without `--repo`.

The ingest window defaults to `--since "2 years ago"`. That is relative, so counts
drift as time passes; pin an absolute date to reproduce a published number. All
output below is from fastify/fastify, ingested on 2026-10-15.

`npm test` runs the unit tests. `npm run test:live` runs the database tests and needs
the container.

## The graph data model

One graph per repository, named `repo:<owner>-<name>`. Everything is derived from
`git log` plus merged-PR metadata — no LLM is involved in building the graph.

```text
(:Person {login, name, firstSeen, lastSeen})
(:File   {path, module, alive})
(:Commit {sha, ts, author})
(:PR     {number, title, mergedAt})

(:Person)-[:TOUCHED    {commits, bulkCommits, adds, dels, lastTs, doa}]->(:File)
(:File)  -[:CO_CHANGED {weight, support}]->(:File)
(:PR)    -[:AUTHORED_BY]->(:Person)
(:PR)    -[:MODIFIED]->(:File)
(:PR)    -[:REVIEWED_BY {at}]->(:Person)
```

Indexes applied before every load (`src/schema/ddl.ts`):

```cypher
CREATE INDEX FOR (p:Person) ON (p.login)
CREATE INDEX FOR (f:File)   ON (f.path)
CREATE INDEX FOR (f:File)   ON (f.module)
CREATE INDEX FOR (c:Commit) ON (c.sha)
CREATE INDEX FOR (r:PR)     ON (r.number)
```

Four decisions worth knowing:

- **`Person` is keyed by lowercase GitHub login**, resolved from commit email via the
  GitHub API and cached. One human with two commit emails must become one node, or a
  bus-factor-1 file stops looking bus-factor-1.
- **`TOUCHED.doa` is degree of authorship**, normalised per file so each file's doa
  sums to 1. That is what makes "holds more than half of this file" meaningful.
- **`CO_CHANGED` is stored once per pair**, `(a)-[:CO_CHANGED]->(b)` with `a < b`, and
  matched undirected in every query. `support` is the share of the rarer file's
  commits that include both.
- **Timestamps are UTC ISO strings**, so string order is time order. Git's `%aI`
  keeps the author's local offset, which would break that.

## The queries and algorithms it depends on

Each block below is copied from the constant that runs it, so what the README claims
and what the code sends are the same text.

**`algo.maxFlow` — the contribution** (`MAXFLOW_CYPHER`, `src/tools/fix.ts`). The
network is materialised in a throwaway `flow:<uuid>` graph and solved in the engine:

```cypher
MATCH (s:FlowNode {name: $source}) MATCH (t:FlowNode {name: $sink})
WITH collect(s) AS sources, collect(t) AS targets
CALL algo.maxFlow({
  sourceNodes: sources, targetNodes: targets,
  relationshipTypes: ['FLOWS_TO'], capacityProperty: 'cap', nodeLabels: ['FlowNode']
})
YIELD edges, edgeFlows, maxFlow
UNWIND range(0, size(edges) - 1) AS i
RETURN maxFlow, startNode(edges[i]).name AS src, endNode(edges[i]).name AS dst, edgeFlows[i] AS flow
```

`SOURCE` and `SINK` are real nodes rather than the procedure's built-in multi-source
mode, which wires infinite-capacity virtual nodes and would erase the capacity-1 and
budget limits the whole model rests on.

**Bus-factor-1 files** (`RISK_CYPHER`, `src/tools/risk.ts`). One row per file, never
per edge: a read returning more than 10,000 rows is silently truncated by FalkorDB,
so every read is also wrapped in `underCap()`.

```cypher
MATCH (p:Person)-[t:TOUCHED]->(f:File)
WHERE f.alive AND t.commits > 0 AND ($module IS NULL OR f.module = $module)
WITH f, collect({login: p.login, doa: t.doa, lastTs: t.lastTs}) AS holders, sum(t.doa) AS total, sum(t.commits) AS commits
WHERE commits >= $minCommits AND total > 0
WITH f, holders, total, commits, [h IN holders WHERE h.doa / total > $threshold] AS dominant
WHERE size(dominant) = 1
WITH f, holders, total, commits, dominant[0] AS sole
RETURN f.path AS path, f.module AS module, sole.login AS soleHolder, sole.doa / total AS share,
       commits, size(holders) AS holders, [h IN holders WHERE h.login <> sole.login | h.lastTs] AS otherTs
ORDER BY share DESC, path
```

The list comprehension is not stylistic: FalkorDB has no `EXISTS { MATCH … }`
subqueries, so "is there exactly one dominant holder" has to be collected and then
filtered.

**Reviewer suggestion** (`REVIEW_CYPHER`, `src/tools/review.ts`). Two legs: people who
touched the PR's own files, and people who touched a co-change neighbour of them. The
second leg lets co-change *nominate* a reviewer, not merely re-rank one.

```cypher
MATCH (pr:PR {number: $number})-[:MODIFIED]->(f:File)<-[t:TOUCHED]-(p:Person)
WHERE NOT (pr)-[:AUTHORED_BY]->(p)
WITH p, sum(t.doa) AS direct
RETURN p.login AS login, direct, 0.0 AS co
UNION ALL
MATCH (pr:PR {number: $number})-[:MODIFIED]->(:File)-[c:CO_CHANGED]-(g:File)<-[t2:TOUCHED]-(p:Person)
WHERE NOT (pr)-[:MODIFIED]->(g) AND NOT (pr)-[:AUTHORED_BY]->(p)
WITH p, sum(t2.doa * c.support) AS co
RETURN p.login AS login, 0.0 AS direct, co
```

The two sums are added per person in TypeScript, never in Cypher — see the engine
note below. `NOT (pr)-[:MODIFIED]->(g)` stops a neighbour the PR also changed being
counted on both legs, and the author is excluded on both, or they could re-enter
through a neighbour of their own change.

**Co-change neighbours** (`IMPACT_CYPHER`, `src/tools/impact.ts`):

```cypher
MATCH (f:File {path: $path})-[c:CO_CHANGED]-(g:File)
WHERE g.alive AND c.support > $minSupport
RETURN g.path AS path, c.weight AS weight, c.support AS support
ORDER BY support DESC, weight DESC, path
LIMIT 100
```

**Reviewer eligibility for `fix`** (`ELIGIBLE_CYPHER`, `src/tools/fix.ts`) — one row
per module, so the result cannot blow the row cap however large the repo:

```cypher
MATCH (r:Person)-[t:TOUCHED]->(g:File)
WHERE g.alive AND t.commits > 0 AND t.doa > $theta AND ($module IS NULL OR g.module = $module)
RETURN g.module AS module, collect({login: r.login, via: g.path, doa: t.doa}) AS experts
```

### Two engine behaviours the code works around

Both were found by probing a live graph, not by reading documentation:

- `algo.maxFlow` returns **only positive-flow edges, and never the min cut.** The cut
  is derived in TypeScript with one breadth-first search over the residual network
  from `SOURCE`.
- An expression mixing a `WITH`-carried value with a fresh aggregate
  (`RETURN direct + sum(x)`) is **accepted and returns null** — no error, and
  `ORDER BY` then sorts the nulls. Every aggregate is closed in its own `WITH`, and
  `review`'s two legs are summed in TypeScript for exactly this reason.

## The four commands

### `impact <path>`: what else moves when I touch this file

```text
$ npm run brain -- --repo fastify/fastify impact lib/reply.js
Files that change with lib/reply.js (support = share of the rarer file's commits that include both):
  100%    3x  lib/context.js
   67%    4x  lib/logger-factory.js
   60%    3x  lib/decorate.js
   50%    4x  lib/four-oh-four.js
   50%    3x  eslint.config.js
   33%    8x  lib/route.js
   33%    3x  lib/error-handler.js
  +3 test files (--include-tests to list)
```

Tests are collapsed into a count by default: a test moving with its source is
mechanical coupling, not news. Lockfiles, snapshots and generated output are never
co-change evidence.

### `risk`: where knowledge sits with one person

```text
$ npm run brain -- --repo fastify/fastify risk --limit 8
repo:fastify-fastify  bus-factor-1 = one person holds >0.5 of doa, on files with >=3 authorship commits

by kind (at-risk / active files):
  source     1 / 28     eomm holds 1
  test      13 / 84     mrazauskas holds 5
  ci        11 / 17     fdawgs holds 10
  docs       7 / 37     fdawgs holds 6
  types      0 / 10

32 files:   share commits people  others-last  holder               path
  ci      100%       3      1        never  fdawgs               .github/workflows/lint-ecosystem-order.yml
  ci      100%       5      1        never  fdawgs               .github/workflows/lock-threads.yml
  ci      100%       5      1        never  fdawgs               .github/workflows/md-lint.yml
  docs    100%       5      1        never  fdawgs               docs/Reference/Middleware.md
  test    100%       3      1        never  mrazauskas           test/types/using.tst.ts
  test     69%       4      2     672d ago  mrazauskas           test/types/content-type-parser.tst.ts
  ci       68%       6      2      72d ago  fdawgs               .github/workflows/integration-alternative-runtimes.yml
  test     67%       3      2     724d ago  mcollina             test/http2/plain.test.js
  … 24 more (--limit, --json)
```

fastify's source code is healthy: 1 of 28 active source files is at risk. Its CI
pipeline is not: 11 of 17 active CI files are bus-factor-1, and one maintainer holds
10 of those 11. How the rule was chosen is under [How `risk` decides](#how-risk-decides-a-file-is-bus-factor-1).

### `fix`: the fewest reviews that spread that knowledge

```text
$ npm run brain -- --repo fastify/fastify fix --ceiling
repo:fastify-fastify  fix: budget 2 reviews/person, reviewer needs doa >0.2 on another file in the module, top 5 candidates per file

  at risk now             32  (one person holds >0.5 of doa, >=3 authorship commits)
  have a reviewer         32
  projected at risk        1  IF every review below happens — a projection, not a measurement
    with no shortlist      1  (every eligible reviewer allowed; top 5 costs 0)
  bottleneck           bandwidth
        1 left because reviewers are at budget (--budget): climba03003, eomm, mcollina, uzlopak
  still at risk
    .github/workflows/lock-threads.yml

31 reviews for 19 reviewers (the minimum that achieves the projection):
  climba03003
    .github/workflows/coverage-win.yml
    .github/workflows/lint-ecosystem-order.yml
  dancastillo
    test/custom-parser.0.test.js
    test/request-header-host.test.js
  eomm
    .github/workflows/citgm-package.yml
    .github/workflows/integration.yml
  …
```

On fastify, 31 reviews across 19 people would take the bus-factor-1 count from
**32 to a projected 1** (top 5 candidates per file, budget 2; with no shortlist
the projection is also 1). That is a **projection**: it assumes every review
happens and transfers enough knowledge, and nothing re-measures it. The one file
left over, `lock-threads.yml`, stays because all four of its candidate reviewers
are already at budget. With `--budget 3` the projection is 0: 32 reviews across 13
people.

Options: `--budget` (reviews per person, default 2), `--theta` (expertise floor,
default 0.2), `--candidates` (shortlist size, default 5), `--ceiling` (also solve
with no shortlist), plus `risk`'s `--threshold`, `--min-commits`, `--kind` and
`--module`.

### `review <pr>`: who should review this PR

`review` scores candidates by expertise on the PR's files and their co-change
neighbours. It is the baseline the backtest measures, not the contribution.

v1 has **no open-review load penalty**: ingest does not fetch open PRs, so `review`
cannot know who is already busy (spec §12 D7).

**Measured.** On fastify/fastify: 30 held-out merged PRs (bot-authored PRs barred
from the holdout; all 30 had at least one human reviewer), history cut at
`2026-09-22T08:46:53Z`, 257 training PRs, 18 reviewers active before the cutoff,
seed 20261018.

| predictor            | hit-rate@1 | hit-rate@3 |
|----------------------|------------|------------|
| `review`             | 13%        | 30%        |
| most-active baseline | **17%**    | **43%**    |
| random baseline      | 7%         | 13%        |

The same measurement on **vitejs/vite** (30 held out, 28 with a human reviewer,
cut at `2026-10-09T02:12:26Z`, 267 training PRs, 10 active reviewers):

| predictor            | hit-rate@1 | hit-rate@3 |
|----------------------|------------|------------|
| `review`             | 64%        | 79%        |
| most-active baseline | **71%**    | **100%**   |
| random baseline      | 18%        | 36%        |

On both repos `review` beats random and **loses to the trivial most-active
baseline** — on vite the baseline is simply perfect at k=3, because ten people do
all the reviewing. That is the measured result, published as measured. Ranking whoever reviewed the most PRs
is a strong heuristic on a repo with a small active reviewer core — it covers
69–100% of PRs on every repo vetted here — which is exactly why this project's
headline is `fix`'s counterfactual rather than review precision.

Hit-rate@k, not precision@k: most PRs have one or two reviewers, so precision@3 is
capped near 0.33 and would measure the cap more than the ranking (spec §12 D1).

Reproduce:

```bash
npm run brain -- --repo fastify/fastify backtest .cache/repos/fastify/fastify \
  --holdout 30 --pr-limit 300
```

Leakage control: PRs are sorted by merge time, the newest 30 held out, and
`git log --until=<cutoff>` cuts commit history at the boundary (strict `<`).
Held-out PR nodes, their files and their authors are loaded — all of that is
legitimate input at prediction time — but their `REVIEWED_BY` edges, the answer,
are not. Without the history cut the held-out PR's own commits sit in the graph
and `review` scores the author on the very change it is predicting for.

## MCP server: the same four tools, for an agent

```bash
npm run mcp          # JSON-RPC 2.0 over stdio
```

Register it with any MCP client:

```json
{ "command": "npx", "args": ["tsx", "src/mcp/main.ts"], "cwd": "<this repo>" }
```

It exposes `repo_impact`, `repo_risk`, `repo_review` and `repo_fix`. Two things are
deliberate:

- **`repo` is required on every tool.** The CLI warns on stderr when `--repo` is
  missing, because identities then fall back to email local-parts and the numbers
  are not quotable. An MCP client never sees stderr, so the schema makes that state
  unreachable instead of merely discouraged.
- **`repo_fix`'s payload carries its own disclaimer.** The CLI prints "a projection,
  not a measurement" next to `atRiskAfter`; an agent reading JSON would never see
  that prose, so `atRiskAfterIsProjection: true` and the `disclaimer` string travel
  in the result, beside the `budget`, `theta` and `candidates` the number is only
  meaningful with.

No MCP SDK dependency — the four methods an MCP client needs (`initialize`,
`tools/list`, `tools/call`, `ping`) are about 120 lines of framing in
`src/mcp/server.ts`, and `src/mcp/tools.ts` knows nothing about transport.

## How `fix` works

`fix` builds an explicit flow network:

```text
SOURCE ──cap 1──▶ at-risk file ──cap 1──▶ eligible reviewer ──cap k_r──▶ SINK
```

- Each **at-risk file** (from `risk`) needs one review: capacity 1 from SOURCE.
- A file connects to a reviewer, with capacity 1, only if the reviewer is
  **eligible**: not the file's sole holder, and holding more than θ (default 0.2)
  of the knowledge of some *other* live file in the same module. Each file keeps
  its 5 strongest eligible reviewers (`--candidates`).
- Each reviewer can absorb **k_r** extra reviews (`--budget`, default 2): capacity
  k_r to SINK.

The network is written into a throwaway `flow:<uuid>` graph and solved with
FalkorDB's `algo.maxFlow`. The graph is deleted afterwards, even if the solve fails.
SOURCE and SINK are real nodes. `algo.maxFlow`'s built-in multi-source mode uses
infinite-capacity virtual nodes, which would erase the capacity-1 and k_r limits.

The flow on each file→reviewer edge is the assignment. `algo.maxFlow` returns
flows but **never the cut**, so the min cut is derived in TypeScript with one
breadth-first search over the residual network from SOURCE. The cut does two jobs:

- **It proves minimality.** By the max-flow min-cut theorem, the cut's capacity
  equals the max flow. Within this network — the same `--candidates` shortlist and
  the same `--budget` — no set of assignments can de-risk more files, and the
  solution uses exactly one review per de-risked file. It is **not** a claim about
  all possible assignments: lifting the shortlist can cover more, which is exactly
  what `--ceiling` measures (undici 13 vs 2, vite 106 vs 44).
- **It names the bottleneck.** The reviewers whose SINK edges cross the cut are
  the people whose budget binds. The output then splits what is left exactly:
  files with no eligible reviewer at all (`--theta` is the lever), and files
  whose reviewers are all at budget (`--budget` is the lever).

`fix`'s "after" number is `atRiskBefore − maxFlow`, a **projection** and never a
measurement. Always quote it with its shortlist size N and its `--ceiling`.
Projected bus-factor-1 files after `fix` at the defaults (budget 2, θ 0.2, N = 5):

| repo | at risk | have a reviewer | projected after (N = 5) | `--ceiling` (no shortlist) |
|---|---|---|---|---|
| fastify/fastify | 32 | 32 | 1 | 1 |
| nodejs/undici | 82 | 82 | 13 | 2 |
| vitejs/vite | 189 | 179 | 106 | 44 |
| FalkorDB/FalkorDB | 86 | 84 | 63 | 60 |
| pnpm/pnpm | 1593 | 1572 | 1411 | 1029 |

## How `risk` decides a file is bus-factor-1

Each person gets a degree-of-authorship (`doa`) score per file: creator bonus, plus
log-damped commit count, plus a recency term. It is normalised so shares on a file
sum to 1 (after Fritz et al.'s Degree-of-Knowledge). A file is **bus-factor-1** when
one person holds **more than half** of its `doa` and the file has **at least 3
authorship commits** in the ingest window.

- **0.5 is a definition, not a tuned dial.** At any threshold ≥ 0.5 at most one
  person can exceed it, so the rule means exactly "one person holds a strict
  majority". `--threshold` remains for exploring.
- **The activity floor is what makes the list mean something.** Without it, the
  list is files someone touched once: cold files, not concentrated knowledge.
- **Higher thresholds hide multi-author concentration.** Commit counts are
  log-damped, so one extra contributor caps the top share near 0.7. At 0.8 the rule
  degenerates to "only one person ever touched it".

Measured on fastify/fastify, 2-year window. Each cell is at-risk files, with the
multi-contributor ones in parentheses:

| min commits | 0.5 | 0.6 | 0.7 | 0.8 |
|---|---|---|---|---|
| 1  | 190 (98) | 112 (20) | 100 (8) | 92 (0) |
| **3**  | **32 (27)** | 17 (12) | 5 (0) | 5 (0) |
| 5  | 11 (8)  | 5 (2)  | 3 (0) | 3 (0) |
| 10 | 1 (1)   | 1 (1)  | 0     | 0     |

**Output is split by file kind**: source, test, CI/dotfiles, docs, types. Tests count
as knowledge here but are hidden by default in `impact`. That is deliberate. In
`impact`, a test moving with its source is noise for "what else must I change". In
`risk`, a test only one person understands is genuine risk.

**Recency is a column, not a filter.** The original rule also required that no one
else had touched the file in 180 days. Measured at the old 0.8 threshold, it
excluded 0 additional files on fastify (2-, 5- and 10-year windows) and 2 on
FalkorDB. Recency already sits inside `doa`, so `risk` reports "days since anyone
else touched it" and filters nothing on it.

**Bulk commits are not authorship.** A commit touching more than 50 files (a vendor
drop, a codebase import, a mass reformat) gives its author no creator credit and no
`doa`. Files only bulk commits ever touched are never reported. Without this rule,
FalkorDB/FalkorDB's August 2026 Rust-engine import made its author the "sole
holder" of 274 files under the old 0.8 rule. With it, the same rule gives 69 (19 at
the current defaults).

## Prior art

None of the components is new. The contribution is the **assembly**: an expertise
graph in FalkorDB feeding a max-flow / min-cut that prescribes the minimal set of
reviews, with a proof of minimality and a named bottleneck.

- **CodeScene** (Adam Tornhill, *Your Code as a Crime Scene*): behavioural code
  analysis, knowledge maps, bus-factor and change coupling from version control.
  `impact` and `risk` follow this tradition.
- **Fritz et al., "A Degree-of-Knowledge Model to Capture Source Code
  Familiarity"** (ICSE 2010): the creator / commits / recency shape of `doa`.
- **Mockus & Herbsleb, "Expertise Browser"** (ICSE 2002): expertise derived from
  change history.
- **Thongtanunam et al., RevFinder** (SANER 2015): reviewer recommendation from
  the review history of files with similar paths.
- **SofiaWL** (Mirsaeedi & Rigby, ICSE 2020): reviewer recommendation that
  deliberately spreads knowledge to reduce turnover risk. This is the closest
  prior work to `fix`'s goal. `fix` differs in posing it as a capacitated flow
  problem with a minimality proof, rather than as a per-PR ranking.

## Limitations

- **`fix`'s "after" is a projection.** It assumes every prescribed review happens
  and actually transfers knowledge. Nothing measures that.
- **The 5-candidate shortlist is a documented trade-off, not a tuned dial.**
  `algo.maxFlow` maximises the number of covered files and does not care who
  covers them. With every eligible reviewer in the network, it picked arbitrary
  ones (in practice, whoever sorted first). With no shortlist the projection is
  better, but only by assigning files to reviewers whose expertise barely clears
  the θ = 0.2 floor. `--ceiling` prints both numbers so the cost is visible:
  0 files on fastify, 62 on vite. θ and N are both provisional until the backtest
  tunes them.
- **The 0.8 threshold was wrong, and we measured why.** At 0.8, `risk` meant
  "exactly one person ever touched it". 62 of the 78 fastify files it flagged had a
  single commit in the window: cold code, not concentrated knowledge. That is why
  the default is a 0.5 strict majority with a 3-commit floor.
- **No open-review load penalty** in `review` (ingest does not fetch open PRs).
- **Renames inside very large commits** can appear as delete plus add, because git
  skips exhaustive rename detection there (`diff.renameLimit`). Bulk commits no
  longer feed `doa`, so this affects only which paths count as alive.
- **The ingest window is relative** by default, so numbers drift with time.
