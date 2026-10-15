// One bot predicate for every place that needs it (spec §12 D5): git authors in
// gitlog.ts, PR authors and reviewers in github.ts / the backtest ground truth.

const KNOWN_BOTS = [
  "dependabot",
  "renovate",
  "github-actions",
  "copilot",
  "coderabbitai",
  "codecov",
  "sonarcloud",
  "netlify",
  "vercel",
  "changeset-bot",
  "allcontributors",
  "greenkeeper",
  "snyk-bot",
  "mergify",
  "pre-commit-ci",
  "imgbot",
];

export interface Identity {
  name?: string;
  email?: string;
  login?: string;
  /** GraphQL __typename of the actor; GitHub Apps are "Bot". */
  typename?: string;
}

/**
 * Why an identity counts as a bot, or null for a human. Strongest signal first
 * (spec §12 D13): GitHub's own type, then "[bot]" markers, then the known-bot list,
 * then the "*bot" login suffix heuristic. Reasons are surfaced in the parse summary
 * so a misclassified human (a "talbot") is visible, not silent.
 */
export type BotReason = "typename" | "[bot]" | "known" | "login-suffix";

export function botReason(id: Identity): BotReason | null {
  if (id.typename === "Bot") return "typename";
  // typename "User" is NOT proof of a human: machine accounts like eslintbot are Users.
  const fields = [id.name, id.email, id.login].filter((f): f is string => Boolean(f)).map((f) => f.toLowerCase());
  if (fields.some((f) => f.includes("[bot]"))) return "[bot]";
  if (fields.some((f) => KNOWN_BOTS.some((b) => f === b || f.startsWith(b + "-") || f.startsWith(b + " ")))) return "known";
  // Any login ending in "bot". Catches machine USER accounts like "eslintbot" (not
  // typename Bot). Cost: a human login like "talbot" is misread as a bot; a missed
  // bot in the backtest ground truth is the worse error. Display names are exempt.
  if (id.login && /bot$/i.test(id.login)) return "login-suffix";
  return null;
}

export function isBot(id: Identity): boolean {
  return botReason(id) !== null;
}
