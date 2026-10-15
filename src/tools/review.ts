// review(prNumber): who should review this (spec §5). STUB. This is the
// BASELINE being measured by the backtest, not the contribution.
//
// Score candidates by doa on the PR's files + doa on co-changed neighbours.
// No open-review load penalty in v1: ingest does not fetch open PRs (spec §12 D7);
// the README must say so. Spec gives no Cypher; UNVERIFIED sketch
// (pattern predicates in WHERE and the mixed aggregation need checking on FalkorDB):
//
// MATCH (pr:PR {number: $number})-[:MODIFIED]->(f:File)<-[t:TOUCHED]-(p:Person)
// WHERE NOT (pr)-[:AUTHORED_BY]->(p)
// WITH pr, p, sum(t.doa) AS direct
// OPTIONAL MATCH (pr)-[:MODIFIED]->(:File)-[c:CO_CHANGED]-(g:File)<-[t2:TOUCHED]-(p)
// RETURN p.login, direct + coalesce(sum(t2.doa * c.support), 0) AS score
// ORDER BY score DESC LIMIT 3

import type { Graph } from "falkordb";

export interface ReviewCandidate {
  login: string;
  score: number;
}

export async function review(_graph: Graph, _prNumber: number): Promise<ReviewCandidate[]> {
  throw new Error("not implemented: review");
}
