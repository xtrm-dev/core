# Instructions: how the project-management system works

Read this when you are lost: a new operator, a new session, or anyone who must understand the whole system before acting. It
explains the parts, who does what, where everything is written, how a day and a piece of work run, how messages travel, and
how to find out what is happening now. It states no new rules. The rules live in `SKILL.md` and the role files; this file
points to them. Where this file and those files disagree, they win.

`<pack>` below is the pack directory, for example `~/.xtrm/skills/optional/project-management`. Every command runs from the
project's checkout or a worktree of it.

## 1. The system in one page

A project is work of days or weeks for a team of agent sessions, run for one human: the **operator**.

- The **operator** decides: rulings, approvals, GOs for production. The operator reads Jira and the status board, and
  answers there or in chat.
- The **manager** (one per project) runs the project: GOs, release windows, merges, the operator channel, and keeping the
  team staffed.
- A **lead** (one per workstream) runs one workstream: it plans, launches workers, gets their pull requests reviewed and
  closes its issues.
- A **worker** (one per issue) builds one contract and reports to its lead.
- The **board helper** (one per project) is the only writer to Jira and the router of the operator's comments.
- **Specialists** are agents dispatched on an issue and kept alive for the next issue of their role: the default for building (`worker`),
  reviews (`pr-reviewer`), tests and investigations. `xt` sessions are for work that needs a pane, tmux, `gh` or Jira (SKILL.md rule 1).

Everything that matters is recorded in **Substrate** (`sb`): contracts, plans, decisions, questions, evidence, closure.
**Jira** and the **status board** (a here.now page) are views for the operator. The pack holds no data about your instance:
the Jira site, project key, repository and paths are settings in one config file.

Every session also serves one **common goal**: what the whole project must achieve, written in a goal document (for
example the product's PRD) and in the project epic. Each issue is a part of that goal.

## 2. The parts and where they live

| Part | What it is | Where |
|---|---|---|
| Substrate | the record: issues with contracts, claims, the journal, provenance, closure | `sb` CLI; store `~/.xtrm/state.db` |
| Jira | the operator's view: epics, stories, sprints, the window calendar, comments | written only through `scripts/jira.py` and `scripts/post-guard.py` |
| Status board | a live here.now page: workers, schedule, follow-ups, open questions | data store written by `status_board_sync` and the keeper |
| tmux session | one session per project; the manager's window holds the coordinators | `tmux list-panes -s -t <session>` |
| Agent host | the registry of live sessions that routing reads | `~/.xtrm/run/agent-host.json`, `GET /v1/sessions` |
| The lane | the board helper's loops, state files and alarms | `$PM_LANE_DIR`: `events.log`, `pending-routes.jsonl`, cursors, reports |
| The config | every instance setting, one profile per project | `~/.config/xtrm/project-management.json` |
| Session hooks | small guards for managers and leads in Claude Code | `hooks/`, wired in `~/.claude/settings.json` |
| Role definitions | the launch roles: `manager`, `lead`, `worker`, `board-helper` | specialist definitions, read by `xt --role` |

The pack has four skills:

| Skill | Use |
|---|---|
| `project-management` | the doctrine for managers and leads; `references/` holds the role files and procedures |
| `board-audit` | the board helper's cycle, audits, the lane and the router |
| `status-board-keeper` | the status board: its store, the sync timer, the keeper's steps |
| `journal-search` | full-text search over every journal entry |

## 3. Roles and how a session gets one

A session has exactly one role: `manager`, `lead`, `board_helper` or `worker`. One resolver
(`scripts/pm_role.py`) decides it for every script and hook, in this order:

1. A `.pm-role` file in the session's worktree root. This is an override, used only for sessions launched before the
   launch roles existed or under the shared `project-manager` role.
2. The launch role: the `--role` the session was launched with (`manager`, `lead`, `board-helper`; the old name
   `board-audit-runner` still works).
3. The session name: `*-manager`, `*-lead` or legacy `*-coord`, `*board-helper*`.
4. Otherwise `worker`.

Launch each role like this (full syntax and checks: `references/launching.md`):

```
xt claude <name> --window --role manager --bead <manager_issue> --model opus -- --effort high
xt claude <epic>-<area>-lead --window --role lead --bead <workstream ref> --model sonnet -- --effort high
specialist_dispatch {specialist: "worker", issue_ref}        # default; the next issue goes by specialist_reply
xt claude|pi <story>-<slug> --window --role worker --bead <issue ref> [--model sonnet|opus -- --effort high]   # only by rule 1
xt pi board-helper --window --role board-helper
```

After a launch, the launcher checks the new session's kit:

```
python3 <pack>/project-management/scripts/pm_session.py show --dir <worktree>
```

Rules about role files:
- A role file belongs in a worktree root, never in the root of a main checkout. A role file in a main checkout gives every
  session that falls back to that directory the wrong role. Remove such a file.
- When a session ends, its successor needs no role file if it was launched with its role.

## 4. The common goal

- **Where it is.** Three pointers in the project's config profile: `goal_doc` (the goal document, for example
  `docs/product/PRD.md`), `epic` (the Substrate project epic, whose SUCCESS states the goal) and `jira_epic` (the Jira epic
  the operator reads). `goal_refs` adds further pointers.
