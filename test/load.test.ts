import { test } from "node:test";
import assert from "node:assert/strict";
import type { Graph } from "falkordb";
import { RESULTSET_SIZE, connectionErrorMessage, graphName, underCap, writeBatched } from "../src/db/client.ts";
import { buildRepoModel, type Commit } from "../src/ingest/gitlog.ts";
import { buildLoadPlan, isMissingGraph, loadRepo } from "../src/ingest/load.ts";
import { DDL, isAlreadyIndexed } from "../src/schema/ddl.ts";
import type { PullRequest } from "../src/ingest/github.ts";

const AS_OF = new Date("2026-10-15T00:00:00Z");
const commit = (sha: string, ts: string, email: string, paths: string[], created: string[] = []): Commit => ({
  sha,
  ts,
  authorEmail: email,
  authorName: email.split("@")[0],
  files: paths.map((path) => ({ path, adds: 2, dels: 1, binary: false })),
  created,
});

const model = buildRepoModel(
  [
    commit("c3", "2026-03-01T10:00:00+05:45", "alice@x.io", ["src/core/a.ts", "src/core/b.ts"]),
    commit("c2", "2026-02-01T00:00:00Z", "bob@x.io", ["src/core/a.ts", "src/core/b.ts", "pnpm-lock.yaml"]),
    commit("c1", "2026-01-01T00:00:00Z", "alice@x.io", ["src/core/a.ts", "src/core/b.ts", "README.md"], ["src/core/a.ts"]),
  ],
  AS_OF,
);
const alive = new Set(["src/core/a.ts", "src/core/b.ts", "README.md"]);

class FakeGraph {
  queries: { cypher: string; rows?: unknown[] }[] = [];
  deleted = false;
  failWith?: (cypher: string) => Error | undefined;
  async query(cypher: string, opts?: { params?: { rows?: unknown[] } }) {
    const err = this.failWith?.(cypher);
    if (err) throw err;
    this.queries.push({ cypher, rows: opts?.params?.rows });
    return { metadata: [] };
  }
  deleteError?: Error;
  async delete() {
    if (this.deleteError) throw this.deleteError;
    this.deleted = true;
  }
}
const asGraph = (g: FakeGraph) => g as unknown as Graph;

test("graph-per-repo naming", () => {
  assert.equal(graphName("FalkorDB/FalkorDB"), "repo:FalkorDB-FalkorDB");
  assert.throws(() => graphName("fastify"));
});

test("load plan: node steps before edge steps; every statement is a batched UNWIND", () => {
  const plan = buildLoadPlan(model, alive);
  assert.deepEqual(plan.map((s) => s.label), ["Person", "File", "Commit", "TOUCHED", "CO_CHANGED"]);
  for (const s of plan) assert.match(s.cypher, /^UNWIND \$rows AS row\n/);
  assert.ok(!plan.some((s) => /LIMIT/.test(s.cypher)), "landmine 2: no LIMIT on writes");
});

test("load plan rows: lowercase login, no emails on the node, module, alive, UTC timestamps", () => {
  const plan = Object.fromEntries(buildLoadPlan(model, alive).map((s) => [s.label, s.rows]));
  // No emails key: commit emails resolve the login at ingest and are never written
  // to the node (hackathon rule 6 — no personal data in the graph).
  assert.deepEqual(plan.Person.find((p) => p.login === "alice"), {
    login: "alice",
    name: "alice",
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastSeen: "2026-03-01T04:15:00.000Z", // +05:45 normalised to UTC
  });
  assert.ok(
    !buildLoadPlan(model, alive).some((s) => /emails/.test(s.cypher)),
    "no load step may write an email address into the graph",
  );
  assert.deepEqual(plan.File.find((f) => f.path === "pnpm-lock.yaml"), { path: "pnpm-lock.yaml", module: ".", alive: false });
  assert.deepEqual(plan.File.find((f) => f.path === "src/core/a.ts"), { path: "src/core/a.ts", module: "src/core", alive: true });
  assert.equal(plan.Commit.find((c) => c.sha === "c3")!.ts, "2026-03-01T04:15:00.000Z");
  const touched = plan.TOUCHED.find((t) => t.login === "alice" && t.path === "src/core/a.ts")!;
  assert.deepEqual(Object.keys(touched).sort(), ["adds", "bulkCommits", "commits", "dels", "doa", "lastTs", "login", "path"]);
  assert.equal(touched.commits, 2);
  // pnpm-lock.yaml keeps its TOUCHED row (factual) but is not in CO_CHANGED.
  assert.ok(plan.TOUCHED.some((t) => t.path === "pnpm-lock.yaml"));
  assert.deepEqual(plan.CO_CHANGED, [{ a: "src/core/a.ts", b: "src/core/b.ts", weight: 3, support: 1 }]);
});

test("load plan refuses non-canonical CO_CHANGED pairs", () => {
  const bad = { ...model, coChanged: [{ a: "z.ts", b: "a.ts", weight: 3, support: 1 }] };
  assert.throws(() => buildLoadPlan(bad, alive), /not canonical/);
});

