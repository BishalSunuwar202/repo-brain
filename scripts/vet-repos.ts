// Vets candidate repos for the backtest (spec §6): does the repo have recorded
// PR reviews by someone other than the author, from enough distinct people?
//
// Run: node scripts/vet-repos.ts owner/name [owner/name ...]
// Every gh response is cached under .cache/vetting/ so reruns cost no API calls.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBot as isBotIdentity } from "../src/ingest/bots.ts";

const CACHE_DIR = join(import.meta.dirname, "..", ".cache", "vetting");
const PR_SAMPLE = 100;
const SINCE = new Date(Date.now() - 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10) + "T00:00:00Z";

mkdirSync(CACHE_DIR, { recursive: true });

function cached<T>(key: string, fetch: () => T): T {
  const file = join(CACHE_DIR, key.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  const value = fetch();
  writeFileSync(file, JSON.stringify(value));
  return value;
}

function gh(args: string[]): string {
  return execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

const QUERY = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    stargazerCount
    primaryLanguage { name }
    defaultBranchRef { name target { ... on Commit { history(since: $since) { totalCount } } } }
    pullRequests(states: MERGED, first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        mergedAt
        changedFiles
        author { __typename login }
        reviews(first: 50) { totalCount nodes { state author { __typename login } } }
      }
    }
  }
}`;

type Actor = { __typename: string; login: string } | null;
type PR = {
  number: number;
  mergedAt: string;
  changedFiles: number;
  author: Actor;
  reviews: { totalCount: number; nodes: { state: string; author: Actor }[] };
};
type RepoPage = {
  stargazerCount: number;
  primaryLanguage: { name: string } | null;
  defaultBranchRef: { name: string; target: { history: { totalCount: number } } };
  pullRequests: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PR[] };
};

function fetchPage(owner: string, name: string, cursor: string | null): RepoPage {
  return cached(`${owner}-${name}-prs-${cursor ?? "first"}`, () => {
    const args = ["graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-f", `since=${SINCE}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    return JSON.parse(gh(args)).data.repository as RepoPage;
  });
}

function contributorCount(owner: string, name: string): number | string {
  return cached(`${owner}-${name}-contributors`, () => {
    try {
      const out = gh(["-i", `repos/${owner}/${name}/contributors?per_page=1&anon=false`]);
      const last = out.match(/[?&]page=(\d+)>; rel="last"/);
      return last ? Number(last[1]) : 1;
    } catch {
      return "not measured (API refused: history too large)";
    }
  });
}

function fileCount(owner: string, name: string, branch: string): { files: number; truncated: boolean } {
  return cached(`${owner}-${name}-tree`, () => {
    const tree = JSON.parse(gh([`repos/${owner}/${name}/git/trees/${branch}?recursive=1`]));
    const files = tree.tree.filter((e: { type: string }) => e.type === "blob").length;
    return { files, truncated: Boolean(tree.truncated) };
  });
}

// Commit authors on the default branch in the window, by GitHub login. Answers:
// can a git-history-based predictor even name the people who actually review?
const HISTORY = `
query($owner: String!, $name: String!, $since: GitTimestamp!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit {
      history(first: 100, since: $since, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { author { email user { login } } }
      }
    } } }
  }
}`;

