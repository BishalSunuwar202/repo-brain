// Backtest (spec §6, §12 D1/D2/D11). The scoring helpers are real and tested; the
// driver is a STUB until review() and github.ts exist.
//
// 1. Ingest the repo excluding the last 30 merged PRs (bot-authored PRs excluded
//    from the holdout; doa computed with asOf = the oldest held-out PR's mergedAt).
// 2. For each held-out PR, run review(pr).
// 3. hit-rate@1 / hit-rate@3 (D1): did ANY of the top-k appear among the PR's
//    actual reviewers (groundTruthReviewers below).
// 4. Baselines: random eligible reviewer; most-active-reviewer-overall. Report
//    review's number NEXT TO the most-active baseline (D2).

import { isBot } from "../ingest/bots.ts";

export interface ReviewEvent {
  login: string;
  /** GraphQL __typename of the reviewer, when known. */
  typename?: string;
}

/**
 * Who actually reviewed: lowercased logins (Person.login is lowercase, D11), minus
 * the PR author (thread replies are recorded as reviews) and bots (D5).
 * Drop the lowercasing and every hit-rate silently reads zero.
 */
export function groundTruthReviewers(reviews: ReviewEvent[], prAuthor: string): Set<string> {
  const author = prAuthor.toLowerCase();
  const out = new Set<string>();
  for (const r of reviews) {
    const login = r.login.toLowerCase();
    if (login === author || isBot({ login, typename: r.typename })) continue;
    out.add(login);
  }
  return out;
}

/** 1 if any of the top-k predictions is an actual reviewer, else 0. */
export function hitAtK(predicted: string[], actual: Set<string>, k: number): 0 | 1 {
  return predicted.slice(0, k).some((p) => actual.has(p.toLowerCase())) ? 1 : 0;
}

/** Mean of hitAtK over PRs that have at least one human reviewer. */
export function hitRate(cases: { predicted: string[]; actual: Set<string> }[], k: number): number {
  const scored = cases.filter((c) => c.actual.size > 0);
  if (scored.length === 0) return NaN;
  return scored.reduce((sum, c) => sum + hitAtK(c.predicted, c.actual, k), 0) / scored.length;
}

export interface BacktestResult {
  heldOut: number;
  hitRateAt1: number;
  hitRateAt3: number;
  baselines: { random: { hit1: number; hit3: number }; mostActive: { hit1: number; hit3: number } };
}

export async function backtest(_repo: string, _holdout = 30): Promise<BacktestResult> {
  throw new Error("not implemented: backtest");
}
