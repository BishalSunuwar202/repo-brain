// Merged PRs + their reviews and files, via `gh api graphql`, cached to disk (spec §4).
//
// One GraphQL call gets 50 PRs with their reviews AND their files; REST needs
// three calls per PR. scripts/vet-repos.ts proved the query shape.
//
// Split in two so the risky half needs no network:
//   parsePRs()        pure: GraphQL nodes -> PullRequest[]
//   fetchMergedPRs()  paginates `gh`, caches every page, then parses
//
// Shape notes:
// - Logins are lowercased here because Person.login is lowercased by identity.ts
//   (spec §12 D11). Miss it and every backtest hit-rate silently reads zero.
// - Reviewer AND author __typename are carried through: GitHub Apps are "Bot",
//   which is isBot()'s strongest signal (D13). load.ts drops bot reviewers and
//   self-reviews; the backtest uses authorTypename to drop bot-authored PRs from
//   the holdout. Neither filter happens here — this layer stays faithful.
// - Every review event is kept. load.ts reduces to one REVIEWED_BY per
//   (PR, reviewer) at their earliest review.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PullRequest {
  number: number;
  title: string;
  mergedAt: string;
  author: string;
  /** GraphQL __typename of the author; "Bot" for a GitHub App. */
  authorTypename?: string;
  files: string[];
  /** Every review event; load.ts dedupes, drops bots and self-reviews, lowercases. */
  reviewers: { login: string; typename?: string; state: string; at: string }[];
}

/** A null actor is a deleted ("ghost") account. */
type Actor = { __typename: string; login: string } | null;

export interface PrNode {
  number: number;
  title: string;
  mergedAt: string;
  author: Actor;
  files: { totalCount: number; pageInfo?: PageInfo; nodes: { path: string }[] };
  reviews: { totalCount: number; nodes: { state: string; submittedAt: string; author: Actor }[] };
}

/** Per-PR page sizes. Raise these if a truncation error fires rather than papering over it. */
/** GitHub's hard cap on a connection page. Not a knob: a bigger PR needs pagination. */
export const FILES_PER_PR = 100;
export const REVIEWS_PER_PR = 100;
const PRS_PER_PAGE = 50;

/**
 * GraphQL nodes -> PullRequest[]. Drops PRs authored by a deleted account (nothing
 * can be attributed to them and AUTHORED_BY needs a Person) and drops ghost
 * reviewers while keeping their PR.
 *
 * THROWS on a truncated files or reviews list. A truncated review list is a wrong
 * backtest ground truth and a truncated file list is a wrong review() input; both
 * would be invisible in the output. Same lesson as landmine 9, applied to the API.
 */
export function parsePRs(nodes: PrNode[]): PullRequest[] {
  const out: PullRequest[] = [];
  for (const n of nodes) {
    if (n.reviews.totalCount > n.reviews.nodes.length) {
      throw new Error(`PR ${n.number}: ${n.reviews.totalCount} reviews but only ${n.reviews.nodes.length} fetched — raise REVIEWS_PER_PR`);
    }
    if (n.files.totalCount > n.files.nodes.length) {
      throw new Error(
        `PR ${n.number}: ${n.files.totalCount} files but only ${n.files.nodes.length} fetched. GitHub caps a connection page at ${FILES_PER_PR}, so file pagination did not complete — see fillFiles.`,
      );
    }
    if (!n.author) continue;
    out.push({
      number: n.number,
      title: n.title,
      mergedAt: n.mergedAt,
      author: n.author.login.toLowerCase(),
      authorTypename: n.author.__typename,
      files: n.files.nodes.map((f) => f.path),
      reviewers: n.reviews.nodes
        .filter((r): r is typeof r & { author: NonNullable<Actor> } => Boolean(r.author))
        .map((r) => ({ login: r.author.login.toLowerCase(), typename: r.author.__typename, state: r.state, at: r.submittedAt })),
    });
  }
  return out;
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string;
}

export interface FilePage {
  totalCount: number;
  pageInfo: PageInfo;
  nodes: { path: string }[];
}

/** Fetches one further page of a PR's files, starting after `cursor`. */
export type FilePageFetcher = (number: number, cursor: string | null) => FilePage;

