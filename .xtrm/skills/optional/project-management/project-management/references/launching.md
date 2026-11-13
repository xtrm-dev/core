# Launching: agents as windows in the project's session

Mechanics only: launch syntax, liveness, reaping, specialists, limits. Who launches what and when: SKILL.md "Who does what", `references/manager.md`
§0, `references/lead.md` §7.

## Rule

All agents of a project live in one tmux session, the manager's: the manager window holds the manager and its helpers as panes, each lead has its
own window, every worker is a pane of a tiled `workers` window (at most 4 panes each), never one window per worker. `tmux list-windows` is the
roster the operator sees.

## Dispatch surface (verified 2026-10-24 from `--help` and the MCP schemas)

Run the budget preflight first (SKILL.md rule 2) and record its line in the launch entry.

| Shape | Exact syntax | Notes |
|---|---|---|
| `xt claude` worker | `xt claude <name> --window --model sonnet\|opus --prompt '/<skill> ... /goal ...' -- --effort low\|medium\|high\|xhigh\|max` | Effort goes after `--`. `--thinking` is dropped with a warning. |
| worker role (default) | `xt claude\|pi <name> --window --role worker --bead <ref> [--model sonnet\|opus] [-- --effort high]` | `~/.specialists/user/worker.specialist.json` (MMD-3200). Loads this skill and using-specialists at turn 1; Claude default `sonnet`, pi default DeepSeek V4.1 Flash. `--bead` is the prompt. |
| `xt pi` worker | `xt pi <name> --window --model <provider/id> --thinking off\|minimal\|low\|medium\|high\|xhigh --prompt '/skill:<name> ... /goal ...'` | Default `deepseek/deepseek-v4.1-flash` (provider `commandcode`), thinking high; Muse Spark is `commandcode/meta/muse-spark-1.3-contributor`. `--skill <name>` repeats. |
| Role session | `xt claude\|pi --role <role> [--bead <id>] [--model ...]` | `--model` overrides the role's; `--bead` and `--prompt` exclude each other. |
| Manager or lead | `xt claude <day>-manager\|<epic>-<area>-lead --window --role project-manager --bead <ref> --model opus\|sonnet -- --effort high` | The name suffix picks the mode (SKILL.md "Who does what"); a worker name never ends in `-manager` or `-lead`. |
| Board helper | `xt pi board-helper --window --role board-audit-runner` | The only Jira writer; one per project. |
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

One fresh worker per Substrate issue (SKILL.md rules 37, 39; MMD-3200, operator 2026-10-31); it reads `references/worker.md` first and may coordinate
specialists and consult the advisor.
1. **Contract** (the issue is the prompt; a restart resumes from `sb issue resume <ref>`; no `briefs/` folder):
   `sb issue create --project <id> --title <t> --kind task --parent <ref> --scrutiny LOW|MEDIUM|HIGH|CRITICAL --contract <file>`; `validation` is
   `{check}` objects, `output` `{artifact}` objects. The contract is the prompt, so it names files, the branch base (`origin/master`), the tests to
   run and the stop conditions. OUTPUT follows SKILL.md "The rule: two systems, bound files": rulings and reviews go into the journal (`--semantic`)
   and a Jira comment text; a durable document is committed and bound.
2. **Attest:** `sb issue attest <ref> --outcome ready --policy default --attested-by <you>`; `sb issue show <ref> --json` must show `readinessState`
   `ready`, `dispatchable` `true`.
3. **Launch from the main checkout** (after the rule 2.2 preflight):
   `xt claude <name> --window --role worker --bead <ref> --model sonnet|opus -- --effort high` or `xt pi <name> --window --role worker --bead <ref>`.
   Effort defaults to medium: pass high for builders (Opus for maths and data meaning). Pi or Sonnet builder: choose per task (SKILL.md rule 40); a
   pi builder needs a tight contract and a first-diff check. Refuse or queue when a cap or
   gate fails; a new builder launch waits for the operator's word when the operator has ruled so. A start-up line "could not read <ref>" is harmless.
