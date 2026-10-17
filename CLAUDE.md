# Repo Brain — agent orientation

Hackathon entry for **FalkorDB Graph Hacks** (Oct 15–18 2026, solo build). Ingests a
repo's git history into FalkorDB (Redis-protocol graph DB, a *subset* of OpenCypher)
and answers questions from a CLI: `impact`, `risk`, `review`, `fix`. The headline is
`fix`: max-flow / min-cut prescribing the **minimal** set of review assignments that
reduces bus-factor risk, subject to an expertise floor.

**Hard deadline: submission in by Oct 18 2026 18:00 IST.** Favour boring working code
over abstraction. When behind, cut per spec §8 — never cut `fix`, the backtest
number, or the demo video.

## The spec is binding

`docs/superpowers/specs/2026-10-15-repo-brain-design.md`. Read it before any design
work; build what it says rather than redesigning. Later sections supersede earlier
ones where they conflict:

- §12 decision log D1–D17 (post-scaffold review)
- §13 and §16 "Verified live" — what has actually been run against the engine
- §14 D18–D21 (first live ingest), §15 R1–R6 (risk calibration), §16 F1–F3 (`fix` as built)

Provisional values, to be tuned on the backtest: θ = 0.2 (`--theta`, §15 R3) and the
5-candidate shortlist (`--candidates`, §16 F1).

## Decisions already made

- **TypeScript**, Node **>=22** (falkordb 6.8.0 requires it), ESM, `node:test`,
  `commander`, client `falkordb`. No Python.
- CLI first, MCP server second, **no web UI**.
- One graph per repo: `repo:<owner>-<name>`. `fix` solves in a throwaway
  `flow:<uuid>` graph and always deletes it.
- Ingest is deterministic git parsing. No LLM anywhere in the ingest path.
- `--repo owner/name` is required for any number you report (§12 D15). Without it,
  identities fall back to email local-parts and the output is unquotable.
- Pin an absolute `--since` date for published numbers; relative values drift with
  the wall clock.

## Environment

- FalkorDB container `repo-brain-db` at `redis://localhost:6379`, volume
  `.falkordata/`, Browser on **port 3100**. Ports 3000 and 3001 belong to the user's
  unrelated work dev servers — leave them running.
- Leave docker to the user: the container is already up and shared.
- Ingested graphs: fastify/fastify, nodejs/undici, vitejs/vite, pnpm/pnpm,
  FalkorDB/FalkorDB.
- Clones for analysis live in `.cache/repos/<name>/`, one fresh empty dir each,
  `git clone --single-branch` (no blobless clone). They are untrusted checkouts: the
  only permitted interaction is `git log` with the path passed as an argument — no
  `npm install`, build or script inside them (§14 D21).

## FalkorDB facts (verified — verify anything new)

Before using a procedure, check `https://docs.falkordb.com/algorithms/<name>.md`
and say so; record live checks in the spec.

- `algo.maxFlow` takes `relationshipTypes` (`algo.SPpaths` takes `relTypes`). It
  returns **only positive-flow edges** and never the min cut — the cut is derived in
  TS. Its multi-source mode uses infinite-capacity super-nodes, hence explicit
  SOURCE/SINK nodes in the flow graph.
- `startNode(e)` / `endNode(e)` work on yielded edges.

### Cypher landmines

1. Count over `-[e]->` with `WHERE ID(e) >= 0`, or unreferenced edges are only
   existence-checked and counts come back wrong.
2. `LIMIT` does not restrict eager operations — keep it off writes.
3. Indexes do not optimise `<>` filters.
4. No aggregations inside pattern comprehensions.
5. No regex operators — use `CONTAINS` / `STARTS WITH` / `string.matchRegEx()`.
6. No label unions `(n:A|B)` — use `WHERE n:A OR n:B`.
7. Vector index queries do not combine with property filters.
8. No `EXISTS { MATCH … }` subqueries: collect in the aggregation and filter with a
   list comprehension. Pass precomputed UTC ISO strings instead of `datetime()` /
   `duration.inDays()`.
9. **Reads silently truncate at 10,000 rows** (`RESULTSET_SIZE`). Shape reads to one
   row per file or module, and wrap every result in `underCap()` from
   `src/db/client.ts`. Leave the server setting alone (§15).
10. An expression mixing a `WITH`-carried value with a fresh aggregate
   (`RETURN direct + sum(x)`) is **accepted and returns null** — no error, and
   `ORDER BY` then sorts nulls. Finish each aggregate in its own `WITH`, then
   combine in `RETURN`. (Verified live on a synthetic fixture; `OPTIONAL MATCH`
   after an aggregating `WITH` is fine — unmatched rows survive and `sum()` over
   zero rows is 0, not null.)

## Honesty requirements

- The README credits prior art (CodeScene, Fritz et al. Degree-of-Knowledge,
  SofiaWL, RevFinder). The novelty claim is the **assembly**, not the components.
- The eval reports a **real measured** hit-rate@1/@3 (§12 D1 — not precision@k) from
  the backtest against two baselines. No synthetic data, hand-labelling, or estimates
  presented as measured.
- `fix`'s "after" number is a **projection** (atRiskBefore − maxFlow), never a
  measurement. Quote it with its N and its `--ceiling` (§16 F1, F3).

## Eval + demo repos (§15 D8 update)

- Backtest and demo: **fastify/fastify**. Backup: getsentry/sentry-javascript.
- Source-concentrated counterpart for the README: **vitejs/vite**.
- FalkorDB/FalkorDB is dropped as a demo (its HEAD is a recent import; almost no
  co-change). Also vetted: undici (mild), pnpm (single-maintainer, too long to demo).
- The headline is `fix`'s counterfactual, not review precision — the trivial
  most-active baseline covers 69–100% of PRs everywhere.

## Conventions

- Commit and push as work lands; keep each PR small and single-purpose, one topic
  per PR. Stage by explicit path — never `git add -A`. Other sessions may share this
  working tree, so leave files you did not write unstaged and do not switch, rebase
  or reset the shared branch; give a stream its own branch with `git worktree` only
  when it actually needs one.
- Ask before adding dependencies beyond `package.json`.
- Cache every GitHub API response under `.cache/` on first fetch — rate limits bite.
- Scratch work goes in `.cache/scratch/`, never `src/`.
- Live tests need the container: `npm run test:live`.

## Before making the repo public (submission will require it)

The repo is **private** (`github.com/BishalSunuwar202/repo-brain`). Before flipping
visibility:

- [x] Test fixtures use fake identities only (`10000001`, `example.com`): never the
      owner's real GitHub ID, username or email.
- [ ] Confirm `.cache/` and `.falkordata/` are still gitignored and untracked
      (`.cache/identity/` holds email→login mappings fetched from GitHub).
- [ ] Check no analysed repo's contributor data is committed in fixtures or
      example output.

## Status (keep this current)

- [x] Spec + decision log; `algo.maxFlow` verified live
- [x] Ingest: git parsing, identity resolution, bot/lockfile/bulk-commit rules
- [x] `impact`, `risk` (calibrated, §15), `fix` (max-flow/min-cut, §16) — CLI wired
- [x] `github.ts` PR fetch → `review` → backtest hit-rate@1/@3 vs two baselines
      (measured: fastify, 30 held out, 13%/30% vs the most-active baseline's 17%/43%)
- [x] MCP server — stdio JSON-RPC, four tools, no SDK dependency (`npm run mcp`)
- [x] README with the measured number and both baselines beside it
- [ ] Demo video; make public; submit
