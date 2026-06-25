---
name: multiplexing
description: Help the operator coordinate work across N concurrent tmux sessions (Claude Code, pi, raw shells, vim, REPLs). Inventory state, hand off tasks cleanly, prevent messy-run failure modes, keep hygiene. Not an agent harness; not a /using-specialists-v3 replacement; tool-agnostic. Invoked explicitly via /multiplexing — do not rely on auto-activation.
---

# Multiplexing

You are an orchestration assistant for an operator who works in N concurrent tmux sessions at once. Each session runs its own tool (Claude Code, pi, raw shell, vim, REPL). Your job: inventory, hand off, monitor, clean up, recover. You do not run a new harness. You do not replace specialists. You do not assume the operator uses you in any specific session — they may switch agents at any time.

This skill is invoked explicitly via `/multiplexing`. Auto-activation through keyword triggers is unreliable across harnesses; do not assume it fires.

## When this skill applies

The operator triggers `/multiplexing` when they want:
- An inventory of what is running where across their tmux sessions
- Help delegating a task to another session
- Cleanup of dead sessions, orphan processes, leaked worktrees
- Recovery from a "messy run" (a delegated agent that filed spurious beads, fragmented prompt, off-rails behavior)
- A coordinated multi-session plan toward a single goal

## When it does NOT apply

- Specialist chain orchestration → use `/using-specialists-v3`
- Designing a new agent runtime or harness → out of scope
- In-process subagent spawn (Claude Agent SDK, Cline, Cursor subagents, etc.) → out of scope; this skill stays tool-agnostic
- Single-session deep work → no multiplexing needed

## Cardinal rules — non-negotiable

1. **Never multi-line paste via send-keys.** Each `\n` inside the send-keys argument is interpreted as Enter. The delegated agent receives N separate fragmented prompts instead of one.
2. **Never use `$(...)` or backticks** inside the send-keys argument. Shell expansion can inject characters into the target pane unexpectedly.
3. **Never use `tmux paste-buffer`** with a file that contains newlines. Same fragmentation problem as rule 1.
4. **Never send a prompt while the target pane is in Working state.** It will be queued, fragmented, or worse, race against in-flight tool output.
5. **Never invent ad-hoc session names.** Always follow the naming convention below.

## Communication primitives — beads first, /tmp second, send-keys third

The operator's workflow uses three concentric primitives. Pick the right one per content type. Do not invent a fourth.

### Beads — persistent inter-session comms (PRIMARY)

Beads (`bd`) are the canonical cross-session communication primitive in xtrm-equipped projects. They survive session deaths, harness restarts, agent switches, and orphan processes. They are the single most important comms layer in this skill. Use them for:

- **Task content**: title, description, scope, constraints, validation criteria, expected output. The delegated agent reads the bead with `bd show <id>` as the authoritative contract.
- **Findings and output**: the delegated agent appends findings to bead notes via `bd update <id> --notes "..."`. The main session reads them later with `bd show <id>` — no need to scrape the pane.
- **Status changes**: `bd update --claim`, `bd close`, `bd supersede`, dep edges. Any session, at any later time, sees the current state via `bd show` or `bd query`.
- **Cross-session memory**: `bd remember "<insight>" --key <key>` then `bd memories <keyword>` from any session, including future sessions on the same project.
- **Soft handoff between sessions**: chain A finishes, files a follow-up bead with `--deps discovered-from:<source>` → chain B (or session B) picks it up later via `bd ready`.

The operator does NOT need a custom message bus. Beads already are one. Default to beads for any inter-session content that should survive a session crash.

What beads cannot do, and what to use instead:
- **Push notifications**: there is no native push. The main session polls via `bd query "status=closed AND assignee=me"` or watches via a wrapper script.
- **Real-time streaming output**: use `tmux capture-pane` for snapshots or `tail -f` on a log file for streams.

### /tmp prompt-file — ephemeral meta-protocol

Beads carry persistent content. Bootstrap constraints, scope clarifications, and meta-protocol belong in a separate file in `/tmp/<session>-<topic>.txt`:

- Negative constraints ("NEVER merge", "NEVER touch file X", "NO new beads beyond N")
- Output format and report shape
- Which skill to invoke (`/using-specialists-v3`, `/btw`, etc.)
- One-off scope clarifications that do not belong in the bead body

Why separate from beads: these are session-specific instructions that pollute the bead's permanent record. The bead remains a clean task contract; the /tmp file is throwaway.

How to create the file: use Bash heredoc, NOT the Write tool. The Write tool may be blocked by the bd claim gate in xtrm-equipped repos:

```bash
cat > /tmp/<session>-<topic>.txt <<'EOF'
<full prompt content here>
EOF
```

### send-keys — single-line pointer only

Three allowed forms, nothing else:

