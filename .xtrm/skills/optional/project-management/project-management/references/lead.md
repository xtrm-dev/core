# Build-coordinator lane

Read when you are the build lane (the "PR lane"), or launch, resume or work with one, with `references/worker.md`. SKILL.md rule 28 says when a lane
exists (operator, 2026-10-31).

## 1. Who owns what

Roles: SKILL.md "Who does what". The coordinator has the final say on merges, windows, promotions, production; the lane owns build order inside its
batch, PR readiness (refresh, CI, review and fix loops, delta checks), review launch (SKILL.md rule 44) and test dispatch, and whether it calls a PR ready. Decided together
(section 4): ticket and PR order, dependencies, deferrals, window binding, builder count and models. The lane never hands over a PR it believes is not
ready, even when a window asks.

## 2. No-trust audit before building

Before each batch, on new work, after a promotion, when a window moves: check live evidence (code, `gh`/`git`, Substrate, Jira, read-only production),
not what is written down.
1. Order follows real dependencies (alembic chain, shared files, image before config, promotion each PR rides).
2. Jira and Substrate links are real; no two PRs or windows share a code path unlinked.
3. Readiness: open findings, red CI, stale bases, unanswered quant gates.
4. Each contract's premise still holds against current code, production and later rulings.
5. Each window's vehicle (commit, PR, image) exists and reaches `stable` first; quote it only from the window's row or a `gh`/`git` read (worker.md
   1.8).
6. Builder count, model each (rule 29), start order.

A `board-audit-runner` specialist or the board-audit helper runs it, not the lane (rule 39): the lane writes the contract and reads only the verdict; a
per-item board loop is fan-out (rule 26). Output: one `finding` entry on the lane's issue with full text, and one short proposal message to
the coordinator covering each finding: what is wrong, evidence, change, cost of doing nothing. One pass per batch.

## 3. A contract is a starting point

The pinned revision stays authority until revised. When facts disagree with a contract, tell the coordinator **before** building and propose the
revision; never build something else silently, nor what it believes is wrong.

## 4. Decide together

1. Either side proposes with evidence; the other agrees or counters with evidence. The coordinator answers within one hourly cycle or 60 minutes;
   silence is not agreement. While a proposal waits, the lane continues the work the proposal does not affect. The coordinator also checks the lane's
   claims (a lane report is a claim); the lane checks the coordinator's plans.
2. A window under 2 hours away: the lane escalates by SendMessage plus a pointer to the coordinator's pane. Within 20 minutes of a window: no rounds,
   the coordinator decides and records.
3. At most two rounds per item, then a tie-breaker: the advisor (order, risk, production sequencing); an Opus `quant-methodologist` (data meaning,
   rule 29); the operator (product or release preference) via one `@operator` comment (rule 36; the board helper posts it on the coordinator's word).
4. Record each disagreement and outcome as a `decision` on the lane's issue and the project epic.

## 4a. Merges and Jira

Merge-ready means: head SHA pasted from `gh`, checks green on that head, review by rule 44 on that head, quant ruling done if rule 29 requires. The
coordinator merges on arrival (rule 49; memory gate, `--match-head-commit`); the lane never merges and never writes Jira (board helper, on the
coordinator's word).
- Before a merge-ready record for a deployable PR, run scripts/window-lineage.py (SKILL.md rule 41) and state stack, after or conflict for each open PR
  on the same territory.
- A stacked child carries the parent's commits after the squash merge: merge `origin/master` into the child (normal push, never a force push) (11-04).

## 5. Builders

The lane proposes per batch the count (rule 2.3), model and effort (rule 29) and order; one agreement covers the batch. The lane launches the builders
after that agreement; every launch counts toward the coordinator's caps.
- Each launch runs the preflight (rule 2; line on the builder's issue) and gets a fresh builder (rule 3). The lane launches the review of every PR by
  rule 44 (operator, 2026-11-06): `xt claude --role pr-reviewer --model sonnet|opus` or an Agent subagent of type `reviewer`; Opus for HIGH/CRITICAL,
  data-meaning, production or schema PRs. Never `xt pi`, never `specialist_dispatch`. `test-engineer` (specialist) by scrutiny.
- Each contract names in VALIDATION the specialist for its heavy step (for example `test-runner` for a Rust run) and the activation id in the result.
  A contract listing only deliverables got no specialist use (2026-11-01: six of six).
- The lane reaps each builder (`kill-pane` by id) in the same cycle its issue closes with a result and lists builder panes in every handoff.

## 6. Launching the lane

Name it `<lane issue>-build-coord` (`MMD-3012-build-coord`; operator, 2026-10-31), not `pr-lane` or `pr-coord`: it plans order, audits and chooses
builders. Branch `xt/<lane issue>-build-coord`; session and holder names match. Every lane launch prompt and resume line says: "Read
~/.xtrm/skills/optional/project-management/project-management/references/worker.md and references/lead.md first." The lane issue's SCOPE
includes the section 2 audit.

## Why (2026-10-31, MMD-3012)

Every useful correction was found by accident: #1127 moved out of a mixed ingestor night; #795 deferred for blocking findings; two
windows a day apart though one day was needed; a window assumed #918 shipped on an impossible date; a builder fitted test data to the answer. The
planned Jira audit did not run.
