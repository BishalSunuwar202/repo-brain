// MCP server over stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout.
//
// Hand-rolled rather than pulling in @modelcontextprotocol/sdk, because the surface
// an MCP client actually needs is four methods — initialize, tools/list, tools/call,
// ping — and CLAUDE.md says to ask before adding a dependency. Swapping the SDK in
// later only replaces this file; tools.ts is the contract and knows no transport.
//
// stdout carries protocol frames ONLY. Anything diagnostic goes to stderr, or the
// client sees it as a malformed message.

import { connect, graphName, openRepoGraph } from "../db/client.ts";
import { TOOL_DEFS, callTool, type McpDeps } from "./tools.ts";

export const SERVER_INFO = { name: "repo-brain", version: "0.1.0" } as const;

/** What we answer with when the client does not ask for a particular revision. */
export const PROTOCOL_VERSION = "2025-06-18";

/** Revisions whose shape this server matches; a client asking for one gets it back. */
export const SUPPORTED_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const METHOD_NOT_FOUND = -32601;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;

const ok = (id: Rpc["id"], result: unknown): Rpc => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string): Rpc => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Framing. stdin arrives in arbitrary chunks, so a message split across two reads
 * must be held over rather than parsed as two broken ones.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((l) => l.trim()).filter((l) => l !== ""), rest };
}

/** One request in, one response out. `null` means it was a notification: say nothing. */
export async function handleMessage(msg: Rpc, deps: McpDeps): Promise<Rpc | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  const { id = null, method } = msg;

  if (!method) return isNotification ? null : fail(id, INVALID_REQUEST, "missing method");
  // Notifications get no reply even when we do not recognise them.
  if (isNotification) return null;

  switch (method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const version = typeof asked === "string" && SUPPORTED_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions:
          "Ask about a repo that has already been ingested. Every tool needs `repo` as owner/name. repo_fix's atRiskAfter is a projection, not a measurement — quote it with its budget, theta and candidates.",
      });
    }

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, { tools: TOOL_DEFS });

    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") return fail(id, INVALID_REQUEST, "tools/call needs params.name");
      try {
        const out = await callTool(name, args, deps);
        return ok(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        // A tool that fails is still a successful CALL: the model needs to read the
        // message and fix its arguments, which a JSON-RPC error would deny it.
        return ok(id, { content: [{ type: "text", text: String((err as Error)?.message ?? err) }], isError: true });
      }
    }

    default:
      return fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

/** Opens one connection per call, like the CLI — an MCP session may be long and idle. */
export const liveDeps: McpDeps = {
  async withGraph(repo, fn) {
    const db = await connect();
    try {
      if (!(await db.list()).includes(graphName(repo))) {
        throw new Error(`no graph ${graphName(repo)} — ingest it first: npm run brain -- --repo ${repo} ingest <repoPath>`);
      }
      return await fn(await openRepoGraph(db, repo), db);
    } finally {
      await db.close();
    }
  },
};

export interface ServeOptions {
  input?: AsyncIterable<string | Buffer>;
  write?: (line: string) => void;
  deps?: McpDeps;
  log?: (msg: string) => void;
}

export async function serve(opts: ServeOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const deps = opts.deps ?? liveDeps;
  const log = opts.log ?? ((m: string) => process.stderr.write(`[mcp] ${m}\n`));

  log(`repo-brain MCP server on stdio, ${TOOL_DEFS.length} tools`);
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk.toString();
    const { lines, rest } = splitLines(buffer);
    buffer = rest;
    for (const line of lines) {
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        // One unparseable line must not end the session.
        write(JSON.stringify(fail(null, PARSE_ERROR, "invalid JSON")));
        continue;
      }
      try {
        const res = await handleMessage(msg, deps);
        if (res) write(JSON.stringify(res));
      } catch (err) {
        log(`handler threw: ${String((err as Error)?.message ?? err)}`);
        if (msg.id !== undefined && msg.id !== null) {
          write(JSON.stringify(fail(msg.id, INVALID_REQUEST, String((err as Error)?.message ?? err))));
        }
      }
    }
  }
}
