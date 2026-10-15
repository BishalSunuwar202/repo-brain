// End-to-end against a REAL FalkorDB: parse model -> loadRepo -> risk / impact.
// Skipped unless REPO_BRAIN_LIVE=1 (npm test stays database-free).
// Uses a throwaway graph test:<random> and deletes it afterwards.
//
//   REPO_BRAIN_LIVE=1 node --import tsx --test test/live.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "../src/db/client.ts";
import { buildRepoModel, type Commit } from "../src/ingest/gitlog.ts";
import { buildLoadPlan, loadRepo } from "../src/ingest/load.ts";
import { isCoChangeExcluded } from "../src/ingest/paths.ts";
import { impact } from "../src/tools/impact.ts";
import { activeFiles, risk, segmentRisk } from "../src/tools/risk.ts";

const LIVE = process.env.REPO_BRAIN_LIVE === "1";
const AS_OF = new Date("2026-10-15T00:00:00Z");

const commit = (sha: string, ts: string, email: string, paths: string[], created: string[] = []): Commit => ({
  sha,
  ts,
  authorEmail: email,
  authorName: email.split("@")[0],
  files: paths.map((path) => ({ path, adds: 1, dels: 0, binary: false })),
  created,
});

// Newest first, as git emits.
//  solo.ts          alice created + only author (3 commits); dave's bulk touch is not authorship (R5)
//  shared-recent.ts alice dominant (13), bob touched it 44 days before AS_OF -> reported, daysSinceOther 44 (R4)
//  shared-old.ts    alice dominant (3), bob touched it long ago               -> reported
//  split.ts         alice and bob, one commit each                            -> under the 3-commit floor (R1)
//  pnpm-lock.yaml   alice only                                                -> hidden by presentRisk (D14)
//  src/core/*.ts    co-change cluster for impact, with a test file
//  vendor/drop/*    only ever touched by dave's bulk commit                   -> never reported (R5)
const vendorDrop = Array.from({ length: 51 }, (_, i) => `vendor-drop/f${i}.ts`);
const commits: Commit[] = [
  commit("d0", "2026-10-01T00:00:00Z", "dave@x.io", ["solo.ts", ...vendorDrop], vendorDrop),
  commit("b9", "2026-09-01T00:00:00Z", "bob@x.io", ["shared-recent.ts"]),
  commit("a8", "2026-08-01T00:00:00Z", "carol@x.io", ["src/core/a.ts", "src/core/b.ts", "src/core/a.test.ts"]),
  commit("a7", "2026-07-01T00:00:00Z", "carol@x.io", ["src/core/a.ts", "src/core/b.ts", "src/core/a.test.ts"]),
  commit("a6", "2026-06-01T00:00:00Z", "carol@x.io", ["src/core/a.ts", "src/core/b.ts", "src/core/a.test.ts"]),
  commit("b5", "2025-06-01T00:00:00Z", "bob@x.io", ["split.ts", "shared-old.ts"]),
  commit("a4", "2025-05-01T00:00:00Z", "alice@x.io", ["split.ts"]),
  // Extra alice commits so she clearly dominates shared-recent.ts (> 0.8 even with
  // bob's recent touch); otherwise the file drops out as "no dominant holder" and
  // the recency clause is never exercised.
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) =>
    commit(`r${d}`, `2025-04-${String(d).padStart(2, "0")}T00:00:00Z`, "alice@x.io", ["shared-recent.ts"]),
  ),
  commit("a3", "2025-03-01T00:00:00Z", "alice@x.io", ["shared-recent.ts", "shared-old.ts", "solo.ts"]),
  commit("a2", "2025-02-01T00:00:00Z", "alice@x.io", ["shared-recent.ts", "shared-old.ts", "solo.ts", "pnpm-lock.yaml"]),
  commit("a1", "2025-01-01T00:00:00Z", "alice@x.io", ["shared-recent.ts", "shared-old.ts", "solo.ts", "pnpm-lock.yaml"], [
    "shared-recent.ts",
    "shared-old.ts",
    "solo.ts",
    "pnpm-lock.yaml",
  ]),
];

