import { test } from "node:test";
import assert from "node:assert/strict";
import { presentImpact } from "../src/tools/impact.ts";
import { checkKinds, checkMinCommits, checkThreshold, presentRisk, segmentRisk } from "../src/tools/risk.ts";
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

const raw = (path: string, soleHolder = "alice", otherTs: string[] = []) => ({
  path, module: ".", soleHolder, share: 0.9, commits: 4, holders: 1 + otherTs.length, otherTs,
});
const ASOF = new Date("2026-10-15T00:00:00Z");

test("D14: risk never reports a lockfile or generated path", () => {
  const rows = [raw("pnpm-lock.yaml"), raw("packages/x/dist/index.js"), raw("src/core/engine.ts", "bob")];
  assert.deepEqual(presentRisk(rows, { exclude: isCoChangeExcluded, asOf: ASOF }).map((r) => r.path), ["src/core/engine.ts"]);
});

test("R4: daysSinceOther is the latest OTHER touch, null when no one else touched it", () => {
  const [solo, shared] = presentRisk(
    [raw("a.ts"), raw("b.ts", "alice", ["2026-10-05T00:00:00.000Z", "2026-01-01T00:00:00.000Z"])],
    { exclude: () => false, asOf: ASOF },
  );
  assert.equal(solo.daysSinceOther, null);
  assert.equal(shared.daysSinceOther, 10);
  assert.ok(!("otherTs" in shared), "raw timestamps are not part of RiskRow");
});

test("R2: risk rows carry a kind; --kind filters; segments count at-risk over active files", () => {
  const rows = presentRisk(
    [raw(".github/workflows/ci.yml", "carol"), raw(".gitignore", "carol"), raw("test/a.test.js", "bob"), raw("lib/x.js", "bob")],
    { exclude: isCoChangeExcluded, asOf: ASOF },
  );
  assert.deepEqual(rows.map((r) => r.kind), ["ci", "ci", "test", "source"]);
  const onlyCi = presentRisk([raw(".gitignore"), raw("lib/x.js")], { exclude: () => false, asOf: ASOF, kinds: ["ci"] });
  assert.deepEqual(onlyCi.map((r) => r.path), [".gitignore"]);

  const active = [".github/workflows/ci.yml", ".gitignore", "test/a.test.js", "lib/x.js", "lib/y.js", "lib/z.js", "pnpm-lock.yaml"];
  const seg = Object.fromEntries(segmentRisk(rows, active, isCoChangeExcluded).map((s) => [s.kind, s]));
  assert.deepEqual(seg.ci, { kind: "ci", active: 2, atRisk: 2, topHolder: { login: "carol", files: 2 } });
  assert.deepEqual(seg.source, { kind: "source", active: 3, atRisk: 1, topHolder: { login: "bob", files: 1 } });
  assert.deepEqual(seg.docs, { kind: "docs", active: 0, atRisk: 0, topHolder: null });
});

test("R1: --min-commits is an integer >= 1; --kind must be a known kind", () => {
  assert.equal(checkMinCommits(3), 3);
  for (const bad of [0, 2.5, -1, Number.NaN]) assert.throws(() => checkMinCommits(bad), /integer >= 1/, String(bad));
  assert.deepEqual(checkKinds(["ci", "source"]), ["ci", "source"]);
  assert.throws(() => checkKinds(["config"]), /unknown config/);
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