- **How a session sees it.** `pm_session.py show` and `pm_session.py goal` print it, quoting the goal document's opening
  paragraph. The post-compact hook prints it to managers and leads at start and after every compaction.
- **What a session does with it.** It reads the goal document once per session. Every contract names the section of the goal
  it serves (`sb issue edit <ref> --context-refs`). When work and goal disagree, the session asks: a worker asks its lead, a
  lead asks the manager, the manager asks the operator.
- **Who keeps it current.** The manager. When the goal document changes, the manager revises the epic's SUCCESS and orders
  the Jira epic's description from the board helper. Rule 56 in `SKILL.md`.

## 5. Where things are written

| You have | Write it to | Not to |
|---|---|---|
| a plan, a decision, a finding, an open question, a result, a handoff | Substrate: the issue contract or a journal entry | a markdown file |
| something the operator must see or answer | a Jira comment, posted by the board helper (`@operator` for attention) | chat only |
| a draft, a capture, a launch script | scratch: `$PM_STATE_DIR/<issue>/` | the deliverable |
| an ADR, PRD, runbook or design note | the repository through a PR, bound to the issue (`decision` entry with `path@sha`) | an unbound file |

Journal kinds: `decision`, `finding`, `blocker` (an open question; answered by a later `decision`), `milestone`, `result`
(the settled outcome), `handoff` (the state for a successor), `note`. Read them with `sb journal latest|since|show`; find
one without knowing the issue with `journal-search`.

Substrate drives Jira status. Nothing else moves a ticket: no Jira automation, no smart commit.

## 6. A day in the project

All times are UTC, read from `date -u`.

| When | Who | What |
|---|---|---|
| Session start, every compaction | everyone | `pm_session.py show`; re-read the role file; resume the issue (`sb issue resume <ref>`) |
| Every 5 min | board helper lane | read new operator comments and route the decisions |
| Every 5 min | `status_board_sync` timer | copy Jira windows and worker state to the status board |
| Every 15 min | board helper lane | hygiene cycle, deploy snapshot, heavy-queue watch |
| Every hour | manager | read every lead journal and rule in one batched message per lead, or none; team check (`route_target.py --team`); keeper pass; close sweep for issues without a workstream |
| Every hour | each lead | its own close sweep, worker liveness |
| Every 2 h | manager, leads | renew claims (`sb issue renew`); board helper cycle report (a journal entry, no message) |
| Before each production window | manager | prerequisite check, preflight, GO or DRY comment on the window's Jira task |
| 22:17 | manager | daily report: one `result` entry on the epic and one comment on the Jira epic |
| Day boundary | manager | handover to the next day's manager (`references/handover.md`) |

The manager's full daily list is `references/manager.md` §1; the lead's is `references/lead.md`.

## 7. The life of one piece of work

