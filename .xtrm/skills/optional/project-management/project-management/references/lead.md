# Lead: one workstream, end to end

Read when you are a lead, or launch, resume or work with one, together with `references/worker.md`. A lead is a session launched with
`--role lead` (or whose role file says `lead`; name fallback `*-lead`, for example `PROJ-4416-options-lead`): SKILL.md "Who does what", rules 28, 40.
A build lane is a lead. A legacy `*-coord` session with no role file acts as a lead until relaunch, unless `route_roles` names it the manager.

## Start (first, and after every compaction)

`python3 <pack>/project-management/scripts/pm_session.py show` prints your role, project, bound issue, the COMMON GOAL and your TOOLS. Clear
every `KIT:` line first; bind your workstream epic (`pm_session.py init --issue <epic>`) when `--bead` did not. Your epic and every contract you
write name the section of the goal they serve (SKILL.md rule 56). When work and goal disagree, journal a `blocker`; it reaches the manager at
its hourly read, unless rule 40 says it cannot wait.

## 1. Who owns what

You own your workstream and decide inside it: build order, agents within caps (rule 2.3), PR readiness (refresh, CI, review and fix loops, delta
checks), reviews (rule 44), test dispatch, the merge of your master-only PRs (rule 49), reaping, and the GO inside the workstream (rules 41 and 43
bind it). You close your own Substrate issues and order your own Jira moves from the board helper (rule 54). The manager keeps production GOs,
windows, promotions, deploys and merges that span workstreams; it ratifies or overrules your journaled decisions at its hourly read. You never
hand over or merge a PR you believe is not ready, even when a window asks.

## 2. Talking to peers

Rule 40 is the single source for when to message whom. In short:
- **Decide, then journal.** A decision, a proposal, a merge, a done or a status goes to your journal (`decision`, `result`, `milestone`); the
  manager reads it within the hour. Do not message the manager to inform it, and do not wait for an answer you do not need.
- **The manager** (`scripts/route_target.py manager`) only for what cannot wait an hour: a production anomaly, a data-correctness finding, a
  blocker you cannot settle, a decision due within 2 h. One message carries every such item.
- **Another lead:** directly, by session name (`route_target.py --team`), for a cross-workstream dependency; record the agreement as a `decision`
  on both issues. The manager is not a router.
- **The board helper** (`route_target.py board_helper`): Jira orders by intent and answers to its close proposals (rule 54).
- **Your workers** report to you; read their journals and steer them (`SendMessage` to an `xt` session, `specialist_reply` to a specialist).

## 3. No-trust audit before building

Before each batch, on new work, after a promotion, when a window moves: check live evidence (code, `gh`/`git`, Substrate, Jira, read-only production),
not what is written down.
1. Order follows real dependencies (alembic chain, shared files, image before config, promotion each PR rides).
2. Jira and Substrate links are real; no two PRs or windows share a code path unlinked.
3. Readiness: open findings, red CI, stale bases, unanswered quant gates.
4. Each contract's premise still holds against current code, production and later rulings.
5. Each window's vehicle (commit, PR, image) exists and reaches `stable` first; quote it only from the window's row or a `gh`/`git` read (worker.md
   1.8).
6. Agent count, model each (rule 29), start order.

A `board-helper` specialist or the board helper runs it, not the lead (rule 39): the lead writes the contract and reads only the verdict; a
per-item board loop is fan-out (rule 26). Output: one `finding` entry on the lead's issue with full text. A finding that moves another workstream
goes to that lead; one that moves a production GO or a window is a manager item under rule 40. One pass per batch.

## 4. A contract is a starting point

The pinned revision stays authority until revised. When facts disagree with a contract, revise it **before** building (a diff the lead checks and
attests, rule 50) and journal the revision as a `decision`; never build something else silently, nor what you believe is wrong.

## 5. When you and the manager disagree

1. The manager overrules a journaled decision with evidence at its hourly read; you answer with evidence if you disagree. While an item waits,
   continue the work it does not affect.