function committerLogins(owner: string, name: string): Set<string> {
  const logins = new Set<string>();
  let cursor: string | null = null;
  do {
    type H = { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { author: { user: { login: string } | null } }[] };
    const page: H = cached(`${owner}-${name}-history-${cursor ?? "first"}`, () => {
      const args = ["graphql", "-f", `query=${HISTORY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-f", `since=${SINCE}`];
      if (cursor) args.push("-f", `cursor=${cursor}`);
      return JSON.parse(gh(args)).data.repository.defaultBranchRef.target.history;
    });
    for (const n of page.nodes) if (n.author.user) logins.add(n.author.user.login);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return logins;
}

// A null actor is a deleted ("ghost") account; treat as non-human.
const isBot = (a: Actor) => !a || isBotIdentity({ login: a.login, typename: a.__typename });

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function vet(slug: string) {
  const [owner, name] = slug.split("/");
  const prs: PR[] = [];
  let cursor: string | null = null;
  let repo!: RepoPage;
  do {
    repo = fetchPage(owner, name, cursor);
    prs.push(...repo.pullRequests.nodes);
    cursor = repo.pullRequests.pageInfo.hasNextPage ? repo.pullRequests.pageInfo.endCursor : null;
  } while (cursor && prs.length < PR_SAMPLE);
  const sample = prs.slice(0, PR_SAMPLE);

  const reviewsByPerson = new Map<string, number>();
  const reviewerSets: Set<string>[] = [];
  let covered = 0;
  let approved = 0;
  let botReviewOnly = 0;
  let truncatedReviews = 0;
  let humanCovered = 0;
  for (const pr of sample) {
    if (pr.reviews.totalCount > pr.reviews.nodes.length) truncatedReviews++;
    const others = pr.reviews.nodes.filter((r) => r.author && r.author.login !== pr.author?.login);
    const humans = others.filter((r) => !isBot(r.author));
    if (humans.length === 0 && others.length > 0) botReviewOnly++;
    if (humans.length === 0) continue;
    covered++;
    if (!isBot(pr.author)) humanCovered++;
    if (humans.some((r) => r.state === "APPROVED")) approved++;
    reviewerSets.push(new Set(humans.map((r) => r.author!.login)));
    for (const r of humans) reviewsByPerson.set(r.author!.login, (reviewsByPerson.get(r.author!.login) ?? 0) + 1);
  }
  const totalReviews = [...reviewsByPerson.values()].reduce((a, b) => a + b, 0);
  const top = [...reviewsByPerson.entries()].sort((a, b) => b[1] - a[1]);
  const shareWith = (logins: string[]) =>
    reviewerSets.length
      ? Math.round((100 * reviewerSets.filter((s) => logins.some((l) => s.has(l))).length) / reviewerSets.length)
      : null;
  const committers = committerLogins(owner, name);
  const reviewers = [...reviewsByPerson.keys()];
  const humanPRs = sample.filter((p) => !isBot(p.author)).length;
  const tree = fileCount(owner, name, repo.defaultBranchRef.name);

  return {
    repo: slug,
    sampledPRs: sample.length,
    oldestSampledMerge: sample.at(-1)?.mergedAt.slice(0, 10),
    botAuthoredPct: Math.round((100 * sample.filter((p) => isBot(p.author)).length) / sample.length),
    reviewCoveragePct: Math.round((100 * covered) / sample.length),
    humanAuthoredPRs: humanPRs,
    humanPRReviewCoveragePct: humanPRs ? Math.round((100 * humanCovered) / humanPRs) : null,
    botReviewOnlyPRs: botReviewOnly,
    distinctReviewers: reviewsByPerson.size,
    reviewerConcentrationPct: totalReviews ? Math.round((100 * top[0][1]) / totalReviews) : null,
    topReviewerPRSharePct: shareWith(top.slice(0, 1).map(([l]) => l)),
    top3ReviewerPRSharePct: shareWith(top.slice(0, 3).map(([l]) => l)),
    reviewersWithCommitsPct: reviewers.length
      ? Math.round((100 * reviewers.filter((l) => committers.has(l)).length) / reviewers.length)
      : null,
    reviewedPRsWithCommittingReviewerPct: reviewerSets.length
      ? Math.round((100 * reviewerSets.filter((s) => [...s].some((l) => committers.has(l))).length) / reviewerSets.length)
      : null,
    distinctCommitterLogins2y: committers.size,
    topReviewers: top.slice(0, 5).map(([l, n]) => `${l}:${n}`).join(" "),
    approvedPctOfReviewed: covered ? Math.round((100 * approved) / covered) : null,
    medianFilesPerPR: median(sample.map((p) => p.changedFiles)),
    truncatedReviewLists: truncatedReviews,
    stars: repo.stargazerCount,
    language: repo.primaryLanguage?.name ?? null,
    contributors: contributorCount(owner, name),
    commitsLast2y: repo.defaultBranchRef.target.history.totalCount,
    files: tree.files,
    fileTreeTruncated: tree.truncated,
  };
}

const results = [];
for (const slug of process.argv.slice(2)) {
  try {
    const r = vet(slug);
    console.log(JSON.stringify(r));
    results.push(r);
  } catch (err) {
    console.log(JSON.stringify({ repo: slug, error: String(err).slice(0, 300) }));
  }
}
writeFileSync(join(CACHE_DIR, "results.json"), JSON.stringify(results, null, 2));
