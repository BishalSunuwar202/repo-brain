import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepoModel, parseGitLog, parseNumstatPath, unquotePath, type Commit } from "../src/ingest/gitlog.ts";
import { makeResolver } from "../src/ingest/identity.ts";

// Fixtures mirror real `git log --numstat --summary --pretty=format:__C__...` output.
// Note the tabs between numstat columns.

const BASIC = [
  "__C__aaa111|2026-10-01T10:00:00+05:45|alice@x.io|Alice A",
  "10\t2\tsrc/index.ts",
  "3\t0\tREADME.md",
  " create mode 100644 src/index.ts",
  "",
  "__C__bbb222|2026-09-01T10:00:00Z|bob@x.io|Bob | The Builder",
  "1\t1\tsrc/index.ts",
].join("\n");

test("parses headers and numstat lines", () => {
  const commits = parseGitLog(BASIC);
  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    sha: "aaa111",
    ts: "2026-10-01T10:00:00+05:45",
    authorEmail: "alice@x.io",
    authorName: "Alice A",
    files: [
      { path: "src/index.ts", adds: 10, dels: 2, binary: false },
      { path: "README.md", adds: 3, dels: 0, binary: false },
    ],
    created: ["src/index.ts"],
  });
  assert.equal(commits[1].authorName, "Bob | The Builder", "pipes in names survive");
});

test("binary files: numstat dashes become zero counts with binary flag", () => {
  const [c] = parseGitLog("__C__ccc|2026-01-01T00:00:00Z|a@x|A\n-\t-\tassets/logo.png\n5\t1\tsrc/a.ts");
  assert.deepEqual(c.files[0], { path: "assets/logo.png", adds: 0, dels: 0, binary: true });
  assert.equal(c.files[1].binary, false);
});

test("renames: plain arrow form", () => {
  assert.deepEqual(parseNumstatPath("old name.ts => new name.ts"), { oldPath: "old name.ts", path: "new name.ts" });
});

test("renames: brace forms, including empty sides", () => {
  assert.deepEqual(parseNumstatPath("src/{utils => lib}/date.ts"), { oldPath: "src/utils/date.ts", path: "src/lib/date.ts" });
  assert.deepEqual(parseNumstatPath("src/{ => core}/date.ts"), { oldPath: "src/date.ts", path: "src/core/date.ts" });
  assert.deepEqual(parseNumstatPath("src/{core => }/date.ts"), { oldPath: "src/core/date.ts", path: "src/date.ts" });
  assert.deepEqual(parseNumstatPath("{a => b}/x.ts"), { oldPath: "a/x.ts", path: "b/x.ts" });
  assert.deepEqual(parseNumstatPath("docs/{old.md => new.md}"), { oldPath: "docs/old.md", path: "docs/new.md" });
});

test("renames inside a parsed commit carry oldPath and counts", () => {
  const [c] = parseGitLog("__C__ddd|2026-01-01T00:00:00Z|a@x|A\n4\t1\tsrc/{utils => lib}/date.ts\n0\t0\told.ts => new.ts");
  assert.deepEqual(c.files, [
    { oldPath: "src/utils/date.ts", path: "src/lib/date.ts", adds: 4, dels: 1, binary: false },
    { oldPath: "old.ts", path: "new.ts", adds: 0, dels: 0, binary: false },
  ]);
});

test("binary rename", () => {
  const [c] = parseGitLog("__C__eee|2026-01-01T00:00:00Z|a@x|A\n-\t-\timg/{a.png => b.png}");
  assert.deepEqual(c.files[0], { oldPath: "img/a.png", path: "img/b.png", adds: 0, dels: 0, binary: true });
});

test("paths with spaces and git-quoted paths", () => {
  const [c] = parseGitLog(
    '__C__fff|2026-01-01T00:00:00Z|a@x|A\n1\t0\tdocs/My File.md\n2\t0\t"weird\\"name\\\\x.txt"\n1\t1\t"caf\\303\\251.md"',
  );
  assert.deepEqual(
    c.files.map((f) => f.path),
    ["docs/My File.md", 'weird"name\\x.txt', "café.md"],
  );
  assert.equal(unquotePath("plain.txt"), "plain.txt");
});

