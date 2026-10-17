// Backtest baselines (spec §6, §12 D2). The pure rankers run everywhere; the graph
// read runs only with REPO_BRAIN_LIVE=1, against a throwaway graph test:<random>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SEED,
  checkCutoff,
  mostActiveRanking,
  predictMostActive,
  predictRandom,
  reviewerActivity,
  reviewerPool,
} from "../src/eval/baselines.ts";
import { connect } from "../src/db/client.ts";

const LIVE = process.env.REPO_BRAIN_LIVE === "1";

test("mostActiveRanking: most PRs reviewed first, ties on login, logins lowercased", () => {
  const rows = [
    { login: "Carol", prs: 2 },
    { login: "alice", prs: 5 },
    { login: "bob", prs: 2 },
  ];
  assert.deepEqual(mostActiveRanking(rows), ["alice", "bob", "carol"]);
});

test("mostActiveRanking: bots never rank, even as the busiest reviewer", () => {
  const rows = [
    { login: "coderabbitai", prs: 90 },
    { login: "dependabot[bot]", prs: 40 },
    { login: "alice", prs: 3 },
  ];
  assert.deepEqual(mostActiveRanking(rows), ["alice"]);
});

test("predictMostActive: the same ranking for every PR, minus that PR's author", () => {
  const ranking = ["alice", "bob", "carol", "dave"];
  assert.deepEqual(predictMostActive(ranking, "Alice"), ["bob", "carol", "dave"]);
  assert.deepEqual(predictMostActive(ranking, "erin"), ranking);
});

test("reviewerPool: sorted, distinct, lowercased, no bots — independent of read order", () => {
  const a = reviewerPool([{ login: "bob", prs: 1 }, { login: "Alice", prs: 4 }, { login: "renovate", prs: 9 }]);
  const b = reviewerPool([{ login: "alice", prs: 4 }, { login: "bob", prs: 1 }]);
  assert.deepEqual(a, ["alice", "bob"]);
  assert.deepEqual(a, b);
});

const POOL = ["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"];

test("predictRandom: reproducible for the same seed and PR", () => {
  assert.deepEqual(predictRandom(POOL, { number: 7, author: "zed" }), predictRandom(POOL, { number: 7, author: "zed" }));
  assert.deepEqual(predictRandom(POOL, { number: 7, author: "zed" }, DEFAULT_SEED), predictRandom(POOL, { number: 7, author: "zed" }));
});

test("predictRandom: a permutation of the pool minus the author", () => {
  const out = predictRandom(POOL, { number: 3, author: "Carol" });
  assert.equal(out.length, POOL.length - 1);
  assert.equal(new Set(out).size, out.length);
  assert.deepEqual([...out].sort(), POOL.filter((p) => p !== "carol"));
});

test("predictRandom: different PRs and different seeds give different orders", () => {
  const orders = new Set<string>();
  for (let n = 1; n <= 20; n++) orders.add(predictRandom(POOL, { number: n, author: "zed" }).join());
  assert.ok(orders.size > 15, `20 PRs produced only ${orders.size} distinct orders`);
  assert.notDeepEqual(predictRandom(POOL, { number: 1, author: "zed" }, 1), predictRandom(POOL, { number: 1, author: "zed" }, 2));
});

test("predictRandom: a PR's prediction does not depend on which PRs were scored before it", () => {
  const alone = predictRandom(POOL, { number: 42, author: "zed" });
  for (let n = 1; n < 42; n++) predictRandom(POOL, { number: n, author: "zed" });
  assert.deepEqual(predictRandom(POOL, { number: 42, author: "zed" }), alone);
});

test("predictRandom: every reviewer is equally likely to come first (no shuffle bias)", () => {
  const firsts = new Map<string, number>();
  const runs = 8000;
  for (let n = 0; n < runs; n++) {
    const first = predictRandom(POOL, { number: n, author: "zed" })[0];
    firsts.set(first, (firsts.get(first) ?? 0) + 1);
  }
  assert.equal(firsts.size, POOL.length);
  for (const [login, count] of firsts) assert.ok(Math.abs(count - runs / POOL.length) < 150, `${login} first ${count} times`);
});

test("predictRandom: an empty pool is an empty prediction, not a crash", () => {
  assert.deepEqual(predictRandom([], { number: 1, author: "alice" }), []);
  assert.deepEqual(predictRandom(["alice"], { number: 1, author: "alice" }), []);
});

test("checkCutoff: only a UTC ISO timestamp, the shape PR.mergedAt is stored in", () => {
  assert.equal(checkCutoff("2026-09-01T00:00:00.000Z"), "2026-09-01T00:00:00.000Z");
  assert.throws(() => checkCutoff("2026-09-01"), /UTC ISO/);
  assert.throws(() => checkCutoff("2026-09-01T00:00:00+02:00"), /UTC ISO/);
  assert.throws(() => checkCutoff("yesterday"), /UTC ISO/);
});

