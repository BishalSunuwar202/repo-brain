# Repo candidates for the backtest (spec §6)

Measured 2026-10-15 with `scripts/vet-repos.ts` (`gh api graphql`, authenticated).
Raw responses are cached in `.cache/vetting/`, and rerunning the script costs 0 API calls.
Nothing was cloned.

**Method.** For each repo the script takes the **last 100 merged PRs**, newest first
by creation date (GraphQL cannot sort by merge date, so this is a close proxy), plus
up to 50 reviews per PR.
- A **review** counts only if its author is a human and not the PR author. Bots
  (Copilot, CodeRabbit, dependabot…) are excluded, and so are the author's own
  thread replies, which GitHub records as `COMMENTED` reviews.
- **Concentration** is the share of all counted reviews written by the single most
  active reviewer.
- **Top-1 / top-3 PR share** is the % of reviewed PRs where the 1 (or any of the 3)
  most active reviewers took part. It is roughly the in-sample ceiling of the spec's
  *most-active-reviewer* baseline at hit@1 / hit@3. Higher means a harder baseline
  to beat.
- **Reviewers w/ commits** is the % of distinct reviewers who authored at least one
  default-branch commit in the last 2 years. A predictor built on git history cannot
  name a reviewer who has never committed.
- **Commits 2y** is the default-branch history count since 2024-10-15, including
  merge commits.
- **Files** is the blob count of the default-branch tree. No tree was truncated.

**Bar:** reviewCoverage > 60%, distinctReviewers ≥ 8, reviewerConcentration < 50%.

## Results

| Repo | Coverage (all / human-authored PRs) | Distinct reviewers | Concentration | Top-1 / Top-3 PR share | Approved % of reviewed | Median files/PR | Bot-authored PRs | Reviewers w/ commits | Stars | Lang | Contributors | Commits 2y | Files | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **fastify/fastify** | 100 / 100 | 15 | 16% | 35 / 72 | 100 | 2 | 26% | 87% | 37.3k | JS | 432 | 758 | 396 | **PASS** |
| **getsentry/sentry-javascript** ✱ | 98 / 100 | 8 | 28% | 34 / 69 | 100 | 4 | 21% | 100% | 8.8k | TS | 403 | 6,316 | 11,609 | **PASS** (reviewers exactly at bar) |
| eslint/eslint ✱ | 100 / 100 | 15 | 43% | 66 / 89 | 99 | 2 | 30% | 73% | 27.6k | JS | 412 | 1,299 | 2,362 | PASS |
| open-telemetry/opentelemetry-js ✱ | 100 / 100 | 14 | 37% | 53 / 91 | 100 | 4 | 20% | 79% | 3.5k | TS | 396 | 1,266 | 1,532 | PASS |
| FalkorDB/FalkorDB | 100 / 100 | 7 | 54% | 60 / 91 | 99 | 2.5 | 13% | 100% | 10.0k | Rust | 70 | 564 | 957 | FAIL (narrowly) |
| FalkorDB/falkordb-ts | 60 / 38 | 3 | 49% | 50 / 100 | 100 | 1 | 79% | 100% | 53 | TS | 13 | 641 | 105 | FAIL |
| FalkorDB/GraphRAG-SDK | 54 / 47 | 4 | 92% | 70 / 98 | 87 | 3 | 17% | 75% | 1.0k | Python | 10 | 613 | 204 | FAIL |
| FalkorDB/code-graph | 46 / 48 | 6 | 52% | 43 / 93 | 89 | 2 | 46% | 83% | 348 | Python | 12 | 994 | 193 | FAIL |
| honojs/hono | 57 / 57 | 4 | 90% | 98 / 100 | 96 | 2 | 0% | 50% | 32.5k | TS | 363 | 791 | 583 | FAIL |
| drizzle-team/drizzle-orm | 17 / 17 | 5 | 50% | 53 / 88 | 76 | 19.5 | 0% | 60% | 36.0k | TS | 124 | 544 | 1,392 | FAIL |
| trpc/trpc | 32 / 45 | 6 | 66% | 78 / 97 | 94 | 2 | 38% | 33% | 40.7k | TS | 460 | 738 | 1,647 | FAIL |
| colinhacks/zod | 2 / 2 | 2 | 50% | 50 / 100 | 50 | 4 | 3% | 0% | 44.1k | TS | 462 | 1,185 | 742 | FAIL |
| vitejs/vite | 75 / 75 | 6 | 77% | 81 / 99 | 97 | 2.5 | 15% | 100% | 83.3k | TS | 435 | 2,708 | 2,868 | FAIL |
| prisma/prisma | 99 / 99 | 4 | 56% | 35 / 100 | 100 | 28 | 0% | 50% | 47.7k | TS | 29 † | 8,445 | 9,759 | FAIL |
| sveltejs/svelte | 73 / 71 | 7 | 63% | 73 / 97 | 95 | 4 | 17% | 100% | 88.4k | JS | 413 | 2,065 | 9,246 | FAIL |
| typescript-eslint/typescript-eslint ✱ | 75 / 94 | 6 | 53% | 65 / 97 | 91 | 2 | 35% | 83% | 16.4k | TS | 442 | 1,458 | 7,321 | FAIL |
| withastro/astro ✱ | 99 / 96 | 6 | 50% | 55 / 93 | 100 | 4 | 73% | 100% | 63.2k | TS | 338 | 3,801 | 7,041 | FAIL |
| vitest-dev/vitest ✱ | 64 / 61 | 4 | 47% | 67 / 100 | 94 | 3 | 11% | 100% | 17.2k | TS | 460 | 2,200 | 3,191 | FAIL |

