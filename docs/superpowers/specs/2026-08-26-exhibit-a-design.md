# Exhibit A — Design Spec

**A verification engine for pull requests. It cannot make a claim it has not proven.**

- **Event:** The Agent Harness Hackathon (TrueForge / File TF-007), WeMakeDevs x TrueFoundry x Qodo
- **Deadline:** 2026-08-30, 19:00 UTC (20:00 London)
- **Written:** 2026-08-26
- **Team:** solo, part-time (~19 hours available)
- **Primary track:** Q Branch (Best Code Quality). **Upside:** Double-O (Best Use of TrueForge).
- **Stacking prizes:** Field Report (blog), Calling Card (star the repo), Radio Traffic (social)

---

## 1. Problem

Every AI code reviewer reads a diff and asserts things about it. Some assertions are correct.
The reader cannot tell which without checking each one by hand, which is most of the work they
were trying to delegate. An unverified finding has negative value: it costs attention and
returns nothing.

## 2. Thesis

A finding is worth reading only if it comes with executable proof.

Exhibit A clones a pull request into an isolated sandbox, establishes a passing baseline, forms
hypotheses about the diff, and writes a test that reproduces each one. A hypothesis becomes a
finding only when a recorded test run demonstrates it.

The rule is enforced in the tool layer, not the prompt layer: the `submit_finding` MCP tool
rejects any finding whose evidence log does not contain a qualifying run. The agent is
structurally incapable of publishing a hallucinated finding. This is the project.

## 3. The core primitive: differential execution

One primitive underlies every feature: **write a test, run it on the base commit, run it on the
head commit, compare the outcomes.** Four review questions are the same primitive at different
polarities.

| Mode | Test behaviour that proves it | Verdict emitted | Status |
|---|---|---|---|
| **Regression hunt** | fails on head, passes on base | `REGRESSION` | Core |
| **Claim verification** (Qodo's findings) | encode the claim, run on both | `CONFIRMED` / `REFUTED` / `UNVERIFIED` | Core |
| **Fix verification** | fails on base, passes on head | `FIX_CONFIRMED` | Stretch 1 |
| **Vacuous-test detection** (mutation) | break covered code, PR's new tests still pass | `VACUOUS_TEST` | Stretch 2 (likely out) |

Each mode is a thin adapter over the shared engine. Adding a mode costs an adapter, not an engine.

## 4. Claim verification — the differentiating mode

Exhibit A reads the findings Qodo has already posted on the pull request (they are ordinary PR
review comments, retrievable in one Octokit call), turns each claim into an executable test, and
runs it through the differential engine.

Output shape:

> Qodo flagged 5 issues on this PR.
> 2 CONFIRMED - reproduced, test attached
> 1 REFUTED - wrote a test for the claimed failure mode; passes on both commits
> 2 UNVERIFIED - could not construct a reproduction

### Positioning (non-negotiable)

This is a verification layer on top of Qodo, not a competitor to it. Qodo has repository-wide
static context and finds candidate issues quickly; Exhibit A has execution. Static analysis
proposes, execution disposes. A Qodo finding that arrives with a reproduction attached is
strictly more useful than one that does not. The README states this explicitly.

### Epistemic discipline (non-negotiable)

`UNVERIFIED` and `REFUTED` are different claims and must never be conflated.

- `REFUTED` requires a test encoding the claimed failure mode that **passes on both commits**.
- `UNVERIFIED` means the agent could not construct a reproduction. It is not evidence of absence.
- A Qodo finding is never labelled "wrong". The agent's failure to reproduce is a fact about the
  agent, not about the code.

This mirrors the project's core thesis. Consistency here is the point.

## 5. Architecture

TrueForge is the runtime; none of the agent loop is written by us. Three artifacts are built:

### 5.1 `exhibit-a-mcp` — custom MCP server (TypeScript)

The substantive code, and what Qodo reviews.

| Tool | Behaviour | Notes |
|---|---|---|
| `open_case(pr_url)` | Fetch diff + metadata + existing Qodo comments; create case in SQLite; return hunks with stable IDs | Hunk IDs anchor findings to exact lines |
| `provision_workspace(case_id)` | Clone PR head into a Daytona sandbox | **Approval gate 1** |
| `run_in_workspace(case_id, cmd)` | Execute shell command; append `{cmd, stdout, stderr, exit_code, commit_sha, duration}` to the case evidence log | Every command becomes evidence |
| `record_baseline(case_id, cmd)` | Pin the pre-change state | Refuses to proceed if suite is already red on base |
| `submit_finding(case_id, finding)` | **Validate the proof**, then record | The core; see 5.4 |
| `publish_findings(case_id)` | Render findings to markdown and post as a PR review comment | **Approval gate 2** |
| `get_case(case_id)` | Resume a case after reconnect | Session persistence |

### 5.2 `adversarial-review` Skill (`SKILL.md`)

Methodology, not code. Covers: exploring an unknown repository, inferring install and test
commands from its manifest, forming a falsifiable hypothesis from a hunk, writing a minimal
reproduction, encoding a third-party claim as a test, and when to abandon a hypothesis.

**Polyglot support lives here, as agent reasoning — not as per-ecosystem bootstrap code.** This
is deliberate: it is less code to maintain and it is the harness doing real work, which is what
rule 3 and the Double-O track are measuring.

### 5.3 `agent.json` — TrueForge agent config

Model, instructions, the `exhibit-a-mcp` connector, the skill, sandbox provider, dynamic
subagents, and TrueForge's built-in web search (used to check a library's documented behaviour
before claiming misuse).

