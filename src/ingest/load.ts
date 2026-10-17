// Parsed RepoModel (+ merged PRs) -> graph writes (spec §2, §4, §12).
//
// Two halves so most of it is testable without a database:
//   buildLoadPlan()  pure: model -> ordered list of { label, cypher, rows }
//   loadRepo()       runs the schema DDL, then each step via writeBatched (UNWIND)
//
// Shape notes (spec §12):
// - Person keyed by lowercase login (D3, D11). Commit emails are used to RESOLVE that
//   login during ingest and are deliberately NOT stored on the node: nothing reads
//   them back, and the hackathon's rule 6 forbids loading personal data into the
//   graph. They stay in .cache/identity/, which is gitignored.
// - File {path, module, alive}; module = moduleOf(path) (D12); no loc.
// - CO_CHANGED: ONE edge per pair, (a)-[:CO_CHANGED]->(b) with a < b; queries
//   match it undirected (D6).
// - Timestamps are stored as UTC ISO strings so string order == time order
//   (git's %aI keeps the author's offset, which would break that).
// - PR authors and reviewers who never committed get a Person {login} with no
//   TOUCHED edges. Bot reviewers and self-reviews are dropped (D5).
// - Every write is MERGE + SET, so re-running a load over an existing graph
//   updates in place. Pass { fresh: true } to delete the graph first.

import type { Graph } from "falkordb";
import { writeBatched, type Row } from "../db/client.ts";
import { applySchema } from "../schema/ddl.ts";
import { isBot } from "./bots.ts";
import type { RepoModel } from "./gitlog.ts";
import type { PullRequest } from "./github.ts";
import { moduleOf } from "./paths.ts";

export interface LoadStep {
  label: string;
  cypher: string;
  rows: Row[];
}

const utc = (ts: string) => new Date(ts).toISOString();

export const CYPHER = {
  person: `UNWIND $rows AS row
MERGE (p:Person {login: row.login})
SET p.name = row.name, p.firstSeen = row.firstSeen, p.lastSeen = row.lastSeen`,

  file: `UNWIND $rows AS row
MERGE (f:File {path: row.path})
SET f.module = row.module, f.alive = row.alive`,

  commit: `UNWIND $rows AS row
MERGE (c:Commit {sha: row.sha})
SET c.ts = row.ts, c.author = row.author`,

  touched: `UNWIND $rows AS row
MATCH (p:Person {login: row.login})
MATCH (f:File {path: row.path})
MERGE (p)-[t:TOUCHED]->(f)
SET t.commits = row.commits, t.bulkCommits = row.bulkCommits, t.adds = row.adds, t.dels = row.dels,
    t.lastTs = row.lastTs, t.doa = row.doa`,

  coChanged: `UNWIND $rows AS row
MATCH (a:File {path: row.a})
MATCH (b:File {path: row.b})
MERGE (a)-[c:CO_CHANGED]->(b)
SET c.weight = row.weight, c.support = row.support`,

  pr: `UNWIND $rows AS row
MERGE (r:PR {number: row.number})
SET r.mergedAt = row.mergedAt, r.title = row.title`,

  // Login-only Person for PR authors/reviewers with no commits; never overwrites name.
  prPerson: `UNWIND $rows AS row
MERGE (p:Person {login: row.login})`,

  authoredBy: `UNWIND $rows AS row
MATCH (r:PR {number: row.number})
MATCH (p:Person {login: row.login})
MERGE (r)-[:AUTHORED_BY]->(p)`,

  // PR files may predate the window or be deleted: create them, but only set
  // module/alive on creation so git-derived values are never overwritten.
  modified: `UNWIND $rows AS row
MATCH (r:PR {number: row.number})
MERGE (f:File {path: row.path})
ON CREATE SET f.module = row.module, f.alive = row.alive
MERGE (r)-[:MODIFIED]->(f)`,

  reviewedBy: `UNWIND $rows AS row
MATCH (r:PR {number: row.number})
MATCH (p:Person {login: row.login})
MERGE (r)-[e:REVIEWED_BY]->(p)
SET e.at = row.at`,
} as const;

