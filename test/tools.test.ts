import { test } from "node:test";
import assert from "node:assert/strict";
import { presentImpact } from "../src/tools/impact.ts";
import { checkThreshold, presentRisk } from "../src/tools/risk.ts";
import { groundTruthReviewers, hitAtK, hitRate } from "../src/eval/backtest.ts";
import { isCoChangeExcluded } from "../src/ingest/paths.ts";

test("D16: impact ranks source files, collapses tests into a count, still fills the list", () => {
  const rows = [
    { path: "src/a.test.ts", weight: 9, support: 0.95 },
    { path: "src/b.ts", weight: 8, support: 0.9 },
    { path: "test/c.ts", weight: 7, support: 0.8 },
    { path: "src/d.ts", weight: 6, support: 0.7 },
    { path: "src/e.ts", weight: 5, support: 0.6 },
  ];
  assert.deepEqual(presentImpact(rows, { limit: 2 }), {
    rows: [rows[1], rows[3]],
    hiddenTests: 2,
  });
  assert.deepEqual(presentImpact(rows, { limit: 2, includeTests: true }), { rows: rows.slice(0, 2), hiddenTests: 0 });
});

test("D14: risk never reports a lockfile or generated path", () => {
  const rows = [
    { path: "pnpm-lock.yaml", module: ".", soleHolder: "alice", share: 0.99 },
    { path: "packages/x/dist/index.js", module: "packages/x", soleHolder: "alice", share: 0.95 },
    { path: "src/core/engine.ts", module: "src/core", soleHolder: "bob", share: 0.9 },
  ];
  assert.deepEqual(presentRisk(rows, isCoChangeExcluded).map((r) => r.path), ["src/core/engine.ts"]);
});

test("D11: ground truth lowercases GitHub-cased reviewer logins (else every hit-rate reads 0)", () => {
  // Person.login is lowercase; GitHub returns "SevInf". This test fails if the
  // lowercasing in groundTruthReviewers is removed.
  const actual = groundTruthReviewers([{ login: "SevInf" }, { login: "wmadden" }], "someone");
  assert.equal(hitAtK(["sevinf", "x", "y"], actual, 1), 1);
  assert.deepEqual([...actual], ["sevinf", "wmadden"]);
});

test("ground truth drops the PR author (any case) and bots", () => {
  const actual = groundTruthReviewers(
    [
      { login: "Alice" },
      { login: "coderabbitai", typename: "Bot" },
      { login: "copilot-pull-request-reviewer", typename: "Bot" },
      { login: "eslintbot", typename: "User" },
      { login: "bob" },
      { login: "bob" },
    ],
    "alice",
  );
  assert.deepEqual([...actual], ["bob"]);
});

test("hit-rate@k: any of top-k counts; PRs with no human reviewer are not scored", () => {
  const cases = [
    { predicted: ["a", "b", "c"], actual: new Set(["c"]) }, // hit@3 only
    { predicted: ["a", "b", "c"], actual: new Set(["a"]) }, // hit@1 and @3
    { predicted: ["a", "b", "c"], actual: new Set(["z"]) }, // miss
    { predicted: ["a"], actual: new Set<string>() }, // unscored
  ];
  assert.equal(hitRate(cases, 1), 1 / 3);
  assert.equal(hitRate(cases, 3), 2 / 3);
  assert.ok(Number.isNaN(hitRate([], 1)));
});

test("D18: --threshold must be strictly between 0 and 1", () => {
  assert.equal(checkThreshold(0.8), 0.8);
  for (const bad of [0, 1, 1.5, -0.1, Number.NaN]) assert.throws(() => checkThreshold(bad), /strictly between 0 and 1/, String(bad));
});
