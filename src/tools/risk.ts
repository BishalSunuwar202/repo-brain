// risk(module?): where is knowledge concentrated (spec §5, verified live in §13).
//
// Bus-factor-1 = one person holds > 80% of normalised doa AND no one else has
// touched the file since the cutoff (asOf − 180 days).
//
// FalkorDB has no EXISTS { } subqueries (landmine 8): the "no one else recently"
// clause collects lastTs in the aggregation and filters with a list comprehension.
// $cutoff is a UTC ISO string; string comparison is time order because ingest
// normalises every timestamp to UTC ISO. No datetime()/duration functions.

import type { Graph } from "falkordb";
import type { PathPredicate } from "../ingest/paths.ts";

export const RECENT_DAYS = 180;

export const RISK_CYPHER = `MATCH (p:Person)-[t:TOUCHED]->(f:File)
WHERE f.alive AND ($module IS NULL OR f.module = $module)
WITH f, collect({login: p.login, doa: t.doa, lastTs: t.lastTs}) AS holders, sum(t.doa) AS total
WITH f, holders, total, [h IN holders WHERE h.doa / total > 0.8] AS dominant
WHERE size(dominant) = 1
WITH f, holders, total, dominant[0] AS sole
WITH f, total, sole,
     [h IN holders WHERE h.login <> sole.login AND h.lastTs >= $cutoff] AS recentOthers
WHERE size(recentOthers) = 0
RETURN f.path AS path, f.module AS module, sole.login AS soleHolder, sole.doa / total AS share
ORDER BY share DESC, path`;

export interface RiskRow {
  path: string;
  module: string | null;
  soleHolder: string;
  share: number;
}

export function riskCutoff(asOf: Date, days = RECENT_DAYS): string {
  return new Date(asOf.getTime() - days * 24 * 3600 * 1000).toISOString();
}

/** Lockfiles / generated paths keep TOUCHED rows but are never reported (spec §12 D14). */
export function presentRisk(rows: RiskRow[], exclude: PathPredicate): RiskRow[] {
  return rows.filter((r) => !exclude(r.path));
}

export interface RiskOptions {
  module?: string;
  asOf?: Date;
  /** Required on purpose: every caller, including fix's before/after count, must filter. */
  exclude: PathPredicate;
}

export async function risk(graph: Graph, opts: RiskOptions): Promise<RiskRow[]> {
  const res = await graph.roQuery<RiskRow>(RISK_CYPHER, {
    params: { module: opts.module ?? null, cutoff: riskCutoff(opts.asOf ?? new Date()) },
  });
  return presentRisk(res.data ?? [], opts.exclude);
}
