// PRs + reviews via `gh api`, cached to disk (spec §4). STUB.
//
// Endpoints: /repos/{o}/{r}/pulls?state=closed (keep merged_at != null),
//            /repos/{o}/{r}/pulls/{n}/reviews, /repos/{o}/{r}/pulls/{n}/files
// Cache every response under .cache/github/<owner>-<name>/ before parsing.
//
// Lessons from vetting (docs/superpowers/specs/repo-candidates.md):
// - GraphQL (`gh api graphql`) gets 50 PRs + reviews in one call; REST needs one
//   call per PR for reviews. scripts/vet-repos.ts has a working query.
// - Exclude bot reviewers with isBot() from ./bots.ts (pass __typename), and
//   reviews whose author is the PR author (thread replies show up as COMMENTED).
// - Exclude bot-authored PRs (dependabot, renovate) from the backtest holdout.
// - Lowercase logins: Person.login is lowercased by identity.ts.
// - email -> login mapping lives in identity.ts (fetchIdentityMap).

export interface PullRequest {
  number: number;
  title: string;
  mergedAt: string;
  author: string;
  files: string[];
  /** Every review event; load.ts dedupes, drops bots and self-reviews, lowercases. */
  reviewers: { login: string; typename?: string; state: string; at: string }[];
}

export async function fetchMergedPRs(_repo: string, _limit: number): Promise<PullRequest[]> {
  throw new Error("not implemented: github.fetchMergedPRs");
}