test("empty commits (no numstat lines) are kept with zero files", () => {
  const commits = parseGitLog(
    "__C__g1|2026-01-02T00:00:00Z|a@x|A\n__C__g2|2026-01-01T00:00:00Z|a@x|A\n\n__C__g3|2026-01-01T00:00:00Z|a@x|A",
  );
  assert.deepEqual(
    commits.map((c) => [c.sha, c.files.length]),
    [["g1", 0], ["g2", 0], ["g3", 0]],
  );
});

test("empty input", () => {
  assert.deepEqual(parseGitLog(""), []);
});

// ---------------------------------------------------------------------------
// Aggregation

function commit(sha: string, ts: string, email: string, paths: string[], extra: Partial<Commit> = {}): Commit {
  return {
    sha,
    ts,
    authorEmail: email,
    authorName: email.split("@")[0],
    files: paths.map((p) => ({ path: p, adds: 1, dels: 0, binary: false })),
    created: [],
    ...extra,
  };
}

const AS_OF = new Date("2026-10-15T00:00:00Z");

test("rename history: older commits on the old path are credited to the new path", () => {
  // Newest first, as git log emits.
  const model = buildRepoModel(
    [
      commit("c3", "2026-10-01T00:00:00Z", "bob@x", ["src/lib/date.ts"]),
      {
        ...commit("c2", "2026-09-01T00:00:00Z", "bob@x", []),
        files: [{ oldPath: "src/utils/date.ts", path: "src/lib/date.ts", adds: 0, dels: 0, binary: false }],
      },
      commit("c1", "2026-01-01T00:00:00Z", "alice@x", ["src/utils/date.ts"], { created: ["src/utils/date.ts"] }),
    ],
    AS_OF,
  );
  assert.deepEqual(model.files, ["src/lib/date.ts"]);
  const alice = model.touched.find((t) => t.login === "alice")!;
  assert.equal(alice.path, "src/lib/date.ts");
  assert.equal(alice.isCreator, true, "creation follows the rename");
});

test("chained renames resolve to the final path", () => {
  const rename = (sha: string, ts: string, from: string, to: string): Commit => ({
    ...commit(sha, ts, "a@x", []),
    files: [{ oldPath: from, path: to, adds: 0, dels: 0, binary: false }],
  });
  const model = buildRepoModel(
    [
      rename("r2", "2026-03-01T00:00:00Z", "b.ts", "c.ts"),
      rename("r1", "2026-02-01T00:00:00Z", "a.ts", "b.ts"),
      commit("c0", "2026-01-01T00:00:00Z", "a@x", ["a.ts"]),
    ],
    AS_OF,
  );
  assert.deepEqual(model.files, ["c.ts"]);
  assert.equal(model.touched[0].commits, 3);
});

test("doa: creator outweighs a one-off contributor; shares sum to 1 per file", () => {
  const model = buildRepoModel(
    [
      commit("c2", "2026-10-14T00:00:00Z", "bob@x", ["a.ts"]),
      commit("c1", "2025-01-01T00:00:00Z", "alice@x", ["a.ts", "b.ts"], { created: ["a.ts"] }),
    ],
    AS_OF,
  );
  const onA = model.touched.filter((t) => t.path === "a.ts");
  const share = (login: string) => onA.find((t) => t.login === login)!.doa;
  assert.ok(Math.abs(share("alice") + share("bob") - 1) < 1e-9);
  assert.ok(share("alice") > share("bob"));

  // Hand-computed raw scores.
  const daysAlice = (AS_OF.getTime() - Date.parse("2025-01-01T00:00:00Z")) / 86400000;
  const rawAlice = 1 + 0.5 * Math.log(2) + 0.2 * Math.exp(-daysAlice / 180);
  const rawBob = 0.5 * Math.log(2) + 0.2 * Math.exp(-1 / 180);
  assert.ok(Math.abs(onA.find((t) => t.login === "alice")!.doaRaw - rawAlice) < 1e-9);
  assert.ok(Math.abs(share("alice") - rawAlice / (rawAlice + rawBob)) < 1e-9);

  const onB = model.touched.filter((t) => t.path === "b.ts");
  assert.equal(onB.length, 1);
  assert.equal(onB[0].doa, 1);
});

