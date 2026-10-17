// Git history -> Layer A facts (spec §2, §4). Pure and deterministic: no database.
//
// Pipeline: `git log` text -> GitLogParser (line state machine) -> Commit records
//           -> RepoModelBuilder (renames, TOUCHED + doa, CO_CHANGED) -> RepoModel

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { botReason, type BotReason } from "./bots.ts";
import { fallbackLogin } from "./identity.ts";
import { isCoChangeExcluded, type PathPredicate } from "./paths.ts";

export interface FileChange {
  path: string;
  /** Set when git reported a rename in this commit. */
  oldPath?: string;
  adds: number;
  dels: number;
  /** numstat prints `-` for both counts on binary files; adds/dels are then 0. */
  binary: boolean;
}

export interface Commit {
  sha: string;
  ts: string; // strict ISO 8601, author date
  authorEmail: string;
  authorName: string;
  files: FileChange[];
  /** Paths git reported as newly created in this commit (from --summary). */
  created: string[];
}

const HEADER = "__C__";

// `--summary` is not in the spec's command: it adds `create mode` lines, the only
// way to know who created a file. Without it, isCreator would credit whoever
// touched a file first inside the --since window.
// `until` cuts history at a cutoff. The backtest needs it: without it the
// held-out PRs' own commits are in the graph, so review() scores an author on the
// very change it is predicting a reviewer for, and the hit-rate is meaningless.
export function gitLogArgs(since = "2 years ago", until?: string): string[] {
  const args = [
    "-c",
    "core.quotePath=false",
    "log",
    "--no-merges",
    "--numstat",
    "--summary",
    "--date=iso",
    `--pretty=format:${HEADER}%H|%aI|%aE|%aN`,
    `--since=${since}`,
  ];
  if (until) args.push(`--until=${until}`);
  return args;
}

// ---------------------------------------------------------------------------
// Path decoding

