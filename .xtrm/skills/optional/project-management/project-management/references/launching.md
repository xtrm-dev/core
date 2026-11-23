# Launching: agents as windows in the project's session

Mechanics only: launch syntax, liveness, reaping, specialists, limits. Who launches what and when: SKILL.md "Who does what", `references/manager.md`
§0, `references/lead.md` §7.

## Tmux placement

`xt claude` and `xt pi` accept `--pane <target>`, `--workers`, `--window-name <name>`, `--session <name>`, and `--layout <layout>`. `--pane` splits an existing window; `--workers` fills a `workers*` window up to `workersMaxPanes` (default 4) and rolls over to the next window. Placement defaults are configured in the user-owned `~/.xtrm/config/launch.json` (override with `XTRM_LAUNCH_CONFIG`), for example `{ "version": 1, "placement": { "worker": "workers" } }`. Explicit placement flags override defaults. An absent file preserves existing behavior.

## Rule

All agents of a project live in one tmux session, the manager's: the manager window holds the manager and its helpers as panes, each lead has its
own window, every worker is a pane of a tiled `workers` window (at most 4 panes each), never one window per worker. `tmux list-windows` is the
roster the operator sees.

## Dispatch surface (verified 2026-10-24 from `--help` and the MCP schemas)

Run the budget preflight first (SKILL.md rule 2) and record its line in the launch entry.

| Shape | Exact syntax | Notes |
|---|---|---|
| **Worker (default)** | `specialist_dispatch {specialist: "worker", issue_ref}`; next issue of its role: `specialist_reply` / `specialist_resume` | Kept alive and reused (SKILL.md rule 1); no pane. Stop with `specialist_stop_activation` when its role has no queued work. |
| **PR review (default)** | `specialist_dispatch {specialist: "pr-reviewer", issue_ref[, model_override]}`; next PR: `specialist_reply` | Through `claude-bridge`; keep one alive per lead and give it each new PR (rule 44). |
| `xt claude` worker | `xt claude <name> --window --model sonnet\|opus --prompt '/<skill> ... /goal ...' -- --effort low\|medium\|high\|xhigh\|max` | Effort goes after `--`. `--thinking` is dropped with a warning. |
| worker role (`xt`) | `xt claude\|pi <name> --window --role worker --bead <ref> [--model sonnet\|opus] [-- --effort high]` | `~/.specialists/user/worker.specialist.json` (MMD-3200). Loads this skill and using-specialists at turn 1; Claude default `sonnet`, pi default DeepSeek V4.1 Flash. `--bead` is the prompt. |
| `xt pi` worker | `xt pi <name> --window --model <provider/id> --thinking off\|minimal\|low\|medium\|high\|xhigh --prompt '/skill:<name> ... /goal ...'` | Default `deepseek/deepseek-v4.1-flash` (provider `commandcode`), thinking high; never Muse Spark (it stops mid-task, operator 2026-10-30). `--skill <name>` repeats. |
| Role session | `xt claude\|pi --role <role> [--bead <id>] [--model ...]` | `--model` overrides the role's; `--bead` and `--prompt` exclude each other. |
| Manager | `xt claude <name> --window --role manager --bead <ref> --model opus -- --effort high` | The launch role gives the role; any name. Then the session kit ("Session kit" below). |
| Lead | `xt claude <name> --window --role lead --bead <epic-ref> --model sonnet -- --effort high` | One per workstream; any name. |
| Board helper | `xt pi board-helper --window --role board-helper` | The only Jira writer; one per project; the launch role gives `board_helper`. |
| Resume, hotfix base | `xt attach <slug\|dir\|branch>` (name only); `--base origin/stable` | Default base is fresh `origin/<default>`. |
| Specialist | `specialist_list` -> `specialist_dispatch {specialist, issue_ref}` (optional `model_override`, `thinking_override`, `epic_context_depth` 1-2) -> `specialist_status {wait_for_change: true, timeout_s: 60}` -> `specialist_reply {message_id, body}` -> `specialist_result {activation_id}` -> `specialist_stop_activation {activation_id, reason}` | One of `issue_ref` or `contract`; the issue must be READY. An inline `contract` needs `parent_ref`. |

