---
name: session-recovery
description: >-
  Restore agent sessions after tmux/server loss — OOM, reboot, kill-server. Use
  when sessions/worktrees that were open are gone after a host crash, the user
  asks "which agents were open / reopen them / what did I have running", or the
  durable xtmux session snapshot needs interpreting (`xtmux-obs sessions`,
  xtmux.session-snapshot.v1, xt attach into lost worktrees). Also use to verify
  the snapshot writer (cron) is running BEFORE something is lost. Not for live
  coordination between running panes (${multiplexing}): /skill:multiplexing —
  not for production incident triage: /skill:sre-ops — not for resuming one's
  own work contracts inside an Issue: /skill:using-xtrm.
---

# Session recovery — restore agents after tmux/server loss

The tmux inventory lives only in the server. When it dies, the map "which agent
was open in which worktree, on which branch, doing what" dies too — unless the
durable snapshot exists (xtmux XTMUX-491 machinery, cron-refreshed every
minute to `${XDG_STATE_HOME:-~/.local/state}/xtmux/sessions/`).

## Phase 0 — pre-loss sanity (use whenever touching sessions)

Confirm the writer is armed, so recovery later is one command:

```bash
crontab -l | grep -o 'xtmux-obs snapshot-sessions.*'   # cron line present
xtmux-obs sessions                                     # renders + refreshes
```

Missing cron line → suggest installing it. Cron's PATH has no node by
default — xtmux-obs is a `#!/usr/bin/env node` script, so seed the path
(detect your node dir with `which node | xargs dirname`):

```
* * * * * PATH=<node-bin>:/usr/bin:/bin /path/to/xtmux-obs snapshot-sessions --json >/dev/null 2>&1
```

2026-10-05 verified on this host: without the PATH prefix every minute failed
silently (`env: 'node': No such file or directory`).

## Phase 1 — read the inventory

The goal is everything that was open in the session just before the loss,
whatever each agent's state. Agent state does not filter the list.

**First: the pinned pre-loss snapshot.** When the tmux server identity changes,
the server dies, or the machine reboots, the snapshot writer pins the last live
snapshot to `~/.local/state/xtmux/sessions/pinned/pre-loss-<ts>.json` (newest 5
kept, never rotated):

```bash
xtmux-obs sessions --pre-loss           # every pane open before the loss
xtmux-obs sessions --pre-loss --json    # schema xtmux.session-snapshot.v1
uptime -s                               # confirm the pin predates the loss
```

One row per pane: `session, windowIndex, windowName, paneId, currentCommand,
cwd, repo, branch, agentStateRaw, attachSlug`. Filter to the named session
(`.panes[] | select(.session=="xtrm-rc")`) and reopen every agent pane.
`scripts/restore-plan.sh` turns a snapshot into an ordered reopen plan.

**Fallback: transcripts**, only when no pin predates the loss (writer not yet
upgraded, or cron was not running). Transcript recency misses agents that sat
idle long before the loss, so say so in the report:

```bash
scripts/transcript-tips.py            # window = [boot-8h, boot]; --hours N, --until ISO, --json
```

One row per claude/pi transcript: time, kind, id, `LIVE`/`DOWN` (a process
already runs in that cwd), cwd, last role and the tip of the conversation. A
last role of `user` means the agent died mid-turn. `DOWN` rows carry the reopen
command. A session already resumed writes after boot and drops out of the window.
Procedure details and manual parsing: `references/manual-playbook.md`.

```bash
scripts/transcript-tips.py --session xtrm-rc   # only rows under dev/core, dev/xtrm, dev/specialists
scripts/transcript-tips.py --classify           # Jev triage: only rows needing action
scripts/transcript-tips.py --self-test          # runnable self-check (no network)
```

- `--session <name>` scopes rows by cwd to that tmux session's repos
  (`xtrm-rc` = `dev/core`, `dev/xtrm`, `dev/specialists`; any other name
  falls back to a cwd substring match). Default output is unchanged when
  the flag is absent.
- `--classify` (state triage, not inventory: it hides rows, so never use it
  to answer "what was open") drops mechanically finished rows (tip ends in a
  REPORT/HANDOFF block or Done), sends only the remaining ambiguous DOWN
  rows to Jev (TypeSafe choice `finished|mid-work|blocked` with
  probability, one batched request) and prints only rows that need action,
  each suffixed `[jev: <choice> p=<prob>]`. Rows Jev calls `finished` are
  hidden. Without a TypeSafe key, or on API error (including 402), it
  degrades to the unclassified ambiguous rows with a one-line notice on
  stderr; exit status stays 0 and `--json` output stays valid.

Scope to the tmux session the operator named by matching cwd to that session's
repo (for `xtrm-rc`: `dev/xtrm`, `dev/core`, `dev/specialists`). List other
repos' DOWN rows separately, with a one-line state from the tip (finished,
blocked, or died mid-turn). Do not reopen them unasked.

## Phase 2 — triage the rows

Order by importance: agent panes first, scratch shells last.

1. **Agent panes** (command claude/pi/codex + worktree cwd): rank by
   `agentStateRaw` (`running` mid-work > needs-input > done > idle) and known
   importance; a `running` snapshot just before the crash = agent died
   mid-task.
2. **Worktrees with changed/branch state**: pane row or `transcript-tips.py`
   carries the worktree; prefer `xt attach <slug>` — it re-enters the worktree and resumes the
   agent session; transcript restore happens inside the agent runtime.
3. **Scratch shells** (`zsh`, non-repo cwd): reopen lazily/on request, lowest
   priority; sessions may not need all of them.

Also check processes which may have died WITH the server but belong to service
stacks (containers `OOMKilled=true` / `Exited`) — that is /skill:sre-ops
territory; run it in parallel, not instead.

## Phase 3 — reopen

For each chosen row, in tmux (creating windows/sessions is safe; NEVER kill a
tmux server/session — hard safety rule):

```bash
# worktree agent
tmux new-window -t <session> -n <slug> -c <worktree-cwd> '<agent-resume-cmd>'

# resume variants
claude --resume <session-uuid>     # precise; probe the runtime files for the id
claude -c                          # most recent conversation in that cwd
pi                                 # general restart in the worktree

# fallback for plain shells
tmux attach -t <session>:<windowIndex>
```

Runtime session ids when the snapshot lacks them:
`references/manual-playbook.md` has the exact parse to fetch the newest
session uuid per project dir.

## Phase 4 — verify

- New pane shows restored context (transcript %, agent strip, first prompt).
- First-turn MCP approval gates may appear in fresh worktrees — the operator
  decides what to enable; never silently approve new MCP servers.
- Note survivors vs losses in the report: every reopen gets the row evidence
  (pane row → command run → status) and `xtmux-obs sessions` timestamps.
- If the loss was an OOM, close the loop with /skill:sre-ops for the
  resource-cause analysis (root cause, not just session reattachment).

## Trust and dependencies

- Depends on `@jaggerxtrm/xtmux` with the snapshot commands (PR128-era ≥ the
  XTMUX-491 change); degrade gracefully: no snapshot commands → manual
  playbook.
- Read-only over session history files; reopening restores user-owned state
  only. Ask before reopening anything that could carry destructive state
  (e.g. a pane that was mid-deploy).