test("co-change: weight counts co-occurrences, support = weight / min(touches), pairs < 3 dropped", () => {
  const commits = [
    commit("c1", "2026-01-05T00:00:00Z", "a@x", ["a.ts", "b.ts"]),
    commit("c2", "2026-01-04T00:00:00Z", "a@x", ["a.ts", "b.ts", "c.ts"]),
    commit("c3", "2026-01-03T00:00:00Z", "a@x", ["a.ts", "b.ts", "c.ts"]),
    commit("c4", "2026-01-02T00:00:00Z", "a@x", ["a.ts"]),
    commit("c5", "2026-01-01T00:00:00Z", "a@x", ["b.ts"]),
  ];
  const model = buildRepoModel(commits, AS_OF);
  // a-b: 3 together; touches a=4, b=4 -> support 0.75. a-c and b-c: weight 2 -> dropped.
  assert.deepEqual(model.coChanged, [{ a: "a.ts", b: "b.ts", weight: 3, support: 0.75 }]);
  assert.equal(model.stats.pairsBeforeFilter, 3);
});

test("co-change: commits touching > 50 files are dropped, but still count for TOUCHED", () => {
  const bulk = Array.from({ length: 51 }, (_, i) => `f${i}.ts`);
  const commits = [1, 2, 3].map((n) => commit(`b${n}`, `2026-01-0${n}T00:00:00Z`, "a@x", bulk));
  const model = buildRepoModel(commits, AS_OF);
  assert.equal(model.coChanged.length, 0);
  assert.equal(model.stats.bulkCommitsDropped, 3);
  assert.equal(model.touched.length, 51);

  const fifty = Array.from({ length: 50 }, (_, i) => `g${i}.ts`);
  const kept = buildRepoModel([1, 2, 3].map((n) => commit(`k${n}`, `2026-01-0${n}T00:00:00Z`, "a@x", fifty)), AS_OF);
  assert.equal(kept.coChanged.length, (50 * 49) / 2, "exactly 50 files is not bulk");
});

test("bots: no Person, no TOUCHED, and no co-change evidence (D5)", () => {
  const bot = (sha: string) => ({ ...commit(sha, "2026-01-01T00:00:00Z", "49699333+dependabot[bot]@users.noreply.github.com", ["src/a.ts", "src/b.ts"]), authorName: "dependabot[bot]" });
  const model = buildRepoModel([bot("1"), bot("2"), bot("3")], AS_OF);
  assert.equal(model.touched.length, 0);
  assert.equal(model.people.length, 0);
  assert.equal(model.stats.botCommits, 3);
  assert.equal(model.coChanged.length, 0);
  assert.deepEqual(model.commits.map((c) => c.author), [null, null, null], "bot commits keep no author");
});

test("fallback identity: case-insensitive email, person keeps most recent name and all emails", () => {
  const model = buildRepoModel(
    [
      { ...commit("c2", "2026-02-01T00:00:00Z", "Alice@X", ["a.ts"]), authorName: "Alice New" },
      { ...commit("c1", "2026-01-01T00:00:00Z", "alice@x", ["a.ts"]), authorName: "alice old" },
    ],
    AS_OF,
  );
  assert.equal(model.people.length, 1);
  assert.equal(model.people[0].login, "alice");
  assert.equal(model.people[0].name, "Alice New");
  assert.deepEqual(model.people[0].emails, ["alice@x"]);
  assert.equal(model.people[0].firstSeen, "2026-01-01T00:00:00Z");
  assert.equal(model.touched[0].commits, 2);
});

