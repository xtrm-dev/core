# Fleet: workers as windows in the coordinator's session

## Rule

The coordinator keeps all its workers in **its own tmux session**, each in a **new window**. No
separate sessions per worker. The operator sees the whole programme in one place, and
`tmux list-windows` is the roster.

## Dispatch surface (verified 2026-10-24 from `--help` and the MCP schemas)

Run the budget preflight first (SKILL.md, rule 2) and record its line in the launch entry.

| Shape | Exact syntax | Notes |
|---|---|---|
| `xt claude` worker | `xt claude <name> --window --model sonnet\|opus --prompt '/<skill> ... /goal ...' -- --effort low\|medium\|high\|xhigh\|max` | `--model` is forwarded to claude. Effort goes after `--` (claude's own `--effort`). `xt claude --thinking` is warn-and-drop. |
| worker role (default) | `xt claude\|pi <name> --window --role worker --bead <ref> [--model sonnet\|opus] [-- --effort high]` | Definition `~/.specialists/user/worker.specialist.json` (MMD-3200). Loads programme-coordination + using-specialists at turn 1; Claude model default `sonnet`, pi default commandcode DeepSeek V4.1 Flash. With `--bead` the issue is the initial prompt (no `--prompt`). Other roles (`--role executor` etc.): add the rule-37 line to the launch prompt. |
| `xt pi` worker | `xt pi <name> --window --model <provider/id> --thinking off\|minimal\|low\|medium\|high\|xhigh --prompt '/skill:<name> ... /goal ...'` | Muse Spark: `commandcode/meta/muse-spark-1.3-contributor`. Default model: `deepseek/deepseek-v4.1-flash` (provider `commandcode`), thinking high. `--skill <name>` loads extra skills (repeatable). |
| Role session | `xt claude\|pi --role <role> [--bead <id>] [--model ...]` | `--model` overrides the role's model. With `--role`, `--bead` and `--prompt` exclude each other. |
| Resume a worker | `xt attach <slug\|dir\|branch>` | Only argument is the name; no flags. |
| Hotfix base | add `--base origin/stable` | Default base is fresh `origin/<default>`. |
| Specialist | `specialist_list` (choose role) -> `specialist_dispatch {specialist, issue_ref: "MMD-<n>"}` (optional `model_override`, `thinking_override`, `epic_context_depth` 1-2) -> `specialist_status {wait_for_change: true, timeout_s: 60}` -> answer asks with `specialist_reply {message_id, body}` -> `specialist_result {activation_id}` -> `specialist_stop_activation {activation_id, reason}` | Exactly one of `issue_ref` or `contract`. The issue must be READY: 7 sections plus SCRUTINY. `issue_ref` keeps the parent; an inline `contract` needs `parent_ref`. |

**Roles on Claude: pin the model (fri30-coord, 2026-10-31, MMD-3200).** `xt claude --role <role>` takes the system prompt and model from `sp view <role> --raw --surface claude`. The first user message comes from `sp render-task`. Neither `xt` nor `sp` has an inline system-prompt flag; `xt` rejects `--system-prompt` and `--append-system-prompt` after `--`. A system prompt is written into the definition with `sp edit <role> --set specialist.prompt.system _ --file <f>`.
- `~/.config/specialists/user.json` sets most roles (executor and others) to `commandcode/deepseek/...` for pi, per rule 38. That layer cannot set `surface_models` (`sp edit --global` refuses the field), so `sp view --surface claude` returns the DeepSeek model. The `xt` guard for non-Claude models does not list `commandcode`, so it lets the model through, and Claude refuses it at turn 1 ("There's an issue with the selected model").
- Rule: launch any role other than `worker` on Claude with `--model sonnet|opus`, for example `xt claude <name> --role executor --model sonnet`. `worker` already pins `surface_models.claude: sonnet`.
- Open fixes, held for a focused design session; do not change the specialists or core repos from a programme lane: (1) Specialists: allow `surface_models` in the override layer (schema.ts `OVERRIDE_ALLOWED_NESTED_EXECUTION_PATHS`, beside `extensions`), and decide which wins between an overridden `model` and a shipped `surface_models`. (2) Core `xt`: add `commandcode` to `FOREIGN_MODEL_PROVIDERS` (cli/src/utils/worktree-session.ts), so the launch falls back to the parent model with a warning.

Not verified by a live launch: the combination `--model ... -- --effort ...` on `xt claude` (each part is in
`--help`); the `sonnet`/`opus` aliases (claude `--help` says it accepts aliases; the xt example uses a full id).

## Launch

Run from the coordinator's own repo checkout:

```
xt claude <name> --window --prompt '<skills> Resume CORE-2401 and follow its contract. Report with SendMessage and journal on your issue. /goal ...'
```

`--window` opens a detached window in the caller's tmux session and prints `<session>:<pane_id>`.
Keep that pane id: it is the worker's stable target.

- **Window name** is `<runtime>-<slug>`: `claude-`, `pi-` or `codex-`, then `<name>` in lower case
  with every run of other characters turned into `-`, cut to 32 characters (64 for codex). So
  `xt claude ISSUE-260-pi-runtime --window` opens window `claude-issue-260-pi-runtime`. With
  `--role` the name is `role-<runtime>-<role>[-<bead>]`.
- **Names can repeat.** `--window` adds no suffix, and tmux allows two windows with one name. Give
  every worker a distinct `<name>`, and target the pane id, not the window name.
- Address a forked coordinator by its full marked name (including `⑂`) and keep the Substrate journal as backup channel, because a bare name can reach the offline original.
- **Repo.** The worktree is made in the repo that holds the current directory, and the window starts
  in that worktree. There is no repo flag. For a worker in another repo, change directory in a
  subshell: `(cd ~/dev/<repo> && xt claude <name> --window --prompt '...')`. `xt codex` refuses to
  start from inside a worktree: run it from the repo's main checkout.

Every `xt` launch from an agent session exports, with no typing:

| Variable | Value |
|---|---|
| `SUBSTRATE_HOLDER` | `<name>`; overrides the coordinator's own value |
| `XTRM_DISPATCHER_NAME` | the coordinator's messaging name (its `ListAgents` name) |
| `XTRM_DISPATCHER_ADDRESS` | `uds:<socket>`, the address `SendMessage` accepts |
| `XTRM_PARENT_SESSION_ID`, `XTRM_PARENT_PANE_ID` | the coordinator's tmux session and pane |

Unknown values are absent. The worker's session-start primer names the dispatcher and the reply
address, and `@agent_parent_session` is set on the worker's pane. Do not start a worker with a raw
`tmux new-window 'xt claude <name>'`: the tmux server spawns that command, so the coordinator is
not its ancestor and the dispatcher stays unknown.

- `--window` never takes focus, so the coordinator's window stays in front. Use the same `<name>`
  for the claim holder. Start the name with the Story's Jira key in upper case
  (`ISSUE-260-pi-runtime`): the branch is `xt/<name>` with the case kept, and the key in the branch
  name, PR title and commit trailer is what the Jira dev panel links on (project ISSUE only, see
  `references/jira.md`). Only the window name is lower-cased.
- `xt claude <name>` makes a sandboxed worktree on branch `xt/<name>`. Other runtimes: `xt pi <name>`,
  `xt codex <name>` take the same shape. A specialist role: `xt claude <name> --role <role>`.
- `--prompt` starts the session. A leading `/<skill>` loads a skill on turn 1. Builder skills:
  `/using-xtrm /multiplexing /engineering-quality /gitnexus`. Investigator: `/using-xtrm
  /multiplexing /service-knowledge /sre-ops`. Add `/using-substrate` if the runtime lacks it.
- Verify after launch: `tmux list-windows -t "$S" -F '#{window_name} #{pane_id}'`, then the
  worker's first journal entry shows
  `participantId = <name>` (`sb journal latest <ref> --json`).

### Dispatch a builder (worker role)

A builder is one fresh worker for one Substrate issue (SKILL.md, rules 37 and 39; MMD-3200, operator 2026-10-31). The default launch is the `worker` role. Definition: `~/.specialists/user/worker.specialist.json`. The role loads the whole `programme-coordination` skill and the specialists skill at turn 1, makes the worker read `references/workers.md` first, and tells it that it may coordinate specialists and consult the advisor.

1. **Write the contract.** `sb issue create --project <id> --title <t> --kind task --parent <ref> --scrutiny LOW|MEDIUM|HIGH|CRITICAL --contract <file>`. The contract has PROBLEM, SUCCESS, SCOPE, NON_GOALS, CONSTRAINTS, VALIDATION and OUTPUT. `validation` is a list of `{check}` objects and `output` a list of `{artifact}` objects, else the issue stays draft. The contract is the prompt, so it names files, the branch base (`origin/master`), the tests to run and the stop conditions. Put the no-files rule in OUTPUT: rulings, reviews and diagnoses go into the journal (`--semantic`) and a Jira comment text for the Jira writer, never only a path.
2. **Attest it ready.** `sb issue attest <ref> --outcome ready --policy default --attested-by <your name>`, then check `sb issue show <ref> --json`: `readinessState` is `ready` and `dispatchable` is `true`. The worker refuses a draft or an unattested issue.
3. **Run the preflight** (SKILL.md, rule 2.2) and keep the line. Refuse or queue when a cap or gate fails. A new builder launch also waits for the operator's word when the operator has ruled so.
4. **Launch from the main checkout** (`xt` refuses nested worktrees): `xt claude <name> --window --role worker --bead <ref> --model sonnet|opus -- --effort high` or `xt pi <name> --window --role worker --bead <ref>`. Notes:
   - With `--bead` the issue is the prompt. `--bead` and `--prompt` exclude each other: write nothing else.
   - Claude effort defaults to medium: pass `-- --effort high` for builders. Sonnet at high for routine and critical building, Opus for maths and data meaning. `xt pi` builders use the default commandcode DeepSeek V4.1 Flash for light work only.
   - `<name>` starts with the issue key (`<KEY>-<slug>`). It becomes the claim holder, `SUBSTRATE_HOLDER` and the branch `xt/<name>`.
   - A line "could not read <ref>" during start-up is harmless.
5. **Place the pane.** `--window` prints `<session>:<pane_id>`. Move it into the shared window: `tmux join-pane -d -s <pane> -t <session>:workers`, then `tmux select-layout tiled`. At most 4 panes per `workers` window.
6. **Verify.** The worker's first journal entry carries `participantId = <name>` (`sb journal latest <ref> --json`). It claims with a TTL that covers its checkpoint interval.
7. **Supervise by exception.** Arm the pane monitor (Liveness, below). The worker reports to the coordinator named in its primer. Verify its claims against the live tree. A different scope means a fresh issue and a fresh worker, never a reused session.
8. **Reap** with `kill-pane` by pane id when the issue closes (Reaping, below).

Another role (`--role executor`, a specialist role, and so on) is not a worker. On Claude it MUST also pass `--model sonnet|opus` (see "Roles on Claude: pin the model" above), else the session dies at turn 1. Add the rule-37 line to its launch prompt: "Load programme-coordination and read references/workers.md first; you may coordinate specialists (/specialists:using-specialists) and consult the advisor." A bounded read, review or test run does not need a window: dispatch a specialist.

### When --window refuses

`xt` reads `$TMUX` to find the caller's session. After a restart the coordinator's shell can lose
`$TMUX` while the coordinator still runs in a tmux pane, and `--window` fails with "requires running
inside tmux". Do not fall back to a raw `tmux new-window`. Restore the two variables from the pane
that holds the coordinator, then run the same `xt` command in the same shell:

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

Tested with `$TMUX` and `$TMUX_PANE` unset: the restored values pick the coordinator's own session.
The dispatcher identity is unaffected, because `xt` finds it by walking parent processes, not
through tmux. If the loop finds no pane, the coordinator is not in tmux at all: tell the operator.

### Resume a worker

`xt <runtime> <name>` refuses when the worktree already exists ("Worktree path already exists").
To resume that worker:

1. `xt attach <name>` opens its existing session.
2. Send one line: the issue ref and "resume with `sb issue resume <ref>`". The capsule carries the
   rest; never re-send the whole brief from chat.

## The worker's brief is its issue

1. Create the worker task under its theme (`sb plan apply` or `sb issue create --parent`).
2. The coordinator attests it.
3. Launch the window with the worker role (`--role worker --bead <ref>`, section "Dispatch a builder"): the issue is the prompt. For another role the prompt names only the issue ref, the skills and the `/goal`.
4. The worker claims it with `--holder <name>`, checkpoints after each milestone and at its
   context limit, and closes with a `result`. A restarted worker resumes from
   `sb issue resume <ref>`, never from chat.

No `briefs/` folder, no brief file: if a requirement matters, it belongs in the contract.

## Prompt hygiene (every worker)

- Name the banned commands that dump secrets: `env`, `printenv`, `docker inspect` without a
  format, `cat .env`. Give the names-only form.
- Say: claim with `--ttl-ms` covering your checkpoint interval and claim again at every checkpoint;
  scratch goes under `~/.cache/<issue-ref>/` and is never deleted; leftovers are listed in the
  closure.
- Reviewers never `git checkout` in primary or coordinator worktrees. Use
  `git worktree add --detach ~/.cache/rev-<pr>/wt <sha>`. After a review, check `git status` and HEAD of
  the worktrees it could touch.
- Edits outside the coordinator's worktree go to a worker window, not a side worktree made from the
  coordinator.
- Every review brief includes the review pass the repo requires and a delta-review rule for new heads.

## Liveness: never leave a worker stale

A worker the coordinator does not watch goes stale: it sits on a confirmation prompt, finishes and
waits, or dies, and nobody notices. Every worker is checked every cycle and every check ends in an
action.

| State (xtmux agent state) | Meaning | Coordinator action |
|---|---|---|
| `running` | working | none; check again next cycle |
| `needs-input` | waiting on a confirmation or a question | read the prompt (below); alert the operator in one line with window name and prompt; never approve it yourself |
| `done` | turn finished, nothing queued | read its last journal entry (`sb journal latest <ref>`): result written and issue closing, collect it and reap the window (below); work left, steer it with a message |
| `off` / window dead | session ended | resume in a new window from `sb issue resume <ref>` |
| `running` but silent | no journal entry and no pane output for a long time | look at the pane; if truly stuck, steer, then restart from the capsule |

Read the state with `xtmux topology --json` (pane, window, `agent.state`, `agent.last_transition`).
Read what a `needs-input` pane is asking with plain tmux, and match it:

```
tmux capture-pane -p -t <pane-id> | tail -15
PROMPT='Allow execution\?|y/enter: allow|Do you want to proceed|\(y/n\)|\[y/N\]|Allow project MCP'
```

The Pi prompt above was seen live ("Dangerous Command Detected ... Allow execution? ... y/enter:
allow"). Learn the matcher for any other runtime from its first prompt: capture the pane, copy the
distinctive line, add it to `PROMPT`. Silence is measured with `#{window_activity}` (epoch seconds
of the last output) from `tmux list-windows -F`.
- After send-keys into a Claude Code pane, send `C-m` and verify the input line is empty, because pasted text can sit unsubmitted.
- Send pi panes a one-line brief path, never multiline paste, because pi submits on the embedded newline and truncates.

Who answers: the operator answers destructive, privileged or unfamiliar prompts. The coordinator
answers a routine prompt only when the operator said that class is allowed. Never approve sudo for a
worker; never relay an approval between sessions.

**Monitors.** Arm a background monitor (the Monitor tool, or `run_in_background`) that loops every
30-60 s over the coordinator's windows and prints one line per change: `WAITING <window> | <prompt>`,
`DONE <window>`, `DEAD <window>`, `SILENT <window> <seconds>`. Key each line on the pane id and print
the window name beside it: window names are lower-cased (`claude-issue-260-...`) and can repeat.
Print only on change, so a long wait does not repeat. Keep the state in the loop, not in a file.
Match a bare prompt line only: a looser pattern gave false DEAD alerts. Exempt roles that are idle
by design (keeper, deploy agent) from SILENT. Monitors die with the session and when a
window is replaced:

- Re-arm after every worker launch, restart or handoff, and at the start of each cycle if
  none is running.
- List the live monitors in the `handoff` entry.
- A monitor line is a trigger, not a verdict: look at the pane, then act.

## Reaping: close finished windows

Forgotten windows keep their runtimes alive. Ten of them once pushed the server load to about 700.
A finished worker's window never stays open.

1. A worker is finished when its issue is closed, or when it is `done` and the coordinator has
   collected its result.
2. Confirm the `result` entry exists: `sb journal latest <ref> --kind result`.
3. Close the worker's pane in the same cycle: `tmux kill-pane -t <pane-id>`, using the pane id that
   `--window` printed. Never use `tmux kill-window`: a window can hold split panes, and a
   kill-window once closed the coordinator itself and the operator's monitor pane. Before you kill,
   check that the id is the worker's pane: `tmux display-message -p -t <pane-id> '#{window_name}'`.
4. Do not close a window whose result entry is missing. Steer the worker or restart it from the
   capsule first.
5. List the open windows (`tmux list-windows -t "$S" -F '#{window_name} #{pane_id}'`) in every
   `handoff` entry, with the issue ref of each.

## Specialists and AgentRun

Interim rules, learned on the MMD-2331 programme (October 2026). XT-132 replaces them with the final
routing rule.

**Specialists**

- Dispatch through the plugin MCP (`specialist_dispatch`, `specialist_status`, `specialist_result`),
  not the `sp` CLI. The result arrives as a channel push; `specialist_status` is the authoritative
  read.
- Create the issue first, under its theme (`sb issue create --parent <theme>`), attest it, then
  dispatch with `issue_ref`. An inline `contract` creates an issue with no parent, outside the
  programme tree, and `sb` cannot set a parent later. `issue_ref` also allows `epic_context_depth`.
- Review and audit roles run READ_ONLY. A writer needs the workspace lease.
- Sandbox by role: default specialists have no network, `gh`, tmux, ListAgents or host writes — work that needs them goes to a window worker. Exception: `board-audit-runner` (LOW + `execution.lease_waiver`, v1.7.0) runs in an isolated per-Issue worktree where bash is admitted: `gh pr view/list` read-only, `git merge-base --is-ancestor` read-only, `python3 scripts/jira.py` for Jira reads (writes only on coordinator word per proposal-only rule), `sb` reads plus journal writes only on coordinator word. Still no tmux, ListAgents, host writes outside the worktree, repo edits, or production actions. Its `denied_bash_patterns` enforce this; `gh` mutations stay denied.
- After editing a specialist definition, restart the host or rename the definition: the loader
  caches definitions, and a list and a dispatch can disagree.
- Long jobs: Claude Code runs them with `Bash` `run_in_background`; Pi runs them with `BashBackground` plus `Monitor`; `TaskStop` stops either one. Stay silent while healthy, escalate only on a problem. Read the output file with `read`, never by tailing it in the turn. Delegated-agent and fusion workflows are retired (CORE-2443 M1): they caused host-memory pressure and no longer exist — monitor with completion notices instead.
- A specialist counts toward the worker cap. Before a restart or handoff, settle or stop each
  activation, and list the live ones in the handoff.
- Release a claim held by a stopped specialist with `sb issue release <ref> --holder specialist::<name> --activation <id>`, because a restart orphans its activation.

**AgentRun**

- Use it only for repeated judgment work in a workflow the operator approved (examples: a contract
  audit, a Jira audit, the daily report).
- Route on the decision's choice value, not on its confidence. Use Jev decisions first for semantic
  choices, and code for exact checks.
- A run ends. It cannot watch liveness: the monitor loop does that.
- Report its findings as claims: check a sample before acting on them (a Jira audit run had about
  30% false positives).

## Limits and health

- **WARNING: host memory, not the worker count, is the hard limit.** On 2026-10-18 three
  coordinators each fanned out background reviewer and builder subagents that ran full test
  suites in parallel, on top of 8 pi workers, the databases and the feeds. The VPS swap-stormed for
  4 hours (load 150, 9 GB swap, memory full-stall 52%), and the operator had to kill every Claude
  process from the root console. The rules:
  - At most 2 in-process subagents per coordinator at once, and at most 1 of them running tests.
  - Nobody (subagent, reviewer or window worker) runs a full suite or `make ci-light` locally
    while other workers are live. Run targeted test files only, one file at a time, under `ulimit -v 4000000` (2 GB is too small for some suites) and
    `timeout 600`. Hosted CI is the full-suite evidence.
  - Before each dispatch, run the budget preflight and apply the gate of the action's class (SKILL.md,
    "3. Workers (fleet)", rule 2.2): a launch needs load1 <= 15 plus the memory gate, a fan-out or per-item
    loop load1 <= 10 with concurrency <= 2, a merge the memory gate only. The memory gate refuses when
    `/proc/pressure/memory` `full avg10` is above 10 or `MemAvailable` is under 4 GB. Do not dispatch when swap use
    is rising or `full avg60` is above 5.
  - The cap is host-wide: agree on a total of live build workers across all coordinators (pi
    windows plus subagents), and stagger test runs.
  - Hosted CI is not free on Mercury: the self-hosted GitHub runners run on the same VPS. Every
    push to a PR starts a test suite on this host (a heavy one for some PRs), and three PRs
    pushed within minutes run three suites at once. Stagger pushes across workers, never
    re-trigger runs with empty commits or manual dispatches while other runs are queued, and count
    running CI jobs in the memory check.
  - Subagents die with their parent session. A coordinator kill loses every in-flight subagent, so
    long builds belong in window workers with their own issue, not in subagents.
- Caps: at most 3 own worker windows plus 1 board helper per coordinator. Host cap 10 (operator, 2026-10-28); while operator row q-night-builders is open a coordinator may run up to 12 between 22:00 and 12:00Z as a journaled exception; specialists count toward the cap (SKILL.md, "3. Workers (fleet)", rule 2.3). The cap counts every live agent process in the
  session (builders, reviewers, monitors, idle sessions), not active issues: once, 10 agent
  processes were live while the coordinator counted 3 workers. Reap before you launch. Shared model quotas stop everyone. On a quota 429: pause dispatch and tell the
  operator in one line.
- Worker context at 25-30%: `/compact` once, then a fresh window resumes from `sb issue resume`.
- Reviewer, investigator, release or monitor roles are ordinary workers with their own issue.
- Address peers by the exact name `ListAgents` prints; answer the newest message when two cross.
- Stalled window: `tmux capture-pane -p -t <pane-id> | tail`, then
  `sb journal since <ref> <cursor>`; decide whether to steer, restart from the capsule, or close.

## Merge lists

Judge each PR on a merge list by: draft status, review head against current head, alembic single
head, and the FIRST window that actually carries the PR to production (stable moves only by
promotion). "Mergeable and a window exists" is not the bar.
