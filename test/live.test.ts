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
import { risk } from "../src/tools/risk.ts";

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
//  solo.ts          alice created + only toucher, old                  -> bus-factor-1
//  shared-recent.ts alice dominant, bob touched it INSIDE 180 days     -> excluded by recency clause
//  shared-old.ts    alice dominant, bob touched it BEFORE the cutoff   -> bus-factor-1
//  split.ts         alice and bob equal                                -> no dominant holder
//  pnpm-lock.yaml   alice only                                         -> hidden by presentRisk (D14)
//  src/core/*.ts    co-change cluster for impact, with a test file
const commits: Commit[] = [
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
    // Fixture self-check: the recency clause, not the 80% rule, must be what drops shared-recent.ts.
    const aliceRecent = model.touched.find((t) => t.login === "alice" && t.path === "shared-recent.ts")!;
    assert.ok(aliceRecent.doa > 0.8, `alice must dominate shared-recent.ts, got ${aliceRecent.doa}`);

    await loadRepo(graph, buildLoadPlan(model, alive), { fresh: true });

    const raw = await risk(graph, { asOf: AS_OF, exclude: () => false });
    assert.deepEqual(raw.map((r) => r.path).sort(), ["pnpm-lock.yaml", "shared-old.ts", "solo.ts", "src/core/a.test.ts", "src/core/a.ts", "src/core/b.ts"]);

    const shown = await risk(graph, { asOf: AS_OF, exclude: isCoChangeExcluded });
    assert.ok(!shown.some((r) => r.path === "pnpm-lock.yaml"), "D14: lockfile never reported");
    assert.ok(!shown.some((r) => r.path === "shared-recent.ts"), "bob touched it inside 180 days");
    assert.ok(!shown.some((r) => r.path === "split.ts"), "no dominant holder");
    const solo = shown.find((r) => r.path === "solo.ts")!;
    assert.equal(solo.soleHolder, "alice");
    assert.equal(solo.module, ".");
    assert.ok(solo.share > 0.999);

    // D18: --threshold reaches the query. split.ts is a near-tie, bob just ahead on recency.
    const bobSplit = model.touched.find((t) => t.login === "bob" && t.path === "split.ts")!;
    assert.ok(bobSplit.doa > 0.5 && bobSplit.doa < 0.6, `bob must hold just over half of split.ts, got ${bobSplit.doa}`);
    const loose = await risk(graph, { threshold: 0.5, asOf: AS_OF, exclude: isCoChangeExcluded });
    assert.equal(loose.find((r) => r.path === "split.ts")?.soleHolder, "bob");
    assert.ok(!shown.some((r) => r.path === "split.ts"), "default 0.8 still excludes it");

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