test("PR steps: bots and self-reviews dropped, reviewers lowercased and deduped to earliest review", () => {
  const prs: PullRequest[] = [
    {
      number: 7,
      title: "fix core",
      mergedAt: "2026-03-02T00:00:00Z",
      author: "Alice",
      files: ["src/core/a.ts", "src/old.ts", "src/core/a.ts"],
      reviewers: [
        { login: "Carol", state: "COMMENTED", at: "2026-03-01T12:00:00Z" },
        { login: "carol", state: "APPROVED", at: "2026-03-01T09:00:00Z" },
        { login: "alice", state: "COMMENTED", at: "2026-03-01T10:00:00Z" },
        { login: "coderabbitai", typename: "Bot", state: "COMMENTED", at: "2026-03-01T08:00:00Z" },
        { login: "Bob", state: "APPROVED", at: "2026-03-01T11:00:00Z" },
      ],
    },
    { number: 8, title: "deps", mergedAt: "2026-03-03T00:00:00Z", author: "renovate[bot]", files: ["package.json"], reviewers: [] },
  ];
  const steps = Object.fromEntries(buildLoadPlan(model, alive, prs).map((s) => [s.label, s.rows]));
  assert.deepEqual(steps["Person (PR-only)"], [{ login: "carol" }], "only people with no commits");
  assert.deepEqual(steps.AUTHORED_BY, [{ number: 7, login: "alice" }], "bot-authored PR gets no author edge");
  assert.deepEqual(steps.REVIEWED_BY, [
    { number: 7, login: "carol", at: "2026-03-01T09:00:00.000Z" },
    { number: 7, login: "bob", at: "2026-03-01T11:00:00.000Z" },
  ]);
  assert.deepEqual(
    steps.MODIFIED.map((m) => [m.number, m.path, m.alive]),
    [[7, "src/core/a.ts", true], [7, "src/old.ts", false], [8, "package.json", false]],
  );
});

test("writeBatched chunks rows and rejects non-UNWIND statements", async () => {
  const g = new FakeGraph();
  const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
  await writeBatched(asGraph(g), "UNWIND $rows AS row\nCREATE (:X {i: row.i})", rows, 1000);
  assert.deepEqual(g.queries.map((q) => q.rows!.length), [1000, 1000, 500]);
  await writeBatched(asGraph(g), "UNWIND $rows AS row\nCREATE (:X)", [], 1000);
  assert.equal(g.queries.length, 3, "no round-trip for zero rows");
  await assert.rejects(writeBatched(asGraph(g), "CREATE (:X)", rows), /UNWIND/);
});

test("loadRepo: fresh deletes, DDL first, 'already indexed' tolerated, other errors surface", async () => {
  const g = new FakeGraph();
  g.failWith = (c) => (c.includes("p.login") ? new Error("Attribute 'login' is already indexed") : undefined);
  await loadRepo(asGraph(g), buildLoadPlan(model, alive), { fresh: true });
  assert.equal(g.deleted, true);
  assert.deepEqual(g.queries.slice(0, DDL.length - 1).map((q) => q.cypher), DDL.filter((d) => !d.includes("p.login")));
  assert.equal(g.queries.length, DDL.length - 1 + 5);

  const broken = new FakeGraph();
  broken.failWith = (c) => (c.startsWith("UNWIND") ? new Error("connection reset") : undefined);
  await assert.rejects(loadRepo(asGraph(broken), buildLoadPlan(model, alive)), /connection reset/);
  assert.equal(isAlreadyIndexed(new Error("connection reset")), false);
});

test("fresh load: a missing graph is fine, any other delete error surfaces", async () => {
  const missing = new FakeGraph();
  missing.deleteError = new Error("ERR Invalid graph operation on empty key");
  await loadRepo(asGraph(missing), [], { fresh: true });
  assert.equal(missing.queries.length, DDL.length);

  const down = new FakeGraph();
  down.deleteError = new Error("connect ECONNREFUSED 127.0.0.1:6379");
  await assert.rejects(loadRepo(asGraph(down), [], { fresh: true }), /ECONNREFUSED/);
  assert.equal(down.queries.length, 0, "nothing written after a failed delete");
  assert.equal(isMissingGraph(new Error("ECONNREFUSED")), false);
});

// Found on 2026-10-18 with the container stopped: every command printed "error:" and
// nothing else. The falkordb client reports a refused connection as an AggregateError
// whose own `message` is empty, so the CLI had nothing to print. On recording day the
// answer is almost always "docker is not running", so say that.
test("a refused connection names the url and the container instead of printing nothing", () => {
  const refused = new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:6379")]);
  assert.equal(refused.message, "", "the premise: the client's own message is empty");

  const msg = connectionErrorMessage(refused, "redis://localhost:6379");
  assert.match(msg, /redis:\/\/localhost:6379/, "must name the url it tried");
  assert.match(msg, /repo-brain-db/, "must name the container to start");
  assert.match(msg, /ECONNREFUSED/, "must keep the underlying reason");
});

test("a connection error that does have a message keeps it", () => {
  assert.match(connectionErrorMessage(new Error("WRONGPASS invalid password"), "redis://x"), /WRONGPASS invalid password/);
  assert.match(connectionErrorMessage("plain string", "redis://x"), /plain string/);
});

test("underCap: a result at FalkorDB's RESULTSET_SIZE is treated as truncated", () => {
  assert.deepEqual(underCap(undefined, "q"), []);
  assert.equal(underCap(new Array(RESULTSET_SIZE - 1).fill(0), "q").length, RESULTSET_SIZE - 1);
  assert.throws(() => underCap(new Array(RESULTSET_SIZE).fill(0), "risk"), /risk: 10000 rows hit .*RESULTSET_SIZE/);
});
