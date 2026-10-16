# Fleet: workers as windows in the coordinator's session

## Rule

The coordinator keeps all its workers in **its own tmux session**, each in a **new window**. No
separate sessions per worker. The operator sees the whole programme in one place, and
`tmux list-windows` is the roster.

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

## The worker's brief is its issue

1. Create the worker task under its theme (`sb plan apply` or `sb issue create --parent`).
2. The coordinator attests it.
3. Launch the window. The prompt names only the issue ref, the skills and the `/goal`.
4. The worker claims it with `--holder <name>`, checkpoints after each milestone and at its
   context limit, and closes with a `result`. A restarted worker resumes from
   `sb issue resume <ref>`, never from chat.

No `briefs/` folder, no brief file: if a requirement matters, it belongs in the contract.

## Prompt hygiene (every worker)

- Name the banned commands that dump secrets: `env`, `printenv`, `docker inspect` without a
  format, `cat .env`. Give the names-only form.
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

Who answers: the operator answers destructive, privileged or unfamiliar prompts. The coordinator
answers a routine prompt only when the operator said that class is allowed. Never approve sudo for a
worker; never relay an approval between sessions.

**Monitors.** Arm a background monitor (the Monitor tool, or `run_in_background`) that loops every
30-60 s over the coordinator's windows and prints one line per change: `WAITING <window> | <prompt>`,
`DONE <window>`, `DEAD <window>`, `SILENT <window> <seconds>`. Key each line on the pane id and print
the window name beside it: window names are lower-cased (`claude-issue-260-...`) and can repeat.
Print only on change, so a long wait does not repeat. Keep the state in the loop, not in a file. Monitors die with the session and when a
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

## Limits and health

- At most 3 own worker windows open at once. The cap counts every live agent process in the
  session (builders, reviewers, monitors, idle sessions), not active issues: once, 10 agent
  processes were live while the coordinator counted 3 workers. Reap before you launch. Shared model quotas stop everyone. On a quota 429: pause dispatch and tell the
  operator in one line.
- Worker context at 25-30%: `/compact` once, then a fresh window resumes from `sb issue resume`.
- Reviewer, investigator, release or monitor roles are ordinary workers with their own issue.
- Address peers by the exact name `ListAgents` prints; answer the newest message when two cross.
- Stalled window: `tmux capture-pane -p -t <pane-id> | tail`, then
  `sb journal since <ref> <cursor>`; decide whether to steer, restart from the capsule, or close.
