# Repo Brain — FalkorDB Graph Hacks submission

<!--
OPEN BEFORE SUBMITTING (delete this block once settled):
- Tracks: the rules page (wemakedevs.org/hackathons/falkordb/rules, read 2026-10-17)
  names "Agents That Act on Connected Data", "Agent Memory and Coordination" and
  "Company Brain", and allows entering any or all (spec §10, corrected). The choice
  below is a recommendation for the owner to confirm.
- The AI disclosure (rule 11) is the owner's to write. It is a statement about the
  owner's own work, and rule 13 makes its accuracy matter.
- Window closes Oct 18 2026, 11:59 PM IST (rule 7).
-->

## What it is

Repo Brain reads a repository's git history into a FalkorDB graph of who knows which
files and which files change together. Its headline command, `fix`, runs max-flow /
min-cut on that graph to prescribe the fewest code reviews that spread knowledge out
of files only one person understands, assigning only reviewers who clear an
expertise floor.

## Tracks

<!-- Owner to confirm. -->

- **Company Brain.** The graph is an organisation's map of who knows what in its
  code: degree-of-authorship on every person→file edge, co-change between files,
  and who reviewed which PR. `risk` reads where that knowledge has one holder, and
  `fix` says how to spread it.
- **Agents That Act on Connected Data.** An MCP server exposes the four commands as
  tools (`repo_impact`, `repo_risk`, `repo_review`, `repo_fix`), one graph per
  repo, with `repo` required on every call. An agent gets `fix`'s prescription as
  JSON, which carries its own "projection, not a measurement" flag. The agent
  receives a prescription; it does not assign reviewers itself.

We are not entering Agent Memory and Coordination. Nothing here stores agent memory.

## The headline: `fix`

`fix` builds a flow network from the graph and solves it with FalkorDB's
`algo.maxFlow`:

```text
SOURCE ──cap 1──▶ at-risk file ──cap 1──▶ eligible reviewer ──cap k_r──▶ SINK
```

- **At-risk files** come from `risk`: one person holds more than half of the file's
  degree-of-authorship, over at least 3 authorship commits.
- **An eligible reviewer** is not the file's sole holder, and holds more than θ = 0.2
  of the knowledge of another live file in the same module. Each file keeps its 5
  strongest candidates.
- **k_r** is each reviewer's review budget, default 2.

The flow on each file→reviewer edge is the assignment. `algo.maxFlow` returns flows
but not the cut, so the min cut is derived with one residual breadth-first search.
The cut does two jobs:

- **It certifies the result.** No assignment within the same shortlist and budgets
  covers more files. Each review covers one file, so the prescribed set is also the
  fewest reviews that reach that coverage.
- **It names the bottleneck.** The reviewers whose budget crosses the cut are the
  people whose time binds. What remains splits into files nobody is qualified to
  review (raise or lower `--theta`) and files whose reviewers are full (raise
  `--budget`).

On fastify/fastify at the defaults (budget 2, θ 0.2, top 5 candidates), 32 files
are bus-factor-1. 31 reviews across 19 people take that to a **projected** 1, and
with no shortlist (`--ceiling`) the projection is also 1. With `--budget 3` the
projection is 0: 32 reviews across 13 people.

**That number is a projection, never a measurement.** It is `atRiskBefore −
maxFlow`, and it assumes every prescribed review happens and transfers enough
knowledge. Nothing re-measures the graph afterwards. The same defaults on other
repos:

| repo | at risk | have a reviewer | projected after (N = 5) | `--ceiling` (no shortlist) |
|---|---|---|---|---|
| fastify/fastify | 32 | 32 | 1 | 1 |
| nodejs/undici | 82 | 82 | 13 | 2 |
| vitejs/vite | 189 | 179 | 106 | 44 |
| FalkorDB/FalkorDB | 86 | 84 | 63 | 60 |
| pnpm/pnpm | 1593 | 1572 | 1411 | 1029 |

The shortlist has a cost: on vite it leaves 62 files that a full network would
cover. With no shortlist, `algo.maxFlow` maximises coverage and is indifferent to
who covers a file, so the extra coverage comes from reviewers barely over the
expertise floor. `--ceiling` prints both numbers so the trade-off is visible.