/** A PR with 5,000 changed files is a vendored dump, not a review unit. */
const MAX_FILE_PAGES = 50;

/**
 * Completes the file list of any PR that did not fit in one page (GitHub caps a
 * connection at FILES_PER_PR). Mutates the nodes in place; parsePRs still enforces
 * the invariant afterwards, so an incomplete fill fails loudly instead of silently
 * reporting a short file list. Found by vite PR 23319: 246 files.
 */
export function fillFiles(nodes: PrNode[], fetchPage: FilePageFetcher, log: (msg: string) => void = () => {}): void {
  for (const n of nodes) {
    if (n.files.totalCount <= n.files.nodes.length) continue;
    // A page cached before the query asked for files.pageInfo has no cursor to resume
    // from; start over from the first page rather than demand a cache purge.
    const resumable = Boolean(n.files.pageInfo?.hasNextPage);
    let cursor: string | null = resumable ? n.files.pageInfo!.endCursor : null;
    if (!resumable) n.files.nodes = [];
    let pages = 0;
    while (n.files.nodes.length < n.files.totalCount) {
      if (++pages > MAX_FILE_PAGES) throw new Error(`PR ${n.number}: still incomplete after ${MAX_FILE_PAGES} file pages`);
      const page = fetchPage(n.number, cursor);
      // An empty page would otherwise spin on the same cursor forever.
      if (page.nodes.length === 0) break;
      n.files.nodes.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
    log(`PR ${n.number}: ${n.files.nodes.length}/${n.files.totalCount} files after ${pages} extra page(s)`);
  }
}

const FILES_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: ${FILES_PER_PR}, after: $cursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { path }
      }
    }
  }
}`;

const QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: ${PRS_PER_PAGE}, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        mergedAt
        author { __typename login }
        files(first: ${FILES_PER_PR}) { totalCount pageInfo { hasNextPage endCursor } nodes { path } }
        reviews(first: ${REVIEWS_PER_PR}) { totalCount nodes { state submittedAt author { __typename login } } }
      }
    }
  }
}`;

type PrPage = { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PrNode[] };

function cacheDir(owner: string, name: string): string {
  const dir = join(import.meta.dirname, "..", "..", ".cache", "github", `${owner}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cached<T>(dir: string, key: string, fetch: () => T): T {
  const file = join(dir, key.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  const value = fetch();
  writeFileSync(file, JSON.stringify(value));
  return value;
}

export interface FetchOptions {
  log?: (msg: string) => void;
}

/**
 * The `limit` most recently CREATED merged PRs, returned newest-merged first.
 *
 * GitHub cannot order pull requests by mergedAt, so pages come back in creation
 * order and are sorted here. Creation order is not merge order: a long-lived PR
 * merges after newer ones. A caller taking the last N as a holdout must therefore
 * over-fetch — ask for comfortably more than N.
 */
export async function fetchMergedPRs(repo: string, limit: number, opts: FetchOptions = {}): Promise<PullRequest[]> {
  const log = opts.log ?? (() => {});
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`expected owner/name, got "${repo}"`);
  const dir = cacheDir(owner, name);

  const nodes: PrNode[] = [];
  let cursor: string | null = null;
  do {
    const key = `prs-${cursor ?? "first"}`;
    const page: PrPage = cached(dir, key, () => {
      log(`fetching ${key}`);
      const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
      return JSON.parse(out).data.repository.pullRequests as PrPage;
    });
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor && nodes.length < limit);

  const wanted = nodes.slice(0, limit);
  fillFiles(
    wanted,
    (number, cursor) =>
      cached(dir, `files-${number}-${cursor ?? "first"}`, () => {
        log(`fetching files page for PR ${number}`);
        const args = ["api", "graphql", "-f", `query=${FILES_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`];
        if (cursor) args.push("-f", `cursor=${cursor}`);
        const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
        return JSON.parse(out).data.repository.pullRequest.files as FilePage;
      }),
    log,
  );

  const prs = parsePRs(wanted);
  const ghosts = wanted.length - prs.length;
  if (ghosts > 0) log(`dropped ${ghosts} PR(s) authored by a deleted account`);
  log(`${prs.length} merged PRs`);
  return prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}
