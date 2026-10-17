// Rule 10 of the hackathon requires the README to carry "the Cypher queries or graph
// algorithms the product depends on", and rule 12 requires being able to explain them.
// A README query that has drifted from the code is worse than none: it is a confident
// wrong answer about our own system. Writing this README by hand produced four
// plausible-but-wrong queries on the first attempt, which is why this test exists.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { IMPACT_CYPHER } from "../src/tools/impact.ts";
import { REVIEW_CYPHER } from "../src/tools/review.ts";
import { RISK_CYPHER } from "../src/tools/risk.ts";
import { ELIGIBLE_CYPHER } from "../src/tools/fix.ts";
import { DDL } from "../src/schema/ddl.ts";

const README = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");

const QUERIES: [string, string][] = [
  ["RISK_CYPHER", RISK_CYPHER],
  ["IMPACT_CYPHER", IMPACT_CYPHER],
  ["REVIEW_CYPHER", REVIEW_CYPHER],
  ["ELIGIBLE_CYPHER", ELIGIBLE_CYPHER],
];

for (const [name, cypher] of QUERIES) {
  test(`README quotes ${name} exactly as the code sends it`, () => {
    assert.ok(
      README.includes(cypher.trim()),
      `README.md does not contain ${name} verbatim. Copy it from the constant rather than retyping it:\n\n${cypher.trim()}`,
    );
  });
}

test("README documents every index the schema actually creates", () => {
  // The model section lists the DDL; a new index that never reaches the README means
  // the documented model and the real one have diverged.
  for (const stmt of DDL) {
    const match = /\((\w+):(\w+)\) ON \((\w+)\.(\w+)\)/.exec(stmt);
    assert.ok(match, `unparseable DDL statement: ${stmt}`);
    const [, , nodeLabel, , property] = match;
    const documented = new RegExp(`\\(\\s*\\w+\\s*:\\s*${nodeLabel}\\s*\\)\\s*ON\\s*\\(\\s*\\w+\\.${property}\\s*\\)`).test(README);
    assert.ok(documented, `README does not document the index on ${nodeLabel}.${property} (${stmt})`);
  }
});

test("README names every node label and relationship type the loader writes", () => {
  for (const label of ["Person", "File", "Commit", "PR"]) {
    assert.match(README, new RegExp(`:${label}\\b`), `README does not mention the ${label} label`);
  }
  for (const rel of ["TOUCHED", "CO_CHANGED", "AUTHORED_BY", "MODIFIED", "REVIEWED_BY"]) {
    assert.ok(README.includes(rel), `README does not mention the ${rel} relationship`);
  }
});
