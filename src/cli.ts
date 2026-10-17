// Entry point: npm run brain -- <command> [opts]

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { connect, graphName, openRepoGraph } from "./db/client.ts";
import { RepoModelBuilder, headFiles, streamGitLog, type RepoModel } from "./ingest/gitlog.ts";
import { fetchIdentityMap, makeResolver, sinceToDate, type Resolver } from "./ingest/identity.ts";
import { fetchMergedPRs } from "./ingest/github.ts";
import { buildLoadPlan, loadRepo } from "./ingest/load.ts";
import { FILE_KINDS, excludePatterns, makeExcluder } from "./ingest/paths.ts";
import { DEFAULT_HOLDOUT, DEFAULT_PR_LIMIT, backtest } from "./eval/backtest.ts";
import { DEFAULT_SEED } from "./eval/baselines.ts";
import { impact } from "./tools/impact.ts";
import { DEFAULT_K, checkK, presentReview, review } from "./tools/review.ts";
import { DEFAULT_BUDGET, DEFAULT_CANDIDATES, DEFAULT_THETA, checkBudget, checkCandidates, checkTheta, fix } from "./tools/fix.ts";
import { DEFAULT_MIN_COMMITS, DEFAULT_THRESHOLD, activeFiles, checkKinds, risk, segmentRisk } from "./tools/risk.ts";
import type { FalkorDB, Graph } from "falkordb";

const program = new Command()
  .name("brain")
  .description("Repo Brain: git history -> FalkorDB expertise graph -> who should review what")
  .option("--repo <owner/name>", "GitHub repo: resolves authors to GitHub logins and selects the graph repo:<owner>-<name>");

const collect = (value: string, previous: string[]) => [...previous, value];

interface ParseOpts {
  since: string;
  asOf?: string;
  /** Cut history here. The backtest needs it so predictions cannot see the future. */
  until?: string;
  noExclude: string[];
}

interface Parsed {
  model: RepoModel;
  alive: Set<string>;
  identify: Resolver;
  reportable: boolean;
  excludePatterns: string[];
}

async function parseRepo(repoPath: string, opts: ParseOpts): Promise<Parsed> {
  const repo: string | undefined = program.opts().repo;
  // Spec §12 D15: without --repo, identities come from email local-parts, which can
  // split one human or merge two. Such output must never be quoted.
  if (!repo) {
    console.error(
      [
        "",
        "!!! WARNING: no --repo given. Authors are identified by email local-part only.",
        "!!! One person can split into two, and two people can merge into one.",
        "!!! These numbers are NOT suitable for reporting. Re-run with --repo owner/name.",
        "",
      ].join("\n"),
    );
  }
  const identify = makeResolver(repo ? fetchIdentityMap(repo, sinceToDate(opts.since)) : undefined);
  const patterns = excludePatterns(opts.noExclude);
  const builder = new RepoModelBuilder({ identify, exclude: makeExcluder(patterns) });
  for await (const c of streamGitLog(repoPath, opts.since, opts.until)) builder.add(c);
  const model = builder.finish(opts.asOf ? new Date(opts.asOf) : new Date());
  return { model, alive: headFiles(repoPath), identify, reportable: Boolean(repo), excludePatterns: patterns };
}

// commander maps `--no-exclude <glob>` to opts.exclude (string[]).
type CliParseOpts = { since: string; asOf?: string; exclude: string[] };

const parseOptions = (cmd: Command) =>
  cmd
    .argument("<repoPath>", "path to a local git checkout")
    .option("--since <when>", "git --since value", "2 years ago")
    .option("--as-of <iso>", "reference time for doa recency (default: now)")
    .option("--no-exclude <glob>", "keep a pattern from the exclusion list (repeatable)", collect, []);