| Step | Who | Command or record |
|---|---|---|
| 1. Contract | lead | `sb issue create ... --contract <file>`: problem, scope, success, validation, output; name the goal section |
| 2. Attest | lead | `sb issue attest <ref> --outcome ready ...`; the issue must show `ready` and `dispatchable` |
| 3. Preflight | lead | the budget line (load, memory pressure, live agents) within the caps; it goes in the journal |
| 4. Launch | lead | a `worker` specialist (`specialist_dispatch`, or `specialist_reply` to a kept-alive one); an `xt` worker only by rule 1 |
| 5. Claim | worker | `sb issue claim <ref> --holder <name> --ttl-ms <n>`; renew at every checkpoint |
| 6. Build | worker | journal one fact per entry; checkpoint at each milestone |
| 7. Receipt and PR | worker | `sb provenance dispatch` and `allocate`, then `gh pr create` with the issue marker, so the PR links to the issue |
| 8. Review | lead | rule 44: the kept-alive `pr-reviewer` specialist, at the exact head |
| 9. Merge | lead (master-only PR) or manager (deploys, promotion, several workstreams) | on arrival, with `--match-head-commit` and the memory gate (rule 49) |
| 10. Result and close | worker or lead | a `result` entry, then `sb issue close --outcome completed`; the close gate checks the PR link rows |
| 11. Jira Done | board helper | moves the ticket by transition id on the lead's order |
| 12. Reap | lead | confirm the result; keep a specialist for its role's next issue, or `tmux kill-pane -t <pane-id>` for an `xt` worker |

A different scope always gets a new issue. A kept-alive specialist takes the next issue of its role; an `xt` worker ends with its scope (a
same-scope follow-up may stay, at most three issues).

## 8. How messages travel

- **By role, never by a stored address.** `python3 <pack>/project-management/scripts/route_target.py manager` (or
  `board_helper`, `--team`, `--all`) prints the live session name; send to it with `SendMessage`.
- **Worker to lead:** a decision, a blocker, a contract conflict or a scope deviation (SKILL.md rule 40). Done, merge-ready and progress go
  to the journal; a specialist's result is its report.
- **Lead to manager:** almost never by message. A lead decides inside its workstream and journals it; the manager reads every
  lead journal once an hour and rules there. A message only for what cannot wait an hour: a production anomaly, a
  data-correctness finding, a blocker the lead cannot settle, a decision due within 2 h (SKILL.md rule 40). The manager never
  asks for status and never acknowledges. Leads settle cross-workstream questions with each other directly.
- **Anyone to Jira:** through the board helper, on the order of the manager or the owning lead.
- **Operator comment to a session:** the lane's routers read new Jira comments every 5 minutes and put each decision in the
  outbox (`pending-routes.jsonl`). The board helper decides who gets it (`route-forward.py --to <name>`, default the
  manager) and sends it. Undelivered items are counted (`route-backlog.py`), alarmed (`deadman.py`), and shown to the
  receiver before its next gated command (`action_gate.py`).
- **Question to the operator:** `pm_question.py add --ref <ref> --q <text> --rec <text>` writes a Substrate blocker and a
  status-board `questions` row; the board helper posts one `@operator` comment. After 5 silent turns the
  `operator-questions` hook reminds the session.
- **Operator answer on the status board:** it goes to the session that owns the question, else to the manager.

## 9. Session start, compaction and handover

**Start and after every compaction**, every session:
1. `python3 <pack>/project-management/scripts/pm_session.py show`. Clear every `KIT:` line.
2. Read your role file in full: `references/manager.md`, `lead.md` or `worker.md` (managers and leads also `launching.md`).
   The action gate blocks merges and launches until the listed references are read.
3. `sb issue resume <ref>`; `sb journal latest <ref> --kind handoff`.
4. Re-arm monitors and crons from the latest handoff.

**Hooks** (managers and leads in Claude Code; `references/setup.md` §8):

| Hook | When | Does |
|---|---|---|
| `post_compact.py` | session start, after compaction | role line, common goal, resume steps |
| `action_gate.py` | before gated commands | blocks until the references are read; shows pending messages once |
| `checkpoint_warn.py` | at 35 % and 60 % of context; at 70 % and 85 % | the role's tool cards; one `handoff` entry, then compact yourself |
| `operator-questions.py` | each turn | reminds about an unanswered operator question |

**Handover** (`references/handover.md`): the outgoing manager settles, collects reports, writes the handoff, launches its
successor with `--role manager`, hands over crons and the claim on `manager_issue` in order, and exits; the successor reaps
it. Leads rotate the same way with `--role lead`. While two managers are live, the holder of the claim on `manager_issue`
keeps the role.

## 10. Setting it up (short)

The full procedure is `references/setup.md`; the board helper's lane is `board-audit/references/setup-lane.md`; the status
board is `status-board-keeper/references/setup.md`.

1. Install the tools: `sb`, `xt`, `gh` (logged in), `tmux`, Python 3.10 or later; a Jira API token in its own file.
2. Write `~/.config/xtrm/project-management.json`: a `defaults` block and one profile per project with `repo_dir`,
   `lane_dir`, `state_dir`, the Jira and Substrate keys, the status board site, and `goal_doc`, `epic`, `jira_epic`.
