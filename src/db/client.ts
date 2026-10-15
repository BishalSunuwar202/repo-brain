// FalkorDB connection + write helpers. One graph per repo (spec §3).

import { FalkorDB, type Graph } from "falkordb";

export const DEFAULT_URL = process.env.FALKORDB_URL ?? "redis://localhost:6379";

/** Query parameter shape accepted by the falkordb client. */
export type Param = null | string | number | boolean | Param[] | { [key: string]: Param };
export type Row = { [key: string]: Param };

/** "fastify/fastify" -> "repo:fastify-fastify" */
export function graphName(repo: string): string {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`expected owner/name, got "${repo}"`);
  return `repo:${owner}-${name}`;
}

export async function connect(url = DEFAULT_URL): Promise<FalkorDB> {
  return FalkorDB.connect({ url });
}

export async function openRepoGraph(db: FalkorDB, repo: string): Promise<Graph> {
  return db.selectGraph(graphName(repo));
}

/**
 * Writes rows in chunks through a query that starts with `UNWIND $rows AS row`.
 * Keeps round-trips down (spec §4). Never append `LIMIT` to a write (landmine 2).
 */
export async function writeBatched(graph: Graph, cypher: string, rows: Row[], batchSize = 1000): Promise<void> {
  if (!/^\s*UNWIND \$rows AS row\b/.test(cypher)) throw new Error("batched writes must start with UNWIND $rows AS row");
  for (let i = 0; i < rows.length; i += batchSize) {
    await graph.query(cypher, { params: { rows: rows.slice(i, i + batchSize) } });
  }
}