### 5.4 The validator (`src/case/evidence.ts`)

`submit_finding` accepts a finding only if the case evidence log contains a run satisfying that
finding's mode:

- the run's `commit_sha` matches the expected commit for the mode's polarity,
- the run's `exit_code` matches the expected outcome,
- the paired run on the opposite commit exists and shows the opposite outcome,
- the reproduction test file is recorded verbatim in the case.

Otherwise it returns a structured rejection naming the missing evidence. The agent may retry by
gathering the evidence. It may not retry by rewording.

**Flake guard:** a candidate reproduction must fail on head across **3 consecutive runs** before
it qualifies. A test that fails intermittently is recorded as `FLAKY` and is not publishable as
a finding.

## 6. Approval gates

Two gates, both with genuine justifications rather than theatrical ones.

- **Gate 1 — before `provision_workspace`.** "This pull request contains code I have not
  verified. I need to execute it. Provision an isolated sandbox?" Running an untrusted
  contributor's code is the textbook reason a sandbox exists.
- **Gate 2 — before `publish_findings`.** Displays the exact markdown to be posted. Posting
  publicly to someone's PR is the irreversible action.

Denial at either gate pauses the case. Nothing is written anywhere.

## 7. Repository shape

```
exhibit-a/
|- README.md                 # incl. ## Qodo Code Review Evidence
|- agent/
|  |- agent.json
|  \- skills/adversarial-review/SKILL.md
|- src/
|  |- server.ts              # MCP entry
|  |- tools/                 # one file per tool
|  |- case/store.ts          # SQLite persistence (node:sqlite)
|  |- case/evidence.ts       # the validator
|  |- engine/differential.ts # the shared primitive
|  |- modes/                 # one adapter per review mode
|  |- github/client.ts       # Octokit, behind an interface
|  |- sandbox/daytona.ts     # Daytona, behind an interface
|  \- render/comment.ts
\- test/                     # vitest
```

**Stack:** TypeScript, Node 24, `@modelcontextprotocol/sdk`, zod, Octokit, Daytona SDK, vitest.
`node:sqlite` is built into Node 24 — no native module, nothing for a judge to fail to compile.

GitHub and Daytona sit behind interfaces so the validator's tests run offline against fakes.

## 8. Error handling

Every failure is explicit and recorded; none are silent.

| Condition | Case state | Behaviour |
|---|---|---|
| Sandbox will not provision | `blocked` | Report honestly; no findings |
| Test command cannot be inferred | `baseline_unavailable` | Agent may report **unproven observations**, clearly labelled; `publish_findings` will not post them as findings |
| Suite already red on base | `baseline_red` | Refuse to proceed; a red baseline makes differential evidence meaningless |
| Run exceeds 10 minutes | recorded as `TIMEOUT` | Not usable as evidence |
| Reproduction fails intermittently | recorded as `FLAKY` | Not publishable |
| GitHub auth / rate limit | `blocked` | Surface the actual error |
| Approval denied | `paused` | Nothing written |

**Declared support tiers in README:** Python and Node verified; other ecosystems best-effort.
Never overclaim.