✱ Not on the original candidate list. Only one listed repo passed, so 6 more were
measured to find a backup.
† Measured as reported. prisma shows 29 contributors and 29 distinct committer logins
over 8,445 commits, which looks off (possibly rewritten history). Not investigated.

**Window covered by the 100 PRs** (oldest merge in the sample): fastify 2026-07-30,
sentry-javascript 2026-10-09 (6 days!), eslint 2026-07-28, otel-js 2026-09-02,
FalkorDB 2026-09-09.

### Why the failures fail (one line each)
- **FalkorDB/falkordb-ts:** 79% of merged PRs are bot-authored. Only 21 human PRs, 38% of them reviewed, 3 reviewers.
- **FalkorDB/GraphRAG-SDK:** one person wrote 92% of reviews (galshubeli 200 of ~217). 31 PRs got bot-only review.
- **FalkorDB/code-graph:** coverage 46%. 24 PRs got bot-only review. 6 reviewers.
- **FalkorDB/FalkorDB:** coverage is perfect, but only 7 reviewers. DvirDukhan reviewed 60% of PRs alone, and the top 3 cover 91%.
- **honojs/hono:** yusukebe is on 98% of reviewed PRs. Prediction would be trivial.
- **drizzle-orm:** 17% coverage, mostly self-merged.
- **trpc:** 32% coverage. 68 PRs got bot-only review.
- **zod:** 2% coverage. 95 of 100 PRs got only bot review.
- **vite:** sapphi-red is on 81% of reviewed PRs.
- **prisma:** 4 reviewers. Median PR touches 28 files. 8.4k commits and 9.8k files make it a heavy ingest.
- **svelte:** 7 reviewers. dummdidumm is on 73% of reviewed PRs.
- **typescript-eslint:** 6 reviewers. bradzacher wrote 53% of reviews.
- **astro:** 73% of PRs are bot-authored (changesets), leaving only 27 human PRs.
- **vitest:** 4 reviewers. The top 3 cover 100% of reviewed PRs.

## (a) Recommendation

