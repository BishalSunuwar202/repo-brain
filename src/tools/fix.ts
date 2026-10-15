// fix(module?, budget?): THE CONTRIBUTION (spec §5, calibrated in §15 R3 and §16).
//
// Flow network:
//   SOURCE --cap=1--> [at-risk File]
//   [at-risk File] --cap=1--> [eligible Reviewer]   (iff reviewer is eligible)
//   [Reviewer] --cap=k_r--> SINK                    (k_r = review bandwidth)
//
// Eligibility (expertise floor), spec §15 R3 — this REPLACES §5's co-change rule,
// which was measured to leave fix nearly empty (5 of 78 at-risk fastify files had
// any alive co-change partner). r is eligible for f iff r is not f's sole holder
// and r has doa > θ on some OTHER alive, non-excluded file in f's module.
// Co-change evidence may raise a reviewer's rank; it never gates eligibility.
//
// Max flow = files that can be de-risked within bandwidth. Min-cut names the
// bottleneck: reviewer bandwidth vs. nobody eligible.
//
// k_r = --budget (default 2, spec §12 D7).
//
// Execution per spec §5 "Verified API": materialise (:FlowNode {kind})-[:FLOWS_TO {cap}]->
// with explicit SOURCE/SINK in a throwaway graph flow:<uuid> (the built-in
// multi-source mode uses infinite-capacity super-nodes, which erase cap=1 and k_r),
// CALL algo.maxFlow({sourceNodes, targetNodes, relationshipTypes: ['FLOWS_TO'],
// capacityProperty: 'cap', nodeLabels: ['FlowNode']}), derive the min-cut in TS
// from edgeFlows (the procedure does not return it), then delete the graph.

import { randomUUID } from "node:crypto";
import type { FalkorDB, Graph } from "falkordb";
import { underCap, writeBatched } from "../db/client.ts";
import type { PathPredicate } from "../ingest/paths.ts";
import { risk, type RiskOptions } from "./risk.ts";

export interface Assignment {
  reviewer: string;
  files: string[];
}

export interface FixResult {
  /** Files risk() flags as bus-factor-1, before any review happens. */
  atRiskBefore: number;
  /**
   * COUNTERFACTUAL: files still bus-factor-1 *if* every prescribed review happens.
   * It is atRiskBefore - maxFlow, not a re-measurement, and must be presented as a
   * projection — the graph cannot know whether the reviews were done.
   */
  atRiskAfter: number;
  /** At-risk files with at least one eligible reviewer (spec §15 R3's "32/32"). */
  coverable: number;
  assignments: Assignment[];
  bottleneck: "bandwidth" | "eligibility" | "none";
  /** Reviewers whose budget the min cut shows to be binding; empty unless bandwidth-bound. */
  bottleneckReviewers: string[];
  /** The at-risk files no reviewer could be assigned to, sorted. Length is atRiskAfter. */
  unserved: string[];
  /**
   * atRiskAfter with the candidate shortlist lifted — what the projection would be if
   * every eligible reviewer, however marginal, were allowed in. null unless asked for,
   * because it costs a second solve. See DEFAULT_CANDIDATES for why the gap exists and
   * why the restrictive default is still the honest one: any published projection
   * should state N, and this is how the cost of that N stays visible.
   */
  ceiling: number | null;
}



// --- The min-cut derivation (spec §5 "Deriving the min-cut") -----------------
// algo.maxFlow returns flows only, never the cut. We derive it here: residual
// BFS from SOURCE gives the reachable set S, and the cut is every edge leaving
// S. Pure and database-free on purpose — this is where the demo's sentence
// comes from, so it is the part that must be test-covered.

/** An edge of the materialised flow network, carrying the flow maxFlow assigned it. */
export interface FlowEdge {
  from: string;
  to: string;
  cap: number;
  flow: number;
}

/**
 * Edges crossing the minimum cut, in input order. By the max-flow min-cut
 * theorem their total capacity equals the max flow, which the tests assert.
 */
