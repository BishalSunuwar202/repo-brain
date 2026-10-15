// fix(module?, budget?): THE CONTRIBUTION (spec §5). STUB.
//
// Flow network:
//   SOURCE --cap=1--> [at-risk File]
//   [at-risk File] --cap=1--> [eligible Reviewer]   (iff reviewer is eligible)
//   [Reviewer] --cap=k_r--> SINK                    (k_r = review bandwidth)
//
// Eligibility (expertise floor): r is eligible for f iff r has doa > θ on at
// least one file co-changed with f. θ tuned on the backtest.
//
//   MATCH (f:File)-[:CO_CHANGED]-(g:File)<-[t:TOUCHED]-(r:Person)
//   WHERE f.path IN $atRisk AND t.doa > $theta
//   RETURN f.path, collect(DISTINCT r.login) AS eligible
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

import type { Graph } from "falkordb";

export interface Assignment {
  reviewer: string;
  files: string[];
}

export interface FixResult {
  atRiskBefore: number;
  atRiskAfter: number;
  assignments: Assignment[];
  bottleneck: "bandwidth" | "eligibility" | "none";
}

export async function fix(_graph: Graph, _opts: { module?: string; budget: number }): Promise<FixResult> {
  throw new Error("not implemented: fix");
}
