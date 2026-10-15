# Repo Brain

Repo Brain reads a repository's git history and pull-request reviews into a
FalkorDB graph (who touched which files, which files change together, who
reviewed what). It then answers four questions from the command line: what
else moves when I touch this file (`impact`), where knowledge is concentrated
in one person (`risk`), who should review this PR (`review`), and the headline
one, `fix`. `fix` uses max-flow / min-cut to prescribe the smallest set of
review assignments that spreads that knowledge, without assigning anyone who
lacks the expertise to review well. Built for FalkorDB Graph Hacks, Oct 2026.

```bash
npm install
npm run brain -- parse /path/to/repo   # git history -> counts, no database needed
npm test
```

## How `risk` decides a file is bus-factor-1

```bash
npm run brain -- --repo fastify/fastify ingest /path/to/fastify --fresh
npm run brain -- --repo fastify/fastify risk            # --threshold 0.5 --min-commits 3
```

Each person gets a degree-of-authorship (`doa`) score per file: creator bonus,
plus log-damped commit count, plus a recency term. It's normalised so shares on a
file sum to 1 (after Fritz et al.'s Degree-of-Knowledge). A file is
**bus-factor-1** when one person holds **more than half** of its `doa`, and the
file has **at least 3 authorship commits** in the ingest window.

- **0.5 is a definition, not a tuned dial.** At any threshold ≥ 0.5 at most one
  person can exceed it, so the rule means exactly "one person holds a strict
  majority". `--threshold` remains for exploring, and below 0.5 a single-holder
  guard keeps the result well defined.
- **The activity floor is what makes the list mean something.** Without it, the
  list is files someone touched once: cold files, not concentrated knowledge.
- **Higher thresholds hide multi-author concentration.** Because commit counts are
  log-damped, one extra contributor caps the top share near 0.7. So at 0.8 the
  rule degenerates to "only one person ever touched it".

Measured on `fastify/fastify`, 2-year window. Each cell is at-risk files, with the
multi-contributor ones in parentheses:

| min commits | 0.5 | 0.6 | 0.7 | 0.8 |
|---|---|---|---|---|
| 1  | 190 (98) | 112 (20) | 100 (8) | 92 (0) |
| **3**  | **32 (27)** | 17 (12) | 5 (0) | 5 (0) |
| 5  | 11 (8)  | 5 (2)  | 3 (0) | 3 (0) |
| 10 | 1 (1)   | 1 (1)  | 0     | 0     |

**Output is split by file kind** (source, test, CI/dotfiles, docs, types) and
shows at-risk over active files per kind. On fastify the source code is healthy
(1 of 28 active source files). The CI pipeline is not: 11 of 17 active CI files
are bus-factor-1, and one maintainer holds 10 of those 11.

Tests count as knowledge here but are hidden by default in `impact`. That's
deliberate, not inconsistent. In `impact`, a test moving with its source is
mechanical coupling, so it's noise for "what else must I change". In `risk`, a
test only one person understands is genuine risk.

**Recency is a column, not a filter.** The original rule also required that no
one else touched the file in 180 days. We measured it. At the old 0.8 threshold
it excluded 0 additional files on fastify (2-, 5- and 10-year windows) and 2 on
FalkorDB. Recency already sits inside `doa`. So `risk` now reports "days since
anyone else touched it" for you to judge, and filters nothing on it.

**Bulk commits are not authorship.** A commit touching more than 50 files (a
vendor drop, a codebase import, a mass reformat) gives its author no creator
credit and no `doa`. It's already ignored for co-change. Files only bulk commits
ever touched are never reported, because we know nothing about who holds them.
Without this rule, FalkorDB/FalkorDB's August 2026 Rust-engine import made its
author the "sole holder" of 274 files under the old 0.8 rule. With it, the same
rule gives 69 (19 at the current defaults).

Known limitations:
- On very large commits, git skips exhaustive rename detection (`diff.renameLimit`),
  so a rename inside a bulk commit can show up as delete plus add. Bulk commits
  no longer feed `doa`, so this affects only which paths are considered alive.
- `--since` defaults to a relative window ("2 years ago"), so the counts drift as
  time passes. Pin an absolute date to reproduce a published number.