test("checkCutoff: normalises to toISOString, so string comparison against mergedAt is exact", () => {
  // Unnormalised, "…:00Z" > "…:00.000Z" ('Z' sorts after '.'), so a PR merged exactly
  // at the cutoff would compare as BEFORE it and leak a held-out PR into training.
  assert.equal(checkCutoff("2026-03-10T00:00:00Z"), "2026-03-10T00:00:00.000Z");
  assert.ok(!("2026-03-10T00:00:00.000Z" < checkCutoff("2026-03-10T00:00:00Z")));
});

// Fixture, hand-checkable. Cutoff 2026-06-01: PRs 1–4 train, PR 5 is held out.
//   PR 1 (by alice, 2026-01-10): reviewed by bob (two parallel edges — counts once), carol
//   PR 2 (by bob,   2026-02-10): reviewed by carol, alice, and bob (a self-review
//                                 that slipped past ingest — must not count)
//   PR 3 (by alice, 2026-03-10): reviewed by carol, coderabbitai
//   PR 4 (no author: a bot PR, 2026-04-10): reviewed by dave
//   PR 5 (by carol, 2026-07-01, HELD OUT): reviewed by erin, erin, erin…
//   PR 6 (by bob, mergedAt missing): reviewed by frank
// Expected training counts: carol 3, bob 1, alice 1, dave 1. erin and frank absent;
// coderabbitai filtered as a bot; bob's self-review on PR 2 not counted.
test("reviewerActivity: counts training PRs per reviewer, live", { skip: !LIVE && "set REPO_BRAIN_LIVE=1" }, async () => {
  const db = await connect();
  const graph = db.selectGraph(`test:${randomUUID()}`);
  try {
    await graph.query(`
CREATE (alice:Person {login:'alice'}), (bob:Person {login:'bob'}), (carol:Person {login:'carol'}),
       (dave:Person {login:'dave'}), (erin:Person {login:'erin'}), (frank:Person {login:'frank'}),
       (rabbit:Person {login:'coderabbitai'}),
       (p1:PR {number:1, mergedAt:'2026-01-10T00:00:00.000Z'}), (p2:PR {number:2, mergedAt:'2026-02-10T00:00:00.000Z'}),
       (p3:PR {number:3, mergedAt:'2026-03-10T00:00:00.000Z'}), (p4:PR {number:4, mergedAt:'2026-04-10T00:00:00.000Z'}),
       (p5:PR {number:5, mergedAt:'2026-07-01T00:00:00.000Z'}), (p6:PR {number:6}),
       (p1)-[:AUTHORED_BY]->(alice), (p2)-[:AUTHORED_BY]->(bob), (p3)-[:AUTHORED_BY]->(alice),
       (p5)-[:AUTHORED_BY]->(carol), (p6)-[:AUTHORED_BY]->(bob),
       (p1)-[:REVIEWED_BY]->(bob), (p1)-[:REVIEWED_BY]->(bob), (p1)-[:REVIEWED_BY]->(carol),
       (p2)-[:REVIEWED_BY]->(carol), (p2)-[:REVIEWED_BY]->(alice), (p2)-[:REVIEWED_BY]->(bob),
       (p3)-[:REVIEWED_BY]->(carol), (p3)-[:REVIEWED_BY]->(rabbit),
       (p4)-[:REVIEWED_BY]->(dave),
       (p5)-[:REVIEWED_BY]->(erin), (p6)-[:REVIEWED_BY]->(frank)`);

    const rows = await reviewerActivity(graph, { before: "2026-06-01T00:00:00.000Z" });
    const byLogin = Object.fromEntries(rows.map((r) => [r.login, r.prs]));
    assert.deepEqual(byLogin, { alice: 1, bob: 1, carol: 3, dave: 1, coderabbitai: 1 }, "raw read: bots are filtered in TS, not here");
    assert.deepEqual(mostActiveRanking(rows), ["carol", "alice", "bob", "dave"]);
    assert.deepEqual(reviewerPool(rows), ["alice", "bob", "carol", "dave"]);

    // The cutoff is strict: a PR merged exactly at it is held out, not training.
    const atCutoff = await reviewerActivity(graph, { before: "2026-03-10T00:00:00.000Z" });
    assert.deepEqual(Object.fromEntries(atCutoff.map((r) => [r.login, r.prs])), { alice: 1, bob: 1, carol: 2 });
  } finally {
    await graph.delete().catch(() => {});
    await db.close();
  }
});