/** Undo git's C-style quoting: "a\"b\\c\303\251" -> a"b\cé */
export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
      bytes.push(simple[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function tidy(p: string): string {
  return p.replace(/\/{2,}/g, "/").replace(/^\//, "").replace(/\/$/, "");
}

/**
 * Decode a numstat path field. Handles the two rename forms git emits:
 *   old.ts => new.ts
 *   src/{old => new}/file.ts   (either side of the braces may be empty)
 */
export function parseNumstatPath(raw: string): { path: string; oldPath?: string } {
  const field = unquotePath(raw);
  const brace = field.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, pre, from, to, post] = brace;
    return { oldPath: tidy(pre + from + post), path: tidy(pre + to + post) };
  }
  const arrow = field.indexOf(" => ");
  if (arrow !== -1) {
    return { oldPath: unquotePath(field.slice(0, arrow)), path: unquotePath(field.slice(arrow + 4)) };
  }
  return { path: field };
}

// ---------------------------------------------------------------------------
// Line parser

const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;
const CREATE = /^ create mode \d+ (.+)$/;

/** Feed lines in order; completed commits come back from push() and end(). */
export class GitLogParser {
  private current: Commit | null = null;

  push(line: string): Commit | null {
    if (line.startsWith(HEADER)) {
      const done = this.current;
      const [sha, ts, authorEmail, ...name] = line.slice(HEADER.length).split("|");
      this.current = { sha, ts, authorEmail, authorName: name.join("|"), files: [], created: [] };
      return done;
    }
    if (!this.current || line === "") return null;

    const stat = line.match(NUMSTAT);
    if (stat) {
      const binary = stat[1] === "-";
      this.current.files.push({
        ...parseNumstatPath(stat[3]),
        adds: binary ? 0 : Number(stat[1]),
        dels: binary ? 0 : Number(stat[2]),
        binary,
      });
      return null;
    }
    const created = line.match(CREATE);
    if (created) this.current.created.push(unquotePath(created[1]));
    // Other --summary lines (delete mode, mode change, rename) are ignored:
    // renames are already captured from numstat.
    return null;
  }

  end(): Commit | null {
    const done = this.current;
    this.current = null;
    return done;
  }
}

export function parseGitLog(text: string): Commit[] {
  const parser = new GitLogParser();
  const out: Commit[] = [];
  for (const line of text.split("\n")) {
    const c = parser.push(line);
    if (c) out.push(c);
  }
  const last = parser.end();
  if (last) out.push(last);
  return out;
}

/** Streams commits newest-first from `git log` without buffering the whole output. */
export async function* streamGitLog(repoPath: string, since?: string, until?: string): AsyncGenerator<Commit> {
  const git = spawn("git", gitLogArgs(since, until), { cwd: repoPath, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  git.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number>((resolve) => git.on("close", (code) => resolve(code ?? 1)));

  const parser = new GitLogParser();
  for await (const line of createInterface({ input: git.stdout, crlfDelay: Infinity })) {
    const c = parser.push(line);
    if (c) yield c;
  }
  const last = parser.end();
  if (last) yield last;

  const code = await exited;
  if (code !== 0) throw new Error(`git log failed (${code}): ${stderr.trim()}`);
}

/** Paths present at HEAD; File.alive is membership in this set. */
export function headFiles(repoPath: string): Set<string> {
  const out = execFileSync("git", ["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  return new Set(out.split("\n").filter(Boolean).map(unquotePath));
}

// ---------------------------------------------------------------------------
// Aggregation
//
// Identity: every non-bot commit is attributed to a login via `identify`
// (identity.ts; spec §12 D3). People and TOUCHED rows are keyed by login.
//
// CO_CHANGED evidence excludes (spec §12 D4, D5):
//   - commits by bots (mechanical changes)
//   - commits touching > 50 files, counted BEFORE path exclusion (a build commit
//     with 40 sources + 100 dist files is still bulk)
//   - excluded paths (lockfiles, generated output; paths.ts)
//
// Bulk commits are a structural event, not an authorship event (spec §14 R5): they
// still produce TOUCHED rows (facts, counted in bulkCommits) and still resolve
// renames, but set no isCreator and add nothing to doa. A person whose only touches
// on a file are bulk gets doa 0; a file touched only by bulk commits has doa 0 for
// everyone and is never reported by risk.

export const BULK_COMMIT_FILES = 50; // commits touching more files: no co-change, no doa
export const MIN_PAIR_WEIGHT = 3;
const RECENCY_DAYS = 180;
const DAY_MS = 24 * 3600 * 1000;

export interface PersonRecord {
  login: string;
  name: string;
  /** Every git author email that resolved to this login, lowercased. */
  emails: string[];
  firstSeen: string;
  lastSeen: string;
  commits: number;
}

export interface TouchedRecord {
  login: string;
  path: string;
  /** Authorship commits only — bulk commits excluded (spec §14 R5). */
  commits: number;
  /** Bulk commits (> BULK_COMMIT_FILES files) that touched the file. Audit only. */
  bulkCommits: number;
  adds: number;
  dels: number;
  /** Last authorship touch; last bulk touch only when there is no authorship touch. */
  lastTs: string;
  isCreator: boolean;
  /** Raw score before normalisation, kept for debugging. */
  doaRaw: number;
  /** Normalised per file: shares across all people on a file sum to 1. */
  doa: number;
}

export interface CoChangeRecord {
  /** Canonical order a < b; written as ONE edge and matched undirected (spec §12 D6). */
  a: string;
  b: string;
  weight: number;
  support: number;
}

export interface RepoModel {
  commits: { sha: string; ts: string; author: string | null; fileCount: number }[];
  people: PersonRecord[];
  /** Every path touched in the window, after rename resolution. */
  files: string[];
  touched: TouchedRecord[];
  coChanged: CoChangeRecord[];
  /** Every author classified as a bot, with why. Printed for audit (spec §12 D13). */
  bots: BotRecord[];
  stats: {
    commitsParsed: number;
    botCommits: number;
    bulkCommitsDropped: number;
    excludedPathTouches: number;
    pairsBeforeFilter: number;
  };
}

export interface BotRecord {
  login: string;
  reason: BotReason;
  /** "name <email>" as seen in git, for eyeballing misclassifications. */
  seenAs: string;
  commits: number;
}

export interface BuilderOptions {
  /** commit -> Person.login; default is the email-local-part fallback. */
  identify?: (c: Commit) => string;
  /** paths that are not co-change evidence; default is CO_CHANGE_EXCLUDE. */
  exclude?: PathPredicate;
}

interface TouchAcc {
  commits: number;
  bulkCommits: number;
  adds: number;
  dels: number;
  lastMs: number;
  lastBulkMs: number;
  isCreator: boolean;
}

/**
 * Consumes commits NEWEST FIRST (git log's order) — rename resolution depends on it:
 * a rename `old => new` is seen before the older commits that touched `old`, so
 * those older commits are credited to the file's current path.
 */
export class RepoModelBuilder {
  private alias = new Map<string, string>();
  private commits: RepoModel["commits"] = [];
  private people = new Map<string, PersonRecord & { emailSet: Set<string> }>();
  private touches = new Map<string, Map<string, TouchAcc>>(); // path -> login -> acc
  private coTouches = new Map<string, number>(); // path -> commits in the co-change set
  private pairs = new Map<string, number>(); // "a\0b" -> weight
  private stats = { commitsParsed: 0, botCommits: 0, bulkCommitsDropped: 0, excludedPathTouches: 0, pairsBeforeFilter: 0 };

  private bots = new Map<string, BotRecord>();
  private identify: (c: Commit) => string;
  private exclude: PathPredicate;

  constructor(opts: BuilderOptions = {}) {
    this.identify = opts.identify ?? ((c) => fallbackLogin(c.authorEmail));
    this.exclude = opts.exclude ?? isCoChangeExcluded;
  }

  private resolve(path: string): string {
    return this.alias.get(path) ?? path;
  }

  add(c: Commit): void {
    this.stats.commitsParsed++;
    for (const f of c.files) {
      if (f.oldPath && f.oldPath !== f.path) this.alias.set(f.oldPath, this.resolve(f.path));
    }

    const changes = new Map<string, { adds: number; dels: number }>();
    for (const f of c.files) {
      const p = this.resolve(f.path);
      const prev = changes.get(p) ?? { adds: 0, dels: 0 };
      changes.set(p, { adds: prev.adds + f.adds, dels: prev.dels + f.dels });
    }
    const created = new Set(c.created.map((p) => this.resolve(p)));
    const email = c.authorEmail.toLowerCase();

    // Resolve first so the bot check also sees the GitHub login (catches machine
    // User accounts whose git name/email look human, e.g. eslintbot).
    // Bots: no Person, no TOUCHED, no co-change evidence.
    const login = this.identify(c);
    const reason = botReason({ name: c.authorName, email, login });
    if (reason) {
      this.stats.botCommits++;
      this.commits.push({ sha: c.sha, ts: c.ts, author: null, fileCount: changes.size });
      const bot = this.bots.get(login) ?? { login, reason, seenAs: `${c.authorName} <${email}>`, commits: 0 };
      bot.commits++;
      this.bots.set(login, bot);
      return;
    }

    this.commits.push({ sha: c.sha, ts: c.ts, author: login, fileCount: changes.size });
    const ms = Date.parse(c.ts);
    const person = this.people.get(login);
    if (!person) {
      this.people.set(login, {
        login,
        name: c.authorName,
        emails: [],
        emailSet: new Set([email]),
        firstSeen: c.ts,
        lastSeen: c.ts,
        commits: 1,
      });
    } else {
      person.commits++;
      person.emailSet.add(email);
      if (ms < Date.parse(person.firstSeen)) person.firstSeen = c.ts;
      if (ms > Date.parse(person.lastSeen)) {
        person.lastSeen = c.ts;
        person.name = c.authorName;
      }
    }
    const bulk = changes.size > BULK_COMMIT_FILES;
    for (const [path, delta] of changes) {
      let byPerson = this.touches.get(path);
      if (!byPerson) this.touches.set(path, (byPerson = new Map()));
      const acc = byPerson.get(login) ?? { commits: 0, bulkCommits: 0, adds: 0, dels: 0, lastMs: 0, lastBulkMs: 0, isCreator: false };
      acc.adds += delta.adds;
      acc.dels += delta.dels;
      if (bulk) {
        acc.bulkCommits++;
        acc.lastBulkMs = Math.max(acc.lastBulkMs, ms);
      } else {
        acc.commits++;
        acc.lastMs = Math.max(acc.lastMs, ms);
        acc.isCreator ||= created.has(path);
      }
      byPerson.set(login, acc);
    }

    if (bulk) {
      this.stats.bulkCommitsDropped++;
      return;
    }
    const paths = [...changes.keys()].filter((p) => !this.exclude(p)).sort();
    this.stats.excludedPathTouches += changes.size - paths.length;
    for (const p of paths) this.coTouches.set(p, (this.coTouches.get(p) ?? 0) + 1);
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = paths[i] + "\0" + paths[j];
        this.pairs.set(key, (this.pairs.get(key) ?? 0) + 1);
      }
    }
  }

  /** @param asOf reference time for recency; pass the holdout cutoff when backtesting. */
  finish(asOf: Date = new Date()): RepoModel {
    const now = asOf.getTime();
    const touched: TouchedRecord[] = [];
    for (const [path, byPerson] of this.touches) {
      const rows = [...byPerson].map(([login, { lastMs, lastBulkMs, ...t }]) => {
        const days = Math.max(0, (now - lastMs) / DAY_MS);
        // No authorship commits => no doa at all, not even the recency term.
        const doaRaw =
          t.commits === 0 ? 0 : 1.0 * (t.isCreator ? 1 : 0) + 0.5 * Math.log(1 + t.commits) + 0.2 * Math.exp(-days / RECENCY_DAYS);
        const lastTs = new Date(t.commits ? lastMs : lastBulkMs).toISOString();
        return { login, path, ...t, lastTs, doaRaw, doa: 0 };
      });
      // Bulk-only file: total is 0, every doa stays 0 (no 0/0).
      const total = rows.reduce((s, r) => s + r.doaRaw, 0);
      for (const r of rows) touched.push({ ...r, doa: total > 0 ? r.doaRaw / total : 0 });
    }

    const coChanged: CoChangeRecord[] = [];
    for (const [key, weight] of this.pairs) {
      if (weight < MIN_PAIR_WEIGHT) continue;
      const [a, b] = key.split("\0");
      const denom = Math.min(this.coTouches.get(a)!, this.coTouches.get(b)!);
      coChanged.push({ a, b, weight, support: weight / denom });
    }

    const people = [...this.people.values()].map(({ emailSet, ...p }) => ({ ...p, emails: [...emailSet].sort() }));
    return {
      commits: this.commits,
      people,
      files: [...this.touches.keys()].sort(),
      touched,
      coChanged,
      bots: [...this.bots.values()].sort((x, y) => y.commits - x.commits),
      stats: { ...this.stats, pairsBeforeFilter: this.pairs.size },
    };
  }
}

export function buildRepoModel(commits: Iterable<Commit>, asOf?: Date, opts?: BuilderOptions): RepoModel {
  const b = new RepoModelBuilder(opts);
  for (const c of commits) b.add(c);
  return b.finish(asOf);
}
