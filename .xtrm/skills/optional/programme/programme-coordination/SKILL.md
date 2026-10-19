---
name: programme-coordination
description: >
  Coordinate a multi-week engineering programme with Substrate as the only record and Jira as
  the operator view. One coordinator session plans, dispatches workers as tmux windows in its
  own session, audits, and keeps /goal alive. Use when starting, resuming or handing off a
  programme; when turning a list of fixes into themes, sprints and worker contracts; or when
  the operator asks for a programme status in Jira. Not for implementing code (workers do
  that), single issues (use planning), or Mercury production windows (use mercury-release,
  production-ops).
---

# Programme coordination

A programme is a body of work that spans days or weeks and needs more than one worker.
The coordinator plans, dispatches, audits and decides. Workers build. Reviewers review.
The coordinator never builds or reviews code itself.

## The rule: two systems, no files

| System | Holds | Written by |
|---|---|---|
| **Substrate** (`sb`) | contracts, plan, decisions, open questions, evidence, handoffs | coordinator and workers |
| **Jira** | the operator's view: programme, themes, sprints, human-only steps | coordinator |

Do not create `PLAN.md`, a journal file, a goal-prompt file or a `briefs/` folder. Each has a
Substrate home:

| Instead of a file | Use |
|---|---|
| plan | the programme epic's contract, and `sb issue tree` |
| running log | the epic's journal (`sb journal append`) |
| open question | a `blocker` journal entry; a later `decision` entry answers it |
| worker brief | the worker's issue contract |
| goal prompt | the latest `handoff` entry on the epic |
| handoff | `sb journal append --kind handoff`, then `sb issue resume` |

Details and exact commands: `references/substrate.md`.

## Shape of a programme

```
Substrate                              Jira (project ISSUE or XT)
Programme epic          ───── 1:1 ───  Epic
  Theme epic (child)    ───── 1:1 ───  Story, in a weekly sprint
    Worker task                        (leaf: Substrate only, never mirrored)
    Worker task
  Operator step (approval, window)     Task, related to its Story, in the sprint
```

- **Epic and Story map 1:1.** Each carries the other's key (Jira label `substrate:<ref>` plus the
  description on one side, an `sb issue note` on the other).
- **Worker tasks stay in Substrate.** The Story lists their refs. Never create one Jira ticket per
  worker task: that was the failure this shape replaces.
- **A theme is a result a person can recognise**, one deliverable that fits a sprint. Every Story
  goes into a sprint.
- **The Epic is an ADR-style brief** an agent can reason from (context, decision, rejected
  alternatives, consequences), not a list of directives. It is written in Jira. The Substrate epic
  contract carries the same content in the seven fields (`references/substrate.md`).
- **Owners.** Jira owns summary, brief, sprint, assignee, priority, epic link and portfolio status.
  Substrate owns the contract, readiness, attestation, claim, journal, provenance and closure
  evidence. Edit a field in the system that owns it.
- Epics nest in Substrate (`--kind epic --parent <epic>`). The journal levels are: programme
  (overall story and decisions), theme (that theme's story), task (one worker's detail).

Jira tool: `scripts/jira.py` (REST; token file, account and site from `JIRA_TOKEN_FILE`,
`JIRA_EMAIL`, `JIRA_SITE`, with defaults for the operator's machine; token never printed). Field recipes,
sprint rhythm and the board profile: `references/jira.md`.

## 1. Start

1. `sb issue create --project <id> --title "..." --kind epic --scrutiny MEDIUM --contract '<json>'`
   for the programme, with a full contract (PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS,
   VALIDATION, OUTPUT; JSON shape in `references/substrate.md`). SUCCESS is the finish line.
2. Create the themes and worker tasks in one step with `sb plan apply` (piped, no file kept;
   `sb plan check` first).
3. The coordinator attests every contract it dispatches: new issues are DRAFT and not claimable
   until `sb issue attest <ref> --outcome ready --policy default --attested-by <who>`. An edit
   bumps the revision and needs a new attestation.
4. Create the Jira Epic, one Story per theme, assign Stories to sprints (`references/jira.md`).
5. Append a `decision` entry on the programme epic: the Jira keys, the sprint plan, the modes.

## 2. Run

- **Journal everything that matters on the epic**, one entry per fact: `decision`, `finding`,
  `blocker`, `milestone`, `result`. Read it back in bounded windows: `sb journal since <epic> <cursor>`,
  `sb journal latest <epic> --kind decision`, `sb journal timeline <epic> --limit 20`. The text
  views print a short preview of each entry; add `--json` to read the full entry (a 4.4 KB entry
  reads back complete with `--json`).
- **New finding during the work:** create a child issue, link it with
  `sb issue relate --kind discovered_from`, add its ref to the matching Story.
- **A scope change** is a new contract revision, never a journal entry that overrides the contract.
- **Every PR:** review, decision, fix, delta check, merge with `--match-head-commit`. After the
  merge, confirm the main branch equals the head that CI tested. If another PR merged in between,
  the combination is untested: the next PR's CI or a canary must prove it. (In repos where a push
  to the main branch runs no CI, nothing else will.)