## 9. Testing

The validator is the core logic and gets the most test attention. Negative cases specifically:

- finding with no recorded run -> rejected
- finding whose run passed when it needed to fail -> rejected
- finding whose run failed on the wrong commit SHA -> rejected
- finding with no paired run on the opposite commit -> rejected
- finding backed by a run marked `FLAKY` or `TIMEOUT` -> rejected
- `REFUTED` verdict submitted without a passing run on both commits -> rejected

Fakes for GitHub and Daytona keep the suite offline and fast.

## 10. Demo (3 minutes)

1. **0:00** Point at a real PR that Qodo has already reviewed. "Qodo found five things. Let's find out which are true."
2. **0:20** Gate 1. Sandbox provisioned. Baseline established.
3. **0:50** Claims worked: one CONFIRMED, one REFUTED with a passing test on both commits, two UNVERIFIED and said plainly.
4. **1:40** A regression Qodo did not flag, found and proven.
5. **2:10** Agent attempts an unproven observation. **Its own tooling rejects it.**
6. **2:30** Gate 2, exact comment shown, approved, cut to the live PR on GitHub.

Beat 5 is the one that matters. Beat 3's UNVERIFIED admissions are the second most important
thing in the video: every other submission shows their agent being right.

## 11. Schedule (~19h)

| Day | Hours | Deliverable |
|---|---|---|
| **Wed 26 (tonight)** | 3 | Repo, **Qodo app installed before commit #2**, Daytona + model keys, TrueForge running, MCP skeleton, case store, `open_case`. PR #1 |
| **Thu 27** | 4 | `provision_workspace` + Gate 1, `run_in_workspace`, evidence log. PR #2, #3 |
| **Fri 28** | 4 | Differential engine, `submit_finding` validator, validator tests. PR #4 |
| **Sat 29** | 5 | Regression + claim-verification adapters, `publish_findings` + Gate 2, SKILL.md, agent.json, end-to-end run. PR #5, #6 |
| **Sun 30** | 3 | README, 3-min demo, blog post, Qodo evidence section. **Submit by 18:00 London** |

Work ships as pull requests reviewed by Qodo and merged. No direct pushes to main.

### Cut order if behind

`VACUOUS_TEST` (mutation) -> `FIX_CONFIRMED` -> polyglot breadth (pin to Python) -> subagents.

**Never cut:** the differential engine, the validator, both approval gates, the sandbox, or
claim verification. Those are the project.

## 12. Hackathon compliance checklist

- [ ] Agent runs on TrueForge, harness visibly doing the work (rule 3)
- [ ] Qodo GitHub app installed **before the first substantive PR** (rule 4)
- [ ] Every substantive change merged via a Qodo-reviewed PR; no direct pushes to main (rule 4)
- [ ] All valid High-severity Qodo findings fixed, or dismissed in-thread with a written reason
- [ ] Public repo, README a stranger can run (rule 10)
- [ ] `## Qodo Code Review Evidence` section: link to a representative merged PR, 1-2 sentences
      on what Qodo surfaced and what changed or was dismissed, plus PR history showing review ->
      decisions -> follow-up review against final code (rule 10)
- [ ] ~3-minute demo video (rule 10)
- [ ] Short write-up of what the agent does and how it uses TrueForge (rule 10)
- [ ] **AI assistant use disclosed** (rule 12)
- [ ] No keys or personal data in repo or demo (rule 7)
- [ ] Only repos/accounts we own or may use (rule 7)
- [ ] Star the TrueForge repo (Calling Card draw)
- [ ] Blog post published and linked (Field Report)

## 13. TrueForge capabilities exercised

MCP connectors, sandboxed execution, human approval, subagents, persistent sessions, skills,
any-model support. Seven of the eight advertised capabilities, each present because the design
needs it rather than to satisfy a checklist.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Daytona key not obtained | Hard dependency. Obtain tonight, before any code |
| Model API key (no SF credits, online entrant) | Obtain tonight |
| Qodo retrofitted late, judges notice | Install before commit #2; judges explicitly check the trail |
| Polyglot bootstrap flakiness | Support tiers declared in README; cut to Python-only if needed |
| 19 hours is optimistic | Cut order in section 11; core is protected |
| Crowded category (idea #3 of 6 on the official list) | Lead with "an agent that cannot make a claim it has not proven", not "a code review agent" |