## Why the graph is load-bearing

**What runs in FalkorDB.** Every command reads the graph with Cypher, and nothing
works without it.

- `fix`'s flow network is materialised as a throwaway `flow:<uuid>` graph, solved
  with `algo.maxFlow`, and deleted afterwards. SOURCE and SINK are real nodes,
  because `algo.maxFlow`'s multi-source mode uses infinite-capacity virtual nodes
  that would erase the capacity-1 and budget limits.
- `fix`'s eligibility read, `risk`'s per-file holder aggregation, `impact`'s
  co-change neighbours and `review`'s two-hop PR→file←person and
  file–co-change–file←person scores are all Cypher over the repo graph.

**What does not run in FalkorDB.** We are not claiming more than this:

- Git parsing, and the arithmetic for degree-of-authorship and co-change weights,
  happen in TypeScript at ingest. The results are stored as edge properties.
- The min cut is computed in TypeScript from `algo.maxFlow`'s flows, because the
  procedure does not return it. Ranking, shortlisting and output formatting are
  TypeScript too.
- `impact`, `risk` and `review` are one- and two-hop queries. A relational database
  could answer them with joins. The graph makes them natural, not possible.
- Max-flow is the genuinely graph-algorithmic part, and FalkorDB is what solves it.
  It could also be solved by a standalone max-flow library. The claim is that the
  data model is a graph and the algorithm is a graph algorithm, run in the engine.
  It is not that only a graph database could do this.

## Graph data model

One graph per repository, `repo:<owner>-<name>`.

```text
(:Person {login, name, firstSeen, lastSeen})
    -[:TOUCHED {commits, bulkCommits, adds, dels, lastTs, doa}]->(:File {path, module, alive})
(:File)-[:CO_CHANGED {weight, support}]->(:File)     stored one way, read undirected
(:PR {number, mergedAt, title})-[:AUTHORED_BY]->(:Person)
(:PR)-[:REVIEWED_BY {at}]->(:Person)
(:PR)-[:MODIFIED]->(:File)
(:Commit {sha, ts, author})                          no edges; author is a login, null for bots
```

Indexes: `Person.login`, `File.path`, `File.module`, `Commit.sha`, `PR.number`.

`fix`'s solve graph, `flow:<uuid>`, is `(:FlowNode {name})-[:FLOWS_TO {cap}]->(:FlowNode)`.

## The Cypher the product depends on

`fix`, solving the flow network (`src/tools/fix.ts`):

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

`fix`, finding who clears the expertise floor in each module:

```cypher
MATCH (r:Person)-[t:TOUCHED]->(g:File)
WHERE g.alive AND t.commits > 0 AND t.doa > $theta AND ($module IS NULL OR g.module = $module)
RETURN g.module AS module, collect({login: r.login, via: g.path, doa: t.doa}) AS experts
```

`risk`, finding files where one person holds a strict majority (`src/tools/risk.ts`):

```cypher
MATCH (p:Person)-[t:TOUCHED]->(f:File)
WHERE f.alive AND t.commits > 0 AND ($module IS NULL OR f.module = $module)
WITH f, collect({login: p.login, doa: t.doa, lastTs: t.lastTs}) AS holders,
     sum(t.doa) AS total, sum(t.commits) AS commits
WHERE commits >= $minCommits AND total > 0
WITH f, holders, total, commits, [h IN holders WHERE h.doa / total > $threshold] AS dominant
WHERE size(dominant) = 1
WITH f, holders, total, commits, dominant[0] AS sole
RETURN f.path AS path, f.module AS module, sole.login AS soleHolder, sole.doa / total AS share,
       commits, size(holders) AS holders, [h IN holders WHERE h.login <> sole.login | h.lastTs] AS otherTs
ORDER BY share DESC, path
```

`impact`, finding what changes together (`src/tools/impact.ts`):

