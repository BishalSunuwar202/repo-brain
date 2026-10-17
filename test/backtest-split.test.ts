// Splitting PRs into training and holdout. Every bug here inflates the measured
// hit-rate, and none of them is visible in the output.

import test from "node:test";
import assert from "node:assert/strict";

import { splitHoldout, withheldReviews } from "../src/eval/backtest.ts";
import type { PullRequest } from "../src/ingest/github.ts";

function pr(number: number, mergedAt: string, over: Partial<PullRequest> = {}): PullRequest {
  return {
    number,
    title: `pr ${number}`,
    mergedAt,
    author: "alice",
    authorTypename: "User",
    files: ["lib/a.js"],
    reviewers: [{ login: "bob", typename: "User", state: "APPROVED", at: mergedAt }],
    ...over,
  };
}

const prs = [
  pr(5, "2026-10-05T00:00:00Z"),
  pr(4, "2026-10-04T00:00:00Z"),
  pr(3, "2026-10-03T00:00:00Z"),
  pr(2, "2026-10-02T00:00:00Z"),
  pr(1, "2026-10-01T00:00:00Z"),
];

test("splitHoldout holds out the n most recently merged PRs", () => {
  const { holdout } = splitHoldout(prs, 2);
  assert.deepEqual(holdout.map((p) => p.number), [5, 4]);
});

test("splitHoldout sorts by mergedAt, not by the order it was handed", () => {
  // GitHub cannot order PRs by mergedAt, so the fetch sorts; don't rely on it.
  const { holdout } = splitHoldout([prs[4], prs[0], prs[2], prs[1], prs[3]], 2);
  assert.deepEqual(holdout.map((p) => p.number), [5, 4]);
});

test("splitHoldout keeps bot-authored PRs out of the holdout", () => {
  // 17 of fastify's last 50 merged PRs are github-actions backports. Predicting
  // a reviewer for a bot's automated cherry-pick measures nothing.
  const withBots = [pr(6, "2026-10-06T00:00:00Z", { author: "github-actions", authorTypename: "Bot" }), ...prs];
  const { holdout } = splitHoldout(withBots, 2);
  assert.deepEqual(holdout.map((p) => p.number), [5, 4]);
});

test("splitHoldout still allows a bot-authored PR into training", () => {
  // A bot's backport is a poor prediction target but real evidence of activity,
  // so it is barred from the holdout and kept in training. It must merge before
  // the cutoff to qualify: a bot PR merged after it is future data like any other.
  const bot = pr(6, "2026-10-02T12:00:00Z", { author: "github-actions", authorTypename: "Bot" });
  const { training } = splitHoldout([bot, ...prs], 2);
  assert.ok(training.some((p) => p.number === 6));
});

test("splitHoldout excludes a bot-authored PR merged after the cutoff from training too", () => {
  const bot = pr(6, "2026-10-06T00:00:00Z", { author: "github-actions", authorTypename: "Bot" });
  const { training, holdout } = splitHoldout([bot, ...prs], 2);
  assert.ok(!training.some((p) => p.number === 6));
  assert.ok(!holdout.some((p) => p.number === 6));
});

test("splitHoldout cuts training strictly before the oldest held-out merge", () => {
  // Strict: a PR merged exactly at the cutoff belongs to the holdout, not
  // training. Off by one here and the answer is in the training set.
  const { training, cutoff } = splitHoldout(prs, 2);
  assert.equal(cutoff, "2026-10-04T00:00:00.000Z");
  assert.deepEqual(training.map((p) => p.number), [3, 2, 1]);
  assert.ok(training.every((p) => new Date(p.mergedAt).toISOString() < cutoff));
});

test("splitHoldout refuses a holdout larger than the PRs it was given", () => {
  assert.throws(() => splitHoldout(prs, 99), /holdout/i);
});

test("withheldReviews strips the reviewers the backtest is trying to predict", () => {
  // The held-out PR's node and MODIFIED edges are legitimate input: review()
  // needs to know which files changed. Its REVIEWED_BY edges are the answer.
  const [stripped] = withheldReviews([pr(5, "2026-10-05T00:00:00Z")]);
  assert.deepEqual(stripped.reviewers, []);
  assert.deepEqual(stripped.files, ["lib/a.js"]);
  assert.equal(stripped.author, "alice");
});
