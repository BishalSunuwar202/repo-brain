import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BUDGET, DEFAULT_THETA, SINK, SOURCE, assignmentsFrom, bottleneckReviewers, checkBudget, checkCandidates, checkTheta, buildNetwork, classifyBottleneck, eligibleByFile, fileNode, mergeFlows, minCut, presentFix, reviewerNode, type FlowEdge } from "../src/tools/fix.ts";
import { isCoChangeExcluded, moduleOf } from "../src/ingest/paths.ts";

// The fixture from spec §5, verified live against algo.maxFlow (maxFlow = 13,
// edge flows A->B 8, A->C 5, B->C 8). Residual from A reaches B (10-8=2 left),
// B->C is saturated, so S = {A, B} and the cut is the two edges into C.
test("minCut: cut edges leave the residual-reachable set, and cut capacity equals maxFlow", () => {
  const edges: FlowEdge[] = [
    { from: "A", to: "B", cap: 10, flow: 8 },
    { from: "A", to: "C", cap: 5, flow: 5 },
    { from: "B", to: "C", cap: 8, flow: 8 },
  ];

  const cut = minCut(edges, "A");

  assert.deepEqual(
    cut.map((e) => `${e.from}->${e.to}`),
    ["A->C", "B->C"],
  );
  assert.equal(
    cut.reduce((sum, e) => sum + e.cap, 0),
    13,
    "max-flow min-cut theorem: cut capacity must equal the max flow",
  );
});

// Spec §5: fix must say WHY it could not do better, and the two answers need
// opposite advice — raise --budget, or go find someone who knows the module.
//
// Read from the unserved files, NOT from the cut's composition. A saturated
// SOURCE->file edge in the cut means that file WAS served; an unservable file has
// residual capacity on its SOURCE edge, so it sits inside the reachable set and its
// edge never crosses the cut. Measured on fastify, composition-counting reported
// "eligibility" for a file whose four candidates were all at budget.

test("classifyBottleneck: an unserved file with no candidate at all is an eligibility problem", () => {
  const edges: FlowEdge[] = [{ from: SOURCE, to: fileNode("src/orphan.ts"), cap: 1, flow: 0 }];
  assert.equal(classifyBottleneck(edges), "eligibility");
});

// The fastify case: the file has four qualified reviewers and every one of them is
// already at budget. More budget fixes this; more expertise is not the problem.
test("classifyBottleneck: an unserved file whose candidates are all saturated is a bandwidth problem", () => {
  const edges: FlowEdge[] = [
    { from: SOURCE, to: fileNode("src/a.ts"), cap: 1, flow: 1 },
    { from: SOURCE, to: fileNode("src/b.ts"), cap: 1, flow: 1 },
    { from: SOURCE, to: fileNode("src/blocked.ts"), cap: 1, flow: 0 },
    { from: fileNode("src/a.ts"), to: reviewerNode("eomm"), cap: 1, flow: 1 },
    { from: fileNode("src/b.ts"), to: reviewerNode("eomm"), cap: 1, flow: 1 },
    { from: fileNode("src/blocked.ts"), to: reviewerNode("eomm"), cap: 1, flow: 0 },
    { from: reviewerNode("eomm"), to: SINK, cap: 2, flow: 2 },
  ];
  assert.equal(classifyBottleneck(edges), "bandwidth");
});

test("classifyBottleneck: nothing unserved is 'none'", () => {
  const edges: FlowEdge[] = [
    { from: SOURCE, to: fileNode("src/a.ts"), cap: 1, flow: 1 },
    { from: fileNode("src/a.ts"), to: reviewerNode("alice"), cap: 1, flow: 1 },
    { from: reviewerNode("alice"), to: SINK, cap: 2, flow: 1 },
  ];
  assert.equal(classifyBottleneck(edges), "none");
});