```cypher
MATCH (f:File {path: $path})-[c:CO_CHANGED]-(g:File)
WHERE g.alive AND c.support > $minSupport
RETURN g.path AS path, c.weight AS weight, c.support AS support
ORDER BY support DESC, weight DESC, path
```

`review`, scoring candidates on a PR's files and their co-change neighbours
(`src/tools/review.ts`):

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

## The measured number

`review` recommends reviewers for a PR. It is the baseline the backtest measures,
not the contribution. On fastify/fastify, 30 held-out merged PRs, history cut at
`2026-09-22T08:46:53Z`, 257 training PRs, 18 reviewers active before the cutoff,
random seed 20261018:

| predictor            | hit-rate@1 | hit-rate@3 |
|----------------------|------------|------------|
| `review`             | 13%        | 30%        |
| most-active baseline | **17%**    | **43%**    |
| random baseline      | 7%         | 13%        |

The same measurement on **vitejs/vite** (30 held out, 28 with a human reviewer, cut
at `2026-10-09T02:12:26Z`, 267 training PRs, 10 active reviewers):

| predictor            | hit-rate@1 | hit-rate@3 |
|----------------------|------------|------------|
| `review`             | 64%        | 79%        |
| most-active baseline | **71%**    | **100%**   |
| random baseline      | 18%        | 36%        |

On both repos `review` beats random and **loses to the trivial most-active
baseline**. On vite the baseline is perfect at k=3, because ten people do all the
reviewing. That is the measured result, published as measured. Ranking whoever reviewed the most PRs
is a strong heuristic on a repo with a small active reviewer core. It covers
69–100% of PRs on every repo we vetted, which is why the headline is `fix`'s
counterfactual rather than review precision.

There is no leakage. The newest 30 PRs are held out, and `git log --until=<cutoff>`
cuts commit history at the boundary. Held-out PRs' `REVIEWED_BY` edges, the
answers, are never loaded. Both baselines learn only from reviews before the
cutoff.

## Prior art

None of the components is new. The contribution is the **assembly**: an expertise
graph in FalkorDB feeding a max-flow / min-cut that prescribes the fewest reviews,
with a certificate that nothing does better under the same constraints and a named
bottleneck.

- **CodeScene** (Adam Tornhill, *Your Code as a Crime Scene*): knowledge maps,
  bus factor and change coupling from version control. `impact` and `risk` follow
  this tradition.
- **Fritz et al., Degree-of-Knowledge** (ICSE 2010): the creator / commits /
  recency shape of `doa`.
- **Mockus & Herbsleb, Expertise Browser** (ICSE 2002): expertise from change
  history.
- **RevFinder** (Thongtanunam et al., SANER 2015): reviewer recommendation from
  similar file paths.
- **SofiaWL** (Mirsaeedi & Rigby, ICSE 2020): reviewer recommendation that spreads
  knowledge to reduce turnover risk. It is the closest prior work to `fix`'s goal.
  `fix` differs by posing the problem as a capacitated flow with a certificate,
  rather than as a per-PR ranking.

## Limitations

- **`fix`'s "after" number is a projection.** It assumes every prescribed review
  happens and actually transfers knowledge. Nothing measures that.
- **The 5-candidate shortlist is a documented trade-off, not a tuned dial.**
  `--ceiling` prints its cost: 0 files on fastify, 62 on vite. θ = 0.2 and N = 5 are
  both provisional.
- **`review` loses to the most-active baseline** on both repos measured (above).
- **`review` has no open-review load penalty**, because ingest does not fetch open
  PRs.
- **Renames inside very large commits** can appear as a delete plus an add, because
  git skips exhaustive rename detection there. Bulk commits no longer feed `doa`, so
  this affects only which paths count as alive.
- **The ingest window is relative by default**, so numbers drift with time. Pin
  `--since` to reproduce one.

## Run it

Setup and every command are in the [README](../README.md#run-it). For the MCP
server, run `npm run mcp` (JSON-RPC 2.0 over stdio).

## AI assistance (rule 11)

<!-- OWNER WRITES THIS. Say which AI tools were used and what you did yourself.
     Do not submit this placeholder. -->

TODO(owner): AI-assistance disclosure.
