# Continuity

Read after every compaction, before a resume or a day-boundary handover.

- **The manager and the leads compact; the manager hands over at the day boundary** unless the operator says otherwise (operator, 2026-10-31,
  MMD-2331 seq 1913; sun01-coord ruling 2026-11-01: the 24 h rotation of rule 35 stays for leads and workers). The handover is autonomous:
  `references/handover.md`.
- Compact 2-3 times a day at a quiet point, never within 20 min of a window: write a checkpoint `handoff` first
  (`sb journal append <ref> --kind handoff`), compact, re-arm `/goal`.
- **Compact yourself** (operator, 2026-11-17): the manager and every lead decide when to compact, without waiting for the operator. After the
  handoff entry, run in one command, then end the turn (the detached shell types `/compact` into your own pane once the turn is over):
  ```
  (setsid sh -c 'sleep 20; tmux send-keys -t "${TMUX_PANE:?}" -l /compact; sleep 1; tmux send-keys -t "${TMUX_PANE:?}" Enter' >/dev/null 2>&1 &)
  ```
  The post-compact hook prints the resume checklist and the nudge types the resume prompt. A Pi session compacts the same way.
  The command needs `tmux` outside a sandbox: if your shell runs sandboxed, run it with the sandbox off, or nothing is typed.
- The hooks enforce this, not a line in this file (operator 2026-11-16, XTRM-802/XTRM-804): `checkpoint_warn.py`'s FINAL message requires the
  checkpoint `handoff` to carry the goal prompt (key `goal`) and `open_promises[{promise,due_utc,timer_id}]`, and reads the session's bound issue
  in state.db to say whether the newest GOAL PROMPT handoff is newer than its newest `decision` (it is not when the goal was left for after the
  compaction); `post_compact.py` step 2 prints that saved goal prompt back for re-injection, with a WARNING naming both seqs when it is stale,
  instead of asking for a rewrite after the compaction; `promise-check.py` (Stop) flags an "I will … <time or event>" promise with no later
  CronCreate and no journal entry naming its key time. Each of them resolves the session's own bound issue (`.substrate-issue`,
  `SUBSTRATE_ISSUE_REF`): a lead gets its workstream epic, never another issue's ref.
- Why: a takeover costs about 4x the output tokens of a compaction recovery, and rotations lost an operator question and moved windows mid-flight.
- Resume: `sb issue resume <ref>` (the epic for the manager, the workstream issue for a lead). Set `SUBSTRATE_ISSUE_REF` to it; bind the
  worktree with `pm_session.py init --issue <ref>` (kept out of git by `.git/info/exclude`); keep a long-TTL claim for the edit gate, renewed with `sb issue renew`.
- **Session hooks** (operator, 2026-10-31) are part of the pack, in `project-management/hooks/`, wired by the operator in
  `~/.claude/settings.json` (`references/setup.md`, "8. Session hooks"). They act by the session role (`scripts/pm_role.py`: role file, launch role,
  then name). Workers and reviewers get no checkpoint or resume steps.
   - `checkpoint_warn.py` warns at the `checkpoint_thresholds` (default 70% EARLY, 85% FINAL) of the window and asks for ONE structured
     `handoff` entry, the handover itself and no file (SHAs, windows, workers and reap conditions, crons, monitors, questions, PRs, goal prompt,
     open promises, next action), verified against live state, then the self-compaction above.
   - `promise-check.py` is the Stop hook for the promise rule above (settings: `promise_check_turns`, default 15, 0 = off; one reminder per promise); the operator wires it
     next to `operator-questions.py --event stop` in the `Stop` block.
   - `post_compact.py` prints the resume steps after a compaction or a start, then the project's private `post_compact_extra` text file (its
     own fleet rules); with `post_compact_nudge` true it also types `post_compact_nudge_text` into `$TMUX_PANE`.
   - `action_gate.py` blocks the gated actions (merges, launches, attests, dispatches) until the session has re-read its role references.
   - Hooks load at session start: open `/hooks` once or restart. Pi sessions do not run these hooks: their checkpoint comes from their own goal.
- **billion-context (bili) pilot** (operator, 2026-10-31; sun01-coord first, review 11-01): launch through the per-session launcher, never
  `bili plugin install claude` (it writes the global `~/.claude/settings.json` and disables auto-compact in every Claude session).
   - Config `~/.config/billion-context/claude-coordinator.json` (1M window, nudge every 150k, forced fold at 70%; pi sessions keep the default
     config); restart script as scratch under `$PM_STATE_DIR/bili-pilot/`.
   - Fold rules (MMD-3017 board lane): fold at a boundary, many ranges in ONE `compress` call; keep decisions, GOs, windows, open questions, verbatim
     keys, SHAs, ids, UTC times, contract lines, paths.
   - Never fold an unapplied WORD or the contract you work against; a summary is not authority; recover with `search_context`, then `decompress`.