// Both at once: report whichever explains more unserved files, and on a tie prefer
// the structural one, since no amount of --budget will fix it.
test("classifyBottleneck: a mixed shortfall reports whichever explains more files, ties to eligibility", () => {
  const saturated: FlowEdge[] = [
    { from: SOURCE, to: fileNode("src/served.ts"), cap: 1, flow: 1 },
    { from: fileNode("src/served.ts"), to: reviewerNode("alice"), cap: 1, flow: 1 },
    { from: reviewerNode("alice"), to: SINK, cap: 1, flow: 1 },
  ];
  // unserved, but alice is a candidate for it — she is just out of budget
  const blocked = (path: string): FlowEdge[] => [
    { from: SOURCE, to: fileNode(path), cap: 1, flow: 0 },
    { from: fileNode(path), to: reviewerNode("alice"), cap: 1, flow: 0 },
  ];
  // unserved with no candidate edge at all
  const orphan = (n: number): FlowEdge[] => Array.from({ length: n }, (_, i) => ({ from: SOURCE, to: fileNode(`src/orphan${i}.ts`), cap: 1, flow: 0 }));

  assert.equal(classifyBottleneck([...saturated, ...blocked("src/b1.ts"), ...orphan(2)]), "eligibility", "2 orphans beat 1 blocked");
  assert.equal(classifyBottleneck([...saturated, ...blocked("src/b1.ts"), ...orphan(1)]), "eligibility", "1 and 1 ties to the structural one");
  assert.equal(classifyBottleneck([...saturated, ...blocked("src/b1.ts"), ...blocked("src/b2.ts"), ...orphan(1)]), "bandwidth", "2 blocked beat 1 orphan");
});

// What the min cut is actually FOR. Its capacity proves the assignment optimal, and
// its reviewer->SINK edges name exactly whose budget is binding — the one piece of
// advice that follows from the cut rather than from counting.
test("bottleneckReviewers: the cut names whose budget is binding, in order", () => {
  const cut: FlowEdge[] = [
    { from: SOURCE, to: fileNode("src/a.ts"), cap: 1, flow: 1 },
    { from: reviewerNode("mcollina"), to: SINK, cap: 2, flow: 2 },
    { from: reviewerNode("eomm"), to: SINK, cap: 2, flow: 2 },
  ];
  assert.deepEqual(bottleneckReviewers(cut), ["eomm", "mcollina"]);
  assert.deepEqual(bottleneckReviewers([]), []);
});

// Spec §5 network: SOURCE -cap=1-> file -cap=1-> reviewer -cap=k_r-> SINK.
// k_r is the only capacity above 1; the two cap=1 layers are what make the
// built-in multi-source mode unusable (it would use infinite-capacity supernodes).
test("buildNetwork: one cap=1 edge per file, one cap=1 edge per eligible pair, one cap=budget edge per reviewer", () => {
  const edges = buildNetwork({
    atRisk: ["src/a.ts", "src/b.ts"],
    eligible: new Map([
      ["src/a.ts", ["alice", "bob"]],
      ["src/b.ts", ["alice"]],
    ]),
    budget: 2,
  });

  const shape = edges.map((e) => `${e.from}->${e.to}@${e.cap}`);
  assert.deepEqual(shape, [
    `${SOURCE}->f:src/a.ts@1`,
    `${SOURCE}->f:src/b.ts@1`,
    "f:src/a.ts->r:alice@1",
    "f:src/a.ts->r:bob@1",
    "f:src/b.ts->r:alice@1",
    `r:alice->${SINK}@2`,
    `r:bob->${SINK}@2`,
  ]);
  assert.ok(
    edges.every((e) => e.flow === 0),
    "a freshly built network carries no flow yet",
  );
});

// Without this edge the file disappears from the network entirely and max flow
// looks healthy, so the "no eligible reviewer" bottleneck could never be reported.
test("buildNetwork: a file with no eligible reviewer still gets its SOURCE edge", () => {
  const edges = buildNetwork({
    atRisk: ["src/orphan.ts"],
    eligible: new Map(),
    budget: 2,
  });

  assert.deepEqual(edges, [{ from: SOURCE, to: fileNode("src/orphan.ts"), cap: 1, flow: 0 }]);
  // It stays inside the residual-reachable set, so the cut is EMPTY and only the
  // unserved-file reading can diagnose it.
  assert.deepEqual(minCut(edges, SOURCE), []);
  assert.equal(classifyBottleneck(edges), "eligibility");
});

