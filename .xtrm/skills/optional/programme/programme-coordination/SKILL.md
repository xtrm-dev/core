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
index:
  paragraphs:
    - id: two-systems
      title: "The rule: two systems, no files"
      when: "Deciding where anything is written"
    - id: shape
      title: "Shape of a programme"
      when: "Creating epics, themes, stories, sprints"
    - id: start
      title: "1. Start"
      when: "Starting a programme"
    - id: run
      title: "2. Run"
      when: "Journaling, PRs, reviews, closes, Jira status moves"
    - id: fleet
      title: "3. Workers (fleet)"
      when: "Dispatching or supervising workers"
    - id: goal
      title: "4. /goal keeps everyone alive"
      when: "Writing coordinator or worker goals"
    - id: continuity
      title: "5. Continuity"
      when: "Handoff, resume, restart"
    - id: modes
      title: "Modes"
      when: "Choosing Light vs Full"
    - id: pitfalls
      title: "Pitfalls"
      when: "Before fan-out, Jira creates, approvals"
    - id: operations
      title: "Daily operations (added 2026-10-22)"
      when: "Running a coordinator day: crons, monitors, windows, specialists, reports, artifact"
  paths:
    - path: references/substrate.md
      when: "Contract, issue, journal command syntax"
      see: [start, run, continuity]
    - path: references/jira.md
      when: "Jira fields, windows, binding rule, recipes"
      see: [shape, run]
    - path: references/fleet.md
      when: "Worker launch, liveness, reaping, limits"
      see: [fleet]
    - path: references/worked-example.md
      when: "Full worked pass before acting"
      see: [start]
    - path: scripts/jira.py
      when: "Jira REST calls"
      see: [run]
    - path: references/coordinator-operations.md
      when: "Daily rhythm, journal result payloads, crons in local time, windows, specialists and subagent roles, operator questions, progress artifact, cleanup"
      see: [operations, run, fleet]
    - path: references/agentrun.md
      when: "Board-scale audits — prefer AgentRun over per-item API"
      see: [run, fleet]
    - path: references/coordinator-transition.md
      when: "Handover to a successor coordinator: helper reports, handover file, cron/monitor/claim order"
      see: [continuity]
---

# Programme coordination

A programme is a body of work that spans days or weeks and needs more than one worker.
The coordinator plans, dispatches, audits and decides. Workers build. Reviewers review.
The coordinator never builds or reviews code itself.
Consult the advisor (Agent, Opus, read-only) with VERIFIED/UNVERIFIED facts and numbered questions before every critical or unexpected decision; it counts toward the 2-subagent cap and does not replace specialist verification, to avoid confident wrong calls.

## Read-when index (references are NOT loaded with this skill; open what the trigger names)