4. **Place the pane:** `tmux join-pane -d -s <pane> -t <session>:workers`, `tmux select-layout tiled`; at most 4 panes per `workers` window.
5. **Supervise by exception:** arm the pane monitor; verify claims against the live tree. A different scope means a fresh issue and worker. **Reap**
   with `kill-pane` by id when the issue closes.

Another role (`--role executor`) is not a worker: on Claude it MUST pass `--model sonnet|opus` or the session dies at turn 1, and its prompt carries
the rule-37 line. A bounded read or test run needs a specialist, not a window. A PR review is neither: it follows SKILL.md rule 44 (only `xt claude
--role pr-reviewer --model sonnet|opus`).

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

Interim rules from the MMD-2331 project (October 2026); XT-132 replaces them.

**Specialists**
- Dispatch through the plugin MCP, not the `sp` CLI; `specialist_status` is authoritative. Create the issue under its theme and attest it first: an
  inline `contract` makes a parentless issue and `sb` cannot set a parent later.
- Default specialists have no network, `gh`, tmux, ListAgents or host writes: that work goes to a window worker. Exception `board-audit-runner` (LOW +
  `execution.lease_waiver`, v1.7.0): per-Issue worktree with `gh pr view/list`, `git merge-base --is-ancestor`, `python3 scripts/jira.py` and `sb`
reads; Jira writes only through the board helper, journal writes only on the order of the manager or the owning lead. A `board-audit-runner`
specialist does not write Jira: it proposes, and the board helper writes on that order (sun01-coord, 2026-11-01); `denied_bash_patterns` enforce it: still no tmux,
  ListAgents, host writes outside the
  worktree, repo edits, production actions or `gh` mutations.
- Long jobs: Claude `Bash` `run_in_background`; Pi `BashBackground` plus `Monitor`; `TaskStop` stops either. Stay silent while healthy, escalate only
  on a problem; read the output file with `read`, never tail it in the turn. Delegated-agent and fusion workflows are retired (CORE-2443 M1,
  host-memory pressure).
- After editing a definition restart the host or rename it: the loader caches.
- A specialist counts toward the worker cap. Before a restart settle or stop each activation; release a stopped one's claim with
  `sb issue release <ref> --holder specialist::<name> --activation <id>`.

**AgentRun**
- Findings are claims: sample-check before acting (a Jira audit run had about 30% false positives).
- Route on the decision's choice value, not its confidence; Jev decisions first for semantic choices, code for exact checks. A run cannot watch
  liveness: the monitor loop does.

## Limits and health

- **Host memory, not worker count, is the hard limit.** On 2026-10-18 three coordinators fanned out subagents running full test suites beside 8 pi
  workers, the databases and feeds: the VPS swap-stormed for 4 hours (load 150, 9 GB swap, memory stall 52%) until the operator killed every Claude
  process.
  - At most 2 in-process subagents per manager or lead, 1 running tests. Subagents die with their parent: long builds belong in window workers.
  - No full suite or `make ci-light` locally while other workers are live: targeted files, one at a time, under `ulimit -v 4000000` and `timeout 600`;
    hosted CI is the full-suite evidence.
  - Before each dispatch run the preflight and the class gate (rule 2.2); do not dispatch when swap use rises or `full avg60` is above 5.
  - Hosted CI shares this VPS: stagger pushes, never re-trigger with empty commits or manual dispatches while runs queue, count running CI jobs in the
    memory check.
- Caps: SKILL.md rule 2.3 (per lead 3 worker windows; host cap 18 while the memory gate holds; once 10 processes were live while one session
  counted 3 workers). Quota 429: pause dispatch, tell the operator in one line (rule 30). Compacting a Pi worker: `references/continuity.md`.
- Reviewer, investigator, release or monitor roles are ordinary workers with their own issue.