2. A decision due within 2 h of a window: message the manager (rule 40). Within 20 minutes of a window the manager decides alone and records.
   With no live manager (`route_target.py manager` finds none), decide your own window, journal it, and the next manager ratifies it.
3. At most two rounds per item, then a tie-breaker: the advisor (order, risk, production sequencing); an Opus `quant-methodologist` (data meaning,
   rule 29); the operator (product or release preference) via one `@operator` comment (rule 36).
4. Record each disagreement and outcome as a `decision` on your issue and the project epic.

## 6. Merges and Jira

Merge-ready means: head SHA pasted from `gh`, checks green on that head, an `xtrm-reviewer[bot]` review on that head whose body holds the OCR section
"Ledger check: exit 0" (rule 44), quant ruling done if rule 29 requires, the specialist chain recorded (rule 52).
- **A master-only PR** (no window, no promotion of its own): you merge it yourself, memory gate and `--match-head-commit` in the same command, then
  journal a `result` with the merge SHA (rule 49).
- **A PR that deploys, rides a promotion or spans workstreams:** journal the merge-ready record; the manager merges it at its read, or on your
  message when a window is due within 2 h. Before that record run `scripts/window-lineage.py` (rule 41) and state stack, after or conflict for each
  open PR on the same territory.
- You never write Jira yourself: order moves and closes from the board helper.
- A stacked child carries the parent's commits after the squash merge: merge `origin/master` into the child (normal push, never a force push) (11-04).

## 7. Agents

- Pick per batch the count (rule 2.3), model and effort (rule 29) and order, and launch within your cap; the host cap (rule 2.3) is the only
  ceiling above it.
- Builders: a `worker` specialist by default, kept alive for the next issue of its role (rule 3); an `xt` worker only for what rule 1 lists.
  Each launch runs the preflight (rule 2; line on the worker's issue). Syntax: `references/launching.md`, "Dispatch a builder".
- Reviews (rule 44): launch the review of every PR; keep one `pr-reviewer` specialist alive and give it each new PR. `test-engineer` by scrutiny.
- Each contract names in VALIDATION its specialist chain (rule 52) and wants the activation ids in the result. A contract listing only deliverables
  got no specialist use (2026-11-01: six of six).
- Liveness every cycle (`references/launching.md`, "Liveness"): every check ends in an action. The operator answers destructive, privileged or
  unfamiliar prompts; the lead answers a routine prompt only when the operator said that class is allowed, never approves sudo and never relays an
  approval between sessions.
- Edits outside the lead's worktree go to a worker, not a side worktree.
- Close or confirm the close of each worker's issue (rule 54) in the same cycle; then reap an `xt` worker (`kill-pane` by id) or keep a specialist
  for its role's next issue. List live agents in every handoff.

## 8. Launching a lead

The manager launches it from the main checkout, in its own tmux session:
`xt claude <epic>-<area>-lead --window --role lead --bead <workstream ref> --model sonnet -- --effort high`, then the kit check
`pm_session.py show --dir <worktree>` (`references/launching.md`, "Session kit"). Branch `xt/<name>`; session and holder names match. The
`<epic>-<area>-lead` name is a convention and the routing fallback; the launch role routes it. The workstream issue's SCOPE
includes the section 3 audit. Every lead launch prompt and resume line says: "Load project-management; read references/lead.md and
references/worker.md first."

A lead compacts at a clear checkpoint (`references/continuity.md`) and rotates at 24 h or when its context is rotted (SKILL.md rules 35, 40): a
`handoff` entry first, then the lead itself launches its successor on the same issue with `--role lead` and checks its kit; it releases its
claim, the successor claims, the outgoing deletes its own role file if it has one (`pm_role.py clear --dir <its worktree>`) and exits, and the
successor reaps it, as in `references/handover.md`.

## Why (2026-10-31, MMD-3012)

Every useful correction was found by accident: #1127 moved out of a mixed night; #795 deferred for blocking findings; two
windows a day apart though one day was needed; a window assumed #918 shipped on an impossible date; a builder fitted test data to the answer. The
planned Jira audit did not run.