| Trigger | Read |
|---|---|
| After every compaction; before any launch | references/fleet.md "Specialists and AgentRun", "Limits and health" |
| After every compaction; before a window, cron or report | references/coordinator-operations.md §1, §3, §6, §6a, §11 |
| Drafting a Jira change for the board helper; windows; batch change log | references/jira.md "Windows on the Jira calendar", "Ticket description", "Batch change log" |
| sb syntax, contract JSON, result payloads | references/substrate.md |
| Handover to a successor | references/coordinator-transition.md, in order |
| Board-scale audit | references/agentrun.md (STATUS box first) |
| Progress artifact data each cycle | skill tabellone-keeper (Haiku keeper) |
| Dispatching any worker; a worker after compaction | references/fleet.md "Dispatch a builder (worker role)" and references/workers.md (the worker's own rules; every launch points to it) |
| New programme only | "Shape of a programme", "1. Start" (end of file), references/worked-example.md |

## 3. Workers (fleet)

**Mandatory fleet rules (operator, 2026-10-23).** The operator reported that these were ignored.
Re-read this section and "Daily operations" after every compaction and every 4 hours, before the next dispatch.

1. **Check the worker shape before every launch.** Exact commands: `references/fleet.md`, "Dispatch surface".
   - `xt pi` does light, continuous work: the board helper (one per coordinator; skill `board-audit`, "Continuous helper cycle"), watchers, timers, host health. Model: DeepSeek V4.1 Flash (`commandcode/deepseek/deepseek-v4.1-flash`), the default. Do not use Muse Spark: it stops mid-task and idles (operator, 2026-10-30).
   - Specialists (`specialist_dispatch` with an attested issue) do bounded heavy work: heavy reads, reviews, test runs, audits, investigations. This work does not go to `xt claude` panes or to the coordinator.
   - `xt claude` only for critical work and heavy building, or work that needs `gh`, push or docker with long interactive ownership (operator, 2026-10-28). Everything else that needs a window goes to `xt pi`, because the operator can talk to pi panes directly. Specialists of ANY role in `specialist_list` may be used for bounded work. Choose the model with judgement and state it in the launch (`--model`, plus `-- --effort <level>`): Opus, or Sonnet at effort high, for heavy reasoning; Sonnet for routine build and review.
2. **Run the budget preflight before ANY launch** (worker, specialist, subagent). Launch checklist:
   1. Run the preflight in one command and keep its output line:
      `read l1 _ </proc/loadavg; f=$(awk '/^full/{sub("avg10=","",$2);print $2}' /proc/pressure/memory); echo "preflight $(date -u +%H:%MZ) load1=$l1 nproc=$(nproc) psi_full_avg10=$f agents_host=$(ps -u "$USER" -o comm= | grep -cxE 'claude|pi')"`
   2. Refuse or queue by the gate of the action's class (advisor correction 2026-10-28; the coordinator ruled and the operator row is open):
      - Merges and promote-merge: memory gate only (PSI full avg10 <= 10, MemAvailable >= 4 GB), read in the same command.
      - Launches: load1 <= 15 plus the memory gate (coordinator ruling 2026-10-28; operator row open).
      - Production jobs: hard memory gate (fail closed); log load1; refuse above 2 x nproc.
      - Fan-out and per-item loops: load1 <= 10, concurrency <= 2.
      A single load1 gate for every action blocked every launch for hours on 2026-10-28, because production alone holds load1 at 15-23 in trading hours on this 12-vCPU host.
   3. Caps (binding; operator 2026-10-24): per coordinator at most 3 own worker windows (xt claude or xt pi) plus 1 board helper (xt pi), at most 2 subagents and 1 test run. Host cap 10 (operator, 2026-10-28). While operator row q-night-builders is open, a coordinator may run up to 12 between 22:00 and 12:00Z as a journaled exception. Specialists count toward the cap. The operator's answer replaces this line. (`agents_host` above counts claude and pi for the user on the whole host, all coordinators included.) Refuse the launch when it would exceed a cap. Reap first.
   4. Record the preflight line in the launch journal entry on the worker's issue.
   - Reap a worker with no journal entry for 2 h after its handoff.
   - Incident 2026-10-23 22:30Z: 15 claude, 12 pi and a Paseo daemon pushed `user-1000.slice` over `memory.high` (14 GiB), with load 125 and PSI full 77%.
3. **Save context and tokens.**
   - A worker that finishes a task gets a fresh session (`sb issue resume`), not a longer chat.
   - Never hand a new task to an existing worker, idle or not (operator, 2026-10-30: "FRESH CONTEXT, EACH WORK, ALL THE TIME"). Every new piece of work, audits and research included, gets its own sb contract and a newly launched worker; reusing an idle helper such as a board pi mixes contexts.
   - A coordinator hands off at 60% context, then compacts.
   - Routine Opus steps run at effort low.
   - Keep rules in skills, not in CLAUDE.md.
   - Disable the MCP servers a worker does not use.
   - Use a subagent only when it isolates a large output.
4. **Do Jira hygiene every cycle** (`references/coordinator-operations.md`, section 12).
5. **Run the wind-down protocol** when the operator ends the day (`references/coordinator-operations.md`, section 13).
6. **Heavy and critical work is delegated** (operator, 2026-10-29). Workers and coordinators MUST use
   specialists (`/using-specialists`) for long test runs, large code or production reads, reviews and
   investigations. For critical work, they also use native subagents and the advisor (Agent, Opus,
   read-only, with VERIFIED/UNVERIFIED facts and numbered questions) when needed, exactly as the
   coordinator does: before a production-impacting, data-meaning or irreversible decision. A builder
   may coordinate specialists and subagents itself, within the subagent cap. The `pr-reviewer` for
   every PR is dispatched by the build-coordinator lane, never by the builder whose PR it is.

**Pick the worker shape** (interim rule; XT-132 decides the final one):

| Work | Shape |
|---|---|
| Bounded role with a contract: review, exploration, audit, test run | specialist (Claude plugin MCP `specialist_dispatch`, or Pi native specialists) |
| Long-running owned job with a contract and no network, `gh` or tmux need: watcher, monitor, audit loop, background check | specialist as above — not one-off only (below) |
| Light continuous work that needs network or tmux: board helper, Jira watcher, timers, host health | one `xt pi` worker (rule 1) |
| The same judgment repeated over many items, in an operator-approved workflow | AgentRun (`references/agentrun.md` — mandatory at board scale, never per-item API loops) |
| Interactive or long-owned work, or anything that needs network, `gh` or docker | tmux window worker (below) |

Rules for specialists and AgentRun: `references/fleet.md`, "Specialists and AgentRun".

Keep all window workers in the coordinator's own tmux session, one window each. Details and the
exact launch command: `references/fleet.md`. Short form:

```
xt claude <name> --window --prompt '<skills> ... /goal ...'
xt pi <name> --window --prompt "<skill names> /goal"
```

- Every worker gets its own attested issue before launch. That contract is its brief.
- **Roster shape.** The coordinator window holds the coordinator and its two standing helpers as
  panes (helper = timers, host health, light reads, with heavy reads sent to specialists; board =
  Jira and Substrate audit, skill `board-audit`). Every other
  xt worker goes into ONE window named `workers`, one pane each (tiled). Never one window per
  worker. Launch `xt pi <name> --window` from the MAIN checkout (xt refuses nested worktrees from
  inside a worktree), then `tmux join-pane -d -s <pane> -t <coordinator or workers pane>` and
  `tmux select-layout tiled`.
- **Lifetime.** Reap an `xt pi` worker (`kill-pane` by id) in the same cycle its issue closes with
  a result. List the reap condition of every live pane in each handoff.
- **Superseding an old coordinator:** collect a full report to a file and a handoff entry, take
  over every live duty (watchers, crons, owed GOs, owed PR work), journal the takeover list, then
  `kill-pane` its panes one by one.
- **The worker knows who dispatched it.** `xt` exports the coordinator's messaging name and
  address (`XTRM_DISPATCHER_NAME`, `XTRM_DISPATCHER_ADDRESS`) and the worker's primer names them,
  so the prompt does not need to. Keep "report with `SendMessage` and journal on your issue" in
  the prompt. A worker that cannot report sends its result nowhere; the same applies to any
  message that expects a reply.
- `xt` exports `SUBSTRATE_HOLDER=<name>`, which stamps the worker's name on every journal entry
  it writes, and the worker claims with `--holder <name>` (same name). After each launch check
  the worker's first entry.
- **Claims are leases** (about 15 minutes by default). The worker claims with `--ttl-ms` that covers
  its checkpoint interval, and renews it at every checkpoint. Put this in the worker's prompt.
  A same-holder re-claim returns ok but keeps the old `expiresAt` and generation (sb 0.2.x,
  verified 2026-10-25): renew with `sb issue release <ref> --holder <who>` then `sb issue claim`,
  and size the TTL to the next duty time plus a margin, not to a round hour.
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
- The cap is in rule 2 and counts every live agent process, not active issues. On a quota 429: pause dispatch, tell the operator in one line.
- At 25-30% worker context: `/compact` once, then a fresh worker resumes from `sb issue resume` (rule 3).

## Daily operations (added 2026-10-22)

Read `references/coordinator-operations.md` before the first production window. Summary of the
additions, each one learned from a real failure:

1. Daily rhythm with fixed checks: Monitor re-arm every 30 min, claim renewal every 2 h, daily report at 22:17Z, progress artifact every 6 h and after each promotion.
2. A `result` journal entry needs `--result '{"resultVersion":1,"summary":"..."}'`.
3. Crons take host LOCAL time and die with a restart; recreate them from the handoff.
4. Primary checkout: HEAD detached on `origin/stable`, local `master` synced; read `DEPLOY.md` before any production action.
5. Jira window Tasks: start date, due date and the two window fields must agree; one GO/DRY comment per window.
6. Roles: specialists for bounded roles; advisor and quant-methodologist as Opus subagents; heavy reviews as Sonnet subagents; workers call specialists in turn; max 2 subagents.
7. Specialist hygiene: `$slot` templates, stale MCP module check, read `specialist_result` after settle.
8. AgentRun must run; if it does not, stop and escalate with the exact error.
9. Ask the operator only for sudo, product and release gates, as multiple choice with a recommendation; never list technical options.
10. Cleanup is a candidate list approved in batches; never delete scratch; never run `xt update --apply` or `xt clean` while the core prune path is unsafe.
11. Never leave an AskUserQuestion open within 20 minutes of a window, to keep session crons firing.
12. Each cycle: Jira hygiene and the board helper's cycle report (filters 10065, 10055, 10056, status drift, comment watch; skill `board-audit`); background and monitoring rules (`references/coordinator-operations.md`, section 12).
13. Wind-down: brief, push, handoff, release, kill-pane by id, verify worktrees (section 13).
14. Progress artifact keeper (operator, 2026-10-26): each hourly cycle, dispatch one Haiku subagent (Agent, model haiku) as the keeper of the progress artifact's mechanical data (`workers`, `schedule`, `followups` collections via ArtifactData, never a republish). Tell it to load the `tabellone-keeper` skill (programme pack) plus the cycle's verified facts (windows done, specialists live, new follow-ups). It copies state and never judges; verdicts stay with the coordinator. It counts toward the 2-subagent cap.
15. Operator-facing pending items live in the progress artifact (operator, 2026-10-28). Every decision, confirmation or review pointer left waiting on the operator is a row in the Tabellone `questions` collection (doc `<coordinator name>`, rows `{id, ref, by, q, rec, why}`), not only a chat line. Refresh the rows whenever the operator asked for something and 5 turns passed without a follow-up; remove a row once answered.
16. Worker audits and research become review artifacts (operator, 2026-10-28). Publish each audit, investigation or research report a worker produces as a Claude artifact in the `mercury-visual-style` page style (light grey page, white cards, no dark theme; reference https://meadow-ponder-9a73.here.now/), and point its `questions` row at it. A file path alone is not a deliverable.
17. Keep the bases synced (operator, 2026-10-28, "important"). The coordinator always runs in a worker worktree, and specialists start from its base; the primary checkout's master is the other shared base. Fast-forward both to `origin/master` continuously, not only after own merges: a `systemd-run --user` timer every 10 min running an ff-only script (hold the primary when the range touches `config/`), checked each hourly cycle, and run by hand right after every merge. `xt claude|pi` already start new worktrees from a fresh `origin/<default>` (CORE-2340; `--base` overrides).
18. Rules go into this skill, not into private memory (operator, 2026-10-28: "recursive self improvement"). When the operator states a durable rule, or a session learns a reusable lesson, write it here or in the reference it belongs to (through a worker when the coordinator's edit boundary blocks the path), commit it in `~/.xtrm`, and keep private memory for session-specific facts only.
19. DRY is per target. `make promote` ignores `DRY=1` and opens the real promotion PR; only `make promote-merge` honours it. Read the target (or `make help`) before relying on a dry run.
20. Evidence values carry their reading time. A GO/DRY comment that cites a host reading (load1, PSI, free memory) writes the UTC time beside it, because the next reader cannot reproduce a moving value.
21. Prefer a hotfix to a promotion when the release branch must take one change only. If `origin/stable..origin/main` (or master) carries other work that has its own window, branch from stable, cherry-pick the one change, PR into stable, deploy, and back-merge stable into the default branch the same day (infra AGENTS.md, market-data branch model). Open the back-merge from a branch cut at stable (`git push origin origin/stable:refs/heads/backmerge/<ref>`), never with `stable` itself as the PR head: the repo deletes head branches on merge (`delete_branch_on_merge: true`), and on 2026-10-30 15:44Z merging #1162 (head `stable`) deleted `stable`; restored at 15:5xZ by `gh api -X POST repos/<o>/<r>/git/refs -f ref=refs/heads/stable -f sha=<old tip>`, then PRs auto-retargeted to master must be set back to base stable.
22. Pane monitors match prompts, not words. The confirmation-prompt monitor greps the prompt chrome (`Allow execution?`, `Do you want to proceed`, `(y/n)`, `[y/N]`), never bare words such as `approve` or `Permission`, which also match ordinary messages shown in the pane.

23. Gate by what the work costs, and never skip silently (operator, 2026-10-28: "all checks always"). Light network or local-IO work (board-helper cycles, Jira scans, the progress-artifact keeper) is gated on memory only: `/proc/pressure/memory` full avg10 <= 10 and MemAvailable >= 4 GB. Heavier classes use the gates in "3. Workers (fleet)", rule 2.2: launches load1 <= 15 plus the memory gate, fan-out and per-item loops load1 <= 10 with concurrency <= 2, production jobs a hard memory gate, merges the memory gate only. A single load1 gate on light work defers it indefinitely, because during trading hours production alone holds load1 at 15-23 on this 12-vCPU host (5 deferrals, 111 min, 2026-10-28). A refused gate arms a retry in the same command (a gate-watch under a <=25-minute Monitor, or the next background wake), and the journal entry names the reading, the retry task id and the deadline; a deferral without a retry id is a skip. Reference implementation: ~/.cache/wed2-board/gate.py (--mode check|watch, exit 0 open / 1 shut-or-unknown / 2 timeout; a missing /proc file is UNKNOWN, never open).
24. Before `/new` on a pane that owns background loops or timers, stop them at a planned boundary, or write into the handoff and the resume line that the fresh session must restart them first (the hop procedure for the R2 loop). On 2026-10-28 a rotation killed the R2 intake loop for 40 minutes because the resume line said no restart was needed.
25. Close on finish (operator, 2026-10-28: many Jira rows stayed open after specialists and workers finished). When a worker or specialist ends its work, the Substrate issue is closed with a result, and its Jira row moves by transition id in the same cycle (through the board helper while Jira writes are owned elsewhere). The coordinator checks both at reap and at specialist_stop_activation: a reaped pane or a stopped activation whose issue is still open, or whose Jira row is not moved, is a defect; fix it before the next dispatch. The board helper's standing drift check covers every post-cut-off row, not only today's closures.
26. A loop of per-item local CLI calls is fan-out, even when each call is light: gate it at load1 <= 10 with concurrency <= 2, and replace it with one bulk read where one exists, because a per-issue `sb` loop over ~300 issues pushed load1 to 33 at 22:25Z on 2026-10-28.
27. One change per night is LIFTED (operator ruling 2026-10-29 21:51Z, MMD-2331 seq 1523, rule R-MULTI — replaces this rule's old folded-night ban and the 10-08 one-change-per-window rule): a night or window may carry several ingestor changes when (a) each change has its own pre-written verify check and its own rollback (revert that commit or env key, then restart) and appears as one row of the night plan; (b) image changes go first, then config, each applied in a separate step with its verify in between when the mechanics allow (config files riding one 21:15Z restart are verified per change with distinct checks); (c) a deploy-watcher or production-monitor specialist watches every multi-change night from the reopen to +60 min; (d) the night plan names the executor and the attribution order. Read the target's constraints in the repo skill, because deploy mechanics belong to the repository that owns them.
28. When more than 3 builders are live, one build-coordinator lane (`xt claude`) owns their launches, reviews, merge-readiness and hand-offs, and the programme coordinator rules only on GOs, windows and escalations, because the coordinator's context is the scarcest resource in the fleet. Every builder launch states its model and effort.
29. The coordinator is Opus, and Opus also serves the advisor and quant-methodologist rulings; everything else runs on Sonnet or pi: the build-coordinator lane on Sonnet at effort high, builders on Sonnet, reviews as `pr-reviewer`/`reviewer` specialists rather than Opus subagents, the Jira writer and board helper on `xt pi`, and light fixes (test fixtures, rebases, footers, docs commits) on `xt pi`. A fleet with several Opus sessions hit the Claude usage limit at 23:0xZ on 2026-10-28 and stopped every Claude pane. This supersedes rule 6's Sonnet-subagent reviews. A PR whose correctness depends on data meaning (timezones, roll rules, bar semantics) also gets an Opus quant-methodologist ruling before GO-ready.
30. When Claude panes show "usage limit reached", pause every launch and tell the operator in one line; after the reset, send each stopped pane a resume line ("limit reset; resume from your last journal entry; re-claim; report"), and a worker that cannot continue hands its remainder to a named owner and releases its claim, because a silently dead pane looks like a slow one (2026-10-28).
31. Pane monitors check liveness, not geometry: match `#{pane_dead}` and pane existence, and also match "usage limit reached" and `401: {`, and re-arm after every launch or reap with the new pane list, because a pane squeezed to 2 rows read as GONE on 2026-10-28.
32. A worker refused by its Edit worktree hook never works around it through the shell; the coordinator launches a short session in the repository the hook protects, because the hook is the only guard against cross-repository writes (market-archive #61, 2026-10-28).
33. Service-knowledge sync is a REQUIRED step of every promotion to stable (operator, 2026-10-29). After the promote-merge, the coordinator dispatches the `service-knowledge-sync` specialist from the stable SHA, and the promotion counts as done only when its result is journaled. Interim until the GitHub app exists.
34. A window's PASS/STOP criteria come from a traced artefact (the expected output derived from the PR head plus a live read-only count), never from a count stated in a message: on 2026-10-29 a message-stated "64 or 61" was written into ISSUE-563 and accepted a STOP case; the traced output showed only 61 with the CL/NG scope line passes. Store the artefact path in the window.
35. Lessons of 2026-10-30 (fri30-coord):
   - A pane monitor detects a closed pane with `tmux list-panes -a -F '#{pane_id}'`, because `tmux display -p -t <gone pane>` prints nothing and exits 0.
   - A SHA in a GO, merge or journal entry is pasted from `gh`/`git` output, never typed: a made-up suffix reached a #1146 GO.
   - The nightly QuestDB restart preflight fetches and fast-forwards the deploy clone to `origin/stable` by itself; whatever is on stable at 21:15Z (CDT) / 22:15Z (CST) goes live. Read the preflight script before telling anyone the clone is static.
   - A specialist `model_override` to a Claude model is refused (HTTP 400, extra-usage billing for third-party apps); use native Agent subagents for Claude work and pi/commandcode for specialists.
   - One ingestor swap per CME halt: `schedule_ingestor_swap.sh` refuses a second schedule on the same day; plan multi-change nights as one image swap plus config at the restart.
   - An R-MULTI night (rule 27) gets a deploy-watcher or production-monitor specialist from the restart to +60 min that reads Prometheus through mcpq and the stack health checks, not only container state.
   - A text sent to a pi pane with `send-keys -l` may sit unsubmitted: send `Enter`, then capture the pane and confirm it is working.
   - `sb plan apply` parentKey takes the flat issue id (`MMD-n`), not the locator.
   - A running Claude session does not load an MCP server approved after its start, even after `/mcp`: restart the pane (or rotate it).
   - DeepWiki may have no index for a repo; read the source instead of trusting an empty answer.
   - Before reaping any pane, read the latest handoff's fleet line for that pane id: a pane marked "never reap" (an operator-owned session) is never killed, even when idle and its issue is done. On 2026-10-30 19:0xZ fri30-coord reaped the operator's MMD-3170 pane %404 and restored it with `xt attach <slug>` in a new window.
   - A launch refused by a load gate runs as a script that re-checks the gate in the same command and retries, so it is deferred, not skipped (rule 23).
   - Rotate any coordinator or lane session older than 24 h to a fresh agent with the transition procedure (operator 2026-10-30); the outgoing launches the successor, the successor reaps the outgoing.
   - PR-lane lessons (MMD-3012 seq 420-425): pin runbook derivation commands to the merge commit (`M^1..M`), never master versus a branch, and never cite `~/.cache` scripts in repo docs; a service-knowledge sync written by a subagent gets a claim-level check against the code at the stable SHA; tests assert exact sets against an independent literal, not a length plus one member; a cron that acts on a PR re-reads head and base from `gh` first.
36. Operator attention goes to Jira with a mention (operator, 2026-10-30). Whenever a question for the operator exists, or something needs the operator's attention, the coordinator or the worker posts one Jira comment on the ticket it belongs to, starting with `@operator` (`scripts/jira.py comment` turns it into a mention of jagger.xtrm@gmail.com that notifies). The comment says in plain words what needs attention and why, gives the recommendation first, and links every artifact produced (review page, `.md` file, PR). The coordinator also keeps the Tabellone `questions` row (rule 15) with the ticket link. Full worker rule: references/workers.md section 2.
37. Every dispatch points the worker to its rules (operator, 2026-10-30). Each launch prompt and each specialist contract names the `programme-coordination` skill and `references/workers.md` ("read ~/.xtrm/skills/optional/programme/programme-coordination/references/workers.md first"), and each resume line after a compaction repeats it, because a worker that never reads its rules reports nowhere and tags nobody. Launch workers with `--role worker` (`xt claude|pi <name> --window --role worker --bead <ref> [--model sonnet|opus] [-- --effort high]`; MMD-3200; the full procedure is references/fleet.md, "Dispatch a builder (worker role)"): the contract must be attested ready first and is the prompt; the role loads the whole skill and the specialists skill at turn 1 and tells the worker it may coordinate specialists and consult the advisor. A worker launched with another role (for example `--role executor`) gets the same line in its launch prompt: "Load programme-coordination and read references/workers.md first; you may coordinate specialists (/specialists:using-specialists) and consult the advisor."
38. Model providers are interchangeable (operator, 2026-10-30, ISSUE-198 c15942: "when one stops working, we just switch it. just make the things work"). When a provider or model fails (quota, 401, stalls), switch the worker, specialist or AgentRun batch to a working provider and carry on; do not ask the operator, do not park the work on the broken provider, and journal the switch. Current default: commandcode DeepSeek V4.1 Flash; opencode-go is not used.
39. Token economy (operator, 2026-10-30 20:15Z: "we're wasting a lot of tokens"). Binding for coordinators, lanes and workers:
   - Every launch prompt loads the specialists skill (`/specialists:using-specialists` on Claude; native specialists on pi). Heavy reads, reviews, test runs and investigations go to specialists, not to the worker's own context.
   - Chat output is minimal, in ASD-STE100 style: state, decision, next step. No narration per step; the operator does not read the scroll. Operator-facing items go to Jira comments (`@operator` when an answer is needed), where notifications reach the operator.
   - Batch work into one script per step (python3 heredoc, pi codemode), filter in the script, return counts and matching lines only. Never dump raw output into context.
   - Peer messages stay short: one decision or fact per line, pointers to files instead of pasted content.

## The rule: two systems, no files

| System | Holds | Written by |
|---|---|---|
| **Substrate** (`sb`) | contracts, plan, decisions, open questions, evidence, handoffs | coordinator and workers |
| **Jira** | the operator's view: programme, themes, sprints, human-only steps, and the production calendar | coordinator |

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

The only files allowed are the handover file, goal file and launch script under `~/.cache/<coord>/` as payload, while Substrate stays the record, because verbatim prompts exceed journal entry limits.

Details and exact commands: `references/substrate.md`.

## 2. Run

- **Journal everything that matters on the epic**, one entry per fact: `decision`, `finding`,
  `blocker`, `milestone`, `result`. Read it back in bounded windows: `sb journal since <epic> <cursor>`,
  `sb journal latest <epic> --kind decision`, `sb journal timeline <epic> --limit 20`. The text
  views print a short preview of each entry; add `--json` to read the full entry (a 4.4 KB entry
  reads back complete with `--json`).
- **New finding during the work:** create a child issue, link it with
  `sb issue relate --kind discovered_from`, add its ref to the matching Story.
- **A scope change** is a new contract revision, never a journal entry that overrides the contract.
- **Every PR that can be deployed or that changes runtime behaviour, config, schema, or serving
  must have a window Task (or an explicit `no-window` exception) before it is considered ready
  for merge.** See `references/jira.md`, “Windows on the Jira calendar”. A PR without one of
  these is untracked and must not be included in a promotion window.
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
  with follow-up, parked, blocked, will not do. The operator might approve mutations to the board explicitly.
- Move by **transition id**, never by name: ids differ per project (`41` is Done on XT and Deferred on ISSUE). The id tables are in `references/jira.md`;
  re-read them once per programme and record them in the board-profile finding.
- **Board-scale checks run as AgentRun workflows, not API loops** (prerequisite check first: `references/agentrun.md` STATUS box; `decide` nodes do not run on this host as of 2026-10-22, so stop and escalate rather than loop the API): title/field hygiene,
  coverage checks, per-ticket programme verdicts, and “open PRs without a window”
  (`references/agentrun.md`). Snapshot once, judge in parallel, read the verdicts. The coordinator
  never walks a whole board by hand.
- **Post results to Jira as comments**: findings, decisions, results and closures that the
  operator needs, with the Substrate ref. The daily report is written once, as a `result` entry on
  the programme epic, then posted as a comment on the Jira Epic. Never copy claims, journals or
  receipts into Jira fields.

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

- Handoff at 60% own context for Claude, 25-30% for Pi. You as an agent deliberately decide when it is appropriate to log a journal and checkpoint: `sb journal append <epic> --kind handoff`, then compact, then
  re-arm `/goal`. Resume: `sb issue resume <epic>` (root-epic resume summarises children).
- Set `SUBSTRATE_ISSUE_REF` to the programme epic so the pre-compact hook checkpoints.
- **Compaction.** Bind the coordinator worktree: `echo <epic> > .substrate-issue` and add it to
  `.git/info/exclude`. The substrate plugin then checkpoints on PreCompact and injects the resume
  capsule on SessionStart(compact). The edit gate then requires a live claim: claim the epic with a
  long TTL and renew it at every checkpoint.
- One user-level SessionStart(compact) hook, `~/.claude/hooks/mercury-post-compact.sh`, is
  registered in `~/.claude/settings.json` and is active only under `~/projects/mercury`. It prints
  skill pointers and the resume steps for the bound issue (`.substrate-issue` or
  `SUBSTRATE_ISSUE_REF`), runs an optional per-checkout `.claude/post-compact-extra.sh` (the
  coordinator's roster and schedule, git-excluded), and types "continue with the goal" into
  `$TMUX_PANE` after about 12 s, so an auto-compacted session does not sit idle. A running session
  loads hooks only at start: open `/hooks` once or restart. Pi workers are not covered: the
  coordinator resumes them by hand.
- Keep the `/goal` text in a file. Set it again after compaction if it is gone.
- Workers compact too, and then idle. Pi workers cannot run `/compact` themselves: the coordinator
  types `/compact` into the pane while it is idle. After compaction a worker needs a resume nudge
  (`sb issue resume <ref>`, claim again, report). The coordinator's post-compaction steps include
  resuming every worker.
- Session crons survive compaction but not process exit. Background sleeps die at the task cap
  (30 min for Monitor, about 2 h for bash). For durable timers use `systemd-run --user` transient
  units (they vanish if their timer is stopped).
- Before a restart or handoff, settle or stop every specialist activation you started: a
  coordinator restart orphans them.
- The handoff lists everything the programme depends on that dies or goes stale: open windows,
  monitors, session crons, live specialist activations, and every recurring prompt or scheduled
  trigger (for example the daily report), with what each one says. A scheduled prompt that names
  a retired tool or file is stale: tell the operator, who owns it.
- Session start: `sb issue resume <epic>`, `sb issue tree --root <epic>`, ListAgents and
  `tmux list-windows`, `gh pr list`, the Jira sprint board.
- For a coordinator-to-coordinator handover, follow `references/coordinator-transition.md` in order, to keep helper lessons, crons and claims intact.
- `/new` in an `xt pi` pane drops the session's xt messaging name (it shows as `pi-session [ref]` or a uuid), its turn-1 skills and its background tasks. The resume line re-loads every skill (`/skill:<name> ...`), re-exports `SUBSTRATE_HOLDER`, and names the handoff entry; the worker re-arms its own timers. Tell peers the new name.

## Modes

- **Light (default):** Substrate plus Jira Epic, Stories and sprints. No production windows. Use
  this unless told otherwise.
- **Full:** adds production windows, release-branch checks and the deploy owner. The release
  steps are Mercury operations, not this skill: use `mercury-release` and `production-ops`, and
  journal their outcomes on the epic. **Jira is the only calendar:** each window is a Jira Task
  with label `window`, parent = its theme Epic, and four date fields (`references/jira.md`, "Windows on the Jira
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
  tickets: search by label `substrate:<ref>` AND the exact summary before creating, and compare the summary as an
  exact string after the read (one substrate ref can be shared by two themes, so a label-only
  search reuses the wrong Epic).
- Write operator-facing Jira text in plain language: what changes, who runs it, when (UTC).
- Never relay a privileged-action approval between sessions; the operator gives it in the
  session that asks.
- Peers can message twice or cross: answer the newest, do not re-act.
- An Epic with more than ~20 direct children is a signal to create or use Stories as parents
  for the window Tasks and to move detailed worker work back to Substrate.

## Shape of a programme

```
Substrate                              Jira (project ISSUE or XT)
  Programme epic        ───── 1:1 ───  Epic (programme)
                                         │ Relates (an Epic cannot have a parent)
  Theme epic (child)    ───── 1:1 ───  theme Epic (label mmd-programme + substrate:<theme ref>,
                                         in a sprint)
                                           ├ theme Story (sprint deliverable)
    Worker task                            │ (leaf: Substrate only, never mirrored)
    Worker task                            └ window Tasks
  Operator step / window               Task (label window), parent = its theme Epic, in the sprint
```

- **Substrate theme epic maps 1:1 to the Jira theme Epic.** Each carries the other's key (Jira label
  `substrate:<ref>` plus the description on one side, an `sb issue note` on the other).
- **Worker tasks stay in Substrate.** The Story lists their refs. Never create one Jira ticket per
  worker task: that was the failure this shape replaces.
- **A theme is a result a person can recognise**, one deliverable that fits a sprint. Every Story
  goes into a sprint.
- **Window Tasks** (production or operator windows) are parented to their theme Epic, not the programme
  Epic. The programme Epic links to the theme Epics (Relates) instead of parenting them, because an
  Epic cannot have a parent in a team-managed project. Keep each theme Epic under ~15–20 direct
  children so the board remains scannable.
- **The Epic is an ADR-style brief** an agent can reason from (context, decision, rejected
  alternatives, consequences), not a list of directives. It is written in Jira. The Substrate epic
  contract carries the same content in the seven fields (`references/substrate.md`).
- **Every Jira ticket is a self-contained brief (operator, 2026-10-25), whoever files it.** Epic, Story,
  Task, Bug and window Task alike: context (what is wrong and why it matters), decision or plan, rejected
  alternatives, consequences, open questions, evidence. Short is fine; pointer-only is not. Write the
  whole idea first, then the pointers (`MMD-2878`, PR numbers). A ticket that says only "see MMD-4429"
  is thin and is enriched from its Substrate contract and journal. Jira faces the operator and the
  team; a full ticket also lets an agent reason without opening Substrate. Model: ISSUE-529. Every new
  ticket gets a duplicate, merge and link check before it is filed (skill `board-audit`). Template:
  `references/jira.md`, "Ticket description".
- **Owners.** Jira owns summary, brief, sprint, assignee, priority, epic link, portfolio status,
  and the production calendar (windows). Substrate owns the contract, readiness, attestation,
  claim, journal, provenance and closure evidence. Edit a field in the system that owns it.
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

## References

`references/substrate.md` · `references/jira.md` · `references/fleet.md` ·
`references/worked-example.md` · `references/agentrun.md` · `scripts/jira.py` (Jira REST, token file from `JIRA_TOKEN_FILE`, never
printed). The frontmatter `index` maps every paragraph and path to its read trigger.