**Roles on Claude: pin the model (fri30-coord, 2026-10-31, MMD-3200).** `xt claude --role <role>` takes system prompt and model from
`sp view <role> --raw --surface claude`; the first user message comes from `sp render-task`.
- `~/.config/specialists/user.json` sets most roles to `commandcode/deepseek/...` (rule 38) and cannot set `surface_models`; the `xt` foreign-model
  guard lacks `commandcode`, so Claude refuses the model at turn 1.
- Neither `xt` nor `sp` has an inline system-prompt flag (`xt` rejects `--system-prompt` and `--append-system-prompt` after `--`); write one with
  `sp edit <role> --set specialist.prompt.system _ --file <f>`.
- Rule: launch any role but `worker` on Claude with `--model sonnet|opus`; `worker` pins `surface_models.claude: sonnet`.
- Open fixes (specialists `surface_models` override; core `FOREIGN_MODEL_PROVIDERS`) wait for a design session: do not change the specialists or core
  repos from a project session.

### Session kit

The launch role is the session's role: `--role manager`, `--role lead`, `--role worker`, `--role board-helper` (mapped by the
`launch_roles` setting; `references/setup.md`, "Routing roles"). `--bead <ref>` binds the issue. Right after the launch command, before any message
to the session, the launcher checks the kit and adds what the launch did not give:

```
python3 <pack>/project-management/scripts/pm_session.py show --dir <worktree>      # role (source), project, bound issue, KIT lines, goal
                                                                                  # (launch role from the agent host, or --launch-role <r>)
python3 <pack>/project-management/scripts/pm_session.py init --dir <worktree> [--role <r>] [--issue <ref>]
```

`<pack>` is the pack directory (`~/.xtrm/skills/optional/project-management`); `<worktree>` is the session's worktree, which `xt` creates under
`<repo>/.xtrm/worktrees/`. `init --role` writes the role file `.pm-role` only when the launch role does not already give that role: a session
launched under the shared `project-manager` role, or a running session from before the split. A role file always wins over the launch role.
`init --issue` writes `.substrate-issue`; both files stay out of git (info/exclude). The worker's own first step (`pm_session.py show`,
`references/worker.md`) prints the common goal, so the prompt needs no paste; the contract names the goal section it serves (step 1 below).

### Identity and restore

`xt` exports the dispatcher as three observed labels, never authority: `XTRM_DISPATCHER_PARTICIPANT` is the dispatcher's own
`SUBSTRATE_HOLDER` (the name a worker messages and claims by, and the only one that names a participant), `XTRM_DISPATCHER_NAME` is the
display name such as `g04z-lead`, and `XTRM_DISPATCHER_ADDRESS` is its `uds:` socket when it publishes one. `SUBSTRATE_HOLDER=<name>` beside
them is the worker's OWN holder. Unknown values are absent; nothing is defaulted from the environment.