export function minCut(edges: readonly FlowEdge[], source: string): FlowEdge[] {
  const residual = new Map<string, string[]>();
  const link = (u: string, v: string) => {
    const seen = residual.get(u);
    if (seen) seen.push(v);
    else residual.set(u, [v]);
  };
  for (const e of edges) {
    if (e.cap > e.flow) link(e.from, e.to); // forward residual capacity
    if (e.flow > 0) link(e.to, e.from); // backward residual (flow can be cancelled)
  }

  const reachable = new Set([source]);
  const queue = [source];
  for (let i = 0; i < queue.length; i++) {
    for (const v of residual.get(queue[i]!) ?? []) {
      if (!reachable.has(v)) {
        reachable.add(v);
        queue.push(v);
      }
    }
  }

  return edges.filter((e) => reachable.has(e.from) && !reachable.has(e.to));
}

// --- Naming the bottleneck ---------------------------------------------------
// Node ids are prefixed so the cut can be read back without carrying a separate
// role map through the FalkorDB round-trip.

export const SOURCE = "SOURCE";
export const SINK = "SINK";
export const fileNode = (path: string) => `f:${path}`;
export const reviewerNode = (login: string) => `r:${login}`;

export type Bottleneck = FixResult["bottleneck"];

const isFile = (id: string) => id.startsWith("f:");
const isReviewer = (id: string) => id.startsWith("r:");
/** Strips the one-character role prefix put on by fileNode / reviewerNode. */
const unprefix = (id: string) => id.slice(2);

/**
 * Which constraint is actually binding (spec §5), read from the files the flow could
 * not serve.
 *
 * NOT from the cut's composition. A saturated SOURCE->file edge crossing the cut
 * means that file WAS served; a file nobody can review keeps residual capacity on its
 * SOURCE edge, so it stays inside the reachable set and never crosses the cut at all.
 * Counting cut edges therefore gets it backwards: measured on fastify it reported
 * "eligibility" for a file whose four candidates were every one at budget.
 *
 * - no candidate edges at all  -> eligibility: more budget cannot help.
 * - candidates, all saturated  -> bandwidth: raising k_r can.
 *
 * A mixed shortfall reports whichever explains more files; ties go to eligibility,
 * the structural problem.
 */
export function classifyBottleneck(edges: readonly FlowEdge[]): Bottleneck {
  const candidates = new Map<string, number>();
  for (const e of edges) {
    if (isFile(e.from) && isReviewer(e.to)) candidates.set(e.from, (candidates.get(e.from) ?? 0) + 1);
  }

  let uncoverable = 0;
  let blocked = 0;
  for (const e of edges) {
    if (e.from !== SOURCE || e.flow > 0) continue;
    if (candidates.get(e.to)) blocked++;
    else uncoverable++;
  }

  if (!uncoverable && !blocked) return "none";
  return blocked > uncoverable ? "bandwidth" : "eligibility";
}

/**
 * Whose budget is binding, from the min cut — the one recommendation that follows
 * from the cut itself rather than from counting. Their reviewer->SINK edges are
 * exactly the saturated capacities holding max flow down, so these are the people to
 * raise k_r for, and the cut's capacity proves no smaller set would do.
 */
export function bottleneckReviewers(cut: readonly FlowEdge[]): string[] {
  return cut
    .filter((e) => e.to === SINK)
    .map((e) => unprefix(e.from))
    .sort();
}

// --- Building the network ----------------------------------------------------

export interface NetworkInput {
  /** At-risk file paths, already filtered by risk()'s exclude + kind rules. */
  atRisk: readonly string[];
  /** path -> logins eligible to review it (the expertise floor). */
  eligible: ReadonlyMap<string, readonly string[]>;
  /** k_r: extra reviews each reviewer can absorb (spec §12 D7). */
  budget: number;
}

/**
 * The flow network of spec §5, with every capacity explicit.
 *
 * A file with no eligible reviewer still gets its SOURCE edge. Dropping it would
 * remove the file from the network, make max flow look healthy, and leave the
 * "no eligible reviewer" bottleneck unreportable.
 */