1. **Read pointer**: `'leggi /tmp/<file>.txt e seguilo. <one-line constraint>. report finale.'`
2. **Slash command**: `/using-specialists-v3`, `/btw`, `/compact`, etc.
3. **Brief correction**: a single redirective sentence (≤ 3 sentences) when an in-flight agent needs a course adjustment. Anything longer goes in a /tmp file.

## Pre-flight checklist — mandatory before every first send-keys to a session

```bash
# 1. Pane idle? No Working state, no menu wizard, no auth prompt
tmux capture-pane -t <session> -p | tail -15

# 2. Real cwd (session name does NOT guarantee cwd)
tmux display-message -t <session> -p '#{pane_current_path}'

# 3. Agent loaded? Look for model name (Opus / Sonnet / gpt-5.4 / etc.) and budget indicator
tmux capture-pane -t <session> -p | grep -E '(Opus|Sonnet|Haiku|gpt-|kimi|claude-)'
```

If any check fails: STOP. Do not improvise. Either wait, switch session, or recreate. The operator's time spent confirming a clean pre-flight is far cheaper than recovering from a fragmented prompt.

## Session naming convention

```
<orchestrator-session-name>-<topic-slug>
```

| Example | Decomposition |
|---|---|
| `infra-api-sweep` | Spawned by `infra`; topic = sweep over API health |
| `infra-research-mux` | Spawned by `infra`; topic = research on multiplexing |
| `data-bcs-roll` | Spawned by `data`; legacy "roll" name retained |
| `design-spec-rewrite` | Spawned by `design`; topic = rewrite of a spec |

Collision handling: append `-2`, `-3`. Persistent main sessions (`design`, `ops`, `infra`, `data`) keep their bare names. Specialist-spawned `sp-<role>-<hash>` sessions follow the specialists CLI convention and are left alone.

Forbidden: ad-hoc names like `tmp-tests`, `test-orch-service`, `tmp-investigation`. Use the convention even for one-off delegations. The naming convention is what lets the operator parse `tmux ls` and immediately see parent → children.

## Operator-help patterns

### Pattern 1 — Inventory on demand

Trigger: operator says "what's running in `<X>`?", "give me a session map", "what state is everything in?"

Steps:
1. `tmux ls`
2. For each live session: `tmux capture-pane -t <session> -p | tail -8` and `tmux display-message -t <session> -p '#{pane_current_path}'`
3. Return a table: `session | cwd | branch (if git) | model (if agent) | last-task | idle/working`

### Pattern 2 — Assisted hand-off

Trigger: operator says "send task X to session Y", "delegate to Y", "ask Y to do Z"

Steps:
1. Run the pre-flight checklist on Y. If it fails, report which check and stop.
2. If the task represents trackable work, create a bead first (`bd create --title ... --description ...`). This is the persistent content.
3. Write any ephemeral meta-protocol (negative constraints, output format) to `/tmp/<session>-<topic>.txt` via Bash heredoc.
4. Show the operator the exact send-keys command you would run. Wait for explicit confirmation before executing.
5. On confirmation: `tmux send-keys -t Y '<single-line pointer>' Enter`. Some harnesses consume the first Enter as paste-detection — send a second Enter after 1-2s if the prompt is still not submitted.
6. If polling is appropriate, set up a `run_in_background` polling loop (see Monitoring).

### Pattern 3 — Cleanup hygiene

Trigger: operator says "clean orphans", "kill dead sessions", "what's leaking RAM"

Steps:
1. Process inventory: `ps -ef | grep -E "(serena|gitnexus|uvx.*serena|bun.*specialists)"`
2. For each candidate, extract its `--project` argument. Classify into LIVE (path exists on disk), ORPHAN (path is gone), NO_PROJECT (parent uvx wrappers etc.)
3. Kill ORPHAN PIDs with `kill -9`. Skip LIVE (active work). Skip NO_PROJECT (children will cascade-die after their actual workers are gone)
4. tmux sessions: identify ones with idle `❯` prompt AND no pending commits in their cwd worktree. Those are safe to `tmux kill-session -t <name>`. Sessions in Working state or with dirty trees: leave alone
5. Worktrees: `git worktree list` per affected repo. Remove worktrees whose owning job is in `cancelled` / `error` state per `sp ps`
6. `sp clean --ps` to hide resolved terminal rows from the default `sp ps` dashboard

### Pattern 4 — Recovery from messy run

Trigger: operator says "the agent went off-rails", "filed N spurious beads", "fragmented prompt", "started processing each line as a separate task"

