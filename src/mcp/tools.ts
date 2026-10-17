// MCP tool surface over the four tools (spec §10, track 02 "Agentic AI").
//
// Split the same way as the rest of the codebase, so the contract is testable
// without a transport or a database:
//   TOOL_DEFS / callTool   the tool contract and dispatch — pure but for deps
//   server.ts              the stdio JSON-RPC loop that speaks MCP
//
// Every tool requires `repo`. The CLI can shout on stderr when --repo is missing
// (spec §12 D15: identities fall back to email local-parts and the output is not
// quotable). An MCP client never sees stderr, so here the schema makes that case
// impossible rather than merely discouraged.

import type { FalkorDB, Graph } from "falkordb";
import { FILE_KINDS, excludePatterns, makeExcluder } from "../ingest/paths.ts";
import { impact } from "../tools/impact.ts";
import { DEFAULT_K, checkK, review } from "../tools/review.ts";
import { DEFAULT_MIN_COMMITS, DEFAULT_THRESHOLD, activeFiles, checkKinds, risk, segmentRisk } from "../tools/risk.ts";
import {
  DEFAULT_BUDGET,
  DEFAULT_CANDIDATES,
  DEFAULT_THETA,
  checkBudget,
  checkCandidates,
  checkTheta,
  fix,
  type FixResult,
} from "../tools/fix.ts";

/** How a tool reaches a graph. Injected so the contract is testable with a stub. */
export interface McpDeps {
  withGraph<T>(repo: string, fn: (graph: Graph, db: FalkorDB) => Promise<T>): Promise<T>;
}

interface Prop {
  type: string;
  description: string;
  default?: unknown;
  items?: { type: string; enum?: readonly string[] };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, Prop>;
    required: string[];
  };
}

const repoProp: Prop = {
  type: "string",
  description:
    "GitHub repo as owner/name (e.g. fastify/fastify). Selects the graph repo:<owner>-<name>, which must already be ingested. Required: without it authors are identified by email local-part only and the numbers are not reportable.",
};

const kindProp: Prop = {
  type: "array",
  description: `Restrict to these file kinds; default all. Lockfiles and generated paths are never reported.`,
  items: { type: "string", enum: FILE_KINDS },
};

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "repo_impact",
    description:
      "Files that historically change together with a given file, by co-change support (the share of the rarer file's commits that include both). Use to answer 'what else moves when I touch this?' before editing.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        path: { type: "string", description: "Repo-relative file path, exactly as git records it." },
        includeTests: { type: "boolean", description: "List test files instead of collapsing them to a count.", default: false },
        limit: { type: "integer", description: "Rows to return.", default: 15 },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "repo_risk",
    description:
      "Bus-factor-1 files: files where one person holds more than `threshold` of the degree-of-authorship, among files active enough to matter. Returns per-file-kind segments and the at-risk files themselves. Use to answer 'where is knowledge dangerously concentrated?'",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        module: { type: "string", description: "Restrict to one module (top-level directory grouping)." },
        threshold: { type: "number", description: "One person must hold MORE than this share of doa. 0 < threshold < 1.", default: DEFAULT_THRESHOLD },
        minCommits: { type: "integer", description: "Activity floor: authorship commits on the file.", default: DEFAULT_MIN_COMMITS },
        kind: kindProp,
        limit: { type: "integer", description: "At-risk files to return; segments always cover all of them.", default: 25 },
      },
      required: ["repo"],
    },
  },
  {
    name: "repo_review",
    description:
      "Suggest reviewers for a merged or open PR already in the graph, scored by degree-of-authorship on the PR's files plus their co-change neighbours. Measured on a held-out backtest: it beats a random baseline and loses to a most-active-reviewer baseline, so treat it as a ranking signal rather than an answer.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        prNumber: { type: "integer", description: "PR number as GitHub shows it." },
        top: { type: "integer", description: "Candidates to return.", default: DEFAULT_K },
      },
      required: ["repo", "prNumber"],
    },
  },
  {
    name: "repo_fix",
    description:
      "The minimal set of review assignments that would reduce bus-factor-1 risk, solved as max-flow / min-cut with an expertise floor and a per-person review budget. Returns the assignments, the bottleneck, and a PROJECTION of the remaining risk — never a re-measurement.",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoProp,
        module: { type: "string", description: "Restrict to one module." },
        budget: { type: "integer", description: "k_r: extra reviews each reviewer can absorb.", default: DEFAULT_BUDGET },
        theta: { type: "number", description: "Expertise floor: a reviewer needs doa above this on another live file in the same module. 0 < theta < 1.", default: DEFAULT_THETA },
        candidates: { type: "integer", description: "Strongest eligible reviewers per file offered to the solver.", default: DEFAULT_CANDIDATES },
        threshold: { type: "number", description: "Risk dominance share, as in repo_risk.", default: DEFAULT_THRESHOLD },
        minCommits: { type: "integer", description: "Risk activity floor, as in repo_risk.", default: DEFAULT_MIN_COMMITS },
        kind: kindProp,
        ceiling: {
          type: "boolean",
          description: "Also solve with the shortlist lifted, to show what `candidates` costs. Repeats the solve; seconds on a large repo.",
          default: false,
        },
      },
      required: ["repo"],
    },
  },
];

/**
 * Does this PR exist in the graph at all? `ingest` only creates PR nodes when it is
 * given --prs, so an un-ingested PR and a PR nobody can review both come back from
 * review() as an empty list. An agent cannot act on that ambiguity, so the two are
 * separated here.
 */
