// review(prNumber): who should review this PR (spec §5). This is the BASELINE
// the backtest measures, not the project's contribution — `fix` is.
//
// Score = doa on the files this PR modifies, plus doa on files that co-change
// with them, weighted by the co-change support. The PR's author is excluded.
//
// Both legs NOMINATE: someone who has only ever touched a co-change neighbour is
// a candidate too, not just a tie-breaker among people who touched the PR's files.
// The legs are a UNION ALL of one row per person each, summed by mergeLegs in TS.
//
// The Cypher below was probed against the live engine before being written,
// because the obvious formulation is wrong in two ways that produce
// plausible-looking output instead of an error:
//
//   1. landmine 10 — `RETURN direct + sum(t2.doa * c.support)` is ACCEPTED and
//      returns null for every row, so ORDER BY sorts nulls. Here the two sums
//      never meet in Cypher at all: each leg closes its own aggregate.
//   2. a co-change neighbour g that the PR ALSO modifies would be counted twice,
//      once as direct and again as co-change. Hence
//      `WHERE NOT (pr)-[:MODIFIED]->(g)` on the co-change leg.
//
// No open-review load penalty in v1: ingest does not fetch open PRs (spec §12 D7).

import type { Graph } from "falkordb";
import { underCap } from "../db/client.ts";
import { isBot } from "../ingest/bots.ts";

export interface ReviewCandidate {
  login: string;
  /** doa on the files this PR modifies. */
  direct: number;
  /** doa on files that co-change with them, weighted by support. */
  co: number;
  score: number;
}

/** One row as the engine returns it: one person on one leg, the other leg's sum 0. */
export type ReviewRow = Omit<ReviewCandidate, "score">;

export const DEFAULT_K = 3;

export function checkK(k: number): number {
  if (!Number.isInteger(k)) throw new Error(`k must be an integer, got ${k}`);
  if (k < 1) throw new Error(`k must be >= 1, got ${k}`);
  return k;
}

/**
 * Top k by score. Ties break on login so a published hit-rate is reproducible
 * rather than dependent on the engine's row order.
 */
export function rankCandidates(rows: readonly ReviewCandidate[], k: number): ReviewCandidate[] {
  return rows
    .filter((r) => !isBot({ login: r.login }))
    .map((r) => ({ login: r.login, direct: r.direct, co: r.co, score: r.score }))
    .sort((a, b) => b.score - a.score || a.login.localeCompare(b.login))
    .slice(0, checkK(k));
}

/** Sums each person's rows from the two legs into one candidate. */
export function mergeLegs(rows: readonly ReviewRow[]): ReviewCandidate[] {
  const byLogin = new Map<string, ReviewCandidate>();
  for (const r of rows) {
    const c = byLogin.get(r.login) ?? { login: r.login, direct: 0, co: 0, score: 0 };
    c.direct += r.direct;
    c.co += r.co;
    c.score = c.direct + c.co;
    byLogin.set(r.login, c);
  }
  return [...byLogin.values()];
}

// CO_CHANGED is stored in one direction only, so the co-change leg matches it undirected.
export const REVIEW_CYPHER = `MATCH (pr:PR {number: $number})-[:MODIFIED]->(f:File)<-[t:TOUCHED]-(p:Person)
WHERE NOT (pr)-[:AUTHORED_BY]->(p)
WITH p, sum(t.doa) AS direct
RETURN p.login AS login, direct, 0.0 AS co
UNION ALL
MATCH (pr:PR {number: $number})-[:MODIFIED]->(:File)-[c:CO_CHANGED]-(g:File)<-[t2:TOUCHED]-(p:Person)
WHERE NOT (pr)-[:MODIFIED]->(g) AND NOT (pr)-[:AUTHORED_BY]->(p)
WITH p, sum(t2.doa * c.support) AS co
RETURN p.login AS login, 0.0 AS direct, co`;

export interface ReviewOptions {
  k?: number;
}

export async function review(graph: Graph, prNumber: number, opts: ReviewOptions = {}): Promise<ReviewCandidate[]> {
  const k = checkK(opts.k ?? DEFAULT_K);
  const res = await graph.query<ReviewRow>(REVIEW_CYPHER, { params: { number: prNumber } });
  // At most two rows per candidate person (one per leg), so the cap is generous —
  // but more than RESULTSET_SIZE rows would truncate silently (landmine 9).
  const rows = underCap(res.data, `review(${prNumber}) candidates`);
  return rankCandidates(mergeLegs(rows.map((r) => ({ login: r.login, direct: Number(r.direct), co: Number(r.co) }))), k);
}

export function presentReview(prNumber: number, candidates: ReviewCandidate[]): string {
  if (candidates.length === 0) return `PR #${prNumber}: no candidate reviewer — nobody else has touched these files`;
  const lines = candidates.map(
    (c) => `  ${c.login.padEnd(24)} ${c.score.toFixed(3)}  (touched these ${c.direct.toFixed(3)} + co-change ${c.co.toFixed(3)})`,
  );
  return [`PR #${prNumber}: suggested reviewers, best first`, ...lines].join("\n");
}
