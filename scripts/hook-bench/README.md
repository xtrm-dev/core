# hook-bench — hook fan-out measurement harness (CORE-2339)

Replays N sample hook payloads per event through an installed hook
configuration and reports processes spawned and CPU seconds per tool call.
See `bench.py`'s docstring for the full measurement model (wait4 rusage,
PATH-shim spawn counting, pacing, side-effect safety).

## Canonical runs

```bash
# BEFORE — the live installed configuration (read-only; never edits it).
# --copy-plugin-root is mandatory here: the installed quality-check.cjs writes
# tsconfig-cache.json next to itself on every run, so replaying the live tree in
# place would mutate ~/.xtrm/hooks (a contract violation).
nice -n 19 python3 scripts/hook-bench/bench.py \
    --config ~/.claude/settings.json --label before \
    --plugin-root ~/.xtrm/hooks --copy-plugin-root \
    --cwd "$PWD" --n 50 --json /tmp/hook-bench/before.json

# AFTER — this worktree's template + dispatcher
nice -n 19 python3 scripts/hook-bench/bench.py \
    --config .xtrm/config/hooks.json --plugin-root .xtrm/hooks \
    --label after \
    --cwd "$PWD" --n 50 --json /tmp/hook-bench/after.json
```

Both runs must use the same `--cwd` and therefore the same payload set
(`payloads.py` derives file paths from `--cwd`).

## Rules for shared hosts (from the CORE-2339 contract)

- Always run under `nice -n 19`.
- The harness paces itself so cumulative CPU / cumulative wall stays under
  `--max-core` (default 0.2).
- Do not run heavy measurement in the 20:00–23:00Z blackout window.
- The harness never writes `~/.claude/settings.json` or `~/.xtrm/hooks`; the
  `before` run replays the live config read-only against a **copy** of the live
  hook tree (`--copy-plugin-root`), because executing the installed
  `quality-check.cjs` in place rewrites its machine-local `tsconfig-cache.json`
  inside `~/.xtrm/hooks`.

## Known measurement deviations

- Spawn counting uses PATH shims; binaries invoked by absolute path (e.g. the
  `xtmux` picker) are not counted. No such binary is in the measured hot paths.
- `xt`, `xtmux` and `tmux` shims count the spawn but do not execute the real
  binary, so replaying SessionStart can never trigger a real worktree reap or
  touch the live tmux server.
- `CLAUDE_HOOKS_AUTOFIX=false` is forced so `quality-check.py` never modifies
  files during replay (applies equally to before and after).
- `TMUX`/`TMUX_PANE` are unset; the xtmux `agent-state.sh` hooks exit early
  instead of writing pane state (their real cost is one bash process either
  way; the pane-option write is sub-millisecond).
- CPU is ru_utime+ru_stime of reaped descendants; detached fire-and-forget
  children (the reap sweep's `xt` spawn) are not waited and not counted.