test("live: load -> risk -> impact on a throwaway graph", { skip: !LIVE && "set REPO_BRAIN_LIVE=1" }, async () => {
  const model = buildRepoModel(commits, AS_OF);
  const alive = new Set(model.files);
  const db = await connect();
  const graph = db.selectGraph(`test:${randomUUID()}`);
  try {
    // Fixture self-check (D19): alice must clearly dominate shared-recent.ts, so it is reported
    // even though bob touched it recently — that is what proves the recency filter is gone (R4).
    const aliceRecent = model.touched.find((t) => t.login === "alice" && t.path === "shared-recent.ts")!;
    assert.ok(aliceRecent.doa > 0.8, `alice must dominate shared-recent.ts, got ${aliceRecent.doa}`);

    await loadRepo(graph, buildLoadPlan(model, alive), { fresh: true });

    const all = { asOf: AS_OF, minCommits: 1, exclude: () => false };
    const raw = await risk(graph, all);
    assert.deepEqual(
      raw.map((r) => r.path).sort(),
      ["pnpm-lock.yaml", "shared-old.ts", "shared-recent.ts", "solo.ts", "split.ts", "src/core/a.test.ts", "src/core/a.ts", "src/core/b.ts"],
      "R5: no vendor-drop file, even with the floor at 1",
    );

    // Defaults: threshold 0.5, floor 3, lockfiles hidden.
    const shown = await risk(graph, { asOf: AS_OF, exclude: isCoChangeExcluded });
    const byPath = new Map(shown.map((r) => [r.path, r]));
    assert.deepEqual(
      [...byPath.keys()].sort(),
      ["shared-old.ts", "shared-recent.ts", "solo.ts", "src/core/a.test.ts", "src/core/a.ts", "src/core/b.ts"],
      "R1: split.ts (2 commits) is under the floor; D14: no lockfile",
    );
    assert.deepEqual(byPath.get("solo.ts"), {
      path: "solo.ts", module: ".", kind: "source", soleHolder: "alice", share: 1, commits: 3,
      holders: 1, daysSinceOther: null, // R5: dave's bulk touch makes him neither a holder nor a recent toucher
    });
    const recent = byPath.get("shared-recent.ts")!;
    assert.deepEqual([recent.soleHolder, recent.commits, recent.holders, recent.daysSinceOther], ["alice", 14, 2, 44], "R4: reported, recency is a column");
    assert.equal(byPath.get("shared-old.ts")!.daysSinceOther, 501);
    assert.equal(byPath.get("src/core/a.test.ts")!.kind, "test");

    // R2: --kind and the per-kind denominators.
    assert.deepEqual((await risk(graph, { asOf: AS_OF, exclude: isCoChangeExcluded, kinds: ["test"] })).map((r) => r.path), ["src/core/a.test.ts"]);
    const active = await activeFiles(graph, { exclude: isCoChangeExcluded });
    assert.deepEqual(active.sort(), [...byPath.keys()].sort(), "every active file here is at risk");
    const seg = Object.fromEntries(segmentRisk(shown, active, isCoChangeExcluded).map((x) => [x.kind, x]));
    assert.deepEqual(seg.source, { kind: "source", active: 5, atRisk: 5, topHolder: { login: "alice", files: 3 } });
    assert.deepEqual(seg.test, { kind: "test", active: 1, atRisk: 1, topHolder: { login: "carol", files: 1 } });

    // --threshold reaches the query. split.ts is a near-tie, bob just ahead on recency.
    const bobSplit = model.touched.find((t) => t.login === "bob" && t.path === "split.ts")!;
    assert.ok(bobSplit.doa > 0.5 && bobSplit.doa < 0.6, `bob must hold just over half of split.ts, got ${bobSplit.doa}`);
    assert.equal(raw.find((r) => r.path === "split.ts")?.soleHolder, "bob", "0.5 default, floor 1");
    assert.ok(!(await risk(graph, { ...all, threshold: 0.6 })).some((r) => r.path === "split.ts"));

    // --min-commits reaches the query.
    assert.deepEqual((await risk(graph, { ...all, minCommits: 4 })).map((r) => r.path).sort(), ["shared-old.ts", "shared-recent.ts"]);

    const scoped = await risk(graph, { module: "src/core", asOf: AS_OF, exclude: isCoChangeExcluded });
    assert.deepEqual(scoped.map((r) => r.soleHolder), ["carol", "carol", "carol"]);

    const view = await impact(graph, "src/core/a.ts");
    assert.deepEqual(view, { rows: [{ path: "src/core/b.ts", weight: 3, support: 1 }], hiddenTests: 1 });
    // Undirected match: the pair is stored a.ts -> b.ts but is found from b.ts too.
    assert.deepEqual((await impact(graph, "src/core/b.ts"))?.rows.map((r) => r.path), ["src/core/a.ts"]);
    assert.equal(await impact(graph, "missing.ts"), null);
  } finally {
    await graph.delete();
    await db.close();
  }
});