parseOptions(program.command("parse"))
  .description("parse git history into Layer A facts (no database) and print counts")
  .option("--out <file>", "write the full parsed model as JSON")
  .action(async (repoPath: string, opts: CliParseOpts & { out?: string }) => {
    const path = resolve(repoPath);
    const started = Date.now();
    const { model, alive, identify, reportable, excludePatterns } = await parseRepo(path, { ...opts, noExclude: opts.exclude });

    const summary = {
      repo: path,
      reportable,
      since: opts.since,
      ...model.stats,
      people: model.people.length,
      peopleWithMultipleEmails: model.people.filter((p) => p.emails.length > 1).length,
      identityResolvedVia: identify.counts,
      // Spec §12 D13: every bot classification, with its reason, for a one-glance audit.
      bots: model.bots.map((b) => `${b.login} [${b.reason}] ${b.commits} commits as ${b.seenAs}`),
      filesTouched: model.files.length,
      filesTouchedAlive: model.files.filter((f) => alive.has(f)).length,
      filesAtHead: alive.size,
      touchedEdges: model.touched.length,
      coChangedPairs: model.coChanged.length,
      excludePatterns,
      parseMs: Date.now() - started,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (opts.out) {
      writeFileSync(opts.out, JSON.stringify({ ...model, alive: [...alive] }));
      console.error(`wrote ${opts.out}`);
    }
  });

parseOptions(program.command("ingest"))
  .description("parse git history and load it into FalkorDB graph repo:<owner>-<name>")
  .option("--fresh", "delete the repo graph before loading")
  .option("--prs <n>", "also fetch this many recent merged PRs with their reviews and files via gh (spec §4)")
  .action(async (repoPath: string, opts: CliParseOpts & { fresh?: boolean; prs?: string }) => {
    const repo: string | undefined = program.opts().repo;
    if (!repo) throw new Error("ingest requires --repo owner/name (graph naming + identity resolution, spec §12 D15)");
    const { model, alive, identify } = await parseRepo(resolve(repoPath), { ...opts, noExclude: opts.exclude });
    console.error(
      `parsed: ${model.people.length} people, ${model.files.length} files, ${model.coChanged.length} pairs; identity ${JSON.stringify(identify.counts)}`,
    );
    // Fetching PRs needs `gh` logged in; every page is cached under .cache/github/.
    const prs = opts.prs ? await fetchMergedPRs(repo, checkCount(opts.prs, "--prs"), { log: (m) => console.error(`[prs] ${m}`) }) : [];
    const plan = buildLoadPlan(model, alive, prs);
    const db = await connect();
    try {
      const graph = await openRepoGraph(db, repo);
      await loadRepo(graph, plan, { fresh: opts.fresh, log: (m) => console.error(`[${graphName(repo)}] ${m}`) });
    } finally {
      await db.close();
    }
  });

// fix needs db too: it solves the flow network in its own throwaway graph.
async function withGraph<T>(fn: (graph: Graph, repo: string, db: FalkorDB) => Promise<T>): Promise<T> {
  const repo: string | undefined = program.opts().repo;
  if (!repo) throw new Error("this command needs --repo owner/name to pick the graph");
  const db = await connect();
  try {
    // Querying a missing graph surfaces as a raw "Invalid graph operation on empty key".
    if (!(await db.list()).includes(graphName(repo))) {
      throw new Error(`no graph ${graphName(repo)} — run: npm run brain -- --repo ${repo} ingest <repoPath>`);
    }
    return await fn(await openRepoGraph(db, repo), repo, db);
  } finally {
    await db.close();
  }
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4);

function checkCount(value: string, what: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${what} must be an integer >= 1, got "${value}"`);
  return n;
}

program
  .command("impact")
  .description("files that co-change with <path>")
  .argument("<path>")
  .option("--include-tests", "list test files instead of collapsing them into a count (spec §12 D16)")
  .option("--limit <n>", "rows to show", "15")
  .action(async (path: string, opts: { includeTests?: boolean; limit: string }) => {
    await withGraph(async (graph, repo) => {
      const view = await impact(graph, path, { includeTests: opts.includeTests, limit: Number(opts.limit) });
      if (!view) {
        console.error(`${path}: not a file in ${graphName(repo)} (typo, or not touched in the ingest window)`);
        process.exitCode = 1;
        return;
      }
      console.log(`Files that change with ${path} (support = share of the rarer file's commits that include both):`);
      if (view.rows.length === 0) console.log("  (no co-change partner above the support threshold)");
      for (const r of view.rows) console.log(`  ${pct(r.support)}  ${String(r.weight).padStart(3)}x  ${r.path}`);
      if (view.hiddenTests) console.log(`  +${view.hiddenTests} test file${view.hiddenTests === 1 ? "" : "s"} (--include-tests to list)`);
    });
  });
