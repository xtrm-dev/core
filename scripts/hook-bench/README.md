# hook-bench — hook fan-out measurement harness (CORE-2339)

Replays N sample hook payloads per event through an installed hook
configuration and reports processes spawned and CPU seconds per tool call.
See `bench.py`'s docstring for the full measurement model (wait4 rusage,
PATH-shim spawn counting, pacing, side-effect safety).

## Canonical runs

Both runs MUST pass `--filter`, or the comparison is not apples-to-apples: the
before config carries every third-party hook and the after config carries only
xt, so an unfiltered delta mixes "xt fan-out removed" with "third-party hooks no
longer measured". Use a distinct `--session-id` per run so neither side inherits
the other's GitNexus dedup cache.

```bash
# BEFORE — xt-managed commands from the live installed configuration.
# --copy-plugin-root is mandatory: the installed quality-check.cjs writes
# tsconfig-cache.json next to itself on every run, so replaying the live tree in
# place would mutate ~/.xtrm/hooks (a contract violation).
nice -n 19 python3 scripts/hook-bench/bench.py \
    --config ~/.claude/settings.json --label before \
    --plugin-root ~/.xtrm/hooks --copy-plugin-root \
    --filter '\.xtrm/hooks/' --session-id bench-before \
    --cwd "$PWD" --n 50 --json /tmp/hook-bench/before.json

# AFTER — this worktree's template + dispatcher (already xt-only)
nice -n 19 python3 scripts/hook-bench/bench.py \
    --config .xtrm/config/hooks.json --plugin-root .xtrm/hooks \
    --label after --session-id bench-after \
    --cwd "$PWD" --n 50 --json /tmp/hook-bench/after.json

# Whole-config baseline (xt + third-party), for attribution only — never as the
# before/after delta.
nice -n 19 python3 scripts/hook-bench/bench.py \
    --config ~/.claude/settings.json --label baseline-all \
    --plugin-root ~/.xtrm/hooks --copy-plugin-root --session-id bench-baseline \
    --cwd "$PWD" --n 50 --json /tmp/hook-bench/baseline.json
```

The reported numbers in `.xtrm/reports/core-2339/REPORT.md` come from exactly this
recipe (filter on the before side, fresh session id per side, copies of both trees).

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
