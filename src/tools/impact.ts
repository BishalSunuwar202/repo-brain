// impact(path): what else moves when I touch this (spec §5).
//
// CO_CHANGED is stored once per pair (a < b) and matched UNDIRECTED (spec §12 D6).
// Test files are hidden by default and collapsed into a count (D16). The query
// fetches IMPACT_FETCH rows so hiding tests never leaves the shown list short.

import type { Graph } from "falkordb";
import { isTestPath } from "../ingest/paths.ts";

export const IMPACT_SHOWN = 15;
export const IMPACT_FETCH = 100;
export const MIN_SUPPORT = 0.3;

export const IMPACT_CYPHER = `MATCH (f:File {path: $path})-[c:CO_CHANGED]-(g:File)
WHERE g.alive AND c.support > $minSupport
RETURN g.path AS path, c.weight AS weight, c.support AS support
ORDER BY support DESC, weight DESC, path
LIMIT ${IMPACT_FETCH}`;

export const FILE_CYPHER = `MATCH (f:File {path: $path}) RETURN f.alive AS alive`;

export interface ImpactRow {
  path: string;
  weight: number;
  support: number;
}

export interface ImpactView {
  rows: ImpactRow[];
  /** Test files hidden from `rows`; print as "+N test files". 0 with includeTests. */
  hiddenTests: number;
}

/** Rows must arrive sorted by support desc. Presentation only: edges stay in the graph. */
export function presentImpact(rows: ImpactRow[], opts: { includeTests?: boolean; limit?: number } = {}): ImpactView {
  const limit = opts.limit ?? IMPACT_SHOWN;
  if (opts.includeTests) return { rows: rows.slice(0, limit), hiddenTests: 0 };
  const source = rows.filter((r) => !isTestPath(r.path));
  return { rows: source.slice(0, limit), hiddenTests: rows.length - source.length };
}

/** null when the path is not a File in the graph (typo, or untouched in the window). */
export async function impact(
  graph: Graph,
  path: string,
  opts: { includeTests?: boolean; limit?: number } = {},
): Promise<ImpactView | null> {
  const file = await graph.roQuery<{ alive: boolean }>(FILE_CYPHER, { params: { path } });
  if (!file.data?.length) return null;
  const res = await graph.roQuery<ImpactRow>(IMPACT_CYPHER, { params: { path, minSupport: MIN_SUPPORT } });
  return presentImpact(res.data ?? [], opts);
}
