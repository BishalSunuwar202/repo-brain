// risk(module?): where is knowledge concentrated (spec §5, revised by §15 R1/R2/R4).
//
// Bus-factor-1 file = one person holds MORE than `threshold` of the file's normalised
// doa, among files with at least `minCommits` authorship commits in the window.
//
// - threshold defaults to 0.5. At any threshold >= 0.5 at most one person can exceed
//   it, so the rule is a definition — "one person holds a strict majority of doa" —
//   not a tuned dial. size(dominant) = 1 is then redundant but kept for t < 0.5.
// - minCommits (default 3) is the activity floor: without it the list is files
//   touched once by one person, i.e. cold files, not concentrated knowledge.
// - No recency FILTER (R4): measured inert at 0.8 on fastify and FalkorDB, and recency
//   is already inside doa. "Days since anyone else touched it" is reported instead.
// - Bulk-only touches (t.commits = 0, R5) are not holders; a file with no authorship
//   commits never appears (total > 0 guards the division).
//
// Landmine 8 (no EXISTS { }): other holders' timestamps come out of a list
// comprehension over the collected holders.

import type { Graph } from "falkordb";
import { underCap } from "../db/client.ts";
import { FILE_KINDS, fileKind, type FileKind, type PathPredicate } from "../ingest/paths.ts";

export const DEFAULT_THRESHOLD = 0.5;
export const DEFAULT_MIN_COMMITS = 3;
const DAY_MS = 24 * 3600 * 1000;

const HOLDERS = `MATCH (p:Person)-[t:TOUCHED]->(f:File)
WHERE f.alive AND t.commits > 0 AND ($module IS NULL OR f.module = $module)
WITH f, collect({login: p.login, doa: t.doa, lastTs: t.lastTs}) AS holders, sum(t.doa) AS total, sum(t.commits) AS commits
WHERE commits >= $minCommits AND total > 0`;

export const RISK_CYPHER = `${HOLDERS}
WITH f, holders, total, commits, [h IN holders WHERE h.doa / total > $threshold] AS dominant
WHERE size(dominant) = 1
WITH f, holders, total, commits, dominant[0] AS sole
RETURN f.path AS path, f.module AS module, sole.login AS soleHolder, sole.doa / total AS share,
       commits, size(holders) AS holders, [h IN holders WHERE h.login <> sole.login | h.lastTs] AS otherTs
ORDER BY share DESC, path`;

/** Denominator for the per-segment breakdown: every file that passes the activity floor. */
export const ACTIVE_CYPHER = `${HOLDERS}
RETURN f.path AS path`;

export interface RawRiskRow {
  path: string;
  module: string | null;
  soleHolder: string;
  share: number;
  commits: number;
  holders: number;
  otherTs: string[];
}

export interface RiskRow {
  path: string;
  module: string | null;
  kind: FileKind;
  soleHolder: string;
  /** soleHolder's share of the file's normalised doa, > threshold. */
  share: number;
  /** Authorship commits on the file in the window (all holders, bulk excluded). */
  commits: number;
  /** People with authorship commits on the file, soleHolder included. */
  holders: number;
  /** Days since anyone other than soleHolder last touched it; null if no one else ever did. */
  daysSinceOther: number | null;
}

export interface Segment {
  kind: FileKind;
  /** Files of this kind passing the activity floor. */
  active: number;
  atRisk: number;
  /** Person who is sole holder on the most at-risk files of this kind. */
  topHolder: { login: string; files: number } | null;
}

export interface RiskOptions {
  module?: string;
  asOf?: Date;
  /** Dominance share, exclusive: 0 < threshold < 1. Default 0.5 (spec §15 R1). */
  threshold?: number;
  /** Activity floor: minimum authorship commits on the file. Default 3 (spec §15 R1). */
  minCommits?: number;
  /** Only these kinds; default all. */
  kinds?: readonly FileKind[];
  /** Required on purpose: every caller, including fix's before/after count, must filter. */
  exclude: PathPredicate;
}

export function checkThreshold(threshold: number): number {
  if (!(threshold > 0 && threshold < 1)) throw new Error(`--threshold must be strictly between 0 and 1, got ${threshold}`);
  return threshold;
}

export function checkMinCommits(minCommits: number): number {
  if (!(Number.isInteger(minCommits) && minCommits >= 1)) throw new Error(`--min-commits must be an integer >= 1, got ${minCommits}`);
  return minCommits;
}

export function checkKinds(kinds: readonly string[]): FileKind[] {
  const bad = kinds.filter((k) => !(FILE_KINDS as readonly string[]).includes(k));
  if (bad.length) throw new Error(`--kind: unknown ${bad.join(", ")} (one of ${FILE_KINDS.join(", ")})`);
  return kinds as FileKind[];
}

/**
 * Lockfiles / generated paths keep TOUCHED rows but are never reported (spec §12 D14);
 * adds kind and daysSinceOther, then applies the kind filter.
 */
export function presentRisk(rows: RawRiskRow[], opts: { exclude: PathPredicate; asOf: Date; kinds?: readonly FileKind[] }): RiskRow[] {
  const out: RiskRow[] = [];
  for (const { otherTs, ...r } of rows) {
    if (opts.exclude(r.path)) continue;
    const kind = fileKind(r.path);
    if (opts.kinds?.length && !opts.kinds.includes(kind)) continue;
    const last = otherTs.length ? Math.max(...otherTs.map((t) => Date.parse(t))) : null;
    const daysSinceOther = last === null ? null : Math.max(0, Math.floor((opts.asOf.getTime() - last) / DAY_MS));
    out.push({ ...r, kind, daysSinceOther });
  }
  return out;
}

/** Per-kind bus factor: at-risk / active files, and who holds the most of them. */
export function segmentRisk(rows: RiskRow[], activePaths: string[], exclude: PathPredicate): Segment[] {
  return FILE_KINDS.map((kind) => {
    const mine = rows.filter((r) => r.kind === kind);
    const counts = new Map<string, number>();
    for (const r of mine) counts.set(r.soleHolder, (counts.get(r.soleHolder) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      kind,
      active: activePaths.filter((p) => !exclude(p) && fileKind(p) === kind).length,
      atRisk: mine.length,
      topHolder: top ? { login: top[0], files: top[1] } : null,
    };
  });
}

function params(opts: RiskOptions) {
  return {
    module: opts.module ?? null,
    threshold: checkThreshold(opts.threshold ?? DEFAULT_THRESHOLD),
    minCommits: checkMinCommits(opts.minCommits ?? DEFAULT_MIN_COMMITS),
  };
}

export async function risk(graph: Graph, opts: RiskOptions): Promise<RiskRow[]> {
  const res = await graph.roQuery<RawRiskRow>(RISK_CYPHER, { params: params(opts) });
  return presentRisk(underCap(res.data, "risk"), { exclude: opts.exclude, asOf: opts.asOf ?? new Date(), kinds: opts.kinds });
}

/** Paths of every file passing the activity floor (the per-segment denominator). */
export async function activeFiles(graph: Graph, opts: RiskOptions): Promise<string[]> {
  const { module, minCommits } = params(opts);
  const res = await graph.roQuery<{ path: string }>(ACTIVE_CYPHER, { params: { module, minCommits } });
  return underCap(res.data, "risk active files").map((r) => r.path);
}