// --- R3 eligibility (spec §15) ----------------------------------------------
// eligible(r, f) iff r != soleHolder(f) AND r has doa > theta on some OTHER alive,
// non-excluded file in f's module. Cypher applies theta and the commits floor and
// returns one row per module (landmine 9: never one row per edge); the per-file
// rules are applied here, where they are cheap and testable.

const atRisk = (path: string, soleHolder: string) => ({ path, module: moduleOf(path), soleHolder });

test("eligibleByFile: R3 — expertise on another file in the same module makes a reviewer eligible", () => {
  const eligible = eligibleByFile(
    [atRisk("src/tools/risk.ts", "alice")],
    [{ module: "src/tools", experts: [{ login: "bob", via: "src/tools/impact.ts", doa: 0.9 }] }],
    { exclude: () => false },
  );

  assert.deepEqual(eligible.get("src/tools/risk.ts"), ["bob"]);
});

test("eligibleByFile: a module's experts do not cross into another module", () => {
  const eligible = eligibleByFile(
    [atRisk("src/tools/risk.ts", "alice")],
    [{ module: "src/ingest", experts: [{ login: "bob", via: "src/ingest/gitlog.ts", doa: 0.9 }] }],
    { exclude: () => false },
  );

  assert.deepEqual(eligible.get("src/tools/risk.ts"), []);
});

// The two exclusions that make the assignment mean something. The sole holder
// already owns the file, so assigning it to them spreads no knowledge; and a
// reviewer whose only expertise is f itself learns nothing new from reviewing f,
// which is why R3 demands expertise on some OTHER file.
test("eligibleByFile: neither the sole holder nor expertise via the file itself counts", () => {
  const eligible = eligibleByFile(
    [atRisk("src/tools/risk.ts", "alice")],
    [
      {
        module: "src/tools",
        experts: [
          { login: "alice", via: "src/tools/impact.ts", doa: 0.9 }, // sole holder of risk.ts
          { login: "carol", via: "src/tools/risk.ts", doa: 0.9 }, // expert only via the file itself
        ],
      },
    ],
    { exclude: () => false },
  );

  assert.deepEqual(eligible.get("src/tools/risk.ts"), []);
});

test("eligibleByFile: D14-excluded files are not expertise evidence, and logins come back distinct", () => {
  const eligible = eligibleByFile(
    [atRisk("packages/core/engine.ts", "alice")],
    [
      {
        module: "packages/core",
        experts: [
          { login: "bob", via: "packages/core/pnpm-lock.yaml", doa: 0.9 },
          { login: "bob", via: "packages/core/util.ts", doa: 0.4 },
          { login: "bob", via: "packages/core/parse.ts", doa: 0.5 },
          { login: "dave", via: "packages/core/dist/bundle.js", doa: 0.9 },
        ],
      },
    ],
    { exclude: isCoChangeExcluded },
  );

  assert.deepEqual(eligible.get("packages/core/engine.ts"), ["bob"]);
});

// buildNetwork tolerates a missing key, but `coverable` is a reported number
// (spec §15 R3: "32/32"), so an uncoverable file must be present and empty,
// never absent.
test("eligibleByFile: every at-risk file gets an entry, empty when nobody qualifies", () => {
  const eligible = eligibleByFile([atRisk("README.md", "alice")], [], { exclude: () => false });

  assert.deepEqual([...eligible], [["README.md", []]]);
});

// --- Reading the assignments back out of the flow ---------------------------
// algo.maxFlow returns a flow per edge. The file->reviewer edges carrying flow
// ARE the prescription; everything else in the network is scaffolding.

const flowed = (from: string, to: string, cap: number, flow: number): FlowEdge => ({ from, to, cap, flow });

test("assignmentsFrom: file->reviewer edges carrying flow become the prescription, grouped per reviewer", () => {
  const edges = [
    flowed(SOURCE, fileNode("src/a.ts"), 1, 1),
    flowed(SOURCE, fileNode("src/b.ts"), 1, 1),
    flowed(fileNode("src/a.ts"), reviewerNode("bob"), 1, 1),
    flowed(fileNode("src/b.ts"), reviewerNode("bob"), 1, 1),
    flowed(reviewerNode("bob"), SINK, 2, 2),
  ];

  assert.deepEqual(assignmentsFrom(edges), [{ reviewer: "bob", files: ["src/a.ts", "src/b.ts"] }]);
});

