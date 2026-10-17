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

import { randomUUID } from "node:crypto";
import type { FalkorDB, Graph } from "falkordb";
import { isBot } from "../ingest/bots.ts";
import type { PullRequest } from "../ingest/github.ts";
import { isMissingGraph } from "../ingest/load.ts";
import { review } from "../tools/review.ts";
import { mostActiveRanking, predictMostActive, predictRandom, reviewerActivity, reviewerPool } from "./baselines.ts";

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

export const DEFAULT_HOLDOUT = 30;
/** Fetched PRs. Creation order is not merge order, so over-fetch well past the holdout. */
export const DEFAULT_PR_LIMIT = 300;

export interface Split {
  /** The PRs to predict for, newest merged first. */
  holdout: PullRequest[];
  /** Everything merged strictly before the cutoff. */
  training: PullRequest[];
  /** The oldest held-out PR's mergedAt, normalised. */
  cutoff: string;
}

/**
 * Splits fetched PRs into a holdout and a training set.
 *
 * Bot-authored PRs are barred from the holdout — 17 of fastify's last 50 merged
 * PRs are github-actions backports, and predicting a reviewer for an automated
 * cherry-pick measures nothing — but they stay in training as evidence of
 * activity. The cutoff is STRICT: a PR merged exactly at it belongs to the
 * holdout, never to training.
 */
export function splitHoldout(prs: readonly PullRequest[], n: number): Split {
  const iso = (p: PullRequest) => new Date(p.mergedAt).toISOString();
  const merged = prs.filter((p) => p.mergedAt).sort((a, b) => iso(b).localeCompare(iso(a)));
  const targets = merged.filter((p) => !isBot({ login: p.author, typename: p.authorTypename }));
  if (targets.length < n) {
    throw new Error(`holdout of ${n} needs ${n} non-bot-authored merged PRs, have ${targets.length} — raise --pr-limit`);
  }
  const holdout = targets.slice(0, n);
  const cutoff = iso(holdout[holdout.length - 1]);
  return { holdout, training: merged.filter((p) => iso(p) < cutoff), cutoff };
}

/**
 * The held-out PRs with their reviewers removed. Their PR node, author and
 * MODIFIED edges are legitimate input — review() has to know which files
 * changed — but their REVIEWED_BY edges are the answer being predicted.
 */
export function withheldReviews(prs: readonly PullRequest[]): PullRequest[] {
  return prs.map((pr) => ({ ...pr, reviewers: [] }));
}

export interface BacktestResult {
  heldOut: number;
  /** Held-out PRs with at least one human reviewer; only these are scored. */
  scored: number;
  /** The history cutoff every prediction was made from. */
  cutoff: string;
  hitRateAt1: number;
  hitRateAt3: number;
  baselines: { random: { hit1: number; hit3: number }; mostActive: { hit1: number; hit3: number } };
}

export interface BacktestOptions {
  holdout?: number;
  prLimit?: number;
  seed?: number;
  log?: (msg: string) => void;
}

export interface BacktestDeps {
  fetch: (repo: string, limit: number) => Promise<PullRequest[]>;
  /** Parse git history cut at `until`, with doa as of `until`, and load it with `prs`. */
  ingest: (graph: Graph, until: string, prs: PullRequest[]) => Promise<void>;
}

/**
 * Measured hit-rate@1/@3 of review() against two baselines (spec §6, D1/D2).
 *
 * Runs in a throwaway graph built from history cut at the holdout boundary. That
 * cut is the whole point: with the held-out PRs' own commits in the graph,
 * review() would score an author on the very change it is predicting a reviewer
 * for. Note that File.alive still comes from today's HEAD; review() does not read
 * it, so it cannot affect this number.
 */
export async function backtest(db: FalkorDB, repo: string, opts: BacktestOptions, deps: BacktestDeps): Promise<BacktestResult> {
  const log = opts.log ?? (() => {});
  const prs = await deps.fetch(repo, opts.prLimit ?? DEFAULT_PR_LIMIT);
  const { holdout, training, cutoff } = splitHoldout(prs, opts.holdout ?? DEFAULT_HOLDOUT);
  log(`${prs.length} PRs fetched; ${holdout.length} held out, ${training.length} training, cutoff ${cutoff}`);

  const name = `backtest:${randomUUID()}`;
  const graph = db.selectGraph(name);
  try {
    await deps.ingest(graph, cutoff, [...training, ...withheldReviews(holdout)]);
    const activity = await reviewerActivity(graph, { before: cutoff });
    const ranking = mostActiveRanking(activity);
    const pool = reviewerPool(activity);
    log(`${activity.length} reviewers active before the cutoff; most active: ${ranking.slice(0, 3).join(", ")}`);

    const mine: { predicted: string[]; actual: Set<string> }[] = [];
    const active: typeof mine = [];
    const chance: typeof mine = [];
    for (const pr of holdout) {
      const actual = groundTruthReviewers(pr.reviewers, pr.author);
      const predicted = (await review(graph, pr.number, { k: 3 })).map((c) => c.login);
      mine.push({ predicted, actual });
      active.push({ predicted: predictMostActive(ranking, pr.author), actual });
      chance.push({ predicted: predictRandom(pool, { number: pr.number, author: pr.author }, opts.seed), actual });
    }
    return {
      heldOut: holdout.length,
      scored: mine.filter((c) => c.actual.size > 0).length,
      cutoff,
      hitRateAt1: hitRate(mine, 1),
      hitRateAt3: hitRate(mine, 3),
      baselines: {
        random: { hit1: hitRate(chance, 1), hit3: hitRate(chance, 3) },
        mostActive: { hit1: hitRate(active, 1), hit3: hitRate(active, 3) },
      },
    };
  } finally {
    // If ingest threw before writing anything, the graph does not exist and
    // GRAPH.DELETE raises "Invalid graph operation on empty key" — which would
    // replace the real error with a confusing one.
    try {
      await graph.delete();
    } catch (err) {
      if (!isMissingGraph(err)) throw err;
    }
  }
}