export function buildNetwork({ atRisk, eligible, budget }: NetworkInput): FlowEdge[] {
  const edges: FlowEdge[] = atRisk.map((path) => ({ from: SOURCE, to: fileNode(path), cap: 1, flow: 0 }));

  const reviewers = new Set<string>();
  for (const path of atRisk) {
    for (const login of eligible.get(path) ?? []) {
      edges.push({ from: fileNode(path), to: reviewerNode(login), cap: 1, flow: 0 });
      reviewers.add(login);
    }
  }

  for (const login of [...reviewers].sort()) {
    edges.push({ from: reviewerNode(login), to: SINK, cap: budget, flow: 0 });
  }
  return edges;
}

// --- R3 eligibility (spec §15) ----------------------------------------------
// The expertise floor. Cypher applies theta and the commits floor and returns one
// row per MODULE — never one per (file, reviewer) edge, which on pnpm is far over
// RESULTSET_SIZE and would come back silently truncated (landmine 9). The per-file
// rules are applied here instead: cheap, and testable without a database.

/** One row of the eligibility query: a module and everyone with doa > theta inside it. */
export interface ModuleExperts {
  module: string | null;
  /**
   * `via` is the file that earned the expertise, needed for R3's "some OTHER file";
   * `doa` is that file's normalised share, used to rank and shortlist candidates.
   */
  experts: readonly { login: string; via: string; doa: number }[];
}

/** The fields of a risk row that eligibility depends on. */
export interface AtRiskFile {
  path: string;
  module: string | null;
  soleHolder: string;
}

/**
 * How many candidates per file reach the flow network. See eligibleByFile for why
 * the shortlist exists at all.
 *
 * It is NOT free, measured 2026-10-15 (atRiskAfter at the risk defaults, budget 2):
 *
 *   repo       N=1    2     3     5    10   all
 *   fastify     20    11     6     1     1     1
 *   FalkorDB    78    74    72    63    60    60
 *   undici      49    30    24    13     4     2
 *   pnpm      1533  1498  1471  1411  1327  1029
 *   vite       152   132   121   106    90    44
 *
 * Unrestricted scores best because the long tail of barely-qualified reviewers
 * (doa just over theta) absorbs the overflow once the strong ones hit their budget.
 * That is a better NUMBER from worse ADVICE, so the default stays restrictive and
 * `--candidates` is exposed for anyone who wants the optimistic projection. On
 * fastify, the demo repo (§15's D8 update), N=5 costs nothing.
 */
export const DEFAULT_CANDIDATES = 5;

export function checkCandidates(candidates: number): number {
  if (!(Number.isInteger(candidates) && candidates >= 1)) throw new Error(`--candidates must be an integer >= 1, got ${candidates}`);
  return candidates;
}

/**
 * path -> logins eligible to review it, strongest first, for every at-risk file.
 *
 * A file nobody can cover maps to `[]` rather than being absent: `coverable` is a
 * reported number (§15 R3), and buildNetwork needs the file in the network for the
 * eligibility bottleneck to be visible at all.
 *
 * Both exclusions carry weight. The sole holder already owns the file, so assigning
 * it to them spreads no knowledge. A reviewer whose only expertise IS the file
 * learns nothing from reviewing it — hence R3's "some other file g, g.path != f.path".
 *
 * RANKING AND SHORTLISTING. algo.maxFlow minimises cardinality and is indifferent
 * between equally-sized assignments, so with every eligible pair in the network it
 * returns an arbitrary one — measured live, it picked whoever sorted first
 * (fastify: acoluzzi, agustin18; pnpm: 0xnoramiya, 3w36zj6). Keeping each file's
 * strongest `candidates` reviewers means every assignment the solver can reach comes
 * from people who demonstrably know the module, without touching optimality within
 * the restricted network. This is R3's "co-change may raise a reviewer's rank within
 * the eligible set" applied to doa; it never relaxes the floor, only narrows it.
 *
 * A reviewer is ranked by their STRONGEST qualifying file, and ties break on login so
 * the same repo always yields the same prescription.
 */