- **Compress only raw ranges, at a boundary, when context needs it** (operator, 2026-11-01, after sun01-coord folded mid-turn): your context shows
  past calls as shortened previews, so never call one truncated or correct without the operator's terminal or the tool input.
   - Pasting a preview or any text with an ellipsis as a summary destroys the original; the tool answers `applied` and `acp_status` shows nothing.
   - Name ranges by message ids (`mNNNNN`) you see in full, never block ids; write full summaries, no `…` or `...`.
   - Install the PreToolUse guard `compress_guard.py` (matcher `mcp__bili__compress`) in `.claude/settings.local.json` before launch; until then
     make no `compress` call.
   - Recovery: `decompress {blockId, full: true, toFile}`.
- **A Pi session compacts by the same rule as a Claude one:** `/compact` sent into its pane through tmux, by itself, its lead or the manager, at a
  clear checkpoint. After compaction the session gets a resume nudge (`sb issue resume <ref>`, renew the claim with `sb issue renew <ref>`, report);
  the sender's post-compaction steps include it.
- Session crons survive compaction, not process exit. Background sleeps die at the task cap (30 min for Monitor, about 2 h for bash); use
  `systemd-run --user` transient units for durable timers.
- `/new` in an `xt pi` pane drops its messaging name, skills and background tasks: the resume line re-loads skills (`/skill:<name>`), re-exports
  `SUBSTRATE_HOLDER`, names the handoff entry; the worker re-arms its own timers; tell peers the new name.

## Park and wake (operator ruling, 2026-11-22; CORE-2764, CORE-2765)

A lead that only waits for hours holds about 0.85 GB for nothing. `scripts/pm_park.py` parks it and wakes it later from a systemd user
timer, which outlives every session (a cron held by a session dies with it).

- **Who parks:** the manager, to relieve a lead; a lead itself, after it has told the manager its intention and wake (`--self --manager-told`).
  A lead does not park inside two hours of a GO or production duty, nor while it owns live children. Workers and specialists are not parked.
- **Park:** write the `handoff` entry as your last action on your issue, then
  `pm_park.py park <name> --ref <ref> --role <role> (--at <UTC> | --check '<cmd>' --deadline <UTC>) [--reason ...]`. It refuses unless the
  handoff is the session's last entry on `<ref>`, `--self` comes with `--manager-told`, and a wake is set. It writes
  `$PM_STATE_DIR/parked/<name>.json`, creates one timer, journals `park` on `<ref>` and prints the pane to close. Verify the record
  (`pm_park.py list`), then close the pane. Post one Jira comment for the whole park batch through the board helper.
- **Wake:** `--at` wakes at the time. `--check` runs `<cmd>` on every timer fire: exit 0 wakes, exit 1 means not yet, any other exit, a
  timeout or the `--deadline` wakes anyway and the `wake` entry says why. A shut launch gate (load1 15, memory PSI full avg10 10,
  MemAvailable 4 GB) retries later and never skips. The wake writes `parked/<name>.digest.md` (`sb issue resume`, journal entries since
  the park, answers-inbox rows naming the session, merged PRs), opens a tmux window in the same worktree, starts a FRESH session of the
  same runtime, name and role (not `--continue`), pastes the respawn nudge, then journals `wake`. After 3 failed attempts it journals a
  `blocker` for the manager. Stop a wrong park with `systemctl --user stop pm-park-<name>.timer`.
  A `--check` command is stored and journaled verbatim: never put a credential in it. Transient timers do not survive a reboot:
  `pm_park.py list` marks a parked record whose unit is missing (`MISSING`); re-park it or wake it by hand (`wake <name> --force`).
- **Peers write to the journal of a parked session's issue, not to its socket:** a message to a dead socket is lost. `route_target.py --team`
  shows parked sessions on a `parked` line. The woken session reads the handoff and the digest, finds the manager and tells it it is back.
- **Instance settings** (pm_config): `park_launch` (start command; default `claude --dangerously-skip-permissions`, add `--channels ...` there),
  `park_max_attempts`, `park_retry_s`, `park_nudge_delay_s`, `park_check_timeout_s`, and the gate limits `park_gate_load1`,
  `park_gate_psi_full`, `park_gate_mem_gb` (defaults as above; tune them to the host's core count).
