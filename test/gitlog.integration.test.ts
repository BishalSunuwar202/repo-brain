// Runs the real `git log` against a throwaway repo, so the fixture strings in
// gitlog.test.ts are checked against what git actually prints.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoModelBuilder, streamGitLog, type Commit } from "../src/ingest/gitlog.ts";

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