export function buildLoadPlan(model: RepoModel, alive: Set<string>, prs: PullRequest[] = []): LoadStep[] {
  const steps: LoadStep[] = [
    {
      label: "Person",
      cypher: CYPHER.person,
      rows: model.people.map((p) => ({
        login: p.login,
        name: p.name,
        firstSeen: utc(p.firstSeen),
        lastSeen: utc(p.lastSeen),
      })),
    },
    {
      label: "File",
      cypher: CYPHER.file,
      rows: model.files.map((path) => ({ path, module: moduleOf(path), alive: alive.has(path) })),
    },
    {
      label: "Commit",
      cypher: CYPHER.commit,
      rows: model.commits.map((c) => ({ sha: c.sha, ts: utc(c.ts), author: c.author })),
    },
    {
      label: "TOUCHED",
      cypher: CYPHER.touched,
      rows: model.touched.map((t) => ({
        login: t.login,
        path: t.path,
        commits: t.commits,
        bulkCommits: t.bulkCommits,
        adds: t.adds,
        dels: t.dels,
        lastTs: utc(t.lastTs),
        doa: t.doa,
      })),
    },
    {
      label: "CO_CHANGED",
      cypher: CYPHER.coChanged,
      rows: model.coChanged.map((c) => {
        if (!(c.a < c.b)) throw new Error(`CO_CHANGED pair not canonical: ${c.a} / ${c.b}`);
        return { a: c.a, b: c.b, weight: c.weight, support: c.support };
      }),
    },
  ];
  if (prs.length === 0) return steps;

  const known = new Set(model.people.map((p) => p.login));
  const extraPeople = new Set<string>();
  const authored: Row[] = [];
  const modified: Row[] = [];
  const reviewed: Row[] = [];
  for (const pr of prs) {
    const author = pr.author.toLowerCase();
    if (!isBot({ login: author })) {
      authored.push({ number: pr.number, login: author });
      if (!known.has(author)) extraPeople.add(author);
    }
    for (const path of new Set(pr.files)) {
      modified.push({ number: pr.number, path, module: moduleOf(path), alive: alive.has(path) });
    }
    // One REVIEWED_BY per (PR, reviewer), at their earliest review.
    const firstReview = new Map<string, string>();
    for (const r of pr.reviewers) {
      const login = r.login.toLowerCase();
      if (login === author || isBot({ login, typename: r.typename })) continue;
      const at = utc(r.at);
      const prev = firstReview.get(login);
      if (!prev || at < prev) firstReview.set(login, at);
    }
    for (const [login, at] of firstReview) {
      reviewed.push({ number: pr.number, login, at });
      if (!known.has(login)) extraPeople.add(login);
    }
  }

  steps.push(
    { label: "PR", cypher: CYPHER.pr, rows: prs.map((pr) => ({ number: pr.number, mergedAt: utc(pr.mergedAt), title: pr.title })) },
    { label: "Person (PR-only)", cypher: CYPHER.prPerson, rows: [...extraPeople].sort().map((login) => ({ login })) },
    { label: "AUTHORED_BY", cypher: CYPHER.authoredBy, rows: authored },
    { label: "MODIFIED", cypher: CYPHER.modified, rows: modified },
    { label: "REVIEWED_BY", cypher: CYPHER.reviewedBy, rows: reviewed },
  );
  return steps;
}

export interface LoadOptions {
  /** Delete the graph before loading. */
  fresh?: boolean;
  batchSize?: number;
  log?: (msg: string) => void;
}

/** Verified live (spec §13): GRAPH.DELETE on a graph that does not exist yet. */
export function isMissingGraph(err: unknown): boolean {
  return /Invalid graph operation on empty key/.test(String((err as Error)?.message ?? err));
}

export async function loadRepo(graph: Graph, plan: LoadStep[], opts: LoadOptions = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  if (opts.fresh) {
    try {
      await graph.delete();
    } catch (err) {
      if (!isMissingGraph(err)) throw err;
    }
  }
  await applySchema(graph);
  log("schema applied");
  for (const step of plan) {
    const started = Date.now();
    await writeBatched(graph, step.cypher, step.rows, opts.batchSize);
    log(`${step.label}: ${step.rows.length} rows in ${Date.now() - started} ms`);
  }
}
