---
name: project-management
description: >
  Coordinate a multi-week engineering project with Substrate as the only record and Jira as
  the operator view. One manager session per project and one lead session per workstream plan,
  dispatch workers as tmux windows, audit, and keep /goal alive; a board helper is the only Jira
  writer. Use when starting, resuming or handing over a project or a workstream; when turning a
  list of fixes into themes, sprints and worker contracts; or when the operator asks for a project
  status in Jira. Not for implementing code (workers do that), single issues (use planning), or
  production windows themselves (use the project's release skill, production-ops).
index:
  paragraphs:
    - {id: roles, title: "Who does what", when: "Choosing manager or lead mode; deciding who owns a GO, launch, review, close, Jira write or operator message"}
    - {id: two-systems, title: "The rule: two systems, bound files", when: "Deciding where anything is written; scratch versus durable documents"}
    - {id: shape, title: "Shape of a project", when: "Creating epics, themes, stories, sprints"}
    - {id: start, title: "1. Start", when: "Starting a project"}
    - {id: run, title: "2. Run", when: "Journaling, PRs, reviews, closes, Jira status moves"}
    - {id: fleet, title: "3. Workers (fleet)", when: "Dispatching or supervising workers: preflight, gates, caps (rules 1-6)"}
    - {id: goal, title: "4. /goal keeps everyone alive", when: "Writing manager, lead or worker goals"}
    - {id: continuity, title: "5. Continuity", when: "Compaction, resume, handover, session hooks, bili"}
    - {id: modes, title: "Modes", when: "Choosing Light vs Full"}
    - {id: pitfalls, title: "Pitfalls", when: "Before fan-out, Jira creates, approvals"}
    - {id: operations, title: "Daily operations (added 2026-10-22)", when: "Rules 14-55 (48-50 are the slim way, 55 the sb habit); manager.md holds the daily items"}
  paths:
    - {path: references/manager.md, when: "Acting as manager: rhythm, crons, production windows, operator talk, status board, merges, wind-down", see: [roles, operations, run]}
    - {path: references/lead.md, when: "Launching, resuming or acting as a workstream lead", see: [roles, operations]}
    - {path: references/worker.md, when: "Every worker, at launch and after every compaction", see: [fleet]}
    - {path: references/launching.md, when: "Launch syntax, liveness, reaping, specialists, limits (mechanics only)", see: [fleet]}
    - {path: references/handover.md, when: "Manager handover to the next day's manager, in order", see: [continuity]}
    - {path: references/continuity.md, when: "Compaction, resume, handover, session hooks", see: [continuity]}
    - {path: references/project-start.md, when: "Starting a project; creating epics, themes, stories, sprints", see: [shape, start]}
    - {path: references/setup.md, when: "First-time setup of the pack: tools, settings, config file, secrets, routing roles, session hooks, pm_check.py", see: [start, roles]}
    - {path: references/substrate.md, when: "Contract, issue, journal, claim renewal, links command syntax", see: [start, run, continuity]}
    - {path: references/jira.md, when: "Jira fields, windows, ticket description, comments through post-guard, batch log, transition ids", see: [shape, run]}
    - {path: references/worked-example.md, when: "Full worked pass before acting", see: [start]}
    - {path: references/agentrun.md, when: "Board-scale audit; read the STATUS box first", see: [run]}
    - {path: scripts/jira.py, when: "Jira REST reads, moves, links, attachments (never comments)", see: [run]}
    - {path: scripts/post-guard.py, when: "Every Jira comment; --mention-first for the operator", see: [run]}
    - {path: scripts/route_target.py, when: "Addressing the manager, a lead, the board helper or the team by role", see: [roles]}
---

# Project coordination

A project is work of days or weeks that needs several workers. The manager and the leads plan, dispatch, audit and decide; workers build;
reviewers review. Neither builds or reviews code. Before a critical or unexpected decision, ask the advisor (Agent, Opus, read-only) with
VERIFIED/UNVERIFIED facts and numbered questions. It counts toward the 2-subagent cap and does not replace specialist verification.

**First-time setup.** The pack holds no instance data: the Jira site, project key, Substrate prefix, epic, repo, operator identity, status
names and paths are settings (env var or `~/.config/xtrm/project-management.json`). Read `references/setup.md` and run
`scripts/pm_check.py` before the first command; below, `$PM_*` and `$JIRA_*` name those settings.

**Slim way (operator, 2026-11-07).** Rules 48-50 batch by code area, merge on arrival and batch the rulings; where an older rule is heavier, they win.

## Who does what

Restates rules 28, 36, 37, 40, 54 and `references/lead.md`; adds no rule. Operator, 2026-11-01: less micro-management, more cooperation.

**One role, two modes.** Manager and lead launch with `--role project-manager`; the session role picks the mode. The role comes from the role
file `.pm-role` in the session's worktree (`manager`, `lead`, `board_helper`), written right after launch (`references/launching.md`, "Role
file"); names are a fallback (`*-manager`, `*-lead`, legacy `*-coord`), else `worker` (`references/setup.md`, "Routing roles"). A build lane
is a lead; there is no separate build mode.

| Role | Owns | Does not |
|---|---|---|
| **Manager** (Opus, one per project) | GOs (merge, window, promotion), release windows, merges across workstreams, calendar, escalations, advisor and quant rulings, the operator channel (rules 15, 36), keeping the team staffed: launches the leads, the board helper and its own successor (`references/handover.md`). Answers a lead's proposal within one hourly cycle or 60 min; silence is not agreement. | Route messages between peers, launch builders, write fix lists, relay reviews, tail operator inboxes. Asks for proposals, not status. |
| **Lead** (Sonnet high, one per workstream) | Its workstream end to end: build order, workers within caps, rule-44 reviews, test dispatch, fix lists, merge-ready records, reaping; self-GO inside the workstream; closes its own Substrate issues and orders its own Jira moves through the board helper (operator ruling 2026-11-12, journal seq 2870); settles a cross-workstream dependency with the other lead directly. Opens each batch with the no-trust audit. Messages the manager only for a GO, merge-ready, blocker, data-correctness finding or production anomaly. | Merge, write Jira, hand over a PR it believes is not ready. |
| **Board helper** (`xt pi board-helper`, role `board-audit-runner`) | The only Jira writer (an `@operator` comment too, rule 36), on the order of the manager or the owning lead, with before/after re-reads. Decides alone where each operator comment goes (no routing table). Sends close-sweep mismatches to the owning lead; to the manager only items with no workstream parent (rule 54). | Mutate Jira on its own; let other agents write Jira or read the operator inbox. |
| **Worker** (`--role worker`, `<story>-<slug>`) | One attested issue: build, journal, `result`; closes it when the contract grants closure (rule 54). | Pick its next issue, review its own PR, write Jira. |

**Address peers by role or name, never by socket path.** `python3 scripts/route_target.py manager|board_helper` prints the one live address;
`route_target.py lead` resolves only while one lead is live; `route_target.py --team` lists the project's live sessions by role. Else
`SendMessage` to the peer's session name; with several leads live, take the lead's name from `--team`.

## Read-when index (references are NOT loaded with this skill; open what the trigger names)

- After every compaction and before any launch: `launching.md` "Specialists and AgentRun", "Limits and health"; then the role file: `manager.md`
  (manager), `lead.md` (lead), `worker.md` (worker).
- Manager, before a window, cron or report: `manager.md` §1, §3, §6, §6a, §11; production window, operator talk, cleanup, wind-down: §4, §5, §8,
  §10, §12, §13. Handover: `handover.md`. Board-scale audit: `agentrun.md`.
- Status board: skill `status-board-keeper` (rule 14). New project: `project-start.md`, `worked-example.md`.
- Before a merge, a close or a link repair: `substrate.md` "Merges: the review at the exact head", "Links and the close gate".

## 3. Workers (fleet)

**Mandatory fleet rules (operator, 2026-10-23: they were ignored).** Re-read this section and "Daily operations" after every compaction and every 4 h.

1. **Check the worker shape before every launch** (syntax: `references/launching.md`, "Dispatch surface").
   - `xt pi`: light, continuous work (board helper, watchers, timers, host health). Default `commandcode/deepseek/deepseek-v4.1-flash`; never Muse
     Spark, it stops mid-task (operator, 2026-10-30).
   - Specialists (`specialist_dispatch`, attested issue): bounded heavy work (heavy reads, test runs, audits, investigations, and reviews by rule 44) of ANY role in
     `specialist_list`, never `xt claude` panes, the manager or a lead.
   - `xt claude`: only critical work, heavy building, or `gh`, push, docker with long ownership (operator, 2026-10-28); else `xt pi`, which the
     operator can talk to.
   - State `--model` and `-- --effort <level>`: Opus or Sonnet high for heavy reasoning, Sonnet for routine build and review.
2. **Run the budget preflight before ANY launch** (worker, specialist, subagent) and keep its line:
   ```
   read l1 _ </proc/loadavg; f=$(sed -n 's/^full avg10=\([0-9.]*\).*/\1/p' /proc/pressure/memory); echo "preflight $(date -u +%H:%MZ) load1=$l1 nproc=$(nproc) psi_full_avg10=$f agents_host=$(ps -u "$USER" -o comm= | grep -cxE 'claude|pi')"
   ```
   - **2.2 Gate by action class** (advisor, 2026-10-28; operator row open):
      - Merges and promote-merge: memory gate only (PSI full avg10 <= 10, MemAvailable >= 4 GB), read in the same command.
      - Launches: load1 <= 15 plus the memory gate. Fan-out and per-item loops: load1 <= 10, concurrency <= 2.
      - Production jobs: memory gate, fail closed; log load1; refuse above 2 x nproc.
      - Why: one load1 gate blocked every launch for hours on 2026-10-28; production alone holds load1 at 15-23 in trading hours on this 12-vCPU host.
   - **2.3 Caps** (operator, 2026-10-24; host cap 2026-11-13):
      - Per lead: 3 own worker windows, 2 subagents, 1 test run; specialists count. The manager launches no builders: its windows are the leads,
        the board helper and its helpers; 2 subagents.
      - The cap counts every live agent process (idle sessions included), not issues; `agents_host` counts the whole host. Over a cap: refuse, reap
        first.
      - Host cap (operator, 2026-11-13, replaces q-night-builders): up to 18 live agent processes at any hour while the memory gate holds (PSI full
        avg10 <= 10, MemAvailable >= 4 GB) in the same command as the launch; the load1 <= 15 launch gate still applies. A launch that would pass 18
        is refused even when the lead's own cap allows it.
   - **2.4** Put the preflight line in the launch journal entry. Reap a worker with no journal entry 2 h after its handoff.
      - Incident 2026-10-23 22:30Z: 15 claude, 12 pi, a Paseo daemon: `user-1000.slice` over `memory.high` (14 GiB), load 125, PSI full 77%.
3. **Save context and tokens.**
   - A finished worker whose next task has a different scope gets a fresh session (`sb issue resume`), not a longer chat.
   - Never hand a new task of a different scope to an existing worker, idle or not: it gets its own contract and a new worker (operator,
     2026-10-30: "FRESH CONTEXT, EACH WORK, ALL THE TIME").
   - Same scope may stay with the same worker (operator, 2026-11-04, cost): a fix lane on the same PR, a delta fix after review, or the next
     issue on the same files. The worker writes its `result`, runs `/compact`, claims the next issue and continues; a fresh warm-up per
     issue cost more than the work on small follow-ups. Different files or a different service still get a fresh worker.
     Guards: the lead assigns the next issue (the worker never picks it); one claim at a time, the done report on the old
     issue is sent before the new claim; after `/compact` the worker re-reads worker.md and the new contract and journals
     `continues-from <old ref>`; at most 3 issues or the 60% context line per worker, then a fresh one; the PR reviewer checks the diff
     against the new contract's SCOPE.
   - The manager and leads compact; they do not rotate by context percentage (operator, 2026-10-31): rule 35 and `references/continuity.md`.
   - Routine Opus steps at effort low; rules in skills, not CLAUDE.md; disable unused MCP servers; subagent only to isolate large output.
4. **Do Jira hygiene every cycle** (`manager.md` §12).
5. **Run the wind-down** when the operator ends the day (`manager.md` §13).
6. **Workers, leads and the manager MUST delegate heavy and critical work** to specialists (operator, 2026-10-29).
   - Long test runs, large code or production reads, investigations: `/using-specialists`. Reviews: rule 44 (three Claude paths).
   - Before a production-impacting, data-meaning or irreversible decision: native subagents and the advisor. A builder may coordinate both within the
     cap.
   - The lead launches the rule-44 review for every PR, never the builder whose PR it is.

The worker shapes of rule 1 are interim; XT-132 decides the final one. A long owned job needing no network, `gh` or tmux is a specialist; the same
judgment over many items is an AgentRun workflow (`references/agentrun.md`), never per-item API loops.

- Every worker gets its own attested issue before launch; the contract is its brief.
- **Roster.** One tmux session per project, the manager's: the manager window holds the manager and its helpers (board helper, timers) as
  panes; each lead has its own window; workers go in tiled `workers` windows (at most 4 panes each), never one window per worker.
- Launch `xt pi <name> --window` from the MAIN checkout, then `tmux join-pane -d -s <pane> -t <target>` and `tmux select-layout tiled`.
- **Reaping.** When its issue closes with a result, or it is `done` and collected: confirm the `result` entry, then `tmux kill-pane -t <pane-id>`;
  never `kill-window`, it can close the manager.
- Every handoff lists each live pane's reap condition and the open windows (`references/launching.md`, "Reaping").
- **Superseding a manager or lead:** collect its full report as a `handoff` entry, take over every live duty, journal the takeover list, then
  `kill-pane` its panes one by one.
- **Identity.** `xt` exports `XTRM_DISPATCHER_NAME`, `XTRM_DISPATCHER_ADDRESS` and `SUBSTRATE_HOLDER=<name>`; the worker claims with `--holder
  <name>`; the prompt still says "report with `SendMessage` and journal on your issue". Check its first journal entry after launch.
- **Claims are leases** (about 15 minutes). The worker claims with `--ttl-ms` covering its checkpoint interval and renews at every checkpoint
  with `sb issue renew <ref>` (`references/substrate.md`, "Renew a claim"); it claims again only after the lease expired. Put this in the prompt.
- Name a worker `<story-key>-<slug>` (`PROJ-260-pi-runtime`): branch `xt/<name>`, window `claude-<name>` lower case, so the Jira key reaches
  branches, PRs and commits.
- **Roles come from the role file** (`scripts/pm_role.py`), the session name only as a fallback; peers resolve them at send time
  (`references/setup.md`, "Routing roles"). Never hand out a socket path.
- **Several projects in one config:** every launch, timer and lead sets `PM_PROJECT=<name>` (`references/setup.md`, "Several projects");
  the scripts stop rather than guess.
- **Never leave a worker stale.** Each cycle check every window and act (`references/launching.md`, "Liveness"); keep a prompt-and-silence monitor armed.
- The operator answers destructive or privileged prompts. Quota 429: pause dispatch, tell the operator in one line (rule 30). A Pi session compacts
  like a Claude one: `/compact` typed into its pane through tmux by itself, its lead or the manager (`references/continuity.md`; rule 3 limits).

## Daily operations (added 2026-10-22)

The manager reads `references/manager.md` before the first production window; a lead reads `references/lead.md`. The rules below hold, each
learned from a failure or an operator ruling; where an older rule is heavier, rules 48-50 win.

Rhythm, journal discipline, crons, production windows, Jira windows, workers and specialists, monitoring, operator talk, the status board, cleanup,
the handoff checklist and merge lists live in `references/manager.md` §1-§15 (daily report 22:17Z, claim renewal every 2 h, close sweep hourly,
rule 47); the old items 1-13 were that summary, so the rules start at 14.

14. **Status board** (operator, 2026-10-26; skill `status-board-keeper`): one page whose data changes only through its store, written by the
    `status_board_sync` timer and by the keeper (each hourly cycle one Haiku subagent with the cycle's verified facts: `workers`, `schedule`,
    `followups`). Never a republish, never a daily page. The keeper copies state, never judges, and counts toward the 2-subagent cap.
15. **Pending operator items are Status board `questions` rows** (operator, 2026-10-28): doc `<manager or lead name>`, rows `{id, ref, by, q, rec, why}`.
   - Refresh a row when 5 turns pass after the operator's ask without follow-up; remove it once answered.
   - Enforced by `hooks/operator-questions.py` (XTRM-763): after N operator-silent turns (`operator_question_turns`, default 5) a Stop reminder names the
     open question and one command, `scripts/pm_question.py add|refresh|close --ref <ref> --q <text> --rec <text>`: it writes the Substrate blocker/decision
     AND the row. Cron prompts: start them with `[cron` so they do not count as operator turns.
   - One row per question: never replace a row that holds another open question (11-04).
16. **Worker audits and research become review pages** (operator, 2026-10-28; here.now, operator 2026-10-31): skill `here-now`, never a Claude
    artifact; the project's visual style skill.
   - Light grey page, white cards, no dark theme; follow the reference page the operator approved. Point the `questions` row at it; a file path is not
     a deliverable.
17. **Keep the bases synced** (operator, 2026-10-28, "important"): fast-forward the manager and lead worktrees and the primary master to
    `origin/master` continuously.
   - A `systemd-run --user` timer every 10 min runs an ff-only script (hold the primary when the range touches `config/`); check it hourly; run it
     after every merge.
   - New worktrees start from fresh `origin/<default>` (CORE-2340; `--base` overrides).
18. **Rules go into this skill, not private memory** (operator, 2026-10-28: "recursive self improvement"); commit in `~/.xtrm`, through a worker if
    the edit boundary blocks the path.
19. **DRY is per target:** `make promote` ignores `DRY=1` and opens the real PR; only `make promote-merge` honours it. Read the target first.
20. **Every time comes from `date -u`, and every cron or GO prompt names the band** (operator, 2026-11-07, D39): a GO/DRY comment citing load1, PSI or
    free memory writes the UTC time beside it, read in the same command as the write. A cron, GO or launch prompt names the restart band by its DST
    label as the repo's DEPLOY.md defines it (for example CDT or CST), never a bare UTC hour that silently moves an hour at the DST change.
21. **Prefer a hotfix to a promotion when stable must take one change** (`origin/stable..origin/main` carries other work): branch from stable,
    cherry-pick, PR into stable, deploy, back-merge the same day.
   - Open the back-merge from a branch cut at stable (`git push origin origin/stable:refs/heads/backmerge/<ref>`), never `stable` as head: the repo
     sets `delete_branch_on_merge: true`.
   - Incident 2026-10-30 15:44Z: merging #1162 deleted `stable`; restored at 15:5xZ by
     `gh api -X POST repos/<o>/<r>/git/refs -f ref=refs/heads/stable -f sha=<old tip>`, retargeted PRs reset to base stable.
22. **Pane monitors match prompts, not words:** grep `Allow execution?`, `Do you want to proceed`, `(y/n)`, `[y/N]`, never bare `approve` or
    `Permission`.
23. **Gate by cost; never skip silently** (operator, 2026-10-28: "all checks always"): light work (board cycles, Jira scans, keeper) gates on memory
    only; heavier classes use rule 2.2.
   - A load1 gate on light work deferred it indefinitely (5 deferrals, 111 min, 2026-10-28).
   - A refused gate arms a retry in the same command (gate-watch under a <=25-minute Monitor, or the next background wake); the entry names reading,
     retry task id and deadline. No retry id means a skip.
   - Reference: `$PM_LANE_DIR/gate.py` (`--mode check|watch`; exit 0 open, 1 shut or unknown, 2 timeout; a missing /proc file is UNKNOWN).
24. **Before `/new` on a pane owning loops or timers, stop them at a planned boundary or write the restart into the handoff and resume line** (R2
    hop); a rotation killed the R2 intake loop for 40 min, 2026-10-28.
25. **Close on finish** (operator, 2026-10-28): when a worker or specialist ends, its owner (rule 54) closes its Substrate issue with a result and
    orders its Jira row moved by transition id through the board helper, same cycle. Check both at reap and at `specialist_stop_activation`; the
    hourly sweep and the daily counts are rule 47.
   - A scripted batch (drift check, PR-on-stable, hygiene rows) gets a Claude judgement pass before ANY Jira write: on 2026-11-07 the drift script
     proposed 10 of 25 rows wrong, because it reads a PR on stable as Done. The judged list is the batch's evidence, one `finding` entry.
26. **A loop of per-item local CLI calls is fan-out:** load1 <= 10, concurrency <= 2, one bulk read where possible; a per-issue `sb` loop over ~300
    issues pushed load1 to 33 at 22:25Z on 2026-10-28.
27. **Several changes per night** (operator, 2026-11-04: "more than one change allowed per halt, not one, otherwise we finish after christmas"; replaces
    the folded-night ban and the one-change-per-window rule): a night, halt or window carries several changes, of any service, each a row of the night plan
    with its own pre-written verify check and rollback (revert the commit or env key, restart).
   - Capacity (build, review, promotion time) or a real conflict is the only reason to move a second change.
   - Image changes first, then config, applied separately with verify between where possible.
   - A deploy-watcher or production-monitor specialist watches from the reopen to +60 min; the plan names the executor and attribution order.
28. **One lead per workstream** (operator, 2026-10-31; the build lane became a lead, 2026-11-13): a lead owns launches, reviews (rule 44),
    merge-readiness and hand-offs in its workstream; the manager rules only on GOs, windows, escalations.
   - It works by `references/lead.md`; every builder launch states model and effort; every lead prompt and resume line names that file.
29. **The manager is Opus, with advisor and quant rulings; all else is Sonnet or pi, except reviews (rule 44):** leads Sonnet high, builders Sonnet
    or `xt pi` by rule 40, reviews on Claude only (rule 44), board helper and light fixes on `xt pi`.
   - Several Opus sessions hit the usage limit at 23:0xZ on 2026-10-28 and stopped every Claude pane.
   - A PR depending on data meaning (timezones, roll rules, bar semantics) also needs an Opus quant ruling before GO-ready.
30. **On "usage limit reached":** pause launches, tell the operator in one line; after the reset send each pane "limit reset; resume from your last
    journal entry; renew your claim (claim again only if the lease expired); report" (2026-10-28).
   - A worker that cannot continue hands its remainder to a named owner and releases its claim; a silent dead pane looks slow.
31. **Pane monitors check liveness, not geometry:** match `#{pane_dead}`, pane existence, "usage limit reached", `401: {`; re-arm after each launch or
    reap (a 2-row pane read as GONE, 2026-10-28).
32. **A worker refused by its Edit hook never works around it through the shell:** its lead (or the manager) launches a short session in the
    protected repo, the hook being the only guard against cross-repository writes (a sibling repository, 2026-10-28).
33. **Service operating knowledge lives in service-knowledge** (operator, 2026-11-07, D39): what a service is, its tables, readers, checks and traps go into
    the service-knowledge pack through its update flow, never into this skill and never into `DEPLOY.md` (which keeps standing deploy rules only).
    `service-knowledge-sync` is REQUIRED for every promotion to stable (operator, 2026-10-29): dispatch it from the stable SHA after promote-merge; the
    promotion is done only when its result is journaled (interim until the GitHub app exists).
34. **A window's PASS/STOP criteria come from a traced artefact** (PR-head output plus a live read-only count), never a message; store its path in the
    window.
   - 2026-10-29: a message-stated "64 or 61" went into a window and accepted a STOP case; the traced output showed only 61.
35. **Lessons of 2026-10-30 (fri30-coord):**
   - Detect a closed pane with `tmux list-panes -a -F '#{pane_id}'`; `tmux display -p -t <gone pane>` prints nothing and exits 0.
   - Paste a SHA in a GO, merge or journal entry from `gh`/`git`, never type it (a made-up suffix reached a #1146 GO).
   - A nightly restart that fast-forwards the deploy clone to `origin/stable` ships what is on stable then (the repo's DEPLOY.md names it).
   - A specialist `model_override` to a Claude model is refused (HTTP 400): native Agent subagents for Claude work, pi/commandcode for specialists.
   - A swap script that allows one swap per halt refuses a second: plan one image swap plus config at that halt.
   - An R-MULTI night (rule 27) gets a deploy-watcher or production-monitor specialist from the restart to +60 min, reading Prometheus through mcpq
     and health checks, not only container state.
   - Text sent to a pi pane with `send-keys -l` may sit unsubmitted: send `Enter`, capture the pane, confirm it works.
   - `sb plan apply` parentKey takes the flat issue id (`$PM_SB_PREFIX-n`), not the locator.
   - A Claude session does not load an MCP server approved after its start, even after `/mcp`: restart or rotate the pane.
   - Read the latest handoff's fleet line before reaping a pane; "never reap" panes (operator-owned) stay. 2026-10-30 19:0xZ: fri30-coord reaped the
     operator's MMD-3170 pane %404, restored with `xt attach <slug>`.
   - Rotation: the outgoing launches the successor and the successor reaps the outgoing (`references/handover.md`); leads and workers rotate at
     24 h, the manager at the day boundary (`references/continuity.md`).
   - PR-lane lessons (MMD-3012 seq 420-425): pin runbook commands to the merge commit (`M^1..M`); never cite `~/.cache` scripts in repo docs.
   - A subagent-written service-knowledge sync gets a claim-level check against the stable-SHA code; tests assert exact sets against an independent
     literal; a cron acting on a PR re-reads head and base from `gh`.
36. **Operator attention goes to Jira with a mention** (operator, 2026-10-30): one comment on the ticket starting `@operator`, posted only by the
    board helper through `scripts/post-guard.py <KEY> <file> --run <WORD> --mention-first`, which makes it a notifying mention (`jira.py` refuses
    comment posts).
   - A worker sends the text to its lead (none: the manager); on the lead's or manager's order the board helper posts it (sun01-coord, 2026-11-01).
   - Plain words: what and why, recommendation first, links to every artifact. The owning lead or the manager also keeps the `questions` row
     (rule 15). Worker rule: `references/worker.md` section 2.
37. **Every dispatch points the worker to its rules** (operator, 2026-10-30): each launch prompt, specialist contract and post-compaction resume line
    names `project-management` and `references/worker.md`, or a worker reports nowhere and tags nobody.
   - Launch with `--role worker` (`xt claude|pi <name> --window --role worker --bead <ref>`; MMD-3200; `references/launching.md`, "Dispatch a builder
     (worker role)"): attested contract is the prompt.
   - Other roles get this prompt line: "Load project-management and read references/worker.md first; you may coordinate specialists
     (/specialists:using-specialists) and consult the advisor."
38. **Providers are interchangeable** (operator, 2026-10-30, c15942: "when one stops working, we just switch it"): on quota, 401 or stalls
    switch to a working one, journal it, do not ask or park. Default commandcode DeepSeek V4.1 Flash; opencode-go unused.
39. **Token economy** (operator, 2026-10-30 20:15Z: "we're wasting a lot of tokens"), binding for all:
   - Every launch prompt loads the specialists skill; heavy reads, test runs and investigations go to specialists; reviews follow rule 44.
   - Chat output is minimal ASD-STE100: state, decision, next step. Operator items go to Jira comments.
   - One script per step, filtered in the script, returning counts and matching lines. Peer messages: one fact per line, pointers not pastes.
40. **Report by journal, message by exception** (operator, 2026-11-04: 13% of the weekly budget used by 09:00Z on day 1; every message wakes
    the receiver and costs a full read of its context):
   - A lead messages the manager only for a GO request, a merge-ready record, a blocker, a data-correctness finding or a production anomaly (a
     secret exposure, a usage limit or provider stop, or shared state changed by mistake is a blocker). A worker messages its lead for those and
     for a decision, a contract conflict or a scope deviation. Pane-liveness monitors (rule 31) stay on: a silent dead worker must not wait for the
     hourly read. Status, "done, reaped", "record kept" and progress go to their own journal; the manager reads lead journals once per hourly cycle
     (`sb journal since <ref> <seq>`). One message carries every decision of the hour.
   - The manager or the owning lead orders Jira by intent (what changes, why, which rows); the board helper words it in plain language and reports
     ids once per order batch. Dictating comment text is micro-management; use it only for an operator-facing @operator comment.
   - Ask before answering: a peer message that needs no decision gets no reply.
   - Choose the builder shape per task (operator, 2026-11-04, replacing "mandatory Sonnet"): `xt pi` or `xt claude` Sonnet, judged
     on how complicated the task is, how long it runs, and whether the worker can be reused after a compaction (rule 3). The best
     results come from the contract: a clear, well-scoped Substrate issue (`/planning`, `/substrate:using-substrate`) is the main
     lever, for pi more than for Sonnet. A pi builder is managed: tight SCOPE and VALIDATION, a check of its first journal entry and
     its first diff, and a rule-44 review (Claude, never pi) before merge-ready. Opus only for the manager and for quant/advisor rulings,
     batched into one session where the questions allow it; a Sonnet lead asks the Opus advisor on critical decisions or doubts.
     On a usage limit apply rules 30 and 38 (pause, switch provider), never stop silently.
   - A lead whose context may be rotted (long session, repeated corrections, contradicted facts) rotates at a clear checkpoint: a
     handoff entry first, then a fresh session from it, never mid-window.
   - Usage: every ~3 h rank sessions by cost (`bunx ccusage@20.0.48 session --since <YYYYMMDD> --json`, top 6) and act on the top one;
     the ranking, not a guess, says where the budget goes.
   - The manager and leads compact at a clear checkpoint (operator, 2026-11-04: not a hard threshold): after a decision batch, a
     window close or a handoff entry, never mid-window or mid-ruling. Context size (~150k) is a cue to look for the next checkpoint,
     not a trigger: every wake re-reads the whole context, so a smaller context is cheaper on every message, timer and Monitor wake.
   - When only time-gated work remains, arm ONE background wake for the next item and end the turn; a goal check-in or Stop-hook
     nudge gets a one-line answer, not a full state restatement.
   - Re-homed duties carry their premises as UNVERIFIED: check the one load-bearing premise with one command; drop the duty when it is
     stale.
41. **Reconstruct the window lineage before every deploy or window GO** (operator, 2026-11-04: "no work that might be newer, already
    merged, or planned"). The manager and the owning lead, at the 60-minute check and again just before the make target:
   - Run `scripts/window-lineage.py --repo <repo> --service <service-registry key> --vehicle <SHA> --term <service word>` (read-only).
   - Answer from its output: (a) the vehicle is on stable and carries the newest commit for those paths that should ship; (b) each
     newer master commit on the paths is named "rides the next promotion", or the window waits for it; (c) each open PR on the paths
     is `stack` (ships in this window under rule 27), `after` (a later window, named) or `conflict` (stop and rule); (d) planned
     Substrate issues and Jira windows on the same service (board helper read) do not supersede or reorder this window.
   - Put the four answers in the GO entry. A GO without them is not a GO. gh or sb failure prints UNKNOWN, never zero.
   - The script once printed a false 0 open PRs (glob bug MMD-3928, 11-04): pass a literal `--paths`, or answer (c) with `gh`.
42. **Lessons of 2026-11-04.** Shell and tool traps: `references/manager.md` §14.
   - Cooperation is a rule (operator): the manager, the leads and the board helper decide together, propose with evidence and answer within the
     hour; within 20 min of a window the manager decides alone and records (`references/lead.md` §5).
   - A faster or better way toward the project goal changes the schedule: do it, journal the decision, order the board to match the same
     day; never wait for a successor.
   - Never hand over a stale board: apply every ruling to the Jira windows and Substrate issues before the handoff entry.
   - Sunset rule (MMD-3751 seq 189): no capacity on a part with a dated retirement unless it is served-and-wrong-and-persists, a removal, the
     replacement imports its code (grep-proved) or a free rider; carry its requirement into the replacement's VALIDATION before closing.
   - Service-knowledge first: query it before source; when code and docs disagree fix the doc (`service-knowledge-sync`) in the same cycle and
     journal the marker.
   - Hold stable merges while a window's GO checks "primary HEAD == origin/stable": a moving stable breaks that GO.
   - Verify each peer claim with one live read before it drives an action (Run section).
43. **Prerequisite check is the GO owner's duty (operator, 2026-11-05, c17078: "not mechanically merging whatever a 3 weeks old
    session decided").** Before a window is scheduled, at its T-60 and before every GO or merge, the manager (or the lead, for a self-GO inside
    its workstream) itself proves each precondition is DONE now, with one live read per precondition (running image or env, table, flag, PR
    state, CI, gate result), never from the ticket, an old ruling or a peer report.
   - Write the list in the GO entry: precondition, live evidence, UTC time. One unmet or UNKNOWN precondition = no slot, or NO-GO and
     re-slot with the missing item named and owned.
   - Old decisions are inputs, not authority: re-check their premise against today's code and production before acting on them.
   - Upstream infrastructure (CI runners, images, tokens) is a precondition too: a stalled build is diagnosed and fixed at once, not waited on.
   - Incident 11-05: one window slotted with a database mirror OFF and a crashing parity script; another with an unverified C5; a
     write-mode roll check broke 18 roots for 41 h; CI runners refused for hours before anyone looked.
   - Look-ahead for the next 48 h: rule 45.
44. **Reviews run on Claude as `pr-reviewer`** (operator 2026-11-06, seq 2885, 3023; three paths allowed 2026-11-13), any of: `xt claude --role
    pr-reviewer --model opus|sonnet`; the native `reviewer` subagent in PR review mode (it sets `XTRM_ROLE=reviewer` on every `gh` call, so the
    shim posts as the reviewer bot); the `pr-reviewer` specialist through `claude-bridge` (`model_override` for Opus). Opus for HIGH/CRITICAL,
    data-meaning, production or schema PRs. Merge-ready needs an `xtrm-reviewer[bot]` review at the head with "Ledger check: exit 0".
   - Never an `xt pi` worker, a non-Claude model, or a `gh pr comment` verdict (a comment pins no head).
   - The lead launches the review; the builder never reviews its own PR.
   - A second opinion is a second rule-44 review (any path), never a `seconder`.
45. **Window look-ahead: rule 43 extended** (operator, 2026-11-06: the precondition checks found missing items and nobody tried to land them early).
    At each day boundary and at 12:00Z the manager runs the rule-43 precondition check for every window in the next 48 h (the board helper
    lists them).
   - Each missing or UNKNOWN precondition becomes, the same hour: (a) a Substrate issue with owner and due date before the window's T-60; (b) a lead
     assignment, or a deeper check (specialist or subagent) to find the cause; (c) a re-check at T-180.
   - A window whose precondition cannot land is re-slotted the day before, never discovered at T-60.
   - Finding a gap is not done; landing it or moving the window is.
46. **Jira ticket description: the /planning sections in plain words** (operator, 2026-11-06: descriptions were a mix, some unclear). Every ticket
    description has: Context (problem), Outcome (success), Scope, Not in scope, Constraints and decisions (with rejected alternatives), How we check
    it (validation), Deliverable and window (output, make target, rollback), Substrate ref. Template: `references/jira.md` "Ticket description".
   - It is a brief for a human, not a copy of the Substrate journal.
   - One ticket per operator-visible deliverable or window, never one per worker task.
   - A follow-up named to the operator exists first as a Jira row with window fields (or explicitly "dates only") and a Substrate issue.
47. **Close-on-finish sweep: rule 25 extended** (operator, 2026-11-06: Substrate issues were left open after their work ended). An issue whose work
    ended is closed the same cycle with `sb issue close --outcome ... --result ...`.
   - Each lead's hourly cycle runs `sb issue list --status in_progress` and `--status open` for its workstream, the manager's for issues with no
     workstream parent. For each item older than 48 h without a journal entry the owner closes it, re-assigns it, or journals why it stays open.
   - The daily report states the open count and the closed count.
48. **Batch by code area** (operator, 2026-11-07, MMD-2331 seq 2414, 2415): one PR per code area, never one per reader, family or file set; one promotion
    and one deploy per objective. No compatibility shim and no per-reader flag while there are no users: the reader reads the new source in code, the old
    switch and the old views go in the same branch, and a reader that cannot switch stops cleanly until its PR arrives. One Opus review covers the batch.
49. **Merge on arrival** (same ruling): the manager merges each merge-ready record at once, memory gate and `--match-head-commit` in the same command;
    there is no merge queue to a window. A master-only merge needs no window of its own: it rides the promotion that carries it. Only a merge that itself
    deploys needs a window, and one window carries the objective (rule 48).
50. **Batch the rulings** (operator, 2026-11-07, D39; MMD-2331 seq 2424): one Opus quant session per batch of questions, not one per PR; one review of the
    whole batch (rule 44). A contract revision is a diff the lead checks and attests within minutes, not a new planning cycle.
51. **Land as soon as ready; never cut the operator's scope** (operator, 2026-11-09, MMD-2331 seq 2523-2525). A release ships complete: no
    end-user feature moves to a minor or patch release to save time. Deploys land in production as soon as they are ready; PRs and promotions are
    stacked, with no fixed promotion days: promote each merge-ready batch the same day and deploy in the next allowed slot. Speed beats the safety
    bottlenecks we added; the hard rules stay (make targets, DRY first, memory gate, rules 41 and 43). A technical ruling never narrows a scope the
    operator set (history depth, feature set) without the operator's word: check each ruling's premise against the stated goal.
   - Incident 11-09: the 11-07 quant ruling set the bar rebuild floor at 2023-08-14 (session calendar horizon); the lead accepted it and the
     operator's ten-year rebuild drifted for two days. Restored as Tier 5 (MMD-4359).
52. **The contract names its specialist chain; use the whole roster** (operator, 2026-11-11: "seconder never used, test-engineer little,
    overthinker never"). Source: using-specialists `references/chain-recipes.md`, lightened by the operator. Run `specialist_list` before every
    dispatch and pick by work shape, not habit. Builders run their own tests; no `test-runner` step is required.
   - Every build contract's VALIDATION names its chain by SCRUTINY:
     | Work shape | Chain |
     |---|---|
     | LOW, trivial (typo, one line) | build, then the Claude review |
     | MEDIUM production diff | build -> `seconder` -> Claude review |
     | HIGH, or approach unknown | `explorer`/`researcher`/`overthinker` evidence first if the approach is unclear; build -> `seconder` -> `test-engineer` -> `obligations-scanner` -> Claude review |
     | unknown cause | `debugger` first, then the chain of its scrutiny; a regression test is mandatory |
     | CRITICAL or sensitive (migrations, secrets, auth, MCP or agent config) | `security-deep`: `security-auditor` before and after the build, `seconder`, `test-engineer`, `obligations-scanner`, Claude review |
     | risky decision (production, data, irreversible) | `overthinker` (premortem) plus the `advisor` agent for the final call |
   - The review follows rule 44 (any of its three Claude paths). Specialists run on Claude models
     through `claude-bridge` since 2026-11-13: a step that needs Claude may now be a specialist (set it in the bridge allow list).
   - The lead does not attest a build contract whose VALIDATION does not name the chain. The merge-ready record lists the activation id of each
     step, or the scrutiny reason for a skipped step.
   - The daily report counts dispatches per role; `seconder`, `test-engineer`, `overthinker` or `obligations-scanner` at 0 for a week is a finding.
53. **Planning shape at create** (rule 46 extended, operator 2026-11-11): every `sb issue create` and every Jira ticket ordered from the board
    helper follows /planning: PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION, OUTPUT, plus SCRUTINY; plain words for Jira. A
    contract missing a section is not attested; a Jira order without the sections is not sent.
54. **Who closes** (rules 25 and 47; operator 2026-11-11, less pressure on the lead; 2026-11-12, seq 2870). A worker closes its own issue in the
    turn it writes its `result` when its contract grants closure, else its lead closes it; a lead closes its own issues. Each board-helper cycle
    (skill `board-audit`) lists every project issue (prefix `$PM_SB_PREFIX`) with a `result` entry still open, and every Jira row not Done whose
    Substrate issue is closed, and proposes the batch to the owner: the owning lead, or the manager for items with no workstream parent. The owner
    orders the closes and transitions in one word. After every compaction a lead reads the latest sweep before new work. A Stop-hook close nudge
    waits for the xtrm-wide hook (operator, 2026-11-11).
55. **Read the help before a new `sb` verb** (operator, 2026-11-13): before a `sb` verb you have not used this session, run `sb help <group>`
    (`sb help issue`, `sb help journal`). Underused verbs: `sb issue renew` (keep a lease), `sb links check|sync` (close-gate rows),
    `sb provenance trace` (PR and commit spine), `sb issue tree`, `sb issue relate`, `sb issue edit --context-refs` (bind a document),
    `sb journal since <ref> <cursor>` (read only what changed).

## The rule: two systems, bound files

| System | Holds | Written by |
|---|---|---|
| **Substrate** (`sb`) | contracts, plan, decisions, questions, evidence, handoffs | manager, leads and workers |
| **Jira** | the operator's view: project, themes, sprints, human steps, calendar | the board helper, on the order of the manager or the owning lead |

- **No shadow tracker:** no `PLAN.md`, TODO list, journal file or handoff markdown that duplicates Substrate. Plan = project epic contract and
  `sb issue tree`; log = the epic's journal; worker brief = the issue contract; goal prompt = latest `handoff` entry.
- Open question = a `blocker` entry, answered by a later `decision`. Handoff = `sb journal append --kind handoff`, then `sb issue resume`.
- **Scratch** under `$PM_STATE_DIR/<issue>/` is free (drafts, evidence captures, launch scripts) and never the deliverable: its content reaches
  Substrate or Jira in the same step.
- **Durable documents** (ADR, PRD, design notes, runbooks) are allowed when they matter, made permanent and bound: committed to the repo through a
  PR; bound to the Substrate issue (a `decision` entry citing `path@sha`; `sb issue edit --context-refs` when the document defines the work, at
  planning time, since it makes a new revision; `sb issue close --artifact` at closure); attached to the Jira ticket when the operator should see
  it (the board helper, `jira.py attach` through the guarded path).
- A file kept beyond the session is bound to a ticket or an issue; anything unbound is scratch. Commands: `references/substrate.md`.

## 2. Run

- **Journal what matters on the epic**, one fact per entry (`decision`, `finding`, `blocker`, `milestone`, `result`). Read back with
  `sb journal since|latest|timeline`; `--json` gives the full entry.
- **New finding:** child issue, `sb issue relate --kind discovered_from`, ref added to the Story. **Scope change:** a new contract revision, never a
  journal entry.
- **A PR that itself deploys needs a window Task; a master-only PR does not** (rule 49): it rides the promotion in its body, with a `no-window` note
  (`references/jira.md`, "PR readiness rule").
- **Every PR:** review, decision, fix, delta check, then merge on arrival with `--match-head-commit`. After the merge confirm main equals the head CI tested; if
  another PR merged between, the next CI or a canary must prove the combination (with no CI on push to main, nothing else will).
- **Review at the exact head you merge.** A push after the review makes it stale; the merge guard (`xt identity merge-check`, run by the `gh`
  shim on every `gh pr merge`) refuses a stale or missing review. The marker's `run=` is the agent session id, never `XTRM_SESSION_ID`
  (`xt identity marker-check`). Details: `references/substrate.md`, "Merges: the review at the exact head".
- **Close** with `sb issue close --outcome ... --reason ...`, citing the result entry and PR.
- **The close gate reads link rows, not prose.** Done needs a live artifact for the delivering PR or commit, or the merged trailer commit; a
  mention alone is refused. `sb links check` reads the verdicts, `sb links sync` reconciles; never invent a link (`references/substrate.md`).
- **Every load-bearing claim gets one live check** (git, tree, tests, system) before it drives an action or reaches the operator; all roles produced
  confident wrong claims.
- **Read the board before the first Jira write** (`references/jira.md`, "Read the board first"); record the profile once as a `finding`.
- **Substrate drives Jira status; nothing else does.** No Automation rule or smart commit; the board's dev panel is evidence only.
- Until `sb jira` exists (XTRM-639) the owning lead or the manager orders each move the day of the event and the board helper writes it, by
  transition id, never name (one id meant Done on one board and Deferred on another; the board's ids live in the config, `transitions`).
- **Board-scale checks run as AgentRun workflows, not API loops** (`references/agentrun.md`); `decide` nodes did not run on this host as of
  2026-10-22: stop and escalate. Snapshot once, judge in parallel, read verdicts.
- **Post results to Jira as comments** (the board helper writes them) with the Substrate ref; the daily report is a `result` entry on the epic, then a
  comment on the Jira Epic. Never copy journals into Jira fields.

### Jira writes: one path, enforced in code

Every comment goes through `scripts/post-guard.py`, shipped with this skill; `scripts/jira.py` refuses a direct `POST .../comment`, so an ad-hoc
comment writes nothing. Checks, flags and read-back: `references/jira.md`, "Comments: post-guard.py".

```
~/.xtrm/skills/optional/project-management/project-management/scripts/post-guard.py <KEY> <text-file> --run <WORD> \
  [--mention-first] [--force] [--dry-run] [--update <cid>] [--reply-to <cid>] [--own-writes <file>] [--run-file <file>]
```

## 4. /goal keeps everyone alive

`/goal` is mandatory for the manager, every lead and every worker. Author it with `/goal-prompt`, under 4,000 characters, stored as a `handoff` entry.
- **Manager and lead goal:** epic or workstream ref, `sb issue resume <ref>`, horizon = current sprint, event loop, stop predicate (sprint end,
  operator halt; the day boundary for the manager); no context-percentage hand-off clause.
- **Worker goal:** issue ref, "claim, work, checkpoint after each milestone, close with a result", stop predicate.
- **Event loop:** check liveness and re-arm the monitor; audit each result; journal each decision; at sprint end update Jira and carry open Stories
  forward.

## 5. Continuity

Compaction, resume, handover, the pack session hooks: `references/continuity.md`; wiring: `references/setup.md`, "8. Session hooks".

## Modes

- **Light (default):** Substrate plus Jira Epic, Stories, sprints; no production windows.
- **Full:** adds production windows and the deploy owner (the project's release skill, `production-ops`). **Jira is the only calendar:** a Task with label
  `window`, parent its theme Epic, four date fields (`references/jira.md`).

## Pitfalls

- **Fan-out can lock the host:** parallel subagents running test suites swap-stormed the VPS for 4 h on 2026-10-18. Targeted tests only (rules 2.2,
  2.3; `references/launching.md`, "Limits and health").
- A scripted Jira create has no import side effects and must not duplicate: search label `substrate:<ref>` AND the exact summary first, comparing the
  summary as an exact string after the read (one ref can serve two themes).
- Write operator-facing Jira text in plain words: what changes, who runs it, when (UTC). Never relay a privileged approval between sessions. Answer
  the newest of two crossed peer messages.

## Shape of a project

Epics, themes, stories, sprints, the Jira mapping and an Epic with more than ~20 children: `references/project-start.md`.

## 1. Start
Starting a project, step by step: `references/project-start.md`.
