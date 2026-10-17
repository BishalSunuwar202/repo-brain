import { test } from "node:test";
import assert from "node:assert/strict";
import { botReason, isBot } from "../src/ingest/bots.ts";
import { CO_CHANGE_EXCLUDE, excludePatterns, fileKind, isCoChangeExcluded, isTestPath, makeExcluder, moduleOf } from "../src/ingest/paths.ts";
import { fallbackLogin, identityFromHistory, makeResolver, sinceToDate } from "../src/ingest/identity.ts";
import type { Commit } from "../src/ingest/gitlog.ts";

test("isBot: git authors, PR authors and reviewers", () => {
  const bots = [
    { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" },
    { name: "renovate-bot", email: "bot@renovateapp.com" },
    { name: "github-actions", email: "41898282+github-actions[bot]@users.noreply.github.com" },
    { name: "Copilot", email: "198982749+Copilot@users.noreply.github.com" },
    { login: "copilot-pull-request-reviewer", typename: "Bot" },
    { login: "coderabbitai" },
    { login: "k8s-ci-robot" },
    { login: "netlify-bot" },
    { login: "eslintbot", typename: "User" }, // machine user account, not a GitHub App
  ];
  for (const b of bots) assert.equal(isBot(b), true, JSON.stringify(b));
  const humans = [
    { name: "Alice Talbot", email: "alice@x.io" },
    { login: "mcollina", typename: "User" },
    { name: "Renée Abbot", email: "renee@x.io" },
  ];
  for (const h of humans) assert.equal(isBot(h), false, JSON.stringify(h));
});

test("exclusion list = spec §12 D4 + D14 additions (bun.lockb, *.snap) + §14 D20 (*_lock.toml)", () => {
  assert.deepEqual([...CO_CHANGE_EXCLUDE].sort(), [
    "*-lock.yaml", "*-lock.json", "*.lock", "yarn.lock", "bun.lockb", "go.sum", "Cargo.lock", "*.snap",
    "migration_lock.toml", "*_lock.toml",
    "__snapshots__/**", "dist/**", "build/**", "vendor/**", "*.min.*", "*.generated.*",
  ].sort());
});

test("D20: prisma migration_lock.toml is excluded, ordinary toml is not", () => {
  assert.equal(isCoChangeExcluded("apps/api/prisma/migrations/migration_lock.toml"), true);
  assert.equal(isCoChangeExcluded("poetry_lock.toml"), true);
  assert.equal(isCoChangeExcluded("Cargo.toml"), false);
  assert.equal(isCoChangeExcluded("pyproject.toml"), false);
  assert.equal(makeExcluder(excludePatterns(["migration_lock.toml", "*_lock.toml"]))("prisma/migration_lock.toml"), false);
});

test("D14: bun.lockb and loose .snap files are excluded", () => {
  assert.equal(isCoChangeExcluded("bun.lockb"), true);
  assert.equal(isCoChangeExcluded("src/components/__tests__/button.test.tsx.snap"), true);
  assert.equal(isCoChangeExcluded("test/output.snap"), true);
  assert.equal(isCoChangeExcluded("src/snapshot.ts"), false);
});

test("D14: --no-exclude removes a pattern; unknown patterns are an error", () => {
  const keepBuild = makeExcluder(excludePatterns(["build/**"]));
  assert.equal(keepBuild("packages/vite/src/build/plugin.ts"), false, "real build/ source dir kept");
  assert.equal(keepBuild("pnpm-lock.yaml"), true, "rest of the list still applies");
  assert.equal(isCoChangeExcluded("packages/vite/src/build/plugin.ts"), true, "default still excludes");
  assert.throws(() => excludePatterns(["biuld/**"]), /not in the exclusion list/);
  assert.deepEqual(excludePatterns(), [...CO_CHANGE_EXCLUDE]);
});

test("D16: isTestPath", () => {
  const tests = [
    "src/a.test.ts", "src/a.spec.tsx", "lib/a_spec.rb", "test/helpers.ts", "packages/x/__tests__/y.js",
    "apps/api/test/integration/check-in.spec.ts", "tests/test_parser.py", "e2e/login.ts", "src/a.tests.ts",
  ];
  for (const p of tests) assert.equal(isTestPath(p), true, p);
  const source = ["src/testing-library.ts", "src/latest.ts", "src/contest/a.ts", "src/specification.ts", "attest.ts"];
  for (const p of source) assert.equal(isTestPath(p), false, p);
});

test("D13: botReason says why, strongest signal first", () => {
  assert.equal(botReason({ login: "copilot-pull-request-reviewer", typename: "Bot" }), "typename");
  assert.equal(botReason({ name: "dependabot[bot]", email: "x@y" }), "[bot]");
  assert.equal(botReason({ login: "renovate" }), "known");
  assert.equal(botReason({ login: "eslintbot", typename: "User" }), "login-suffix");
  assert.equal(botReason({ login: "talbot" }), "login-suffix", "known false positive — visible in the audit");
  assert.equal(botReason({ login: "mcollina", typename: "User" }), null);
});

test("isCoChangeExcluded: basename globs anywhere, directory globs at any depth", () => {
  const excluded = [
    "pnpm-lock.yaml", "apps/web/pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Gemfile.lock",
    "Cargo.lock", "go.sum", "src/__snapshots__/a.test.ts.snap", "dist/index.js", "packages/x/dist/a.d.ts",
    "build/out.js", "vendor/github.com/x/y.go", "public/jquery.min.js", "api/schema.generated.ts",
  ];
  for (const p of excluded) assert.equal(isCoChangeExcluded(p), true, p);
  const kept = [
    "package.json", "src/lock.ts", "src/locks/mutex.ts", "src/distance.ts", "docs/dist-notes.md",
    "src/builder.ts", "go.mod", "src/minify.ts", "generated.ts",
  ];
  for (const p of kept) assert.equal(isCoChangeExcluded(p), false, p);
});

test("moduleOf: first two directory segments", () => {
  assert.equal(moduleOf("src/tools/fix.ts"), "src/tools");
  assert.equal(moduleOf("packages/core/src/deep/x.ts"), "packages/core");
  assert.equal(moduleOf("src/cli.ts"), "src");
  assert.equal(moduleOf("README.md"), ".");
});

test("fallbackLogin normalises email local-part and strips GitHub noreply id", () => {
  assert.equal(fallbackLogin("10000001+BishalSunuwar202@users.noreply.github.com"), "bishalsunuwar202");
  assert.equal(fallbackLogin("Alice.Smith@Corp.io"), "alice.smith");
  assert.equal(fallbackLogin("dev@localhost"), "dev");
});

const c = (sha: string, email: string): Commit => ({ sha, ts: "2026-01-01T00:00:00Z", authorEmail: email, authorName: "x", files: [], created: [] });

test("resolver precedence: sha, then email, then fallback; logins lowercased", () => {
  const map = identityFromHistory([
    { oid: "s1", author: { email: "Personal@Gmail.com", user: { login: "Alice" } } },
    { oid: "s2", author: { email: "ghost@x.io", user: null } },
  ]);
  assert.deepEqual([...map.byEmail], [["personal@gmail.com", "Alice"]]);
  const r = makeResolver(map);
  assert.equal(r(c("s1", "whatever@x.io")), "alice");
  assert.equal(r(c("other", "personal@gmail.com")), "alice");
  assert.equal(r(c("s2", "ghost@x.io")), "ghost");
  assert.deepEqual(r.counts, { sha: 1, email: 1, fallback: 1 });
});

test("sinceToDate handles git's relative form and ISO dates", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  assert.equal(sinceToDate("2 years ago", now).toISOString(), "2024-10-15T12:00:00.000Z");
  assert.equal(sinceToDate("6 months ago", now).toISOString(), "2026-04-15T12:00:00.000Z");
  assert.equal(sinceToDate("2025-01-01", now).toISOString(), "2025-01-01T00:00:00.000Z");
  assert.throws(() => sinceToDate("last tuesday", now));
});

test("R2: fileKind — test > ci (dot-path) > docs > types > source", () => {
  const cases: Record<string, string> = {
    "test/types/instance.test-d.ts": "test",
    "lib/route.test.js": "test",
    ".github/workflows/ci.yml": "ci",
    ".gitignore": "ci",
    ".github/CONTRIBUTING.md": "ci",
    "docs/Reference/Server.md": "docs",
    "docs/images/logo.png": "docs",
    "README.md": "docs",
    "types/instance.d.ts": "types",
    "lib/route.js": "source",
    "fastify.js": "source",
    "package.json": "source",
  };
  for (const [path, kind] of Object.entries(cases)) assert.equal(fileKind(path), kind, path);
});