Every launch with `--bead` also records the dispatcher on the Issue's ExecutionBinding (`sb provenance dispatch
--dispatcher-participant/--dispatcher-session`) and writes that binding's id into the worktree's `.xtrm/session-meta.json`. After a pause,
`xt attach` restores the dispatcher from THAT binding, refreshed against the live sessions by participant — so a restarted lead is found again,
an absent one leaves the keys absent, and the attacher's own dispatcher is never adopted. A bead read from a live pane may only restore a binding
made in the worker's own worktree: two workers on one issue keep their own dispatchers, and no one can elect a dispatcher by writing
`@agent_bead`.

These values are advisory. They tell a worker and the record WHO dispatched it; they never authorize a claim, a merge, a release or a production
change. Check a worker's first journal entry after launch rather than trusting the pane (`references/worker.md`).

## Launch

- `--window` opens a detached window in the caller's tmux session and prints `<session>:<pane_id>`: keep that id, it is the stable target. Window
  names can repeat (`<runtime>-<slug>`, lower case): target the pane id, never the name.
- The worktree is made in the repo of the current directory. Another repo: `(cd ~/dev/<repo> && xt claude <name> --window --prompt '...')`. `xt codex`
  starts only from the main checkout.
- `--prompt` starts the session; a leading `/<skill>` loads a skill on turn 1. Builder skills:
  `/using-xtrm /multiplexing /engineering-quality /gitnexus`. Investigator: `/using-xtrm /multiplexing /service-knowledge /sre-ops`; add
  `/using-substrate` if the runtime lacks it.
- A prompt names skills, the issue ref, "report with `SendMessage` and journal on your issue" and `/goal`:
  `xt claude <name> --window --prompt '<skills> Resume CORE-2401 and follow its contract. Report with SendMessage and journal on your issue. /goal ...'`
- Verify after launch: `tmux list-windows -t "$S" -F '#{window_name} #{pane_id}'`, then the worker's first journal entry shows
  `participantId = <name>` (`sb journal latest <ref> --json`).
- Address a peer by role or session name (`scripts/route_target.py`, SKILL.md "Who does what"), never by socket path. Address a forked session by
  its full marked name (including `⑂`) and keep the Substrate journal as backup: a bare name can reach the offline original.

### Dispatch a builder (worker role)

One issue per task, one contract per scope (SKILL.md rules 3, 37); the worker reads `references/worker.md` first and may coordinate specialists and
consult the advisor.
1. **Contract** (the issue is the prompt; a restart resumes from `sb issue resume <ref>`; no `briefs/` folder):
   `sb issue create --project <id> --title <t> --kind task --parent <ref> --scrutiny LOW|MEDIUM|HIGH|CRITICAL --contract <file>`; `validation` is
   `{check}` objects, `output` `{artifact}` objects. The contract is the prompt, so it names files, the branch base (`origin/master`), the tests to
   run and the stop conditions. OUTPUT follows SKILL.md "The rule: two systems, bound files": rulings and reviews go into the journal (`--semantic`)
   and a Jira comment text; a durable document is committed and bound. CONTEXT names the part of the common goal the issue serves
   (`sb issue edit <ref> --context-refs <file|json>` before attesting, naming `<goal document>#<section>`; SKILL.md rule 56).
2. **Attest:** `sb issue attest <ref> --outcome ready --policy default --attested-by <you>`; `sb issue show <ref> --json` must show `readinessState`
   `ready`, `dispatchable` `true`.
3. **Launch** (after the rule 2.2 preflight): by default a `worker` specialist, `specialist_dispatch {specialist: "worker", issue_ref: <ref>}`,
   or the next issue to a kept-alive one with `specialist_reply`. Only for what SKILL.md rule 1 lists, from the main checkout:
   `xt claude <name> --window --role worker --bead <ref> --model sonnet|opus -- --effort high` or `xt pi <name> --window --role worker --bead <ref>`.
   Effort defaults to medium: pass high for builders (Opus for maths and data meaning). Pi or Sonnet builder: choose per task (SKILL.md rule 40); a
   pi builder needs a tight contract and a first-diff check. Refuse or queue when a cap or
   gate fails; a new builder launch waits for the operator's word when the operator has ruled so. A start-up line "could not read <ref>" is harmless.
4. **Place an `xt` pane:** use `--workers` for a tiled `workers*` window (at most 4 panes by default), `--window` for a lead window, or `--pane <target>` for a manager/helper pane. Use `--session <name>` to select the project session; set role defaults in `~/.xtrm/config/launch.json`. Explicit placement flags override defaults.
5. **Supervise by exception:** `specialist_status` for a specialist, the pane monitor for an `xt` worker; verify claims against the live tree. A
   different scope means a new issue. When the issue closes: reap an `xt` pane by id, or keep the specialist for its role's next issue.

