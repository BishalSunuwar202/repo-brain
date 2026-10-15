# Repo Brain — agent orientation

Read this first. It is deliberately short; the design lives in
`docs/superpowers/specs/2026-10-15-repo-brain-design.md`. **Read that spec before
doing any design work, and do not redesign it.** Its **§12 decision log is binding
and supersedes earlier sections where they conflict.**

## What this is

Hackathon entry for **FalkorDB Graph Hacks** (Oct 15–18 2026, online, solo build).
Ingests a git repo's history into FalkorDB (Redis-protocol graph DB, a *subset* of
OpenCypher) and answers four questions from a CLI. The headline feature is `fix`:
max-flow / min-cut to prescribe the **minimal** set of code-review assignments that
reduces knowledge-concentration (bus-factor) risk, subject to an expertise floor.

**Hard deadline: submission in by Oct 18 2026 18:00 IST.** Favour boring working
code over abstraction. When behind, cut per the spec's cut order (§8) — never cut
`fix`, the backtest number, or the demo video.

## Decisions already made — do not relitigate

- **TypeScript**, Node **>=22** (falkordb 6.8.0 requires it), ESM. No Python. (Owner is a JS/TS dev; a deadline is
  the wrong place to learn a language.)
- Client: `falkordb` (official falkordb-ts). Tests: built-in `node:test`.
- CLI first, MCP server second, **no web UI**.
- One graph per repo: `repo:<owner>-<name>`, using FalkorDB's multigraph topology.
- No LLM anywhere in the ingest path. Ingest is deterministic git parsing.

## Verified environment facts

- FalkorDB Browser is on **port 3100**. Ports 3000 and 3001 are BOTH held by
  unrelated `node` dev servers from the user's work projects. **Never kill those.**
- Container `repo-brain-db` is live: `-p 6379:6379 -p 3100:3000`, volume `.falkordata/`.
- Container: `repo-brain-db`, data volume `.falkordata/` (not `--rm`).
- `algo.maxFlow` takes `relationshipTypes` — **not** `relTypes`, which is what
  `algo.SPpaths` takes. See spec §5 for the verified signature.
- `algo.maxFlow` does **not** return the min-cut. It is derived in TS (spec §5).
- Multi-source/sink in `algo.maxFlow` uses *infinite-capacity* virtual super-nodes,
  so it cannot express our capacity constraints. We materialise explicit
  SOURCE/SINK nodes in a throwaway `flow:<uuid>` graph.

## Cypher landmines (FalkorDB is not Neo4j)

1. Unreferenced relationships are only existence-checked — add `WHERE ID(e) >= 0`
   when counting over `-[e]->`, or counts come back wrong.
2. `LIMIT` does not restrict eager operations — never `CREATE ... RETURN ... LIMIT`.
3. Indexes do not optimise `<>` filters.
4. No aggregations inside pattern comprehensions.
5. No regex operators — use `CONTAINS` / `STARTS WITH` / `string.matchRegEx()`.
6. No label expressions `(n:A|B)` — use `WHERE n:A OR n:B`.
7. Vector index queries do not combine with property filters.
8. **No `EXISTS { MATCH ... }` subqueries** — verified failure, parse error. Collect
   rows in the aggregation and filter with a list comprehension instead (spec §13).
   Also avoid `duration.inDays()` / `datetime()`; pass precomputed UTC ISO strings.

## Honesty requirements

- The README must credit prior art (CodeScene, Fritz et al. Degree-of-Knowledge,
  SofiaWL, RevFinder). The novelty claim is the **assembly**, not the components.
  Do not overstate it — it was already pressure-tested and narrowed once.
- The eval must report a **real measured** hit-rate@1/@3 (§12 D1 — NOT precision@k)
  from the backtest against
  two baselines. No synthetic data, no hand-labelling, no estimated numbers
  presented as measured.

## Conventions

- Do not `git commit` or `git push` unless explicitly asked.
- Do not add dependencies beyond those in `package.json` without asking.
- Do not invent FalkorDB procedure signatures. Verify against
  `https://docs.falkordb.com/algorithms/<name>.md` (every docs page has a `.md`
  variant) and say so when you do.
- Cache every GitHub API response to `.cache/` on first fetch — rate limits bite.
- Scratch work goes in `.cache/`, never in `src/`.

## Status (keep this current)

- [x] Design spec written and approved (+ §12 decision log — binding)
- [x] `algo.maxFlow` signature verified
- [x] Project scaffold + `src/ingest/gitlog.ts`, 17/17 tests passing
- [x] Eval repos vetted → `docs/superpowers/specs/repo-candidates.md`
- [x] FalkorDB container running + `maxFlow = 13` verified live (spec §13)
- [x] Parser hardening: identity resolution, lockfile + bot exclusion (§12 D3–D7), 27/27 tests
- [ ] Ingest → `impact` → `risk` → `review` + backtest → `fix` → MCP → video

## Eval + demo repos (§12 D8)

- Backtest number: **fastify/fastify**. Backup: getsentry/sentry-javascript.
- `risk`/`fix` demo: **FalkorDB/FalkorDB** (git history only — no FalkorDB repo
  qualifies for the backtest; their top-3 reviewers cover 91% of PRs).
- Headline is `fix`'s counterfactual, NOT review precision — the trivial
  most-active baseline covers 69–100% of PRs everywhere.
