# Lead: one workstream, end to end

Read when you are a lead, or launch, resume or work with one, together with `references/worker.md`. A lead is the `project-manager` role in a
session whose role file says `lead` (name fallback `*-lead`, for example `MMD-4416-options-lead`): SKILL.md "Who does what" and rule 28. A build
lane is a lead. A legacy `*-coord` session with no role file acts as a lead until relaunch, unless `route_roles` names it the manager.

## 1. Who owns what

The manager has the final say on GOs across workstreams, release windows, promotions, production and merges (rule 49). The lead owns its workstream:
build order, workers within caps (rule 2.3), PR readiness (refresh, CI, review and fix loops, delta checks), review launch (rule 44), test dispatch,
merge-ready records, reaping, and the GO inside its workstream (self-GO; rules 41 and 43 bind it). It closes its own Substrate issues and orders its
own Jira moves from the board helper (operator ruling 2026-11-12, journal seq 2870). Decided with the manager (section 5): window binding, a deferral
that moves a release, workers beyond the cap. The lead never hands over a PR it believes is not ready, even when a window asks.

## 2. Talking to peers

- Another lead: directly, by session name (`scripts/route_target.py --team` lists them), for a cross-workstream dependency; record the agreement as
  a `decision` on both issues. The manager is not a router.
- The manager (`scripts/route_target.py manager`): only for a GO, a merge-ready record, a blocker, a data-correctness finding or a production
  anomaly (SKILL.md rule 40). The rest goes to the lead's journal, which the manager reads hourly.
- The board helper (`scripts/route_target.py board_helper`): Jira orders by intent (rule 40) and answers to its close proposals (rule 54).
- Workers report to their lead; the lead reads their journals and steers by `SendMessage` to the worker's session name.

## 3. No-trust audit before building

Before each batch, on new work, after a promotion, when a window moves: check live evidence (code, `gh`/`git`, Substrate, Jira, read-only production),
not what is written down.
1. Order follows real dependencies (alembic chain, shared files, image before config, promotion each PR rides).
2. Jira and Substrate links are real; no two PRs or windows share a code path unlinked.
3. Readiness: open findings, red CI, stale bases, unanswered quant gates.
4. Each contract's premise still holds against current code, production and later rulings.
5. Each window's vehicle (commit, PR, image) exists and reaches `stable` first; quote it only from the window's row or a `gh`/`git` read (worker.md
   1.8).
6. Worker count, model each (rule 29), start order.

A `board-audit-runner` specialist or the board helper runs it, not the lead (rule 39): the lead writes the contract and reads only the verdict; a
per-item board loop is fan-out (rule 26). Output: one `finding` entry on the lead's issue with full text. A finding that moves a GO, a window or
another workstream also goes as one short proposal to the manager or that lead: what is wrong, evidence, change, cost of doing nothing. One pass per
batch.

## 4. A contract is a starting point

The pinned revision stays authority until revised. When facts disagree with a contract, revise it **before** building (a diff the lead checks and
attests, rule 50), and propose it first to the manager when it moves a GO, a window or another workstream; never build something else silently, nor
what you believe is wrong.

## 5. Decide together

1. Either side proposes with evidence; the other agrees or counters with evidence. The manager answers within one hourly cycle or 60 minutes;
   silence is not agreement. While a proposal waits, the lead continues the work the proposal does not affect. The manager checks the lead's claims
   (a lead report is a claim); the lead checks the manager's plans.
2. A window under 2 hours away: the lead escalates by `SendMessage` to the manager. Within 20 minutes of a window: no rounds, the manager decides and
   records. With no live manager (`route_target.py manager` finds none), the lead decides its own window, journals the decision, and the next
   manager ratifies it.
3. At most two rounds per item, then a tie-breaker: the advisor (order, risk, production sequencing); an Opus `quant-methodologist` (data meaning,
   rule 29); the operator (product or release preference) via one `@operator` comment (rule 36; the board helper posts it on the lead's or manager's
   order).
4. Record each disagreement and outcome as a `decision` on the lead's issue and the project epic.

## 6. Merges and Jira

Merge-ready means: head SHA pasted from `gh`, checks green on that head, an `xtrm-reviewer[bot]` review on that head whose body holds the OCR section
"Ledger check: exit 0" (rule 44), quant ruling done if rule 29 requires, the specialist chain recorded (rule 52). The lead sends the record to the
manager, who merges on arrival (rule 49; memory gate, `--match-head-commit`). The lead never merges and never writes Jira itself: it orders its
moves and closes from the board helper.
- Before a merge-ready record for a deployable PR, run scripts/window-lineage.py (SKILL.md rule 41) and state stack, after or conflict for each open PR
  on the same territory.
- A stacked child carries the parent's commits after the squash merge: merge `origin/master` into the child (normal push, never a force push) (11-04).

## 7. Workers

- The lead picks per batch the count (rule 2.3), model and effort (rule 29) and order, and launches within its cap; past the cap it asks the manager.
- Each launch runs the preflight (rule 2; line on the worker's issue) and gets a fresh worker (rule 3). Syntax: `references/launching.md`,
  "Dispatch a builder (worker role)".
- The lead launches the review of every PR (rule 44): `xt claude --role pr-reviewer --model sonnet|opus`, the native
  `reviewer` subagent in PR mode, or the `pr-reviewer` specialist through `claude-bridge`; Opus for HIGH/CRITICAL, data-meaning,
  production or schema PRs. `test-engineer` (specialist) by scrutiny.
- Each contract names in VALIDATION its specialist chain (rule 52) and wants the activation ids in the result. A contract listing only deliverables
  got no specialist use (2026-11-01: six of six).
- Liveness every cycle (`references/launching.md`, "Liveness"): every check ends in an action. The operator answers destructive, privileged or
  unfamiliar prompts; the lead answers a routine prompt only when the operator said that class is allowed, never approves sudo and never relays an
  approval between sessions.
- Edits outside the lead's worktree go to a worker window, not a side worktree.
- The lead closes or confirms the close of each worker's issue (rule 54), reaps the worker (`kill-pane` by id) in the same cycle, and lists worker
  panes in every handoff.

## 8. Launching a lead

The manager launches it from the main checkout, in its own tmux session:
`xt claude <epic>-<area>-lead --window --role project-manager --bead <workstream ref> --model sonnet -- --effort high`, then the role file:
`python3 <pack>/project-management/scripts/pm_role.py set lead --dir <worktree>` (`references/launching.md`, "Role file"). Branch `xt/<name>`;
session and holder names match. The `<epic>-<area>-lead` name is a convention and the routing fallback; the role file routes it. The workstream issue's SCOPE
includes the section 3 audit. Every lead launch prompt and resume line says: "Load project-management; read references/lead.md and
references/worker.md first."

A lead compacts at a clear checkpoint (`references/continuity.md`) and rotates at 24 h or when its context is rotted (SKILL.md rules 35, 40): a
`handoff` entry first, then the lead itself launches its successor on the same issue (`xt attach <name>`, then `sb issue resume <ref>`) and
writes `lead` into the successor's role file; it releases its claim, the successor claims, the outgoing deletes its own role file
(`pm_role.py clear --dir <its worktree>`) and exits, and the successor reaps it, as in `references/handover.md`.

## Why (2026-10-31, MMD-3012)

Every useful correction was found by accident: #1127 moved out of a mixed night; #795 deferred for blocking findings; two
windows a day apart though one day was needed; a window assumed #918 shipped on an impossible date; a builder fitted test data to the answer. The
planned Jira audit did not run.
