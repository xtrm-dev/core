# Continuity

Moved from SKILL.md section "5. Continuity". Read after every compaction, before a resume or a day-boundary handoff.

- **A coordinator compacts; it hands off only at the day boundary or on the operator's word** (operator, 2026-10-31, MMD-2331 seq 1913; sun01-coord
  ruling 2026-11-01: the 24 h rotation of rule 35 stays for lanes and workers).
- Compact 2-3 times a day at a quiet point, never within 20 min of a window: write a checkpoint `handoff` first
  (`sb journal append <epic> --kind handoff`), compact, re-arm `/goal`.
- Why: a takeover costs about 4x the output tokens of a compaction recovery, and rotations lost an operator question and moved windows mid-flight.
  Handoff: `references/handover.md`.
- Resume: `sb issue resume <epic>`. Set `SUBSTRATE_ISSUE_REF` to the epic; bind the worktree with `echo <epic> > .substrate-issue` (in
  `.git/info/exclude`); keep a long-TTL claim for the edit gate.
- **Coordinator-only hooks** (operator, 2026-10-31) fire when `XTRM_ROLE=coordinator`; any other value means not a coordinator. Unset:
  `SUBSTRATE_HOLDER`, then the project directory name ending `-coord`/`-coord-<n>`. Builders, lanes and reviewers get neither. Launch a coordinator
  with `XTRM_ROLE=coordinator` exported. Sources: the project's hook directory, `~/.xtrm/hooks/<project>/`.
   - `context-checkpoint-warn.py` warns at 70% (EARLY) and 85% (FINAL) of the window and asks for ONE structured `handoff` entry, the handover itself
     and no file (SHAs, windows, workers and reap conditions, crons, monitors, questions, PRs, next action), verified against live state, then
     `/compact`.
   - `<project>-post-compact.sh` prints resume steps, runs `.claude/post-compact-extra.sh`, and types
     `/project-management continue with the goal ...` into `$TMUX_PANE` after about 12 s.
   - Hooks load at session start: open `/hooks` once or restart. Pi workers are not covered.
- **billion-context (bili) pilot** (operator, 2026-10-31; sun01-coord first, review 11-01): launch through the per-lane launcher, never
  `bili plugin install claude` (it writes the global `~/.claude/settings.json` and disables auto-compact in every Claude session).
   - Config `~/.config/billion-context/claude-coordinator.json` (1M window, nudge every 150k, forced fold at 70%; the pi lanes keep the default
     config); restart script `$PM_STATE_DIR/bili-pilot/restart-<coord>.sh`.
   - Fold rules (MMD-3017 board lane): fold at a boundary, many ranges in ONE `compress` call; keep decisions, GOs, windows, open questions, verbatim
     keys, SHAs, ids, UTC times, contract lines, paths.
   - Never fold an unapplied WORD or the contract you work against; a summary is not authority; recover with `search_context`, then `decompress`.
- **Compress only raw ranges, at a boundary, when context needs it** (operator, 2026-11-01, after sun01-coord folded mid-turn): your context shows
  past calls as shortened previews, so never call one truncated or correct without the operator's terminal or the tool input.
   - Pasting a preview or any text with an ellipsis as a summary destroys the original; the tool answers `applied` and `acp_status` shows nothing.
   - Name ranges by message ids (`mNNNNN`) you see in full, never block ids; write full summaries, no `…` or `...`.
   - Install the PreToolUse guard `$PM_STATE_DIR/<coord>/hooks/compress_guard.py` (matcher `mcp__bili__compress`) in `.claude/settings.local.json`
     before launch; until then make no `compress` call.
   - Recovery: `decompress {blockId, full: true, toFile}`.
- Pi workers cannot run `/compact` (context ceiling 25-30%): the coordinator types it into the idle pane. After compaction each worker needs a resume
  nudge (`sb issue resume <ref>`, claim again, report); the coordinator's post-compaction steps include it.
- Session crons survive compaction, not process exit. Background sleeps die at the task cap (30 min for Monitor, about 2 h for bash); use
  `systemd-run --user` transient units for durable timers.
- `/new` in an `xt pi` pane drops its messaging name, skills and background tasks: the resume line re-loads skills (`/skill:<name>`), re-exports
  `SUBSTRATE_HOLDER`, names the handoff entry; the worker re-arms its own timers; tell peers the new name.
