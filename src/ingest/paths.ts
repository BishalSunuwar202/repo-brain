// Path rules: what counts as co-change evidence and what risk may report
// (spec §12 D4, D14), test files for impact (D16), and File.module (D12).

/**
 * Lockfiles and generated output. Excluded from CO_CHANGED and from `risk` output;
 * they still get TOUCHED rows (those are facts). Override per run with --no-exclude.
 * Matching: a pattern ending in `/**` matches that directory at ANY depth
 * (`dist/**` hits `packages/x/dist/a.js`); any other pattern matches the basename.
 */
export const CO_CHANGE_EXCLUDE: readonly string[] = [
  "*-lock.yaml",
  "*-lock.json",
  "*.lock",
  "yarn.lock",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  // D20: prisma/migrations/migration_lock.toml slipped past `*.lock`.
  "migration_lock.toml",
  "*_lock.toml",
  "*.snap",
  "__snapshots__/**",
  "dist/**",
  "build/**",
  "vendor/**",
  "*.min.*",
  "*.generated.*",
];

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

export type PathPredicate = (path: string) => boolean;

export function makeExcluder(patterns: readonly string[]): PathPredicate {
  const dirs = patterns.filter((g) => g.endsWith("/**")).map((g) => g.slice(0, -3));
  const names = patterns.filter((g) => !g.endsWith("/**")).map(globToRegExp);
  return (path) => {
    const segments = path.split("/");
    const basename = segments.pop()!;
    return segments.some((s) => dirs.includes(s)) || names.some((re) => re.test(basename));
  };
}

/** The default list minus anything passed via --no-exclude. Unknown patterns are an error, not a silent no-op. */
export function excludePatterns(noExclude: readonly string[] = []): string[] {
  const unknown = noExclude.filter((g) => !CO_CHANGE_EXCLUDE.includes(g));
  if (unknown.length) throw new Error(`--no-exclude: not in the exclusion list: ${unknown.join(", ")}`);
  return CO_CHANGE_EXCLUDE.filter((g) => !noExclude.includes(g));
}

export const isCoChangeExcluded: PathPredicate = makeExcluder(CO_CHANGE_EXCLUDE);

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);

/** foo.test.ts, foo_spec.rb, foo.spec.tsx, test/x.ts, src/__tests__/y.js */
export const isTestPath: PathPredicate = (path) => {
  const segments = path.split("/");
  const basename = segments.pop()!;
  return segments.some((s) => TEST_DIRS.has(s)) || /[._-](test|spec)s?\.[^/]+$/i.test(basename) || /^test_.+\.py$/.test(basename);
};

/** File.module = first two DIRECTORY segments: src/tools/fix.ts -> src/tools, src/cli.ts -> src, README.md -> "." */
export function moduleOf(path: string): string {
  const dirs = path.split("/").slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join("/") : ".";
}
