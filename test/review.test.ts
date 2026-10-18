// review(): ranking is pure and tested here; the Cypher's two silent-failure
// modes are guarded by asserting on REVIEW_CYPHER itself, because both return
// plausible-looking numbers rather than erroring.

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_K, REVIEW_CYPHER, checkK, mergeLegs, rankCandidates, type ReviewCandidate } from "../src/tools/review.ts";

const row = (login: string, direct: number, co = 0): ReviewCandidate => ({ login, direct, co, score: direct + co });

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

test("mergeLegs adds each person's direct and co-change rows into one candidate", () => {
  // REVIEW_CYPHER returns one row per person per leg; the sum happens here, not in
  // Cypher, so no WITH-carried value is ever added to a fresh aggregate.
  const got = mergeLegs([
    { login: "bob", direct: 0.7, co: 0 },
    { login: "carol", direct: 0.2, co: 0 },
    { login: "bob", direct: 0, co: 0.3 },
  ]);
  assert.deepEqual(
    got.sort((a, b) => a.login.localeCompare(b.login)),
    [
      { login: "bob", direct: 0.7, co: 0.3, score: 1 },
      { login: "carol", direct: 0.2, co: 0, score: 0.2 },
    ],
  );
});

test("mergeLegs keeps a person nominated by co-change alone", () => {
  // The point of the co-change leg: someone who only ever touched a tightly
  // coupled neighbour is a candidate, not just a tie-breaker.
  assert.deepEqual(mergeLegs([{ login: "dave", direct: 0, co: 0.2 }]), [{ login: "dave", direct: 0, co: 0.2, score: 0.2 }]);
});

test("REVIEW_CYPHER nominates from the co-change leg with UNION ALL", () => {
  // Plain UNION would deduplicate rows; ALL keeps every per-leg row for mergeLegs.
  assert.match(REVIEW_CYPHER, /\nUNION ALL\n/);
  // The co-change leg is its own MATCH, so a co-change-only person reaches the result.
  assert.match(REVIEW_CYPHER, /UNION ALL\nMATCH \(pr:PR \{number: \$number\}\)-\[:MODIFIED\]->\(:File\)-\[c:CO_CHANGED\]-/);
});

test("REVIEW_CYPHER excludes the PR author on both legs", () => {
  // Once co-change nominates, the author would otherwise come back through a
  // neighbour of their own change.
  assert.equal(REVIEW_CYPHER.match(/NOT \(pr\)-\[:AUTHORED_BY\]->\(p\)/g)?.length, 2);
});