- **Close** each issue with `sb issue close --outcome ... --reason ...` and cite the result
  entry and PR.
- **Every load-bearing claim gets one live check** before it drives an action or goes to the
  operator: check it against git, the live tree, tests or the running system. This applies to
  workers, reviewers, specialists and the coordinator itself. Confident wrong claims came from
  all four.
- **Read the board before the first Jira write**: issue types, statuses and categories, transitions,
  board columns, sprints, custom fields, and whether the dev panel shows data
  (`references/jira.md`, "Read the board first"). Never assume a status name. Record the profile once as
  a `finding` on the programme epic.
- **Substrate drives Jira status; nothing else does.** No Jira Automation rule and no smart commit
  moves status; the GitHub for Jira dev panel on ISSUE is evidence only. Until `sb jira` exists
  (XTRM-639), the coordinator moves each item by hand on the day of the event, to the board's
  status that means: ready, being worked, in review, merged and waiting for production, done, done
  with follow-up, parked, blocked, will not do. Move by **transition id**, never by name: ids differ
  per project (`41` is Done on XT and Deferred on ISSUE). The id tables are in `references/jira.md`;
  re-read them once per programme and record them in the board-profile finding.
- **Post results to Jira as comments**: findings, decisions, results and closures that the
  operator needs, with the Substrate ref. The daily report is written once, as a `result` entry on
  the programme epic, then posted as a comment on the Jira Epic. Never copy claims, journals or
  receipts into Jira fields.

## 3. Workers (fleet)

**Pick the worker shape first** (interim rule; XT-132 decides the final one):

| Work | Shape |
|---|---|
| Bounded role with a contract: review, exploration, audit, test run | specialist (Claude plugin MCP `specialist_dispatch`, or Pi native specialists) |
| Long-running owned job with a contract: watcher, monitor, audit loop, background check | specialist as above — not one-off only (below) |
| The same judgment repeated over many items, in an operator-approved workflow | AgentRun |
| Interactive or long-owned work, or anything that needs network, `gh` or docker | tmux window worker (below) |

Rules for specialists and AgentRun: `references/fleet.md`, "Specialists and AgentRun".

Specialists are not one-off only. A long-running job with a clear contract
runs as a specialist activation with the same attested issue, readiness gate,
and journal/close discipline as a review: `specialist_list` to choose the
role, `specialist_dispatch` with `issue_ref`, `specialist_status` to supervise,
`specialist_stop_activation` to reap. Definitions resolve global first, then
per-repo (for example `~/.config/specialists`, `~/.specialists`, or per repo
`~/projects/mercury/*/.specialists` such as `market-data/.specialists`).

Keep all window workers in the coordinator's own tmux session, one window each. Details and the
exact launch command: `references/fleet.md`. Short form:

```
xt claude <name> --window --prompt '<skills> ... /goal ...'
```

- Every worker gets its own attested issue before launch. That contract is its brief.
- **The worker knows who dispatched it.** `xt` exports the coordinator's messaging name and
  address (`XTRM_DISPATCHER_NAME`, `XTRM_DISPATCHER_ADDRESS`) and the worker's primer names them,
  so the prompt does not need to. Keep "report with `SendMessage` and journal on your issue" in
  the prompt. A worker that cannot report sends its result nowhere; the same applies to any
  message that expects a reply.
- `xt` exports `SUBSTRATE_HOLDER=<name>`, which stamps the worker's name on every journal entry
  it writes, and the worker claims with `--holder <name>` (same name). After each launch check
  the worker's first entry.
- **Claims are leases** (about 15 minutes by default). The worker claims with `--ttl-ms` that covers
  its checkpoint interval, and claims again (same holder, which renews) at every checkpoint. Put
  this in the worker's prompt.
- If `--window` fails with "requires running inside tmux", restore the tmux variables and launch
  again (`references/fleet.md`, "When --window refuses"). A worker whose worktree already exists
  resumes with `xt attach` (`references/fleet.md`, "Resume a worker").
- **Scratch:** workers put temporary files under `~/.cache/<issue-ref>/`, never delete them, and
  list them in the closure. The operator approves cleanup in batches. A worker never answers a
  deletion prompt for itself.