**Primary: `fastify/fastify`.**
- **Best on every bar metric:** 100% coverage, 15 reviewers, 16% concentration.
- **Hardest baseline to beat trivially:** the top-3 most-active reviewers are on only
  72% of reviewed PRs, lower than eslint (89%) or otel-js (91%). That leaves real
  room for `review()` to beat the "just ask the maintainer" baseline.
- **Approvals, not comments:** 100% of reviewed PRs carry an `APPROVED`, so the
  ground truth is real approvals.
- **Small ingest:** 758 commits, 396 files.
- **Watch out for:** 26% of PRs are bot-authored and must be excluded from the
  holdout. 13% of reviewers have no commits, so `review()` can never name them; this
  caps recall slightly.

**Backup: `getsentry/sentry-javascript`.**
- **This is the spec's "large" repo:** 6.3k commits, 11.6k files.
- **Lowest top-3 share of anyone (69%),** and every reviewer has commits.
- **Its weak point:** exactly 8 distinct reviewers, sitting on the bar. That figure
  comes from a 6-day window, because the repo is that busy. A 30-PR holdout is about
  2 days of merges, so check the reviewer count over the actual holdout before
  relying on it.
- **Safer but weaker backup:** `eslint/eslint`. It has 15 reviewers, but
  mdjermanovic is on 66% of reviewed PRs, so the most-active baseline will be hard
  to beat.

## (b) FalkorDB's own repos

**None qualifies for the backtest.** FalkorDB/FalkorDB is the closest, and its data
is not bad. Coverage is 100%, 99% of reviewed PRs are approved, and every reviewer
also commits. But the review pool is small (7 people in 5 weeks) and centred on
one person: DvirDukhan reviewed 60% of PRs, and the top 3 cover 91%. On that repo the
most-active-reviewer baseline will score close to the ceiling. Our `review()` would
probably tie or lose, and losing to "just ask Dvir" in front of FalkorDB's own judges
is the worst possible demo moment. The other three FalkorDB repos are worse: either
mostly bot PRs or one dominant reviewer.

**Recommendation: split the roles.**
- **Backtest number on fastify.** It is the only number that needs review ground truth.
- **`risk` + `fix` demo on FalkorDB/FalkorDB.** These need only git history, which
  FalkorDB has: 564 commits and 22 committer logins in 2 years. Their own engineers'
  names on screen is still the strong move.
- **Unverified for FalkorDB:** whether co-change is dense enough to give `fix`
  eligible reviewers. Run `npm run brain -- parse` on a local clone before
  committing to it.
- **Tone:** frame it as "here's where your knowledge is concentrated and the
  4 reviews that fix it", not as naming people as single points of failure.

## (c) Estimated ingest size

These are estimates from the API numbers above, not measured parses. Nothing was cloned.

| | fastify/fastify | getsentry/sentry-javascript | FalkorDB/FalkorDB (demo only) |
|---|---|---|---|
| Commits (2y, incl. merges) | 758 (measured) | 6,316 (measured) | 564 (measured) |
| Files at HEAD | 396 (measured) | 11,609 (measured) | 957 (measured) |
| Committer logins (2y) | 176 (measured) | 224 (measured) | 22 (measured) |
| `git log` parse time | < 1 s (est.: 533 commits parsed in 0.4 s locally) | ~5 s (est.) | < 1 s (est.) |
| TOUCHED edges | ~1–2k (est.) | ~20–40k (est.) | ~1–2k (est.) |
| CO_CHANGED pairs after filter | not measured | not measured | not measured |
| GitHub calls for PRs + reviews | ~1 GraphQL call per 50 PRs | same; ~6 days of PRs per 100 | same |
| Clone size | not measured | not measured (monorepo, expect hundreds of MB) | not measured |

The local runs (533 commits → 413 pairs; 518 commits → 275 pairs) suggest fastify
will land in the low hundreds to low thousands of CO_CHANGED pairs. That is a guess
until it is actually parsed.