export function eligibleByFile(
  atRisk: readonly AtRiskFile[],
  moduleExperts: readonly ModuleExperts[],
  opts: { exclude: PathPredicate; candidates?: number },
): Map<string, string[]> {
  const candidates = checkCandidates(opts.candidates ?? DEFAULT_CANDIDATES);
  const byModule = new Map<string, ModuleExperts["experts"]>();
  for (const row of moduleExperts) {
    if (row.module !== null) byModule.set(row.module, row.experts);
  }

  const out = new Map<string, string[]>();
  for (const f of atRisk) {
    const best = new Map<string, number>();
    for (const e of (f.module === null ? undefined : byModule.get(f.module)) ?? []) {
      if (e.login === f.soleHolder || e.via === f.path || opts.exclude(e.via)) continue;
      best.set(e.login, Math.max(best.get(e.login) ?? 0, e.doa));
    }
    out.set(
      f.path,
      [...best]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, candidates)
        .map(([login]) => login),
    );
  }
  return out;
}

// --- Reading the prescription back out of the flow --------------------------

/**
 * The file->reviewer edges that carry flow, grouped by reviewer, busiest first.
 *
 * `flow > 0` is what makes the prescription minimal: buildNetwork emits an edge for
 * every ELIGIBLE pairing, and maxFlow picks a sufficient subset. Without the filter
 * fix would prescribe every eligible pairing instead of the smallest sufficient one.
 */
export function assignmentsFrom(edges: readonly FlowEdge[]): Assignment[] {
  const byReviewer = new Map<string, string[]>();
  for (const e of edges) {
    if (e.flow <= 0 || !isFile(e.from) || !isReviewer(e.to)) continue;
    const reviewer = unprefix(e.to);
    const files = byReviewer.get(reviewer);
    if (files) files.push(unprefix(e.from));
    else byReviewer.set(reviewer, [unprefix(e.from)]);
  }

  return [...byReviewer]
    .map(([reviewer, files]) => ({ reviewer, files: files.sort() }))
    .sort((a, b) => b.files.length - a.files.length || a.reviewer.localeCompare(b.reviewer));
}

// --- Merging the database's flows back onto the built network ---------------

/** One row of the maxFlow read: an edge that carried flow, keyed by our own node names. */
export interface FlowRow {
  from: string;
  to: string;
  flow: number;
}

/**
 * The built network with the reported flows filled in, zeros kept.
 *
 * algo.maxFlow returns only POSITIVE-flow edges (verified live), so its result is a
 * subset; minCut needs the whole network, since an unsaturated edge is exactly what
 * keeps a node inside the residual-reachable set.
 *
 * Two consistency checks, both fatal. A flow on an edge we never built means the
 * round-trip lost or renamed something, and the flows are landing on the wrong
 * pairs — which still yields a plausible-looking prescription. And maxFlow must
 * equal the flow leaving SOURCE; if it does not, the materialised network is not
 * the one we designed (a cap round-tripped as a string, nodeLabels caught a stray
 * node), and every number fix reports is wrong by an unknown amount.
 */
export function mergeFlows(edges: readonly FlowEdge[], rows: readonly FlowRow[], maxFlow: number): FlowEdge[] {
  const flows = new Map(rows.map((r) => [`${r.from}->${r.to}`, r.flow]));
  const out = edges.map((e) => {
    const key = `${e.from}->${e.to}`;
    const flow = flows.get(key) ?? 0;
    flows.delete(key);
    return { ...e, flow };
  });

  if (flows.size) throw new Error(`maxFlow reported flow on edges that are not in the network: ${[...flows.keys()].join(", ")}`);

  const outOfSource = out.reduce((sum, e) => (e.from === SOURCE ? sum + e.flow : sum), 0);
  if (outOfSource !== maxFlow) {
    throw new Error(`inconsistent flow: maxFlow ${maxFlow} but ${outOfSource} leaving SOURCE — the materialised network is not the one we built`);
  }
  return out;
}

// --- The reported result ----------------------------------------------------

/**
 * Everything after the database round-trip: merge the flows in, cut the network,
 * name the bottleneck, group the prescription.
 *
 * Both counts are derived from the network itself rather than passed in, so the
 * answer cannot disagree with the graph that produced it: atRiskBefore is the
 * SOURCE fan-out, and coverable is the files that have any eligible reviewer at all.
 */
