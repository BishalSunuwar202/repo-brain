// The two backtest baselines (spec §6, §12 D2): review() is reported NEXT TO them.
//
// Both are built from ONE read: per reviewer, how many TRAINING PRs they reviewed.
// Training means merged strictly before `before`, the oldest held-out PR's mergedAt;
// the cutoff is a parameter, never inferred, so the backtest decides it once and
// both baselines and review() agree on it. Counting a held-out review would be
// reading the answers.
//
// Each predictor returns a ranked list of lowercased logins (Person.login is
// lowercase, D11) for hitRate() in backtest.ts, which slices it to k.

import type { Graph } from "falkordb";
import { underCap } from "../db/client.ts";
import { isBot } from "../ingest/bots.ts";

export interface ReviewerActivity {
  login: string;
  /** Distinct training PRs reviewed, not counting PRs they authored. */
  prs: number;
}

/** A held-out PR, as much of it as a baseline may see. */
export interface HeldOutPR {
  number: number;
  author: string;
}

/**
 * One row per reviewer, so it stays far under RESULTSET_SIZE (landmine 9).
 *
 * - The count is of distinct PRs, not edges: grouping on (r, p) collapses parallel
 *   REVIEWED_BY edges, which a re-ingest without MERGE could create. `ID(e) >= 0`
 *   and DISTINCT are kept per landmine 1 although that grouping already covers them
 *   (mutation-checked: removing either changes nothing).
 * - A PR with no mergedAt compares as null and drops out: it cannot be placed on
 *   either side of the cutoff.
 * - Ingest already drops self-reviews (thread replies recorded as reviews), but the
 *   author is excluded here too, because a slipped one would inflate the count.
 * - Bots are filtered in TS with isBot(), the same rule groundTruthReviewers uses.
 */
export const REVIEWER_ACTIVITY_CYPHER = `MATCH (r:PR)-[e:REVIEWED_BY]->(p:Person)
WHERE ID(e) >= 0 AND r.mergedAt < $before
OPTIONAL MATCH (r)-[:AUTHORED_BY]->(a:Person)
WITH r, p, collect(a.login) AS authors
WHERE NOT p.login IN authors
RETURN p.login AS login, count(DISTINCT r) AS prs
ORDER BY login`;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * The cutoff as `toISOString()` gives it, the exact shape PR.mergedAt is stored in.
 * Without normalising, "…:00Z" sorts AFTER "…:00.000Z", so a PR merged exactly at
 * the cutoff would count as training and leak a held-out PR's reviewers.
 */
export function checkCutoff(before: string): string {
  if (!ISO_UTC.test(before)) throw new Error(`cutoff must be a UTC ISO timestamp like 2026-09-01T00:00:00.000Z, got ${before}`);
  return new Date(before).toISOString();
}

export async function reviewerActivity(graph: Graph, opts: { before: string }): Promise<ReviewerActivity[]> {
  const res = await graph.roQuery<ReviewerActivity>(REVIEWER_ACTIVITY_CYPHER, { params: { before: checkCutoff(opts.before) } });
  return underCap(res.data, "baseline reviewer activity");
}

const humans = (rows: readonly ReviewerActivity[]) =>
  rows.map((r) => ({ login: r.login.toLowerCase(), prs: r.prs })).filter((r) => !isBot({ login: r.login }));

// --- mostActive ---------------------------------------------------------------

/**
 * Every human reviewer, most training PRs reviewed first; ties break on login so
 * the baseline is reproducible. Deliberately untuned: on every repo vetted, the
 * most active reviewers took part in 69–100% of PRs, and that strength is the point.
 */
export function mostActiveRanking(rows: readonly ReviewerActivity[]): string[] {
  return humans(rows)
    .sort((a, b) => b.prs - a.prs || a.login.localeCompare(b.login))
    .map((r) => r.login);
}

/** The same prediction for every PR, minus that PR's author, who cannot review it. */
export function predictMostActive(ranking: readonly string[], prAuthor: string): string[] {
  const author = prAuthor.toLowerCase();
  return ranking.filter((login) => login !== author);
}

// --- random ---------------------------------------------------------------------

/**
 * The eligible pool: every human with at least one REVIEWED_BY edge on a training
 * PR. Sorted, so the shuffle's input does not depend on the database's row order.
 */
export function reviewerPool(rows: readonly ReviewerActivity[]): string[] {
  return [...new Set(humans(rows).map((r) => r.login))].sort();
}

/** Fixed default so a published random-baseline number is reproducible. */
export const DEFAULT_SEED = 20261018;

/** mulberry32: a tiny, well-mixed 32-bit PRNG, uniform on [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A uniformly random order of the pool minus the PR's author. The stream is seeded
 * from (seed, PR number), so a PR's prediction does not depend on which PRs were
 * scored before it or in what order. Top-k of a uniform shuffle is k random
 * distinct reviewers, which is what hit@1 and hit@3 need.
 */
export function predictRandom(pool: readonly string[], pr: HeldOutPR, seed = DEFAULT_SEED): string[] {
  const author = pr.author.toLowerCase();
  const out = pool.filter((login) => login !== author);
  const rand = mulberry32(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(pr.number, 0xc2b2ae35));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
