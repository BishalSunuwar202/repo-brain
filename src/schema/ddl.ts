// Indexes from spec §3, applied to each repo graph before loading.
// Default index type in FalkorDB is RANGE; the falkordb client's own
// createNodeRangeIndex() emits the same `CREATE ... INDEX FOR (n:L) ON (n.p)` shape.

import type { Graph } from "falkordb";

export const DDL: string[] = [
  "CREATE INDEX FOR (p:Person) ON (p.login)",
  "CREATE INDEX FOR (f:File) ON (f.path)",
  "CREATE INDEX FOR (f:File) ON (f.module)",
  "CREATE INDEX FOR (c:Commit) ON (c.sha)",
  "CREATE INDEX FOR (r:PR) ON (r.number)",
  "CREATE INDEX FOR (k:Knowledge) ON (k.id)",
];

/**
 * Re-running DDL on an existing graph raises "already indexed"; that is success.
 * Verified live (spec §13): "Attribute 'login' is already indexed".
 */
export function isAlreadyIndexed(err: unknown): boolean {
  return /already indexed|already exists/i.test(String((err as Error)?.message ?? err));
}

export async function applySchema(graph: Graph): Promise<void> {
  for (const stmt of DDL) {
    try {
      await graph.query(stmt);
    } catch (err) {
      if (!isAlreadyIndexed(err)) throw err;
    }
  }
}