program
  .command("risk")
  .description("bus-factor-1 files, by file kind (lockfiles/generated paths never reported, spec §12 D14)")
  .option("--module <module>")
  .option("--threshold <share>", "one person must hold MORE than this share of doa (spec §15 R1)", String(DEFAULT_THRESHOLD))
  .option("--min-commits <n>", "activity floor: authorship commits on the file (spec §15 R1)", String(DEFAULT_MIN_COMMITS))
  .option("--kind <kind>", `only this file kind, repeatable: ${FILE_KINDS.join(", ")}`, collect, [])
  .option("--no-exclude <glob>", "keep a pattern from the exclusion list (repeatable)", collect, [])
  .option("--as-of <iso>", "reference time for days-since-other (default: now)")
  .option("--limit <n>", "rows to show", "25")
  .option("--json", "print segments and all rows as JSON")
  .action(
    async (opts: { module?: string; threshold: string; minCommits: string; kind: string[]; exclude: string[]; asOf?: string; limit: string; json?: boolean }) => {
      await withGraph(async (graph, repo) => {
        const exclude = makeExcluder(excludePatterns(opts.exclude));
        const riskOpts = {
          module: opts.module,
          threshold: Number(opts.threshold),
          minCommits: Number(opts.minCommits),
          kinds: checkKinds(opts.kind),
          asOf: opts.asOf ? new Date(opts.asOf) : undefined,
          exclude,
        };
        const rows = await risk(graph, riskOpts);
        const segments = segmentRisk(rows, await activeFiles(graph, riskOpts), exclude).filter(
          (s) => !riskOpts.kinds.length || riskOpts.kinds.includes(s.kind),
        );
        if (opts.json) return console.log(JSON.stringify({ repo, ...riskOpts, exclude: undefined, segments, rows }, null, 2));

        const scope = [opts.module && `module ${opts.module}`, riskOpts.kinds.length && `kind ${riskOpts.kinds.join(",")}`].filter(Boolean).join(", ");
        console.log(
          `${graphName(repo)}  bus-factor-1 = one person holds >${riskOpts.threshold} of doa, on files with >=${riskOpts.minCommits} authorship commits${scope ? `  [${scope}]` : ""}`,
        );
        console.log(`\nby kind (at-risk / active files):`);
        for (const s of segments) {
          const top = s.topHolder ? `  ${s.topHolder.login} holds ${s.topHolder.files}` : "";
          console.log(`  ${s.kind.padEnd(7)} ${String(s.atRisk).padStart(4)} / ${String(s.active).padEnd(5)}${top}`);
        }
        console.log(`\n${rows.length} file${rows.length === 1 ? "" : "s"}:   share commits people  others-last  holder               path`);
        const limit = Number(opts.limit);
        for (const r of rows.slice(0, limit)) {
          const other = r.daysSinceOther === null ? "never" : `${r.daysSinceOther}d ago`;
          console.log(`  ${r.kind.padEnd(7)} ${pct(r.share)} ${String(r.commits).padStart(7)} ${String(r.holders).padStart(6)}  ${other.padStart(11)}  ${r.soleHolder.padEnd(20)} ${r.path}`);
        }
        if (rows.length > limit) console.log(`  … ${rows.length - limit} more (--limit, --json)`);
      });
    },
  );
program
  .command("review")
  .description("suggest reviewers for a PR (spec §5); this is the backtest's baseline, not the contribution")
  .argument("<prNumber>")
  .option("--top <n>", "how many candidates to return", String(DEFAULT_K))
  .option("--json", "print the full result as JSON")
  .action(async (prNumber: string, opts: { top: string; json?: boolean }) => {
    const number = checkCount(prNumber, "prNumber");
    const k = checkK(Number(opts.top));
    await withGraph(async (graph) => {
      const candidates = await review(graph, number, { k });
      if (opts.json) console.log(JSON.stringify(candidates, null, 2));
      else console.log(presentReview(number, candidates));
    });
  });
