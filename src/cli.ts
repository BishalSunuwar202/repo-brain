// Entry point: npm run brain -- <command> [opts]

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { connect, graphName, openRepoGraph } from "./db/client.ts";
import { RepoModelBuilder, headFiles, streamGitLog, type RepoModel } from "./ingest/gitlog.ts";
import { fetchIdentityMap, makeResolver, sinceToDate, type Resolver } from "./ingest/identity.ts";
import { buildLoadPlan, loadRepo } from "./ingest/load.ts";
import { excludePatterns, makeExcluder } from "./ingest/paths.ts";
import { impact } from "./tools/impact.ts";
import { risk } from "./tools/risk.ts";
import type { Graph } from "falkordb";

const program = new Command()
  .name("brain")
  .description("Repo Brain: git history -> FalkorDB expertise graph -> who should review what")
  .option("--repo <owner/name>", "GitHub repo: resolves authors to GitHub logins and selects the graph repo:<owner>-<name>");

const collect = (value: string, previous: string[]) => [...previous, value];

interface ParseOpts {
  since: string;
  asOf?: string;
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
  for await (const c of streamGitLog(repoPath, opts.since)) builder.add(c);
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
  .action(async (repoPath: string, opts: CliParseOpts & { fresh?: boolean }) => {
    const repo: string | undefined = program.opts().repo;
    if (!repo) throw new Error("ingest requires --repo owner/name (graph naming + identity resolution, spec §12 D15)");
    const { model, alive, identify } = await parseRepo(resolve(repoPath), { ...opts, noExclude: opts.exclude });
    console.error(
      `parsed: ${model.people.length} people, ${model.files.length} files, ${model.coChanged.length} pairs; identity ${JSON.stringify(identify.counts)}`,
    );
    // PRs are not fetched yet (github.ts is a stub); the git layer loads on its own.
    const plan = buildLoadPlan(model, alive);
    const db = await connect();
    try {
      const graph = await openRepoGraph(db, repo);
      await loadRepo(graph, plan, { fresh: opts.fresh, log: (m) => console.error(`[${graphName(repo)}] ${m}`) });
    } finally {
      await db.close();
    }
  });

async function withGraph<T>(fn: (graph: Graph, repo: string) => Promise<T>): Promise<T> {
  const repo: string | undefined = program.opts().repo;
  if (!repo) throw new Error("this command needs --repo owner/name to pick the graph");
  const db = await connect();
  try {
    return await fn(await openRepoGraph(db, repo), repo);
  } finally {
    await db.close();
  }
}

const pct = (x: number) => `${(100 * x).toFixed(0)}%`.padStart(4);

const notYet = (name: string) => () => {
  console.error(`${name}: not implemented yet`);
  process.exitCode = 1;
};

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
  .description("bus-factor-1 files (lockfiles/generated paths never reported, spec §12 D14)")
  .option("--module <module>")
  .option("--no-exclude <glob>", "keep a pattern from the exclusion list (repeatable)", collect, [])
  .option("--as-of <iso>", "reference time for the 180-day window (default: now)")
  .option("--limit <n>", "rows to show", "25")
  .option("--json", "print all rows as JSON")
  .action(async (opts: { module?: string; exclude: string[]; asOf?: string; limit: string; json?: boolean }) => {
    await withGraph(async (graph) => {
      const rows = await risk(graph, {
        module: opts.module,
        asOf: opts.asOf ? new Date(opts.asOf) : undefined,
        exclude: makeExcluder(excludePatterns(opts.exclude)),
      });
      if (opts.json) return console.log(JSON.stringify(rows, null, 2));
      const scope = opts.module ? ` in ${opts.module}` : "";
      console.log(`${rows.length} bus-factor-1 file${rows.length === 1 ? "" : "s"}${scope}: one person holds >80% and no one else touched it in 180 days`);
      for (const r of rows.slice(0, Number(opts.limit))) console.log(`  ${pct(r.share)}  ${r.soleHolder.padEnd(20)}  ${r.path}`);
      if (rows.length > Number(opts.limit)) console.log(`  … ${rows.length - Number(opts.limit)} more (--limit, --json)`);
    });
  });
program.command("review").description("suggest reviewers for a PR").argument("<prNumber>").action(notYet("review"));
program
  .command("fix")
  .description("minimal review assignments that de-risk knowledge concentration")
  .option("--module <module>")
  .option("--budget <n>", "k_r: extra reviews each reviewer can take (spec §12 D7)", "2")
  .option("--no-exclude <glob>", "keep a pattern from the exclusion list (repeatable)", collect, [])
  .action(notYet("fix"));
program.command("backtest").description("hit-rate@1/@3 of review() on held-out PRs vs baselines").action(notYet("backtest"));

await program.parseAsync();