3. Check: `python3 <pack>/project-management/scripts/pm_check.py --project all`. Every required setting must say `OK`.
4. Wire the hooks, then check: `pm_check.py --hooks`.
5. Start the lane (scheduler and dead-man switch) and the status board sync timer.
6. Launch the manager with `--role manager`; it launches the board helper and the leads.

Several projects in one config: every launch, timer and cron sets `PM_PROJECT=<name>`. The scripts stop rather than guess.

## 11. When you are lost: what to run

| Question | Command |
|---|---|
| Who am I, what is my issue, what is the goal? | `pm_session.py show` |
| Who is live in the project, by role? | `route_target.py --team` |
| Is the setup complete? | `pm_check.py` (add `--hooks` for the hooks) |
| What is this issue's state and next step? | `sb issue resume <ref>`; `sb issue show <ref>` |
| What changed since I last looked? | `sb journal since <ref> <seq>` |
| Where did we decide X? | `python3 <pack>/journal-search/scripts/jsearch.py "<words>"` |
| What is the lane doing? | `tail -n 40 $PM_LANE_DIR/events.log` |
| Is the status board sync healthy? | `journalctl --user -u status-board-sync` (look for `ASSERT-FAIL`) |
| How does a service work? | First call `knowledge_evidence_for_files`, then `knowledge_search`; use `knowledge_status` when stale and `knowledge_drift` after recent changes. CLI fallback: `service-knowledge index query "<text>"`. |
| How does a `sb` verb work? | `sb help <group>` |
| Which tools should I be using? | `pm_session.py tools` |
| What wakes this session, and how much does it message others? | `python3 <pack>/project-management/scripts/pm_wakes.py --session <name>` |

Common problems:

| Symptom | Cause | Fix |
|---|---|---|
| A session reports the wrong role | a stray `.pm-role`, or a launch without `--role` | check with `pm_session.py show --dir <worktree>`; remove the stray file or relaunch with the role |
| `KIT: no bound issue` | the launch had no `--bead` and no `.substrate-issue` | `pm_session.py init --issue <ref>` |
| A gated command is denied | the references were not read in full this session, or a message is pending | read the listed files; read the pending items, then retry |
| `ALARM ROUTE-TARGET manager` in the lane | zero or two live managers | check `route_target.py --team`; during a handover the claim decides |
| Operator comments do not arrive | the router or the delivery stopped | `route-backlog.py` lists undelivered items; check `events.log` for `ALARM` lines |
| A script stops with "several projects" | `PM_PROJECT` is not set | export `PM_PROJECT=<name>` |
| `sb issue close` refuses a delivery | the PR link rows are missing | `sb links check --issue <ref>`; `sb links sync`; `sb provenance attach` |

## 12. Map of the files

| Read | When |
|---|---|
| `SKILL.md` | the doctrine: roles, the two systems, fleet rules, daily rules 14 to 56 |
| `references/manager.md`, `lead.md`, `worker.md` | your role, at start and after every compaction |
| `references/launching.md` | launch syntax, the session kit, liveness, reaping, specialists, limits |
| `references/handover.md`, `continuity.md` | handover, compaction, resume |
| `references/project-start.md`, `worked-example.md` | starting a project |
| `references/substrate.md`, `jira.md` | command syntax for Substrate and Jira |
| `references/setup.md` | every setting, the config file, routing roles, the common goal, hooks |
| `board-audit/SKILL.md` | the board helper's cycle and the router |
| `status-board-keeper/SKILL.md` | the status board |
| `journal-search/SKILL.md` | searching the journal |

## Glossary

- **Attested issue:** an issue whose contract was checked ready to execute. Work never starts from a title and a description.
- **Claim:** a lease of about 15 minutes that says who owns an issue; renewed at each checkpoint.
- **Close gate:** the check at closure that a delivering PR or commit is linked to the issue.
- **GO:** the manager's explicit go-ahead for a merge, a production window or a promotion.
- **Kit:** what a session needs before work: its role, its bound issue, the project, the common goal.
- **Lane:** the board helper's state directory, loops and alarms.
- **Launch role:** the `--role` a session was launched with; it is the session's role.
- **Reap:** close a finished worker's pane by its id after its result is recorded.
- **Window:** a scheduled production change, a Jira task with label `window`.