program
  .command("fix")
  .description("minimal review assignments that de-risk bus-factor-1 files (max-flow / min-cut, spec §5)")
  .option("--module <module>")
  .option("--budget <n>", "k_r: extra reviews each reviewer can take (spec §12 D7)", String(DEFAULT_BUDGET))
  .option("--theta <share>", "expertise floor: a reviewer needs MORE than this doa on another file in the module (spec §15 R3, provisional)", String(DEFAULT_THETA))
  .option("--candidates <n>", "strongest eligible reviewers per file offered to the solver", String(DEFAULT_CANDIDATES))
  .option("--threshold <share>", "risk: one person must hold MORE than this share of doa (spec §15 R1)", String(DEFAULT_THRESHOLD))
  .option("--min-commits <n>", "risk activity floor: authorship commits on the file (spec §15 R1)", String(DEFAULT_MIN_COMMITS))
  .option("--kind <kind>", `only this file kind, repeatable: ${FILE_KINDS.join(", ")}`, collect, [])
  .option("--no-exclude <glob>", "keep a pattern from the exclusion list (repeatable)", collect, [])
  .option("--as-of <iso>", "reference time for days-since-other (default: now)")
  .option("--ceiling", "also solve with no shortlist, to show what --candidates costs (a second solve)")
  .option("--json", "print the full result as JSON")
  .action(
    async (opts: {
      module?: string;
      ceiling?: boolean;
      budget: string;
      theta: string;
      candidates: string;
      threshold: string;
      minCommits: string;
      kind: string[];
      exclude: string[];
      asOf?: string;
      json?: boolean;
    }) => {
      await withGraph(async (graph, repo, db) => {
        const fixOpts = {
          module: opts.module,
          budget: checkBudget(Number(opts.budget)),
          theta: checkTheta(Number(opts.theta)),
          candidates: checkCandidates(Number(opts.candidates)),
          threshold: Number(opts.threshold),
          minCommits: Number(opts.minCommits),
          kinds: checkKinds(opts.kind),
          asOf: opts.asOf ? new Date(opts.asOf) : undefined,
          exclude: makeExcluder(excludePatterns(opts.exclude)),
          ceiling: opts.ceiling,
        };
        const result = await fix(graph, db, fixOpts);
        if (opts.json) return console.log(JSON.stringify({ repo, ...fixOpts, exclude: undefined, ...result }, null, 2));

        const scope = [opts.module && `module ${opts.module}`, fixOpts.kinds.length && `kind ${fixOpts.kinds.join(",")}`].filter(Boolean).join(", ");
        const reviews = result.atRiskBefore - result.atRiskAfter;
        console.log(
          `${graphName(repo)}  fix: budget ${fixOpts.budget} reviews/person, reviewer needs doa >${fixOpts.theta} on another file in the module, top ${fixOpts.candidates} candidates per file${scope ? `  [${scope}]` : ""}`,
        );
        console.log(`\n  at risk now          ${String(result.atRiskBefore).padStart(5)}  (one person holds >${fixOpts.threshold} of doa, >=${fixOpts.minCommits} authorship commits)`);
        console.log(`  have a reviewer      ${String(result.coverable).padStart(5)}`);
        console.log(`  projected at risk    ${String(result.atRiskAfter).padStart(5)}  IF every review below happens — a projection, not a measurement`);
        if (result.ceiling !== null) {
          console.log(`    with no shortlist  ${String(result.ceiling).padStart(5)}  (every eligible reviewer allowed; top ${fixOpts.candidates} costs ${result.atRiskAfter - result.ceiling})`);
        }
        // Exact split of what is left: a file with no eligible reviewer can never be
        // served, so every other unserved file is waiting on someone's budget.
        const noReviewer = result.atRiskBefore - result.coverable;
        const atBudget = result.atRiskAfter - noReviewer;
        const names = result.bottleneckReviewers;
        const shown = names.length > 8 ? `${names.slice(0, 8).join(", ")} +${names.length - 8} more` : names.join(", ");
        console.log(`  bottleneck           ${result.bottleneck}`);
        if (atBudget) console.log(`    ${String(atBudget).padStart(5)} left because reviewers are at budget (--budget): ${shown}`);
        if (noReviewer) console.log(`    ${String(noReviewer).padStart(5)} left because nobody clears the expertise floor (--theta)`);
        if (result.unserved.length && result.unserved.length <= 10) {
          console.log(`  still at risk`);
          for (const f of result.unserved) console.log(`    ${f}`);
        } else if (result.unserved.length) console.log(`  still at risk        ${result.unserved.length} files (--json lists them)`);
        if (!reviews) return;
        console.log(`\n${reviews} review${reviews === 1 ? "" : "s"} for ${result.assignments.length} reviewer${result.assignments.length === 1 ? "" : "s"} (the minimum that achieves the projection):`);
        for (const a of result.assignments) {
          console.log(`  ${a.reviewer}`);
          for (const f of a.files) console.log(`    ${f}`);
        }
      });
    },
  );
