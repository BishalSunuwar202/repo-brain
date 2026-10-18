// Runs the real `git log` against a throwaway repo, so the fixture strings in
// gitlog.test.ts are checked against what git actually prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoModelBuilder, headFiles, streamGitLog, type Commit } from "../src/ingest/gitlog.ts";

const gitIn = (cwd: string) => (...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "Ann Lee", GIT_AUTHOR_EMAIL: "ann@x.io", GIT_COMMITTER_NAME: "Ann Lee", GIT_COMMITTER_EMAIL: "ann@x.io" },
  });

const drain = async (path: string) => {
  const out: Commit[] = [];
  for await (const c of streamGitLog(path)) out.push(c);
  return out;
};

// The trap: `.cache/repos/fastify` is the empty dir the clone went INTO, so the repo
// is `.cache/repos/fastify/fastify`. Given the outer dir, git walks up to the
// enclosing repo (ours) and would report its history as fastify's.
test("streamGitLog and headFiles refuse a path that is not its own git root", async () => {
  const outer = mkdtempSync(join(tmpdir(), "repo-brain-root-"));
  try {
    gitIn(outer)("init", "-q", "-b", "main");
    writeFileSync(join(outer, "outer.ts"), "x\n");
    gitIn(outer)("add", "-A");
    gitIn(outer)("commit", "-q", "-m", "outer");

    const wrapper = join(outer, "repos", "fastify");
    const inner = join(wrapper, "fastify");
    mkdirSync(inner, { recursive: true });
    gitIn(inner)("init", "-q", "-b", "main");
    writeFileSync(join(inner, "inner.ts"), "y\n");
    gitIn(inner)("add", "-A");
    gitIn(inner)("commit", "-q", "-m", "inner");

    await assert.rejects(drain(wrapper), (err: Error) => {
      assert.match(err.message, /not the root of a git repository/);
      assert.ok(err.message.includes(wrapper), "names the path given");
      assert.ok(err.message.includes(realpathSync(outer)), "names the repo git resolved to");
      assert.ok(err.message.includes(join(wrapper, "fastify")), "suggests the nested clone");
      return true;
    });
    assert.throws(() => headFiles(wrapper), /not the root of a git repository/);
    await assert.rejects(drain(join(outer, "repos")), /not the root of a git repository/);

    const commits = await drain(inner);
    assert.deepEqual(commits.map((c) => c.files.map((f) => f.path)), [["inner.ts"]]);
    assert.deepEqual([...headFiles(inner)], ["inner.ts"]);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test("streamGitLog refuses a directory outside any git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-brain-nogit-"));
  try {
    await assert.rejects(drain(dir), /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streamGitLog parses real git output: renames, binary, spaces, empty commits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-brain-gitlog-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_NAME: "Ann Lee", GIT_AUTHOR_EMAIL: "ann@x.io", GIT_COMMITTER_NAME: "Ann Lee", GIT_COMMITTER_EMAIL: "ann@x.io" },
      });
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, "src/utils"), { recursive: true });
    writeFileSync(join(dir, "src/utils/date.ts"), "export const a = 1;\n".repeat(20));
    writeFileSync(join(dir, "My Notes.md"), "hello\n");
    writeFileSync(join(dir, "logo.png"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    mkdirSync(join(dir, "src/lib"));
    git("mv", "src/utils/date.ts", "src/lib/date.ts");
    git("commit", "-q", "-m", "move");
    git("commit", "-q", "--allow-empty", "-m", "empty");

    const commits: Commit[] = [];
    for await (const c of streamGitLog(dir)) commits.push(c);

    assert.equal(commits.length, 3);
    const [empty, move, init] = commits;
    assert.equal(empty.files.length, 0);
    assert.deepEqual(move.files, [{ oldPath: "src/utils/date.ts", path: "src/lib/date.ts", adds: 0, dels: 0, binary: false }]);
    assert.deepEqual(init.files.find((f) => f.path === "logo.png"), { path: "logo.png", adds: 0, dels: 0, binary: true });
    assert.ok(init.files.some((f) => f.path === "My Notes.md"));
    assert.deepEqual([...init.created].sort(), ["My Notes.md", "logo.png", "src/utils/date.ts"]);
    assert.equal(init.authorName, "Ann Lee");

    const b = new RepoModelBuilder();
    for (const c of commits) b.add(c);
    const model = b.finish();
    const date = model.touched.find((t) => t.path === "src/lib/date.ts")!;
    assert.equal(date.isCreator, true, "creation credited through the rename");
    assert.equal(date.commits, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