// buildNetwork emits an edge for every ELIGIBLE pair; maxFlow uses only some of
// them. Without the flow > 0 filter, fix would prescribe every eligible pairing
// — the opposite of "minimal", which is the whole claim.
test("assignmentsFrom: an eligible pairing the flow did not use is not an assignment", () => {
  const edges = [
    flowed(fileNode("src/a.ts"), reviewerNode("alice"), 1, 0),
    flowed(fileNode("src/a.ts"), reviewerNode("bob"), 1, 1),
  ];

  assert.deepEqual(assignmentsFrom(edges), [{ reviewer: "bob", files: ["src/a.ts"] }]);
});

test("assignmentsFrom: SOURCE and SINK edges never become assignments", () => {
  const edges = [flowed(SOURCE, fileNode("src/a.ts"), 1, 1), flowed(reviewerNode("alice"), SINK, 2, 2)];

  assert.deepEqual(assignmentsFrom(edges), []);
});

// Busiest reviewer first: the demo reads "alice takes 2, bob takes 1".
test("assignmentsFrom: reviewers are ordered by load, then by login", () => {
  const edges = [
    flowed(fileNode("src/c.ts"), reviewerNode("zoe"), 1, 1),
    flowed(fileNode("src/b.ts"), reviewerNode("alice"), 1, 1),
    flowed(fileNode("src/a.ts"), reviewerNode("alice"), 1, 1),
    flowed(fileNode("src/d.ts"), reviewerNode("bob"), 1, 1),
  ];

  assert.deepEqual(assignmentsFrom(edges), [
    { reviewer: "alice", files: ["src/a.ts", "src/b.ts"] },
    { reviewer: "bob", files: ["src/d.ts"] },
    { reviewer: "zoe", files: ["src/c.ts"] },
  ]);
});

