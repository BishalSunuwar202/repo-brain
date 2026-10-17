// github.ts: GraphQL response -> PullRequest[]. The network call is not tested
// here; parsePRs is where every silent-corruption risk lives.

import test from "node:test";
import assert from "node:assert/strict";

import { fillFiles, parsePRs, type PrNode } from "../src/ingest/github.ts";
import { buildLoadPlan } from "../src/ingest/load.ts";

const actor = (login: string, __typename = "User") => ({ __typename, login });

function node(over: Partial<PrNode> = {}): PrNode {
  return {
    number: 1,
    title: "fix: a thing",
    mergedAt: "2026-09-01T10:00:00Z",
    author: actor("Alice"),
    files: { totalCount: 1, nodes: [{ path: "lib/reply.js" }] },
    reviews: { totalCount: 1, nodes: [{ state: "APPROVED", submittedAt: "2026-09-01T11:00:00Z", author: actor("Bob") }] },
    ...over,
  };
}

test("parsePRs lowercases author and reviewer logins", () => {
  // Person.login is lowercased by identity.ts (D11). Skip this and every
  // hit-rate in the backtest silently reads zero.
  const [pr] = parsePRs([node({ author: actor("AlIcE"), reviews: { totalCount: 1, nodes: [{ state: "APPROVED", submittedAt: "2026-09-01T11:00:00Z", author: actor("BoB") }] } })]);
  assert.equal(pr.author, "alice");
  assert.deepEqual(pr.reviewers.map((r) => r.login), ["bob"]);
});

test("parsePRs keeps the reviewer typename so downstream can spot a Bot actor", () => {
  const [pr] = parsePRs([
    node({ reviews: { totalCount: 1, nodes: [{ state: "COMMENTED", submittedAt: "2026-09-01T11:00:00Z", author: actor("sonarcloud", "Bot") }] } }),
  ]);
  assert.deepEqual(pr.reviewers, [{ login: "sonarcloud", typename: "Bot", state: "COMMENTED", at: "2026-09-01T11:00:00Z" }]);
});

test("parsePRs keeps the author typename so the backtest can exclude bot-authored PRs", () => {
  const [pr] = parsePRs([node({ author: actor("dependabot", "Bot") })]);
  assert.equal(pr.author, "dependabot");
  assert.equal(pr.authorTypename, "Bot");
});

test("parsePRs drops a PR whose author is a deleted (ghost) account", () => {
  // A null actor cannot be attributed: AUTHORED_BY needs a Person, and the
  // backtest holdout excludes unattributable authors anyway. The raw response
  // stays on disk in the cache, so nothing is lost irrecoverably.
  assert.deepEqual(parsePRs([node({ author: null })]), []);
});

test("parsePRs drops a ghost reviewer but keeps the PR", () => {
  const [pr] = parsePRs([
    node({
      reviews: {
        totalCount: 2,
        nodes: [
          { state: "APPROVED", submittedAt: "2026-09-01T11:00:00Z", author: null },
          { state: "APPROVED", submittedAt: "2026-09-01T12:00:00Z", author: actor("Carol") },
        ],
      },
    }),
  ]);
  assert.deepEqual(pr.reviewers.map((r) => r.login), ["carol"]);
});

test("parsePRs keeps every review event, leaving dedupe to load.ts", () => {
  // load.ts reduces to one REVIEWED_BY per (PR, reviewer) at the earliest time.
  // Deduping here too would hide a reviewer's first touch.
  const [pr] = parsePRs([
    node({
      reviews: {
        totalCount: 2,
        nodes: [
          { state: "COMMENTED", submittedAt: "2026-09-02T09:00:00Z", author: actor("bob") },
          { state: "APPROVED", submittedAt: "2026-09-01T11:00:00Z", author: actor("bob") },
        ],
      },
    }),
  ]);
  assert.equal(pr.reviewers.length, 2);
});

test("parsePRs throws when the reviews list is truncated", () => {
  // Truncated reviews == wrong backtest ground truth. This is landmine 9's
  // lesson applied to the API: fail loudly rather than measure a wrong number.
  assert.throws(
    () => parsePRs([node({ reviews: { totalCount: 51, nodes: [{ state: "APPROVED", submittedAt: "2026-09-01T11:00:00Z", author: actor("bob") }] } })]),
    /PR 1.*review/i,
  );
});

test("parsePRs throws when the files list is truncated", () => {
  assert.throws(() => parsePRs([node({ files: { totalCount: 300, nodes: [{ path: "a.ts" }] } })]), /PR 1.*file/i);
});

