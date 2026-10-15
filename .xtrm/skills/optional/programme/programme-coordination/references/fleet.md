# Fleet: workers as windows in the coordinator's session

## Rule

The coordinator keeps all its workers in **its own tmux session**, each in a **new window**. No
separate sessions per worker. The operator sees the whole programme in one place, and
`tmux list-windows` is the roster.

## Launch

```
S=$(tmux display-message -p '#S')                      # the coordinator's session name
P=$(tmux new-window -d -P -F '#{pane_id}' -t "$S" -n <name> -c <repo-or-worktree> \
  "SUBSTRATE_HOLDER=<name> xt claude <name> --prompt '<skills> Resume CORE-2401 and follow its contract. Dispatched by <your ListAgents name>: report to it with SendMessage and journal on your issue. /goal ...'")
tmux set-option -p -t "$P" @agent_parent_session "$(tmux display-message -p '#{session_id}')"
```

The prompt must say who dispatched the worker, by the exact name `ListAgents` shows for the
coordinator's session. `@agent_parent_session` (the parent link that topology and `xt` read) is set by
`xt` only for `--role` launches, so set it by hand for a plain worker. Both are manual today; the
launcher should publish the dispatcher itself (follow-up).

- `-d` keeps the coordinator's window in front. `-n <name>` names the window; use the same name
  for the claim holder and `SUBSTRATE_HOLDER`. Start the name with the Story's Jira key
  (`ISSUE-260-pi-runtime`): `xt claude` makes the branch `xt/<name>`, and the key in the branch name,
  PR title and commit trailer is what the Jira dev panel links on, once GitHub for Jira is connected
  (an open decision in XTRM-110).
- `xt claude <name>` makes a sandboxed worktree on branch `xt/<name>`. Other runtimes: `xt pi <name>`,
  `xt codex <name>` take the same shape. A specialist role: `xt claude <name> --role <role>`.
- `--prompt` starts the session. A leading `/<skill>` loads a skill on turn 1. Builder skills:
  `/using-xtrm /multiplexing /engineering-quality /gitnexus`. Investigator: `/using-xtrm
  /multiplexing /service-knowledge /sre-ops`. Add `/using-substrate` if the runtime lacks it.
- Verify after launch: `tmux list-windows -t "$S"`, then the worker's first journal entry shows
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
| `done` | turn finished, nothing queued | read its last journal entry (`sb journal latest <ref>`): result written and issue closing, collect it; work left, steer it with a message |
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
`DONE <window>`, `DEAD <window>`, `SILENT <window> <seconds>`. Print only on change, so a long wait
does not repeat. Keep the state in the loop, not in a file. Monitors die with the session and when a
window is replaced:

- Re-arm after every worker launch, restart or handoff, and at the start of each cycle if
  none is running.
- List the live monitors in the `handoff` entry.
- A monitor line is a trigger, not a verdict: look at the pane, then act.

## Limits and health

- At most 3 own workers at once (shared model quotas stop everyone). On a quota 429: pause dispatch
  and tell the operator in one line.
- Worker context at 25-30%: `/compact` once, then a fresh window resumes from `sb issue resume`.
- Reviewer, investigator, release or monitor roles are ordinary workers with their own issue.
- Address peers by the exact name `ListAgents` prints; answer the newest message when two cross.
- Stalled window: `tmux capture-pane -p -t <session>:<name> | tail`, then
  `sb journal since <ref> <cursor>`; decide whether to steer, restart from the capsule, or close.