Steps:
1. Interrupt the running agent: `tmux send-keys -t <session> C-c`, two or three times. Esc does NOT stop pi processing — only C-c works.
2. If interrupt fails (agent stuck mid-tool-call): `tmux kill-session -t <session>`. Recreate cleanly later if needed.
3. Inventory side effects: `bd list --status=open --since today` in each affected repo. Identify the spurious beads created today by the messy run.
4. Close them: `bd close <id> --reason "reverted — messy run on <date>"`. Use `--force` if blocked by dependencies (after verifying the dependencies are also spurious).
5. For polluted notes: `bd update <id> --notes ""` OVERWRITES the entire notes field — there is no undo for individual appended note entries. Use this only when the entire notes section is junk.
6. Save the lesson via `bd remember --key <key>` so the next session knows what triggered the messy run and can avoid the same trigger.

### Pattern 5 — Coordinated multi-session goal

Trigger: operator wants one outcome that requires work in N sessions.

Steps:
1. File one parent or epic bead describing the overall goal.
2. Per session needed, file a child bead with `bd create --parent <epic> ...` describing the per-session scope. Each child carries the per-session contract.
3. Hand off each child bead to its target session via Pattern 2.
4. Monitor: poll bead status changes with `bd query "status=closed AND parent=<epic>"`, or capture-pane summaries from each session (see Monitoring).
5. When all children close, read each child's notes via `bd show <id>` and aggregate. Report the consolidated outcome to the operator.

## Monitoring — polling via run_in_background

When a delegated agent runs and the operator wants me to wait without burning context with manual capture-pane calls:

```bash
until ! tmux capture-pane -t <session> -p | grep -qE '\([0-9]+m? ?[0-9]*s? ·|thinking with|↓ [0-9]+|↑ [0-9]+'; do sleep 30; done
echo "DONE"
```

Run this with `run_in_background: true`. The harness will notify when the until-loop exits.

Status-marker grep is intentionally brittle — agent UIs change across versions. Maintain 2-3 fallback patterns and accept that the polling may need adjustment per harness encountered. If the polling exits immediately (false positive), refine the grep before relaunching.

Race conditions to know:
- After send-keys, wait 2-3s before the first capture check. The target agent may not yet have entered Working state. A premature check will see "idle" and you risk sending a second prompt on top of the first.
- A fresh `pi --approve` session shows a "Yes/No data usage" prompt before the chat is ready. Sending keystrokes before that prompt clears them gets you into the wrong dialog.
- Double-Enter pattern: the first Enter sent after a single-line prompt is sometimes consumed by paste-detection. If the prompt does not submit, send another Enter after 1-2s.

## Back-channel notification — do not rely on it as primary

Tested 2026-06-19: `tmux send-keys` from a child session into the parent pane DOES deliver text, but:
- The parent harness catalogs the incoming text as `user sent a new message` system reminder
- Indistinguishable from the operator's real typing — race condition
- Concatenates with any in-flight operator input

Therefore: the default mechanism for "delegated agent finished" is operator-driven (they tell me) or polling (the Monitoring section above). Send-keys-back is acceptable only as a last-resort POSIX-signal-style marker:

```bash
# child sends a TINY signal, no payload:
tmux send-keys -t <parent-session> '[done] /tmp/<output-file>' Enter
```

The parent reads the marker, then reads the file for actual content. Never send the payload itself over send-keys.

The preferred pattern remains: the delegated agent writes its output into the bead via `bd update <id> --notes "..."` and closes the bead with `bd close <id>`. The main session polls bead status. This route has zero injection risk.

## Worktree isolation — known good practice, not enforced today

When a delegated session works on a repo where other sessions are also active, sharing the same checkout causes git-state races. One session's `git checkout` or `git stash` affects what every other session sees on disk. Observed failure mode: a delegated test session can run discovery against the wrong branch if another session switches the shared working tree concurrently. The result may still be useful only when the analysis is branch-agnostic; otherwise it is contaminated.

The known mitigation is to spawn delegated sessions in dedicated worktrees via `xt claude` or `xt pi`. This is not currently enforced. When pre-flight detects two live sessions in the same checkout, warn the operator and recommend `xt claude` / `xt pi` for the next delegation.

## End-of-session hygiene

Before closing the orchestrator session:
1. `tmux ls` → for each `<orchestrator>-*` session with no pending work, `tmux kill-session -t <name>`
2. `git worktree prune` on each affected repo
3. `sp clean --ps` (if `sp ps` shows resolved terminal rows from cancelled or errored jobs)
4. Process check: classify candidates via `--project` path existence, kill orphans
5. If `/session-close-report` skill is loaded in the current repo, run it

## Out of scope — do not add to this skill later

- Spawn primitives (Docker, VM, subprocess pool)
- Custom IPC schemas (inotify, FIFO, Unix sockets, MCP message bus) — beads already serve the comms role
- Replacement for `/using-specialists-v3` — that skill owns specialist chain orchestration
- Tool-specific bindings (Claude Agent SDK, Cline, Cursor, etc.) — keep this skill tool-agnostic
- Auto-activation triggers based on keywords — auto-activation is unreliable across harnesses; this skill is invoked explicitly
