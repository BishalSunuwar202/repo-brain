// review(): ranking is pure and tested here; the Cypher's two silent-failure
// modes are guarded by asserting on REVIEW_CYPHER itself, because both return
// plausible-looking numbers rather than erroring.

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_K, REVIEW_CYPHER, checkK, rankCandidates, type ReviewRow } from "../src/tools/review.ts";

const row = (login: string, direct: number, co = 0): ReviewRow => ({ login, direct, co, score: direct + co });

test("rankCandidates orders by score descending", () => {
  const got = rankCandidates([row("alice", 0.2), row("bob", 0.9), row("carol", 0.5)], 3);
  assert.deepEqual(got.map((c) => c.login), ["bob", "carol", "alice"]);
});

test("rankCandidates breaks ties on login so a published number is reproducible", () => {
  const got = rankCandidates([row("zoe", 0.5), row("adam", 0.5)], 3);
  assert.deepEqual(got.map((c) => c.login), ["adam", "zoe"]);
});

test("rankCandidates keeps direct and co alongside the score", () => {
  // The split is what makes a suggestion explainable: touched these files vs
  // touched files that co-change with them.
  assert.deepEqual(rankCandidates([row("bob", 0.7, 0.3)], 1), [{ login: "bob", direct: 0.7, co: 0.3, score: 1 }]);
});

test("rankCandidates drops bots", () => {
  // Person nodes should already be bot-free (gitlog drops bot commit authors,
  // load.ts drops bot reviewers), so this is a belt-and-braces filter that
  // mirrors groundTruthReviewers on the other side of the backtest.
  const got = rankCandidates([row("dependabot", 0.9), row("alice", 0.1)], 3);
  assert.deepEqual(got.map((c) => c.login), ["alice"]);
});

test("rankCandidates returns at most k", () => {
  const got = rankCandidates([row("a", 0.4), row("b", 0.3), row("c", 0.2), row("d", 0.1)], 2);
  assert.deepEqual(got.map((c) => c.login), ["a", "b"]);
});

test("checkK wants an integer >= 1", () => {
  assert.equal(checkK(1), 1);
  assert.equal(checkK(DEFAULT_K), 3);
  assert.throws(() => checkK(0), /k/i);
  assert.throws(() => checkK(-1), /k/i);
  assert.throws(() => checkK(2.5), /integer/i);
});

test("REVIEW_CYPHER never adds a WITH-carried value to a fresh aggregate (landmine 10)", () => {
  // `RETURN direct + sum(x)` is ACCEPTED by FalkorDB and returns null, so
  // ORDER BY sorts nulls and every candidate scores the same. Verified live.
  // The aggregate must be closed in its own WITH before being added.
  assert.doesNotMatch(REVIEW_CYPHER, /direct\s*\+\s*(coalesce\s*\()?\s*sum\s*\(/);
  assert.match(REVIEW_CYPHER, /WITH[^\n]*\bsum\(/);
});

test("REVIEW_CYPHER excludes files the PR itself modified from the co-change leg", () => {
  // Without this, a neighbour g that the PR also modified is counted twice:
  // once as direct and again as co-change. Verified live on a two-PR fixture.
  assert.match(REVIEW_CYPHER, /WHERE NOT \(pr\)-\[:MODIFIED\]->\(g\)/);
});

test("REVIEW_CYPHER excludes the PR author", () => {
  assert.match(REVIEW_CYPHER, /WHERE NOT \(pr\)-\[:AUTHORED_BY\]->\(p\)/);
});
