// The MCP stdio transport: JSON-RPC 2.0 framing and method dispatch.
// Pure message-in / message-out, so none of this needs a pipe or a database.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FalkorDB, Graph } from "falkordb";
import { PROTOCOL_VERSION, SERVER_INFO, handleMessage, splitLines } from "../src/mcp/server.ts";
import type { McpDeps } from "../src/mcp/tools.ts";

const noGraph: McpDeps = {
  async withGraph() {
    throw new Error("the test did not expect a graph to be opened");
  },
};

function graphDeps(data: unknown[]): McpDeps {
  const answer = async () => ({ data });
  return {
    async withGraph(_repo, fn) {
      return fn({ query: answer, roQuery: answer } as unknown as Graph, {} as FalkorDB);
    },
  };
}

test("initialize advertises the tools capability and the server's identity", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, noGraph);
  assert.equal(res?.id, 1);
  const result = res?.result as { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: unknown };
  assert.equal(result.protocolVersion, PROTOCOL_VERSION);
  assert.ok(result.capabilities.tools, "must advertise tools");
  assert.deepEqual(result.serverInfo, SERVER_INFO);
});

test("initialize echoes a protocol version the client asked for when we support it", async () => {
  const res = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    noGraph,
  );
  assert.equal((res?.result as { protocolVersion: string }).protocolVersion, "2024-11-05");
});

test("a notification gets no reply at all", async () => {
  // No id means a notification. Replying to one is a protocol violation.
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, noGraph), null);
});

test("tools/list returns every tool with its schema", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, noGraph);
  const tools = (res?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
  assert.equal(tools.length, 4);
  for (const t of tools) assert.ok(t.inputSchema, `${t.name} must carry an inputSchema`);
});

test("tools/call returns the tool's JSON as text content", async () => {
  const res = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "repo_review", arguments: { repo: "fastify/fastify", prNumber: 7 } },
    },
    graphDeps([{ login: "alice", direct: 0.5, co: 0.1, score: 0.6 }]),
  );
  const result = res?.result as { content: { type: string; text: string }[]; isError?: boolean };
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0].type, "text");
  const payload = JSON.parse(result.content[0].text) as { candidates: { login: string }[] };
  assert.deepEqual(payload.candidates.map((c) => c.login), ["alice"]);
});

test("a tool that throws comes back as isError in the RESULT, not a JSON-RPC error", async () => {
  // MCP distinguishes protocol failures from tool failures: a tool that rejects must
  // still be a successful JSON-RPC call, so the model can read the message and retry.
  const res = await handleMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "repo_review", arguments: { prNumber: 1 } } },
    noGraph,
  );
  assert.equal(res?.error, undefined, "must not be a JSON-RPC error");
  const result = res?.result as { content: { text: string }[]; isError: boolean };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /repo/);
});

test("an unknown method is a JSON-RPC method-not-found", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 5, method: "resources/list" }, noGraph);
  assert.equal((res?.error as { code: number }).code, -32601);
  assert.equal(res?.result, undefined);
});

test("ping answers, so a client's keepalive does not look like a dead server", async () => {
  const res = await handleMessage({ jsonrpc: "2.0", id: 6, method: "ping" }, noGraph);
  assert.deepEqual(res?.result, {});
});

test("splitLines keeps a partial trailing line for the next chunk", () => {
  // stdin arrives in arbitrary chunks; a message split across two reads must not be
  // parsed as two broken ones.
  const first = splitLines('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(first.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(first.rest, '{"c":');

  const second = splitLines(`${first.rest}3}\n`);
  assert.deepEqual(second.lines, ['{"c":3}']);
  assert.equal(second.rest, "");
});

test("splitLines tolerates CRLF and blank lines", () => {
  const out = splitLines('{"a":1}\r\n\n{"b":2}\n');
  assert.deepEqual(out.lines, ['{"a":1}', '{"b":2}']);
});