export function presentFix(built: readonly FlowEdge[], solved: { rows: readonly FlowRow[]; maxFlow: number }): FixResult {
  const edges = mergeFlows(built, solved.rows, solved.maxFlow);
  const atRiskBefore = edges.filter((e) => e.from === SOURCE).length;
  const coverable = new Set(edges.filter((e) => isFile(e.from) && isReviewer(e.to)).map((e) => e.from)).size;

  return {
    atRiskBefore,
    atRiskAfter: atRiskBefore - solved.maxFlow,
    coverable,
    assignments: assignmentsFrom(edges),
    bottleneck: classifyBottleneck(edges),
    bottleneckReviewers: bottleneckReviewers(minCut(edges, SOURCE)),
    unserved: edges
      .filter((e) => e.from === SOURCE && e.flow === 0)
      .map((e) => unprefix(e.to))
      .sort(),
    // presentFix sees one network; the comparison needs two. fix() fills it in.
    ceiling: null,
  };
}

// --- Options ----------------------------------------------------------------

/** k_r: extra reviews one person can absorb (spec §12 D7). */
export const DEFAULT_BUDGET = 2;
/** Expertise floor on normalised doa. PROVISIONAL (spec §15 R3): tuned on the backtest. */
export const DEFAULT_THETA = 0.2;

export function checkBudget(budget: number): number {
  if (!(Number.isInteger(budget) && budget >= 1)) throw new Error(`--budget must be an integer >= 1, got ${budget}`);
  return budget;
}

export function checkTheta(theta: number): number {
  if (!(theta > 0 && theta < 1)) throw new Error(`--theta must be strictly between 0 and 1, got ${theta}`);
  return theta;
}

// --- The eligibility read (spec §15 R3) -------------------------------------

/**
 * Everyone above the expertise floor, ONE ROW PER MODULE.
 *
 * Not one row per (file, reviewer) pair: on pnpm that edge list runs to tens of
 * thousands and would come back silently truncated at RESULTSET_SIZE (landmine 9).
 * The obvious `UNWIND $files AS f MATCH ... WHERE g.module = f.module` join was
 * measured to time out on pnpm even with the File.module index, so the per-file
 * rules run in TS instead (eligibleByFile).
 *
 * `t.doa` is already normalised per file, so it is the share directly. `t.commits > 0`
 * drops bulk-only touchers (spec §12 D5/R5), who have doa 0 and know nothing.
 */
export const ELIGIBLE_CYPHER = `MATCH (r:Person)-[t:TOUCHED]->(g:File)
WHERE g.alive AND t.commits > 0 AND t.doa > $theta AND ($module IS NULL OR g.module = $module)
RETURN g.module AS module, collect({login: r.login, via: g.path, doa: t.doa}) AS experts`;

// --- Solving the flow in a throwaway graph ----------------------------------
// The network cannot live in the repo graph: algo.maxFlow's multi-source mode uses
// infinite-capacity virtual super-nodes, which would erase cap=1 and k_r, so SOURCE
// and SINK have to be real nodes. They are materialised in flow:<uuid>, solved, and
// dropped, leaving the repo graph untouched.

const MATERIALISE = `UNWIND $rows AS row
MERGE (a:FlowNode {name: row.from})
MERGE (b:FlowNode {name: row.to})
CREATE (a)-[:FLOWS_TO {cap: row.cap}]->(b)`;

/**
 * Verified live against FalkorDB 2026-10-15: `startNode()` / `endNode()` work, so
 * the flows come back keyed by our own node names and need no internal-ID mapping.
 * `edges` holds only POSITIVE-flow edges and `edgeFlows` is parallel to it, so the
 * UNWIND yields no rows at all when nothing can flow — also verified, and the reason
 * maxFlow is read off the first row with a 0 fallback rather than from its own query.
 */