// The cap=1 on SOURCE->file is what guarantees this: one review per at-risk file,
// so the prescription never double-assigns and the file count IS the max flow.
test("assignmentsFrom: no file is assigned twice, and the total equals the max flow", () => {
  const edges = buildNetwork({
    atRisk: ["src/a.ts", "src/b.ts"],
    eligible: new Map([
      ["src/a.ts", ["alice", "bob"]],
      ["src/b.ts", ["alice", "bob"]],
    ]),
    budget: 2,
  }).map((e) => (e.from === fileNode("src/a.ts") && e.to === reviewerNode("alice")) || (e.from === fileNode("src/b.ts") && e.to === reviewerNode("bob")) ? { ...e, flow: 1 } : e);

  const assigned = assignmentsFrom(edges).flatMap((a) => a.files);
  assert.deepEqual([...assigned].sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal(new Set(assigned).size, assigned.length, "cap=1 on SOURCE->file means no file is reviewed twice");
});

// --- Merging the database's flows back onto the built network ---------------
// algo.maxFlow returns ONLY positive-flow edges (verified live), so the returned
// set is a subset. minCut needs the whole network, with zeros where the flow did
// not go, which is what mergeFlows reconstructs.

test("mergeFlows: fills the reported flows in, leaving unused edges at zero", () => {
  const built = buildNetwork({
    atRisk: ["src/a.ts"],
    eligible: new Map([["src/a.ts", ["alice", "bob"]]]),
    budget: 2,
  });

  const merged = mergeFlows(
    built,
    [
      { from: SOURCE, to: fileNode("src/a.ts"), flow: 1 },
      { from: fileNode("src/a.ts"), to: reviewerNode("bob"), flow: 1 },
      { from: reviewerNode("bob"), to: SINK, flow: 1 },
    ],
    1,
  );

  assert.deepEqual(
    merged.map((e) => `${e.from}->${e.to}=${e.flow}`),
    [
      `${SOURCE}->f:src/a.ts=1`,
      "f:src/a.ts->r:alice=0",
      "f:src/a.ts->r:bob=1",
      `r:alice->${SINK}=0`,
      `r:bob->${SINK}=1`,
    ],
  );
  assert.notEqual(merged[0], built[0], "mergeFlows does not mutate the built network");
});

// If the round-trip renames or duplicates an edge, the flows land on the wrong
// pairs and fix prescribes the wrong reviewers while still looking plausible.
// Fail loudly instead.
test("mergeFlows: a flow on an edge the network never built is a bug, not a no-op", () => {
  const built = buildNetwork({ atRisk: ["src/a.ts"], eligible: new Map([["src/a.ts", ["alice"]]]), budget: 2 });

  assert.throws(
    () => mergeFlows(built, [{ from: fileNode("src/a.ts"), to: reviewerNode("ghost"), flow: 1 }], 1),
    /f:src\/a\.ts->r:ghost/,
  );
});

// The one number the demo quotes. If a cap round-trips as a string, or nodeLabels
// pulls in a stray node, maxFlow and the flow leaving SOURCE drift apart — and a
// silently wrong counterfactual is worse than a crash.
test("mergeFlows: the reported maxFlow must equal the flow leaving SOURCE", () => {
  const built = buildNetwork({ atRisk: ["src/a.ts"], eligible: new Map([["src/a.ts", ["alice"]]]), budget: 2 });
  const rows = [
    { from: SOURCE, to: fileNode("src/a.ts"), flow: 1 },
    { from: fileNode("src/a.ts"), to: reviewerNode("alice"), flow: 1 },
    { from: reviewerNode("alice"), to: SINK, flow: 1 },
  ];

  assert.doesNotThrow(() => mergeFlows(built, rows, 1));
  assert.throws(() => mergeFlows(built, rows, 2), /maxFlow 2 .* 1 leaving SOURCE/);
});

test("mergeFlows: no flow at all is a consistent zero, not an error", () => {
  const built = buildNetwork({ atRisk: ["src/orphan.ts"], eligible: new Map(), budget: 2 });

  const merged = mergeFlows(built, [], 0);
  assert.deepEqual(merged, [{ from: SOURCE, to: fileNode("src/orphan.ts"), cap: 1, flow: 0 }]);
});

// --- The reported result ----------------------------------------------------
// presentFix is everything after the database: merge, cut, classify, group. The
// demo quotes atRiskBefore/atRiskAfter, so this is the part that must not drift.

test("presentFix: full coverage within budget de-risks every file", () => {
  const built = buildNetwork({
    atRisk: ["src/a.ts", "src/b.ts"],
    eligible: new Map([
      ["src/a.ts", ["alice"]],
      ["src/b.ts", ["alice"]],
    ]),
    budget: 2,
  });
  const rows = [
    { from: SOURCE, to: fileNode("src/a.ts"), flow: 1 },
    { from: SOURCE, to: fileNode("src/b.ts"), flow: 1 },
    { from: fileNode("src/a.ts"), to: reviewerNode("alice"), flow: 1 },
    { from: fileNode("src/b.ts"), to: reviewerNode("alice"), flow: 1 },
    { from: reviewerNode("alice"), to: SINK, flow: 2 },
  ];

  assert.deepEqual(presentFix(built, { rows, maxFlow: 2 }), {
    atRiskBefore: 2,
    atRiskAfter: 0,
    coverable: 2,
    assignments: [{ reviewer: "alice", files: ["src/a.ts", "src/b.ts"] }],
    bottleneck: "none",
    bottleneckReviewers: [],
    unserved: [],
    ceiling: null,
  });
});

// One reviewer, budget 2, three files everyone is eligible for: the min cut is the
// single reviewer->SINK edge, so the honest answer is "buy bandwidth", not "nobody
// is qualified".
test("presentFix: one file is left at risk when the reviewers run out of budget", () => {
  const built = buildNetwork({
    atRisk: ["src/a.ts", "src/b.ts", "src/c.ts"],
    eligible: new Map([
      ["src/a.ts", ["alice"]],
      ["src/b.ts", ["alice"]],
      ["src/c.ts", ["alice"]],
    ]),
    budget: 2,
  });
  const rows = [
    { from: SOURCE, to: fileNode("src/a.ts"), flow: 1 },
    { from: SOURCE, to: fileNode("src/b.ts"), flow: 1 },
    { from: fileNode("src/a.ts"), to: reviewerNode("alice"), flow: 1 },
    { from: fileNode("src/b.ts"), to: reviewerNode("alice"), flow: 1 },
    { from: reviewerNode("alice"), to: SINK, flow: 2 },
  ];

  const result = presentFix(built, { rows, maxFlow: 2 });
  assert.equal(result.atRiskBefore, 3);
  assert.equal(result.atRiskAfter, 1);
  assert.equal(result.coverable, 3, "all three have an eligible reviewer — budget is what binds");
  assert.equal(result.bottleneck, "bandwidth");
});

// The other diagnosis: a file no one in its module has expertise on. More budget
// would not help, so fix must not say "bandwidth".
test("presentFix: an uncoverable file is reported as an eligibility bottleneck", () => {
  const built = buildNetwork({
    atRisk: ["src/a.ts", "src/orphan.ts"],
    eligible: new Map([["src/a.ts", ["alice"]]]),
    budget: 2,
  });
  const rows = [
    { from: SOURCE, to: fileNode("src/a.ts"), flow: 1 },
    { from: fileNode("src/a.ts"), to: reviewerNode("alice"), flow: 1 },
    { from: reviewerNode("alice"), to: SINK, flow: 1 },
  ];

  const result = presentFix(built, { rows, maxFlow: 1 });
  assert.equal(result.atRiskAfter, 1);
  assert.equal(result.coverable, 1, "src/orphan.ts has no eligible reviewer at all");
  assert.equal(result.bottleneck, "eligibility");
  assert.deepEqual(result.assignments, [{ reviewer: "alice", files: ["src/a.ts"] }]);
});

test("presentFix: nothing at risk is a clean empty answer, not a crash", () => {
  assert.deepEqual(presentFix(buildNetwork({ atRisk: [], eligible: new Map(), budget: 2 }), { rows: [], maxFlow: 0 }), {
    atRiskBefore: 0,
    atRiskAfter: 0,
    coverable: 0,
    assignments: [],
    bottleneck: "none",
    bottleneckReviewers: [],
    unserved: [],
    ceiling: null,
  });
});

// --- Option validation ------------------------------------------------------
// Both reach fix as strings from commander. A silent NaN would make budget
// capacities NaN and maxFlow nonsense, so reject at the edge.

test("checkBudget: k_r is an integer >= 1", () => {
  assert.equal(checkBudget(2), 2);
  assert.equal(checkBudget(1), 1);
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => checkBudget(bad), /--budget must be an integer >= 1/, String(bad));
  }
});

