// Git author -> Person.login (spec §12 D3). One human must be one Person:
// a split identity makes a bus-factor-1 file look safe.
//
// Resolution order per commit:
//   1. GitHub's login for that commit sha (GraphQL history author.user.login)
//   2. GitHub's login for that author email (any other commit with the same email)
//   3. fallback: normalised email local-part

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Commit } from "./gitlog.ts";

export const IDENTITY_CACHE_DIR = join(import.meta.dirname, "..", "..", ".cache", "identity");

/** 109662399+Alice@users.noreply.github.com -> alice; Alice.Smith@corp.io -> alice.smith */
export function fallbackLogin(email: string): string {
  const local = email.toLowerCase().split("@")[0];
  return local.replace(/^\d+\+/, "");
}

export interface IdentityMap {
  bySha: Map<string, string>;
  byEmail: Map<string, string>;
}

export type HistoryNode = { oid: string; author: { email: string | null; user: { login: string } | null } };

export function identityFromHistory(nodes: Iterable<HistoryNode>): IdentityMap {
  const map: IdentityMap = { bySha: new Map(), byEmail: new Map() };
  for (const n of nodes) {
    const login = n.author.user?.login;
    if (!login) continue;
    map.bySha.set(n.oid, login);
    if (n.author.email) map.byEmail.set(n.author.email.toLowerCase(), login);
  }
  return map;
}

export type ResolvedVia = "sha" | "email" | "fallback";

export interface Resolver {
  (c: Commit): string;
  counts: Record<ResolvedVia, number>;
}

/** Logins are lowercased so they match fallback keys; GitHub logins are case-insensitive. */
export function makeResolver(map?: IdentityMap): Resolver {
  const counts: Record<ResolvedVia, number> = { sha: 0, email: 0, fallback: 0 };
  const resolve = ((c: Commit) => {
    const viaSha = map?.bySha.get(c.sha);
    if (viaSha) {
      counts.sha++;
      return viaSha.toLowerCase();
    }
    const viaEmail = map?.byEmail.get(c.authorEmail.toLowerCase());
    if (viaEmail) {
      counts.email++;
      return viaEmail.toLowerCase();
    }
    counts.fallback++;
    return fallbackLogin(c.authorEmail);
  }) as Resolver;
  resolve.counts = counts;
  return resolve;
}

/** "2 years ago" / "6 months ago" / ISO date -> Date. Only what --since needs here. */
export function sinceToDate(since: string, now = new Date()): Date {
  const rel = since.trim().match(/^(\d+)\s+(year|month|week|day)s?\s+ago$/i);
  if (rel) {
    const d = new Date(now);
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    if (unit === "year") d.setUTCFullYear(d.getUTCFullYear() - n);
    if (unit === "month") d.setUTCMonth(d.getUTCMonth() - n);
    if (unit === "week") d.setUTCDate(d.getUTCDate() - 7 * n);
    if (unit === "day") d.setUTCDate(d.getUTCDate() - n);
    return d;
  }
  const abs = Date.parse(since);
  if (Number.isNaN(abs)) throw new Error(`cannot turn --since "${since}" into a date for the GitHub query`);
  return new Date(abs);
}

const HISTORY_QUERY = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit {
      history(first: 100, since: $since, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { oid author { email user { login } } }
      }
    } } }
  }
}`;

type HistoryPage = { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: HistoryNode[] };

/**
 * Default-branch commit authors since `since`, via `gh api graphql`. Every page is
 * cached under .cache/identity/; the start date is rounded down to the day (minus
 * one day of slack) so reruns on the same day hit the cache.
 */
export function fetchIdentityMap(repo: string, since: Date): IdentityMap {
  const [owner, name] = repo.split("/");
  const day = new Date(since.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const dir = join(IDENTITY_CACHE_DIR, `${owner}-${name}`, day);
  mkdirSync(dir, { recursive: true });

  const nodes: HistoryNode[] = [];
  let cursor: string | null = null;
  do {
    const file = join(dir, `${(cursor ?? "first").replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
    let page: HistoryPage;
    if (existsSync(file)) {
      page = JSON.parse(readFileSync(file, "utf8"));
    } else {
      const args = ["api", "graphql", "-f", `query=${HISTORY_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
      args.push("-f", `since=${day}T00:00:00Z`);
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const out = JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
      const target = out.data?.repository?.defaultBranchRef?.target;
      if (!target) throw new Error(`GitHub returned no history for ${repo}: ${JSON.stringify(out.errors ?? out).slice(0, 300)}`);
      page = target.history;
      writeFileSync(file, JSON.stringify(page));
    }
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return identityFromHistory(nodes);
}