test("parsePRs output feeds buildLoadPlan: AUTHORED_BY, MODIFIED and REVIEWED_BY rows", () => {
  const empty = { commits: [], people: [], files: [], touched: [], coChanged: [], bots: [], stats: {} } as never;
  const prs = parsePRs([node()]);
  const plan = buildLoadPlan(empty, new Set(["lib/reply.js"]), prs);
  const by = (label: string) => plan.find((s) => s.label === label)?.rows ?? [];
  assert.deepEqual(by("AUTHORED_BY"), [{ number: 1, login: "alice" }]);
  assert.deepEqual(by("MODIFIED"), [{ number: 1, path: "lib/reply.js", module: "lib", alive: true }]);
  assert.deepEqual(by("REVIEWED_BY"), [{ number: 1, login: "bob", at: "2026-09-01T11:00:00.000Z" }]);
});

// --- file pagination --------------------------------------------------------
// A PR with more than 100 changed files cannot be fetched in one page: GitHub caps
// a connection's `first` at 100, so the old advice to "raise FILES_PER_PR" was
// impossible to follow. vite PR 23319 (246 files) is the case that found this.

test("fillFiles pages until the whole file list is present", () => {
  const asked: (string | null)[] = [];
  const n = node({
    number: 23319,
    files: { totalCount: 5, pageInfo: { hasNextPage: true, endCursor: "c2" }, nodes: [{ path: "a" }, { path: "b" }] },
  });
  fillFiles([n], (number, after) => {
    assert.equal(number, 23319);
    asked.push(after);
    return after === "c2"
      ? { totalCount: 5, pageInfo: { hasNextPage: true, endCursor: "c4" }, nodes: [{ path: "c" }, { path: "d" }] }
      : { totalCount: 5, pageInfo: { hasNextPage: false, endCursor: "c5" }, nodes: [{ path: "e" }] };
  });
  assert.deepEqual(asked, ["c2", "c4"], "must follow the cursor it was handed");
  assert.deepEqual(n.files.nodes.map((f) => f.path), ["a", "b", "c", "d", "e"]);
  // Once filled, the invariant parsePRs enforces holds.
  assert.deepEqual(parsePRs([n])[0].files, ["a", "b", "c", "d", "e"]);
});

test("fillFiles leaves a complete PR alone and spends no request on it", () => {
  const n = node({ files: { totalCount: 1, nodes: [{ path: "only.ts" }] } });
  fillFiles([n], () => {
    throw new Error("must not fetch for a PR whose files are already complete");
  });
  assert.deepEqual(n.files.nodes, [{ path: "only.ts" }]);
});

test("fillFiles stops instead of looping forever when a page comes back empty", () => {
  const n = node({ files: { totalCount: 9, pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [{ path: "a" }] } });
  fillFiles([n], () => ({ totalCount: 9, pageInfo: { hasNextPage: true, endCursor: "c" }, nodes: [] }));
  // Incomplete, so the guard in parsePRs must still fire rather than report 1 file.
  assert.throws(() => parsePRs([n]), /9 files but only 1/);
});

test("the truncation error names pagination, not the impossible 'raise FILES_PER_PR'", () => {
  // GitHub's connection page cap is 100: raising the constant cannot fix this.
  assert.throws(() => parsePRs([node({ files: { totalCount: 246, nodes: [{ path: "a.ts" }] } })]), (err: Error) => {
    assert.doesNotMatch(err.message, /raise FILES_PER_PR/);
    assert.match(err.message, /pagination|paginat/i);
    return true;
  });
});

test("fillFiles refetches from the first page when the cached page has no file cursor", () => {
  // Pages cached before the query asked for files.pageInfo have no cursor to resume
  // from. Throwing there would mean every stale cache entry needs a manual purge, so
  // the whole file list is refetched from the start instead.
  const asked: (string | null)[] = [];
  const n = node({ number: 23319, files: { totalCount: 3, nodes: [{ path: "stale-a" }] } });
  fillFiles([n], (_number, after) => {
    asked.push(after);
    return { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: "z" }, nodes: [{ path: "a" }, { path: "b" }, { path: "c" }] };
  });
  assert.deepEqual(asked, [null], "must start from the first page");
  assert.deepEqual(n.files.nodes.map((f) => f.path), ["a", "b", "c"], "stale partial list must be replaced, not appended to");
});