// theta is a share of normalised doa, so 0 and 1 are both degenerate: 0 makes
// every toucher an expert, 1 makes nobody one.
test("checkTheta: the expertise floor is strictly between 0 and 1", () => {
  assert.equal(checkTheta(0.2), 0.2);
  for (const bad of [0, 1, -0.1, 1.5, Number.NaN]) {
    assert.throws(() => checkTheta(bad), /--theta must be strictly between 0 and 1/, String(bad));
  }
});

// Spec §15 R3: theta is provisional at 0.2 and tuned on the backtest; budget is D7.
test("defaults match the spec: budget 2 (D7), theta 0.2 (§15 R3, provisional)", () => {
  assert.equal(DEFAULT_BUDGET, 2);
  assert.equal(DEFAULT_THETA, 0.2);
});

// --- Ranking and shortlisting the candidates --------------------------------
// Max flow finds a minimum-CARDINALITY assignment, and among equally-optimal ones
// it picks arbitrarily — measured live, it handed fastify to acoluzzi/agustin18 and
// pnpm to 0xnoramiya/3w36zj6, i.e. whoever sorted first. The count was optimal, the
// choice was noise. Restricting each file to its strongest candidates makes every
// assignment max flow can find come from people who demonstrably know the module.

const expert = (login: string, via: string, doa: number) => ({ login, via, doa });