Another role (`--role executor`) is not a worker: on Claude it MUST pass `--model sonnet|opus` or the session dies at turn 1, and its prompt carries
the rule-37 line. A PR review follows SKILL.md rule 44.

### When --window refuses

After a restart `$TMUX` can be lost ("requires running inside tmux"). Never use a raw `tmux new-window`; restore from your own pane, then
rerun in the same shell:

```
p=$$; pane=""
while [ "$p" -gt 1 ]; do
  pane=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' | awk -v p="$p" '$1==p{print $2}')
  [ -n "$pane" ] && break
  p=$(ps -o ppid= -p "$p" | tr -d ' ')
done
export TMUX_PANE="$pane" TMUX=$(tmux display -p -t "$pane" '#{socket_path},#{pid},#{session_id}' | tr -d '$')
xt claude <name> --window --prompt '...'
```

No pane found: the launching session is not in tmux; tell the operator.

### Resume a worker

`xt <runtime> <name>` refuses an existing worktree: `xt attach <name>`, then one line, the issue ref and "resume with `sb issue resume <ref>`". Never
re-send the brief.

## The worker's brief is its issue

The issue is the prompt ("Dispatch a builder", step 1); another role's prompt names only the issue ref, skills and `/goal`.

## Prompt hygiene (every worker)

- Ban secret-dumping commands (`env`, `printenv`, `docker inspect` without a format, `cat .env`). Reviewers never `git checkout` in primary,
  manager or lead worktrees: `git worktree add --detach $PM_STATE_DIR/rev-<pr>/wt <sha>`; check `git status` and HEAD after.
- Review and audit roles run READ_ONLY; a writer needs the workspace lease. After send-keys into a Claude pane send `C-m` and check the input line is
  empty.
- Send pi panes a one-line brief path, never a multiline paste: pi submits on the embedded newline and truncates.
- Every review brief includes the review pass the repo requires and a delta-review rule for new heads.
- Say: claim with `--ttl-ms` covering your checkpoint interval, renew at every checkpoint with `sb issue renew <ref>`, claim again only after the
  lease expired.

## Liveness: never leave a worker stale

Check every worker each cycle; every check ends in an action.

| State (xtmux) | Launcher action |
|---|---|
| `running` | none |
| `needs-input` | read the prompt; alert the operator in one line with window and prompt; never approve it yourself |
| `done` | `sb journal latest <ref>`: result written and issue closing, collect and reap; work left, steer |
| `off` / window dead | resume in a new window from `sb issue resume <ref>` |
| `running`, silent | look at the pane; if stuck, steer, then restart from the capsule |

State: `xtmux topology --json` (`agent.state`). Prompt text, silence from `#{window_activity}`:

```
tmux capture-pane -p -t <pane-id> | tail -15
PROMPT='Allow execution\?|y/enter: allow|Do you want to proceed|\(y/n\)|\[y/N\]|Allow project MCP'
```

- Who answers a prompt: `references/lead.md` §7 (the operator answers destructive, privileged or unfamiliar ones).

**Monitors.** A background monitor every 30-60 s over the launcher's windows prints one line per change: `WAITING <window> | <prompt>`,
`DONE <window>`, `DEAD <window>`, `SILENT <window> <seconds>`, keyed on pane id, state in the loop. Match a bare prompt line only (a looser pattern
gave false DEAD alerts); exempt keeper and deploy roles from SILENT. Monitors die with the session: re-arm after every launch, restart or handoff and
list them in the `handoff`. A line is a trigger, not a verdict.

## Reaping: close finished windows

Forgotten windows keep runtimes alive: ten once pushed server load to about 700.
1. Finished means the issue is closed, or `done` with its result collected; confirm `sb journal latest <ref> --kind result` first. Do not close a
   window whose result entry is missing: steer the worker or restart it from the capsule first.