const MAXFLOW_CYPHER = `MATCH (s:FlowNode {name: $source}) MATCH (t:FlowNode {name: $sink})
WITH collect(s) AS sources, collect(t) AS targets
CALL algo.maxFlow({
  sourceNodes: sources, targetNodes: targets,
  relationshipTypes: ['FLOWS_TO'], capacityProperty: 'cap', nodeLabels: ['FlowNode']
})
YIELD edges, edgeFlows, maxFlow
UNWIND range(0, size(edges) - 1) AS i
RETURN maxFlow, startNode(edges[i]).name AS src, endNode(edges[i]).name AS dst, edgeFlows[i] AS flow`;

export interface Solved {
  rows: FlowRow[];
  maxFlow: number;
}

/** Materialise, solve, drop. The graph is deleted even if the solve throws. */
export async function solveMaxFlow(db: FalkorDB, edges: readonly FlowEdge[]): Promise<Solved> {
  if (!edges.length) return { rows: [], maxFlow: 0 };

  const graph = db.selectGraph(`flow:${randomUUID()}`);
  try {
    // Without the index every MERGE in every batch is a label scan.
    await graph.createNodeRangeIndex("FlowNode", "name");
    // Both terminals exist up front, so a network where nothing can reach SINK still
    // solves (to 0) instead of matching no rows for accidentally the right reason.
    await graph.query(`MERGE (:FlowNode {name: $source}) MERGE (:FlowNode {name: $sink})`, { params: { source: SOURCE, sink: SINK } });
    await writeBatched(
      graph,
      MATERIALISE,
      edges.map((e) => ({ from: e.from, to: e.to, cap: e.cap })),
    );

    const res = await graph.roQuery<{ maxFlow: number; src: string; dst: string; flow: number }>(MAXFLOW_CYPHER, {
      params: { source: SOURCE, sink: SINK },
    });
    const rows = underCap(res.data, "fix maxFlow edge flows");
    return { rows: rows.map((r) => ({ from: r.src, to: r.dst, flow: r.flow })), maxFlow: rows[0]?.maxFlow ?? 0 };
  } finally {
    await graph.delete().catch(() => {});
  }
}

// --- fix() ------------------------------------------------------------------

export interface FixOptions extends RiskOptions {
  /** k_r: extra reviews each reviewer can absorb. Default DEFAULT_BUDGET. */
  budget?: number;
  /** Expertise floor on normalised doa. Default DEFAULT_THETA. */
  theta?: number;
  /** Strongest candidates per file that reach the network. Default DEFAULT_CANDIDATES. */
  candidates?: number;
  /**
   * Also solve with the shortlist lifted and report it as `ceiling`. Costs a second
   * solve (~2.4s on pnpm, negligible elsewhere), so it is opt-in.
   */
  ceiling?: boolean;
}

/**
 * The minimal set of review assignments that reduces bus-factor-1 risk.
 *
 * `db` is needed as well as `graph` because the flow network is solved in its own
 * throwaway graph; Graph does not expose its client.
 */
export async function fix(graph: Graph, db: FalkorDB, opts: FixOptions): Promise<FixResult> {
  const budget = checkBudget(opts.budget ?? DEFAULT_BUDGET);
  const theta = checkTheta(opts.theta ?? DEFAULT_THETA);

  const atRisk = await risk(graph, opts);
  const res = await graph.roQuery<ModuleExperts>(ELIGIBLE_CYPHER, { params: { theta, module: opts.module ?? null } });
  const experts = underCap(res.data, "fix eligibility");

  // One eligibility read, solved once per shortlist size asked for.
  const solve = async (candidates?: number) => {
    const eligible = eligibleByFile(atRisk, experts, { exclude: opts.exclude, candidates });
    const built = buildNetwork({ atRisk: atRisk.map((r) => r.path), eligible, budget });
    return presentFix(built, await solveMaxFlow(db, built));
  };

  const result = await solve(opts.candidates);
  if (!opts.ceiling) return result;
  // MAX_SAFE_INTEGER rather than a flag: checkCandidates wants an integer, and the
  // slice is simply a no-op at that size.
  return { ...result, ceiling: (await solve(Number.MAX_SAFE_INTEGER)).atRiskAfter };
}