test("eligibleByFile: candidates are ranked by expertise, strongest first", () => {
  const eligible = eligibleByFile(
    [atRisk("src/tools/risk.ts", "alice")],
    [{ module: "src/tools", experts: [expert("weak", "src/tools/a.ts", 0.25), expert("strong", "src/tools/b.ts", 0.8), expert("mid", "src/tools/c.ts", 0.5)] }],
    { exclude: () => false },
  );

  assert.deepEqual(eligible.get("src/tools/risk.ts"), ["strong", "mid", "weak"]);
});

test("eligibleByFile: a reviewer expert via several files is ranked by their strongest", () => {
  const eligible = eligibleByFile(
    [atRisk("src/tools/risk.ts", "alice")],
    [{ module: "src/tools", experts: [expert("bob", "src/tools/a.ts", 0.3), expert("carol", "src/tools/b.ts", 0.6), expert("bob", "src/tools/c.ts", 0.95)] }],
    { exclude: () => false },
  );

  assert.deepEqual(eligible.get("src/tools/risk.ts"), ["bob", "carol"]);
});

test("eligibleByFile: the shortlist keeps the strongest candidates and drops the tail", () => {
  const experts = [expert("a", "src/tools/1.ts", 0.9), expert("b", "src/tools/2.ts", 0.8), expert("c", "src/tools/3.ts", 0.7), expert("d", "src/tools/4.ts", 0.6)];
  const rows = [atRisk("src/tools/risk.ts", "zed")];

  assert.deepEqual(eligibleByFile(rows, [{ module: "src/tools", experts }], { exclude: () => false, candidates: 2 }).get("src/tools/risk.ts"), ["a", "b"]);
  assert.deepEqual(eligibleByFile(rows, [{ module: "src/tools", experts }], { exclude: () => false }).get("src/tools/risk.ts"), ["a", "b", "c", "d"]);
});

// Equal doa must not reorder between runs, or the same repo yields different
// prescriptions and the demo is unreproducible.
test("eligibleByFile: ties break on login so the prescription is reproducible", () => {
  const eligible = eligibleByFile(
    [atRisk("src/tools/risk.ts", "zed")],
    [{ module: "src/tools", experts: [expert("carol", "src/tools/a.ts", 0.5), expert("alice", "src/tools/b.ts", 0.5), expert("bob", "src/tools/c.ts", 0.5)] }],
    { exclude: () => false },
  );

  assert.deepEqual(eligible.get("src/tools/risk.ts"), ["alice", "bob", "carol"]);
});

test("checkCandidates: the shortlist is an integer >= 1", () => {
  assert.equal(checkCandidates(5), 5);
  for (const bad of [0, -1, 2.5, Number.NaN]) assert.throws(() => checkCandidates(bad), /--candidates must be an integer >= 1/, String(bad));
});

// The demo should be able to NAME the file it could not place, not just count it.
// On fastify that is a single path, and "we could not cover
// .github/workflows/lock-threads.yml" lands far harder than "1 file remains".
test("presentFix: unserved names the files the flow could not place, sorted", () => {
  const built = buildNetwork({
    atRisk: ["src/z.ts", "src/a.ts", "src/covered.ts"],
    eligible: new Map([["src/covered.ts", ["alice"]]]),
    budget: 2,
  });
  const rows = [
    { from: SOURCE, to: fileNode("src/covered.ts"), flow: 1 },
    { from: fileNode("src/covered.ts"), to: reviewerNode("alice"), flow: 1 },
    { from: reviewerNode("alice"), to: SINK, flow: 1 },
  ];

  const result = presentFix(built, { rows, maxFlow: 1 });
  assert.deepEqual(result.unserved, ["src/a.ts", "src/z.ts"]);
  assert.equal(result.unserved.length, result.atRiskAfter, "every unplaced file is still at risk");
});

// ceiling is the shortlist's cost, and presentFix cannot know it — it only ever sees
// one network. fix() fills it in from a second, unrestricted solve.
test("presentFix: ceiling is null, because one solved network cannot know the other", () => {
  const built = buildNetwork({ atRisk: ["src/a.ts"], eligible: new Map(), budget: 2 });
  assert.equal(presentFix(built, { rows: [], maxFlow: 0 }).ceiling, null);
});
