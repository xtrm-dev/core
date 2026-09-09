# Surfaces — command-level detail

Verified against a live xtrm install. Anything here can drift; `--help` is authoritative.
Read this when you need exact flags. For orientation, SKILL.md is enough.

## Contents
- [xt — sessions, worktrees, topology](#xt)
- [sp — specialists](#sp)
- [xtmux — pane coordination](#xtmux)
- [bd / bv — the work graph](#bd--bv)
- [Harness continuity primitives](#harness-continuity-primitives)
- [Failure modes worth recognising](#failure-modes-worth-recognising)

---

## xt

Agent infrastructure: runtimes, skills, hooks, packages.

| Command | Use |
|---|---|
| `xt claude [name]` | Launch a Claude session in a sandboxed worktree |
| `xt pi [name]` | Launch a Pi session |
| `xt codex [name]` | EXPERIMENTAL: Codex in an xt-owned worktree |
| `xt topology` | Read-only projection joining panes, roles, specialist jobs, beads, worktrees, branches, PRs |
| `xt attach <name>` | Re-attach to an existing worktree and resume its session |
| `xt end` | Close session: rebase, push, open PR, link beads, clean worktree |
| `xt merge` | Drain the worktree PR merge queue via the xt-merge specialist |
| `xt worktree` | Manage session worktrees |
| `xt status` / `xt docs` / `xt memory` | Status+sync, doc drift checks, project memory |

Common launch flags: `--bead <id>` (assigns the bead at launch), `--no-attach`, `--json`,
`--prompt "..."`, `--model <id>`.

**`--bead` assigns the bead at launch.** The worker's own `bd update --claim` then fails
with "already claimed by <runtime>/<slug>" — that slug is the worker itself. It is not a
conflict. Workers should verify the assignee matches their own runtime origin and
proceed; agents have stopped dead on this.

**Worktree occupancy does not follow the pane name.** Git refuses the same branch in two
worktrees, so an agent dispatched to fix an existing branch often ends up working inside
*another* pane's worktree while its own sits untouched. Resolve which worktree a session
actually occupies before removing anything — deleting a "finished" lane's worktree can
destroy a live one's working tree.

---

## sp

Project-scoped specialist agents, bead-first. `/using-specialists` is the doctrine; this
is only the surface.

```
sp chat <name> [--bead <id>] [--prompt <text>] [--context-depth N]   # tracked, TUI
sp run  <name> --prompt "..."                                        # ad-hoc
sp ps <job-id> --json                                                # status
sp console                                                           # operator TUI
```

- `--bead` is for tracked work; `--prompt` is for quick untracked work.
- `chat` without `--bead` auto-creates an ephemeral tracked bead.
- `--context-depth` defaults to 3 with `--bead`.
- `--no-beads` does **not** disable bead reading.
- Output modes: default human, `--json` NDJSON event stream, `--raw` LLM text deltas.
- MCP `use_specialist` runs in the foreground and returns the result directly.

---

## xtmux

`xtmux mux-help` prints the coordination contract. The essentials:

**Communication priority**
1. **beads first** — durable task contract (`bd show <id>`)
2. **`/tmp` prompt-file second** — ephemeral constraints and meta-protocol
3. **`send-keys` third** — single-line pointer only, never a payload

**Never send while working**
```
wait-agent <pane> [--wait-for-transition] --timeout 30m --interval 30s   # BLOCKS
monitor-agent <pane> [--wait-for-transition] ...                         # returns immediately
monitor-list --json / monitor-kill <id>
```
`monitor-agent` registering is not a completion. This has been misread as one.

**Safe handoff**
```
handoff --target <pane> --bead <id> --note '...' [--prompt-file X --wait-ready 2m --monitor]
safe-send-pointer [--reply-to <messageKey>] <pane> 'read /tmp/file.md and follow it'
```
Add `--yes` only after inspecting the printed command.

**Messages**
```
message-send --to <session|pane> [--from x] [--bead id] [--expects-reply[=true|false]] --text <text>
message-list --unacked --expects-reply [--for <name>]
message-reply --in-reply-to <messageKey> --text <text>
message-ack        # receipt, NOT a reply
```
- `--bead` implies `--expects-reply=true`; pass `--expects-reply=false` for a pure ruling
  the recipient should not block on.
- `message-reply` only works from the pane the message was addressed to. From anywhere
  else use `message-send --to <session> --to-pane <%id>`.
- `--for` matches **literally** and silently returns nothing on a miss. Try the bare lane
  name, the prefixed session name, and the `$id` before concluding an inbox is empty.
- The inbox accumulates across sessions; filter by recency and bead rather than draining.

**Inventory**
```
dashboard sessions-only     # compact orchestrator TSV
dashboard expanded          # pane-level detail
audit                       # read-only hygiene report
worktree-collisions         # shared checkout warnings
```
Cleanup rows are candidates, not instructions. Dirty, shared, or working sessions are not
safe to kill blindly.

---

## bd / bv

`bd prime` at session start (and after compaction) loads live workflow context. `bd` owns
creating, claiming and closing; `bv` owns *what to work on*.

```
bd ready | bd blocked | bd show <id> | bd search <text>
bd update <id> --claim | --notes "..." | --status=blocked
bd create --title=... --type=task --priority=2 [--parent <id>] [--deps "discovered-from:<id>"]
bd dep add <issue> <depends-on> | bd dep tree <id>
bd close <id> --reason="..."
bd export --output .beads/issues.jsonl
```

`bv --robot-triage` is the entry point; `--robot-next`, `--robot-plan`, `--robot-insights`,
`--robot-forecast`, `--robot-alerts`, `--robot-diff` cover the rest.
**Use only `--robot-*` flags — bare `bv` opens an interactive TUI that blocks the session.**

Filing discovered work with `--deps "discovered-from:<id>"` and returning to the original
task is how scope stays bounded. A newly found defect earns a place on the critical path
only if it can actually break the thing you are protecting; everything else gets filed.

Practical notes: `bd export` and commit hooks can each exceed two minutes in a large repo
— budget for it rather than backgrounding a dependent chain. `.beads/` may be
`skip-worktree` in agent worktrees, so exports belong to the main checkout path. If a
remote sync backend is broken, the JSONL export may be the only off-host copy of the
board; treat it accordingly.

---

## Harness continuity primitives

| Primitive | Shape |
|---|---|
| `/goal <objective>` | Standing objective across turns; evaluator fires when background shells and subagents finish |
| `/loop [interval] <prompt>` | Recurring or self-paced re-invocation |
| `ScheduleWakeup` | Self-paced next wake; `stop: true` ends the loop |
| `Monitor` | Background script; each stdout line becomes a notification |
| `CronCreate` / `CronList` / `CronDelete` | Cron-scheduled prompts |
| `/schedule` | Durable cloud routines that outlive the session |
| `TaskList` / `TaskStop` | Inspect and cancel background tasks |
| `PushNotification` | Pull an absent operator's attention to something actionable |

`/goal` and `/loop` are **built-in commands, not skills** — they will not show up in a
skills listing or under `~/.claude/skills`, and their absence there is not evidence they
are unavailable. `/goal` is generally the better fit for "drive X to completion" because
it re-evaluates when delegated work finishes rather than on a timer; `/loop` is the
choice when you want a fixed interval or explicit self-pacing. Both interact with hooks:
`/goal` needs hooks enabled, and a stop hook that blocks repeatedly will end a turn with
a warning rather than looping forever.

Monitor filters need to cover failure, not just progress. A useful shape emits only on
change and excludes your own coordinator panes, which otherwise flip state between turns
and make the monitor wake itself in a loop.

---

## Failure modes worth recognising

**CI "failures" that are infrastructure.** When self-hosted runners are containers on the
same saturated host, they die and their jobs report as failures. The signature: one step
stuck `in_progress`, every later step `pending`, `conclusion: null`, and HTTP 404 from the
log endpoint because nothing was uploaded. No test ran, so no test is the cause.

```
gh api repos/<owner>/<repo>/actions/jobs/<job_id> \
  --jq '[.steps[]|"\(.number) \(.status) \(.conclusion) \(.name)"]'
```

Fetch the step list before concluding a job failed on its merits. Runners generally
self-heal; restarting one mid-bootstrap makes it worse. `gh run view --log` returns
nothing while a run is still open — that is not evidence of no failure.

**A PR that is `BLOCKED` with everything green.** Often stale *duplicate* check-runs on
the same SHA leaving the required context absent from the rollup. The default check-runs
filter hides them:

```
gh api .../check-runs?filter=all
```

The remedy is an empty commit for a clean head SHA — no history rewrite, no content
change, no admin override:

```
BASE=$(git rev-parse origin/<branch>); TREE=$(git rev-parse origin/<branch>^{tree})
NEW=$(git commit-tree "$TREE" -p "$BASE" -m "chore: clean head SHA")
git diff --stat "$BASE" "$NEW"                      # must be empty
git push origin "$NEW":"refs/heads/<branch>"
```

In zsh, `"$NEW:refs/heads/…"` silently applies the `:r` history modifier and the push
fails with a mangled refspec. Quote the colon separately, as above.

**Merge state that no one can explain.** If a merge is refused and nothing inspectable
accounts for it, that is a reason to stop and ask, not to force. Overriding an
unexplained base-branch policy is exactly the class of irreversible action that belongs
to the operator.

**Counting review threads.** `mergeStateStatus: UNSTABLE` says nothing about threads.
Count unresolved ones explicitly, and check `isOutdated` — an unresolved-but-outdated
thread is a different situation from a current one.

```
gh api graphql -f query='{repository(owner:"O",name:"R"){
  pullRequest(number:N){reviewThreads(last:40){nodes{isResolved isOutdated path line}}}}}'
```

Where a review gate blocks on unresolved bot threads, replying is not resolving.