2. Same cycle: `tmux kill-pane -t <pane-id>`; never `kill-window` (one once closed the manager and the operator's monitor pane). Check the id:
   `tmux display-message -p -t <pane-id> '#{window_name}'`.
3. Every `handoff` lists the open windows (`tmux list-windows -t "$S" -F '#{window_name} #{pane_id}'`) with issue refs.

## Specialists and AgentRun

Specialists are on par with `xt` sessions and the default for most work (SKILL.md rule 1, operator 2026-11-17).

**Specialists**
- Dispatch through the plugin MCP, not the `sp` CLI; `specialist_status` is authoritative. Create the issue under its theme and attest it first: an
  inline `contract` makes a parentless issue and `sb` cannot set a parent later.
- **Keep-alive:** a specialist that finished its issue waits; give it the next issue of its role with `specialist_reply` (it re-reads the new
  contract) or `specialist_resume`. A warm reviewer or builder skips the cold start, which for an Opus reviewer is the largest single cost. Stop it
  with `specialist_stop_activation` when its role has no queued work, or 2 h after its last result.
- Default specialists have no network, `gh`, tmux, ListAgents or host writes: that work goes to an `xt` worker. Exception `board-helper` (LOW +
  `execution.lease_waiver`, v1.7.0): per-Issue worktree with `gh pr view/list`, `git merge-base --is-ancestor`, `python3 scripts/jira.py` and `sb`
reads; Jira writes only through the board helper, journal writes only on the order of the manager or the owning lead. A `board-helper`
specialist does not write Jira: it proposes, and the board helper writes on that order (sun01-coord, 2026-11-01); `denied_bash_patterns` enforce it: still no tmux,
  ListAgents, host writes outside the
  worktree, repo edits, production actions or `gh` mutations.
- Long jobs: Claude `Bash` `run_in_background`; Pi `BashBackground` plus `Monitor`; `TaskStop` stops either. Stay silent while healthy, escalate only
  on a problem; read the output file with `read`, never tail it in the turn. Delegated-agent and fusion workflows are retired (CORE-2443 M1,
  host-memory pressure).
- After editing a definition restart the host or rename it: the loader caches.
- A specialist counts toward the lead's agent cap (rule 2.3). Before a restart settle or stop each activation; release a stopped one's claim with
  `sb issue release <ref> --holder specialist::<name> --activation <id>`.

**AgentRun**
- Findings are claims: sample-check before acting (a Jira audit run had about 30% false positives).
- Route on the decision's choice value, not its confidence; Jev decisions first for semantic choices, code for exact checks. A run cannot watch
  liveness: the monitor loop does.

## Limits and health

- **Host memory, not worker count, is the hard limit.** On 2026-10-18 three coordinators fanned out subagents running full test suites beside 8 pi
  workers, the databases and feeds: the VPS swap-stormed for 4 hours (load 150, 9 GB swap, memory stall 52%) until the operator killed every Claude
  process.
  - At most 2 in-process subagents per manager or lead, 1 running tests. Subagents die with their parent: long builds belong in a specialist or an
    `xt` worker.
  - No full suite or `make ci-light` locally while other workers are live: targeted files, one at a time, under `ulimit -v 4000000` and `timeout 600`;
    hosted CI is the full-suite evidence.
  - Before each dispatch run the preflight and the class gate (rule 2.2); do not dispatch when swap use rises or `full avg60` is above 5.
  - Hosted CI shares this VPS: stagger pushes, never re-trigger with empty commits or manual dispatches while runs queue, count running CI jobs in the
    memory check.
- Caps: SKILL.md rule 2.3 (per lead 3 live agents; host cap 18 while the memory gate holds; once 10 processes were live while one session
  counted 3 workers). Quota 429: pause dispatch, tell the operator in one line (rule 30). Compacting a Pi worker: `references/continuity.md`.
- Reviewer, investigator, release or monitor roles are specialists (or `xt` workers by rule 1) with their own issue.

