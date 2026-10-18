// The MCP tool surface (spec §10 track 02). No network, no database: the graph is
// stubbed by dispatching on the Cypher each tool sends.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FalkorDB, Graph } from "falkordb";
import { PR_EXISTS_CYPHER, TOOL_DEFS, callTool, fixPayload, type McpDeps } from "../src/mcp/tools.ts";
import { FILE_CYPHER, IMPACT_CYPHER } from "../src/tools/impact.ts";
import { REVIEW_CYPHER } from "../src/tools/review.ts";

/** A Graph whose query() answers from a cypher -> rows table. */
function stubGraph(answers: { cypher: string; data: unknown[] }[]): Graph {
  const answer = async (cypher: string) => {
    const hit = answers.find((a) => a.cypher === cypher);
    if (!hit) throw new Error(`stub graph got an unexpected query:\n${cypher}`);
    return { data: hit.data };
  };
  return { query: answer, roQuery: answer } as unknown as Graph;
}

function deps(graph: Graph): McpDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async withGraph(repo, fn) {
      opened.push(repo);
      return fn(graph, {} as FalkorDB);
    },
  };
}

test("exposes exactly the four tools, each namespaced", () => {
  assert.deepEqual(
    TOOL_DEFS.map((t) => t.name).sort(),
    ["repo_fix", "repo_impact", "repo_review", "repo_risk"],
  );
});

test("D15: every tool requires repo, so an agent can never get unquotable output", () => {
  // Without --repo the CLI falls back to email local-parts and warns the numbers are
  // not reportable. An MCP client cannot see a warning on stderr, so repo is required
  // at the schema level instead.
  for (const def of TOOL_DEFS) {
    assert.ok(def.inputSchema.required.includes("repo"), `${def.name} must require repo`);
    assert.equal(def.inputSchema.properties.repo?.type, "string");
  }
});

test("every tool has a description an agent can choose from", () => {
  for (const def of TOOL_DEFS) {
    assert.ok(def.description.length > 30, `${def.name} needs a real description`);
  }
});

test("an unknown tool name throws and names what was asked for", async () => {
  await assert.rejects(
    () => callTool("repo_nonsense", { repo: "a/b" }, deps(stubGraph([]))),
    /unknown tool: repo_nonsense/,
  );
});

test("a missing repo fails before any graph is opened", async () => {
  const d = deps(stubGraph([]));
  await assert.rejects(() => callTool("repo_review", { prNumber: 1 }, d), /repo/);
  assert.deepEqual(d.opened, [], "must not open a graph to reject a bad argument");
});

test("repo_review returns ranked candidates and opens the named repo's graph", async () => {
  const d = deps(
    stubGraph([
      { cypher: PR_EXISTS_CYPHER, data: [{ number: 42 }] },
      {
        cypher: REVIEW_CYPHER,
        data: [
          { login: "bob", direct: 0.1, co: 0.0, score: 0.1 },
          { login: "alice", direct: 0.5, co: 0.2, score: 0.7 },
        ],
      },
    ]),
  );
  const out = (await callTool("repo_review", { repo: "fastify/fastify", prNumber: 42 }, d)) as {
    candidates: { login: string }[];
  };
  assert.deepEqual(d.opened, ["fastify/fastify"]);
  assert.deepEqual(
    out.candidates.map((c) => c.login),
    ["alice", "bob"],
  );
});

// An empty candidate list and a PR that was never ingested are different answers, and
// an agent cannot tell them apart. Silently returning [] invites "nobody can review
// this" when the truth is "ingest ran without --prs".
test("repo_review distinguishes a PR missing from the graph from one with no candidates", async () => {
  const absent = (await callTool(
    "repo_review",
    { repo: "a/b", prNumber: 6080 },
    deps(stubGraph([{ cypher: PR_EXISTS_CYPHER, data: [] }])),
  )) as { error?: string; candidates?: unknown };
  assert.match(String(absent.error), /6080/);
  assert.match(String(absent.error), /--prs|ingest/);
  assert.equal(absent.candidates, undefined);

  const present = (await callTool(
    "repo_review",
    { repo: "a/b", prNumber: 6080 },
    deps(stubGraph([{ cypher: PR_EXISTS_CYPHER, data: [{ number: 6080 }] }, { cypher: REVIEW_CYPHER, data: [] }])),
  )) as { error?: string; candidates: unknown[] };
  assert.equal(present.error, undefined);
  assert.deepEqual(present.candidates, [], "a known PR with no candidate is an empty list, not an error");
});

test("repo_review validates top through checkK instead of passing it to Cypher", async () => {
  await assert.rejects(
    () => callTool("repo_review", { repo: "a/b", prNumber: 1, top: 0 }, deps(stubGraph([]))),
    /top|k/i,
  );
});

test("repo_impact reports a path that is not in the graph instead of returning nothing", async () => {
  const d = deps(stubGraph([{ cypher: FILE_CYPHER, data: [] }]));
  const out = (await callTool("repo_impact", { repo: "a/b", path: "nope.ts" }, d)) as { error?: string };
  assert.match(String(out.error), /nope\.ts/);
});

test("repo_impact returns co-change rows for a known path", async () => {
  const d = deps(
    stubGraph([
      { cypher: FILE_CYPHER, data: [{ alive: true }] },
      { cypher: IMPACT_CYPHER, data: [{ path: "b.ts", weight: 4, support: 0.8, kind: "source" }] },
    ]),
  );
  const out = (await callTool("repo_impact", { repo: "a/b", path: "a.ts" }, d)) as { rows: unknown[] };
  assert.equal(out.rows.length, 1);
});

// The honesty requirement, applied to the MCP surface. The CLI prints "a projection,
// not a measurement" next to atRiskAfter; an agent reading JSON never sees that prose,
// so the payload has to carry it or the agent will quote a projection as a measurement.
test("repo_fix labels atRiskAfter as a projection inside the payload", () => {
  const payload = fixPayload(
    {
      atRiskBefore: 32,
      atRiskAfter: 1,
      coverable: 31,
      ceiling: null,
      assignments: [{ reviewer: "alice", files: ["a.ts"] }],
      unserved: ["lock-threads.yml"],
      bottleneck: "bandwidth",
      bottleneckReviewers: ["alice"],
    },
    { budget: 2, theta: 0.2, candidates: 5, threshold: 0.5, minCommits: 3 },
  ) as Record<string, unknown>;

  assert.equal(payload.atRiskAfterIsProjection, true);
  assert.match(String(payload.disclaimer), /projection/i);
  assert.match(String(payload.disclaimer), /not a measurement/i);
  // The parameters the number is only meaningful with (spec §16 F3).
  assert.equal(payload.budget, 2);
  assert.equal(payload.theta, 0.2);
  assert.equal(payload.candidates, 5);
});