program
  .command("backtest")
  .description("measured hit-rate@1/@3 of review() on held-out PRs vs two baselines (spec §6)")
  .argument("<repoPath>", "local clone to parse git history from")
  .option("--holdout <n>", "most recent non-bot-authored merged PRs to predict for", String(DEFAULT_HOLDOUT))
  .option("--pr-limit <n>", "merged PRs to fetch (creation order != merge order, so over-fetch)", String(DEFAULT_PR_LIMIT))
  .option("--since <when>", "git --since value", "2 years ago")
  .option("--seed <n>", "seed for the random baseline, so the number is reproducible", String(DEFAULT_SEED))
  .option("--json", "print the full result as JSON")
  .action(async (repoPath: string, opts: { holdout: string; prLimit: string; since: string; seed: string; json?: boolean }) => {
    const repo: string | undefined = program.opts().repo;
    if (!repo) throw new Error("backtest requires --repo owner/name (identity resolution + PR fetch, spec §12 D15)");
    const db = await connect();
    try {
      const result = await backtest(
        db,
        repo,
        {
          holdout: checkCount(opts.holdout, "--holdout"),
          prLimit: checkCount(opts.prLimit, "--pr-limit"),
          seed: Number(opts.seed),
          log: (m) => console.error(`[backtest] ${m}`),
        },
        {
          fetch: (r, limit) => fetchMergedPRs(r, limit, { log: (m) => console.error(`[prs] ${m}`) }),
          ingest: async (graph, until, prs) => {
            // asOf === until: doa recency is measured from the cutoff, not from today.
            const { model, alive } = await parseRepo(resolve(repoPath), { since: opts.since, asOf: until, until, noExclude: [] });
            await loadRepo(graph, buildLoadPlan(model, alive, prs), { log: (m) => console.error(`[backtest] ${m}`) });
          },
        },
      );
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const { baselines: b } = result;
      console.log(`\n${graphName(repo)}  backtest: ${result.heldOut} held-out PRs, ${result.scored} with a human reviewer, history cut at ${result.cutoff}`);
      console.log("                        hit@1  hit@3");
      console.log(`  review                 ${pct(result.hitRateAt1)}   ${pct(result.hitRateAt3)}`);
      console.log(`  most-active baseline   ${pct(b.mostActive.hit1)}   ${pct(b.mostActive.hit3)}`);
      console.log(`  random baseline        ${pct(b.random.hit1)}   ${pct(b.random.hit3)}`);
      const beatsActive = result.hitRateAt3 > b.mostActive.hit3;
      console.log(
        `\nMEASURED on ${result.scored} held-out PRs, not a projection. review ${beatsActive ? "beats" : "does NOT beat"} the trivial most-active baseline at k=3.`,
      );
    } finally {
      await db.close();
    }
  });

try {
  await program.parseAsync();
} catch (err) {
  // A message, not a stack trace; DEBUG=1 for the stack.
  console.error(`error: ${err instanceof Error ? (process.env.DEBUG ? err.stack : err.message) : String(err)}`);
  process.exitCode = 1;
}