test("D3: one human with two emails is ONE person, so a bus-factor-1 file stays bus-factor-1", () => {
  // The bug D3 fixes: noreply + personal email split one author into two holders,
  // so neither crossed the 80% risk threshold and the file looked safe.
  const commits = [
    commit("c3", "2026-09-01T00:00:00Z", "bishal24@gmail.com", ["core.ts"]),
    commit("c2", "2026-08-01T00:00:00Z", "109662399+Bishal@users.noreply.github.com", ["core.ts"]),
    commit("c1", "2026-01-01T00:00:00Z", "109662399+Bishal@users.noreply.github.com", ["core.ts"], { created: ["core.ts"] }),
  ];
  const split = buildRepoModel(commits, AS_OF); // fallback only: two different local parts
  assert.equal(split.people.length, 2);
  assert.ok(split.touched.every((t) => t.doa < 0.8), "split identity hides the risk");

  const identify = makeResolver({ bySha: new Map([["c3", "Bishal"]]), byEmail: new Map() });
  const merged = buildRepoModel(commits, AS_OF, { identify });
  assert.equal(merged.people.length, 1);
  assert.deepEqual(merged.people[0].emails, ["109662399+bishal@users.noreply.github.com", "bishal24@gmail.com"]);
  assert.deepEqual(
    merged.touched.map((t) => [t.login, t.commits, t.isCreator, t.doa]),
    [["bishal", 3, true, 1]],
  );
  assert.deepEqual(identify.counts, { sha: 1, email: 0, fallback: 2 });
});

test("D4: lockfiles and generated paths are not co-change evidence but keep TOUCHED", () => {
  const files = ["src/a.ts", "src/b.ts", "pnpm-lock.yaml", "packages/x/dist/index.js"];
  const model = buildRepoModel([1, 2, 3].map((n) => commit(`c${n}`, `2026-01-0${n}T00:00:00Z`, "a@x", files)), AS_OF);
  assert.deepEqual(model.coChanged, [{ a: "src/a.ts", b: "src/b.ts", weight: 3, support: 1 }]);
  assert.equal(model.stats.excludedPathTouches, 6);
  assert.equal(model.touched.length, 4);
});

test("D6: each pair appears once, canonically ordered a < b", () => {
  const model = buildRepoModel(
    [1, 2, 3].map((n) => commit(`c${n}`, `2026-01-0${n}T00:00:00Z`, "a@x", ["z.ts", "m.ts", "a.ts"])),
    AS_OF,
  );
  assert.equal(model.coChanged.length, 3);
  for (const p of model.coChanged) assert.ok(p.a < p.b);
  assert.equal(new Set(model.coChanged.map((p) => p.a + "|" + p.b)).size, 3);
});

test("D13: bots are recorded with reason; a machine User account is caught via its resolved login", () => {
  const commits = [
    { ...commit("b1", "2026-01-03T00:00:00Z", "49699333+dependabot[bot]@users.noreply.github.com", ["package.json"]), authorName: "dependabot[bot]" },
    { ...commit("b2", "2026-01-02T00:00:00Z", "eslint@googlegroups.com", ["CHANGELOG.md"]), authorName: "ESLint Jenkins" },
    commit("h1", "2026-01-01T00:00:00Z", "nzakas@x.io", ["src/a.ts"]),
  ];
  const identify = makeResolver({ bySha: new Map([["b2", "eslintbot"]]), byEmail: new Map() });
  const model = buildRepoModel(commits, AS_OF, { identify });
  assert.deepEqual(model.people.map((p) => p.login), ["nzakas"]);
  assert.deepEqual(
    model.bots.map((b) => [b.login, b.reason, b.commits]),
    [["dependabot[bot]", "[bot]", 1], ["eslintbot", "login-suffix", 1]].sort(),
  );
  assert.equal(model.bots.find((b) => b.login === "eslintbot")!.seenAs, "ESLint Jenkins <eslint@googlegroups.com>");
});

test("builder exclude option overrides the default list", () => {
  const files = ["src/build/a.ts", "src/build/b.ts"];
  const commits = [1, 2, 3].map((n) => commit(`c${n}`, `2026-01-0${n}T00:00:00Z`, "a@x", files));
  assert.equal(buildRepoModel(commits, AS_OF).coChanged.length, 0, "build/** excluded by default");
  assert.equal(buildRepoModel(commits, AS_OF, { exclude: () => false }).coChanged.length, 1);
});