export const PR_EXISTS_CYPHER = `MATCH (pr:PR {number: $number}) RETURN pr.number AS number`;

type Args = Record<string, unknown>;

function reqString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${key} is required and must be a non-empty string`);
  return v;
}

function reqRepo(args: Args): string {
  const repo = reqString(args, "repo");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error(`repo must be owner/name, got "${repo}"`);
  return repo;
}

function reqInt(args: Args, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${key} is required and must be an integer, got ${JSON.stringify(v)}`);
  return v;
}

function optInt(args: Args, key: string, dflt: number): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${key} must be an integer, got ${JSON.stringify(v)}`);
  return v;
}

function optNum(args: Args, key: string, dflt: number): number {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number, got ${JSON.stringify(v)}`);
  return v;
}

function optBool(args: Args, key: string): boolean {
  const v = args[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new Error(`${key} must be a boolean, got ${JSON.stringify(v)}`);
  return v;
}

function optKinds(args: Args): string[] {
  const v = args.kind;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((k) => typeof k !== "string")) throw new Error("kind must be an array of strings");
  return v as string[];
}

/**
 * The `fix` payload an agent receives. atRiskAfter is a counterfactual, and an agent
 * reading JSON never sees the CLI's "a projection, not a measurement" line — so the
 * label travels inside the payload, next to the parameters it is only meaningful with
 * (spec §16 F3).
 */
export function fixPayload(
  result: FixResult,
  opts: { budget: number; theta: number; candidates: number; threshold: number; minCommits: number },
): Record<string, unknown> {
  return {
    ...opts,
    ...result,
    atRiskAfterIsProjection: true,
    disclaimer:
      "atRiskAfter is a projection, not a measurement: it is atRiskBefore minus the max flow, and it assumes every assignment listed here is carried out and transfers enough knowledge. Nothing re-checks the graph afterwards. Quote it only together with budget, theta and candidates.",
  };
}

export async function callTool(name: string, args: Args, deps: McpDeps): Promise<unknown> {
  switch (name) {
    case "repo_impact": {
      // Validate before opening anything: a bad argument must not cost a connection.
      const repo = reqRepo(args);
      const path = reqString(args, "path");
      const includeTests = optBool(args, "includeTests");
      const limit = optInt(args, "limit", 15);
      return deps.withGraph(repo, async (graph) => {
        const view = await impact(graph, path, { includeTests, limit });
        if (!view) return { error: `${path} is not a file in ${repo}'s graph — a typo, or not touched in the ingest window` };
        return { repo, path, ...view };
      });
    }

    case "repo_risk": {
      const repo = reqRepo(args);
      const module = args.module === undefined ? undefined : reqString(args, "module");
      const threshold = optNum(args, "threshold", DEFAULT_THRESHOLD);
      const minCommits = optInt(args, "minCommits", DEFAULT_MIN_COMMITS);
      const kinds = checkKinds(optKinds(args));
      const limit = optInt(args, "limit", 25);
      const exclude = makeExcluder(excludePatterns([]));
      const riskOpts = { module, threshold, minCommits, kinds, exclude };
      return deps.withGraph(repo, async (graph) => {
        const rows = await risk(graph, riskOpts);
        const segments = segmentRisk(rows, await activeFiles(graph, riskOpts), exclude).filter(
          (s) => !kinds.length || kinds.includes(s.kind),
        );
        return {
          repo,
          threshold,
          minCommits,
          module,
          kinds,
          segments,
          atRisk: rows.length,
          rows: rows.slice(0, limit),
          truncated: rows.length > limit,
        };
      });
    }

    case "repo_review": {
      const repo = reqRepo(args);
      const prNumber = reqInt(args, "prNumber");
      const k = checkK(optInt(args, "top", DEFAULT_K));
      return deps.withGraph(repo, async (graph) => {
        const found = await graph.roQuery<{ number: number }>(PR_EXISTS_CYPHER, { params: { number: prNumber } });
        if (!found.data?.length) {
          return {
            error: `PR #${prNumber} is not in ${repo}'s graph. Either it was never merged into the ingest window, or ingest ran without --prs <n> (PR nodes are only created when PRs are fetched).`,
          };
        }
        return { repo, prNumber, candidates: await review(graph, prNumber, { k }) };
      });
    }

    case "repo_fix": {
      const repo = reqRepo(args);
      const module = args.module === undefined ? undefined : reqString(args, "module");
      const budget = checkBudget(optInt(args, "budget", DEFAULT_BUDGET));
      const theta = checkTheta(optNum(args, "theta", DEFAULT_THETA));
      const candidates = checkCandidates(optInt(args, "candidates", DEFAULT_CANDIDATES));
      const threshold = optNum(args, "threshold", DEFAULT_THRESHOLD);
      const minCommits = optInt(args, "minCommits", DEFAULT_MIN_COMMITS);
      const kinds = checkKinds(optKinds(args));
      const ceiling = optBool(args, "ceiling");
      return deps.withGraph(repo, async (graph, db) => {
        const result = await fix(graph, db, {
          module,
          budget,
          theta,
          candidates,
          threshold,
          minCommits,
          kinds,
          ceiling,
          exclude: makeExcluder(excludePatterns([])),
        });
        return { repo, ...fixPayload(result, { budget, theta, candidates, threshold, minCommits }) };
      });
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