- Name the worker `<story-key>-<slug>` (for example `ISSUE-260-pi-runtime`). The branch is
  `xt/<name>`, so the Jira key reaches branch names, PR titles and commit trailers, which is what
  the Jira dev panel reads (GitHub for Jira is installed for project ISSUE). The window is
  `claude-<name>` in lower case; target workers by the pane id `--window` prints.
- **Never leave a worker stale.** Each cycle, check every window: working, waiting on a confirmation,
  finished, or dead, and act (`references/fleet.md`, "Liveness"). Arm a background monitor that
  matches confirmation prompts and silence with `tmux capture-pane`, and re-arm it after every launch
  or handoff. The operator answers destructive or privileged prompts.
- **Reap finished workers.** When a worker's issue closes, or it is `done` with its result
  collected, confirm the `result` entry and `tmux kill-pane -t <pane-id>` it in the same cycle (never
  `kill-window`: it can close split panes, including the coordinator). List open
  windows in every handoff (`references/fleet.md`, "Reaping").
- At most 3 own worker windows open at once (every live agent process, not active issues). On a quota 429:
  pause dispatch, tell the operator in one line.
- At 25-30% worker context: `/compact` once, then a fresh worker resumes from `sb issue resume`.

## 4. /goal keeps everyone alive

`/goal` is mandatory for the coordinator and for every worker. Without it a session goes idle
and stale. Author it with `/goal-prompt`; keep it under 4,000 characters; store it as a
`handoff` entry so a successor can find it.

- **Coordinator goal:** programme epic ref, "resume with `sb issue resume <epic>`", horizon =
  the current sprint, the event loop (below), stop predicate (sprint end, operator halt, or a
  handoff at 55% context).
- **Worker goal:** its issue ref, "claim, work, checkpoint after each milestone, close with a
  result", and its stop predicate.
- **Event loop:** check every worker's liveness and re-arm the monitor;
on each worker result, audit it; on each decision, journal it; at sprint end,
update Jira and carry open Stories to the next sprint.

## 5. Continuity

- Handoff at about 55% own context: `sb journal append <epic> --kind handoff`, then compact, then
  re-arm `/goal`. Resume: `sb issue resume <epic>` (root-epic resume summarises children).
- Set `SUBSTRATE_ISSUE_REF` to the programme epic so the pre-compact hook checkpoints.
- Before a restart or handoff, settle or stop every specialist activation you started: a
  coordinator restart orphans them.
- The handoff lists everything the programme depends on that dies or goes stale: open windows,
  monitors, session crons, live specialist activations, and every recurring prompt or scheduled
  trigger (for example the daily report), with what each one says. A scheduled prompt that names
  a retired tool or file is stale: tell the operator, who owns it.
- Session start: `sb issue resume <epic>`, `sb issue tree --root <epic>`, ListAgents and
  `tmux list-windows`, `gh pr list`, the Jira sprint board.

## Modes

- **Light (default):** Substrate plus Jira Epic, Stories and sprints. No production windows. Use
  this unless told otherwise.
- **Full:** adds production windows, release-branch checks and the deploy owner. The release
  steps are Mercury operations, not this skill: use `mercury-release` and `production-ops`, and
  journal their outcomes on the epic. **Jira is the only calendar:** each window is a Jira Task
  with label `window`, a parent and four date fields (`references/jira.md`, "Windows on the Jira
  calendar"). No Google Calendar events.

## Pitfalls

- **Fan-out can lock the host.** Parallel subagents running test suites across several
  coordinators swap-stormed the VPS for 4 hours on 2026-10-18. Keep at most 2 subagents per
  coordinator (1 running tests). Run targeted tests only, under a memory cap. Gate each dispatch
  on available memory and `/proc/pressure/memory`, not on load. Rules: `references/fleet.md`,
  "Limits and health".
- Run `sb` inside a git checkout of the repo, or pass `--project <id>`. Per-verb `sb help` is
  broken in 0.2.2; use `sb help <group>` or `references/substrate.md`.
- A scripted Jira create must have no import-time side effects, and a re-run must not duplicate
  tickets: search by label `substrate:<ref>` before creating.
- Write operator-facing Jira text in plain language: what changes, who runs it, when (UTC).
- Never relay a privileged-action approval between sessions; the operator gives it in the
  session that asks.
- Peers can message twice or cross: answer the newest, do not re-act.

## References

`references/substrate.md` · `references/jira.md` · `references/fleet.md` ·
`references/worked-example.md` · `scripts/jira.py` (Jira REST, token file from `JIRA_TOKEN_FILE`, never
printed).
