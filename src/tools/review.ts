// review(prNumber): who should review this PR (spec §5). This is the BASELINE
// the backtest measures, not the project's contribution — `fix` is.
//
// Score = doa on the files this PR modifies, plus doa on files that co-change
// with them, weighted by the co-change support. The PR's author is excluded.
//
// The Cypher below was probed against the live engine before being written,
// because the obvious formulation is wrong in two ways that produce
// plausible-looking output instead of an error:
//
//   1. landmine 10 — `RETURN direct + sum(t2.doa * c.support)` is ACCEPTED and
//      returns null for every row, so ORDER BY sorts nulls. Each aggregate must
//      be closed in its own WITH before it is combined.
//   2. a co-change neighbour g that the PR ALSO modifies would be counted twice,
//      once as direct and again as co-change. Hence
//      `WHERE NOT (pr)-[:MODIFIED]->(g)` on the optional leg.
//
// Known limitation, kept deliberately: candidates come only from people who
// directly touched a modified file, so someone who has only ever touched a
// co-change neighbour can never surface. Co-change ranks candidates, it does not
// nominate them. The README says so.
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

/** One row as the engine returns it. */
export type ReviewRow = ReviewCandidate;

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
export function rankCandidates(rows: readonly ReviewRow[], k: number): ReviewCandidate[] {
  return rows
    .filter((r) => !isBot({ login: r.login }))
    .map((r) => ({ login: r.login, direct: r.direct, co: r.co, score: r.score }))
    .sort((a, b) => b.score - a.score || a.login.localeCompare(b.login))
    .slice(0, checkK(k));
}

export const REVIEW_CYPHER = `MATCH (pr:PR {number: $number})-[:MODIFIED]->(f:File)<-[t:TOUCHED]-(p:Person)
WHERE NOT (pr)-[:AUTHORED_BY]->(p)
WITH pr, p, sum(t.doa) AS direct
OPTIONAL MATCH (pr)-[:MODIFIED]->(:File)-[c:CO_CHANGED]-(g:File)<-[t2:TOUCHED]-(p)
WHERE NOT (pr)-[:MODIFIED]->(g)
WITH p, direct, coalesce(sum(t2.doa * c.support), 0) AS co
RETURN p.login AS login, direct, co, direct + co AS score
ORDER BY score DESC`;

export interface ReviewOptions {
  k?: number;
}

export async function review(graph: Graph, prNumber: number, opts: ReviewOptions = {}): Promise<ReviewCandidate[]> {
  const k = checkK(opts.k ?? DEFAULT_K);
  const res = await graph.query<ReviewRow>(REVIEW_CYPHER, { params: { number: prNumber } });
  // One row per candidate person, so the cap is generous — but a repo with more
  // than RESULTSET_SIZE candidates would truncate silently (landmine 9).
  const rows = underCap(res.data, `review(${prNumber}) candidates`);
  return rankCandidates(
    rows.map((r) => ({ login: r.login, direct: Number(r.direct), co: Number(r.co), score: Number(r.score) })),
    k,
  );
}

export function presentReview(prNumber: number, candidates: ReviewCandidate[]): string {
  if (candidates.length === 0) return `PR #${prNumber}: no candidate reviewer — nobody else has touched these files`;
  const lines = candidates.map(
    (c) => `  ${c.login.padEnd(24)} ${c.score.toFixed(3)}  (touched these ${c.direct.toFixed(3)} + co-change ${c.co.toFixed(3)})`,
  );
  return [`PR #${prNumber}: suggested reviewers, best first`, ...lines].join("\n");
}
