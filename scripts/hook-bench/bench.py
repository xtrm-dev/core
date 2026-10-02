#!/usr/bin/env python3
"""Hook fan-out measurement harness (CORE-2339).

Replays N sample hook payloads per event (PreToolUse Bash, PostToolUse Bash,
PreToolUse Edit, PostToolUse Edit) through an installed hook configuration and
reports processes spawned and CPU seconds per tool call.

Usage:
  # BEFORE: the live installed configuration
  nice -n 19 python3 scripts/hook-bench/bench.py \\
      --config ~/.claude/settings.json --label before \\
      --cwd <repo> --json out/before.json

  # AFTER: the worktree template + dispatcher
  nice -n 19 python3 scripts/hook-bench/bench.py \\
      --config .xtrm/config/hooks.json --plugin-root .xtrm/hooks \\
      --label after --cwd <repo> --json out/after.json

Measurement model:
  - Each hook command is executed exactly as Claude Code would: bash -c with
    the payload JSON on stdin, CLAUDE_PROJECT_DIR set to --cwd.
  - CPU = ru_utime + ru_stime from os.wait4 on the direct child. This
    includes every descendant the child reaped (bash waits on its children,
    node/python wait on theirs). Fire-and-forget detached children are not
    waited and therefore not counted.
  - Process spawns are counted with PATH shims: every PATH-resolved
    interpreter (node, python3, bash, sh, gitnexus, ...) is intercepted by a
    counting shim that logs one line and execs the real binary. The bash -c
    shell itself is counted this way, matching one shell process per hook
    command. Bin binaries invoked by absolute path cannot be shimmed and are
    not counted (documented deviation; no such binary appears in the xt or
    measured third-party commands' hot paths).
  - Pacing: after each command the harness sleeps so that cumulative CPU /
    cumulative wall stays under --max-core (default 0.2). Run under nice -n 19.
  - Environment sanitisation for safe replay on a shared host: TMUX/TMUX_PANE
    are unset (xtmux pane-state hooks no-op early), CLAUDE_HOOKS_AUTOFIX=false
    (quality-check.py must not modify files during replay).

Side-effect safety: `xt`, `xtmux` and `tmux` shims count the spawn but do NOT
exec the real binary — replaying SessionStart hooks must never trigger a real
worktree reap or touch a live tmux server.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from payloads import PAYLOADS  # noqa: E402

EVENT_NAMES = {
    "pre-bash": "PreToolUse",
    "post-bash": "PostToolUse",
    "pre-edit": "PreToolUse",
    "post-edit": "PostToolUse",
    "session": "SessionStart",
}

# Interpreters that get counting shims that EXEC the real binary.
COUNT_EXEC = ["node", "python3", "python", "bash", "sh", "gitnexus", "ruff", "mypy", "tsc", "eslint"]
# Commands that are counted but never executed (side-effect safety).
COUNT_ONLY = ["xt", "xtmux", "tmux"]


def build_shims(shim_dir: str, count_file: str) -> str:
    real_path_env = os.environ.get("PATH", "")
    for name in COUNT_EXEC + COUNT_ONLY:
        real = shutil.which(name, path=real_path_env) if name in COUNT_EXEC else None
        shim = os.path.join(shim_dir, name)
        # The shims must be executable (the replayed hooks exec them through
        # PATH), so the file is created executable directly rather than chmod-ed
        # afterwards. 0o700 keeps them owner-only; the temp dir is private.
        with open(os.open(shim, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700), "w", encoding="utf-8") as fh:
            fh.write('#!/bin/sh\nprintf "1\\n" >> "$SHIM_COUNT_FILE"\n')
            if name in COUNT_EXEC and real:
                fh.write(f'exec "{real}" "$@"\n')
            else:
                fh.write("exit 0\n")
    return shim_dir + os.pathsep + real_path_env


def load_hooks(config_path: str) -> dict:
    with open(config_path, encoding="utf-8") as fh:
        config = json.load(fh)
    hooks = config.get("hooks", config)
    if not isinstance(hooks, dict):
        raise SystemExit(f"no hooks map in {config_path}")
    return hooks


def resolve_command(command: str, plugin_root: str) -> str:
    return command.replace("${CLAUDE_PLUGIN_ROOT}/hooks", plugin_root)


def matcher_matches(matcher: str | None, tool_name: str) -> bool:
    if not matcher or matcher == "*":
        return True
    try:
        return re.fullmatch(matcher, tool_name) is not None
    except re.error:
        return True


def count_lines(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as fh:
            return sum(1 for _ in fh)
    except FileNotFoundError:
        return 0


def run_command(command: str, payload: bytes, cwd: str, env: dict) -> tuple[float, float, int, int]:
    """Run one hook command; return (cpu_s, wall_s, spawns, exit_code)."""
    before = count_lines(env["SHIM_COUNT_FILE"])
    start = time.monotonic()
    proc = subprocess.Popen(
        ["bash", "-c", command],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=cwd,
        env=env,
    )
    try:
        proc.stdin.write(payload)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    _, status, rusage = os.wait4(proc.pid, 0)
    wall = time.monotonic() - start
    proc.returncode = os.waitstatus_to_exitcode(status)
    after = count_lines(env["SHIM_COUNT_FILE"])
    cpu = rusage.ru_utime + rusage.ru_stime
    return cpu, wall, after - before, proc.returncode


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    k = min(len(ordered) - 1, max(0, math.ceil(pct / 100 * len(ordered)) - 1))
    return ordered[k]


def bench_event(hooks: dict, event: str, tool_name: str, samples: list[dict],
                n: int, cwd: str, env: dict, max_core: float) -> dict:
    commands = []
    for wrapper in hooks.get(event, []):
        if not matcher_matches(wrapper.get("matcher"), tool_name):
            continue
        for hook in wrapper.get("hooks", []):
            if hook.get("type", "command") == "command":
                commands.append(hook["command"])

    per_call_cpu, per_call_wall, per_call_spawns = [], [], []
    for i in range(n):
        payload = json.dumps(samples[i % len(samples)]).encode()
        call_cpu = call_wall = 0.0
        call_spawns = 0
        for command in commands:
            cpu, wall, spawns, _code = run_command(command, payload, cwd, env)
            call_cpu += cpu
            call_wall += wall
            call_spawns += spawns
        per_call_cpu.append(call_cpu)
        per_call_wall.append(call_wall)
        per_call_spawns.append(call_spawns)
        # Pacing: keep cumulative CPU/wall under max_core.
        total_cpu = sum(per_call_cpu)
        total_wall = sum(per_call_wall)
        deficit = total_cpu / max_core - total_wall
        if deficit > 0:
            time.sleep(min(deficit, 5.0))

    return {
        "event": f"{event}:{tool_name}",
        "n": n,
        "commands": len(commands),
        "spawns_mean": statistics.fmean(per_call_spawns) if per_call_spawns else 0,
        "spawns_max": max(per_call_spawns, default=0),
        "cpu_mean_ms": 1000 * statistics.fmean(per_call_cpu) if per_call_cpu else 0,
        "cpu_median_ms": 1000 * statistics.median(per_call_cpu) if per_call_cpu else 0,
        "cpu_p95_ms": 1000 * percentile(per_call_cpu, 95),
        "wall_mean_ms": 1000 * statistics.fmean(per_call_wall) if per_call_wall else 0,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=True, help="settings.json or hooks.json to replay")
    ap.add_argument("--plugin-root", default=os.path.expanduser("~/.xtrm/hooks"),
                    help="dir ${CLAUDE_PLUGIN_ROOT}/hooks resolves to")
    ap.add_argument("--copy-plugin-root", action="store_true",
                    help="measure against a temporary copy of --plugin-root instead of the tree itself; "
                         "REQUIRED when the tree is the live ~/.xtrm/hooks, because executing the "
                         "installed quality-check.cjs in place rewrites tsconfig-cache.json next to it")
    ap.add_argument("--cwd", required=True, help="project dir for payloads/CLAUDE_PROJECT_DIR")
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--events", default="pre-bash,post-bash,pre-edit,post-edit")
    ap.add_argument("--label", default="run")
    ap.add_argument("--json", help="append the result to this JSON file")
    ap.add_argument("--max-core", type=float, default=0.2)
    ap.add_argument("--per-hook", action="store_true",
                    help="measure each command separately (cost table mode); n defaults to 10")
    ap.add_argument("--filter", default=None,
                    help="only bench commands whose text matches this regex (e.g. xt-managed only)")
    ap.add_argument("--session-id", default="hook-bench")
    args = ap.parse_args()
    if args.per_hook and args.n == 50:
        args.n = 10

    hooks = load_hooks(args.config)
    plugin_root = args.plugin_root.rstrip("/")

    measured_root = plugin_root
    if args.copy_plugin_root:
        import tempfile as _tempfile
        copy_dir = _tempfile.mkdtemp(prefix="hook-bench-hooks-")
        shutil.copytree(plugin_root, os.path.join(copy_dir, "hooks"), symlinks=True)
        measured_root = os.path.join(copy_dir, "hooks")
        print(f"[{args.label}] plugin-root copied: {plugin_root} -> {measured_root}", flush=True)

    filter_re = re.compile(args.filter) if args.filter else None
    for event, wrappers in hooks.items():
        for wrapper in wrappers:
            kept = []
            for hook in wrapper.get("hooks", []):
                hook["command"] = resolve_command(hook["command"], measured_root)
                if filter_re is None or filter_re.search(hook["command"]):
                    kept.append(hook)
            wrapper["hooks"] = kept
        hooks[event] = [w for w in wrappers if w.get("hooks")]

    bench_dir = tempfile.mkdtemp(prefix="hook-bench-")
    count_file = os.path.join(bench_dir, "spawns.txt")
    open(count_file, "w").close()
    shim_path = build_shims(bench_dir, count_file)

    env = {
        **os.environ,
        "PATH": shim_path,
        "SHIM_COUNT_FILE": count_file,
        "CLAUDE_PROJECT_DIR": args.cwd,
        "CLAUDE_HOOKS_AUTOFIX": "false",
    }
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)

    started = time.monotonic()
    results = []
    for key in args.events.split(","):
        event = EVENT_NAMES[key]
        samples = PAYLOADS[key](args.cwd, args.session_id)
        # SessionStart payloads carry no tool_name (all tools match).
        tool_name = samples[0].get("tool_name", "")
        if args.per_hook:
            for command in [h["command"]
                            for w in hooks.get(event, [])
                            if matcher_matches(w.get("matcher"), tool_name)
                            for h in w.get("hooks", [])
                            if h.get("type", "command") == "command"]:
                res = bench_event({event: [{"matcher": None, "hooks": [{"type": "command", "command": command}]}]},
                                  event, tool_name, samples, args.n, args.cwd, env, args.max_core)
                res["command"] = command
                results.append(res)
                print(f"[{args.label}] {res['event']:24s} cpu/call={res['cpu_mean_ms']:7.1f}ms "
                      f"spawns={res['spawns_mean']:.1f}  {command[:90]}", flush=True)
            continue
        res = bench_event(hooks, event, tool_name, samples, args.n, args.cwd, env, args.max_core)
        results.append(res)
        print(f"[{args.label}] {res['event']:24s} cmds={res['commands']} "
              f"spawns/call={res['spawns_mean']:.1f} (max {res['spawns_max']}) "
              f"cpu/call mean={res['cpu_mean_ms']:.0f}ms median={res['cpu_median_ms']:.0f}ms "
              f"p95={res['cpu_p95_ms']:.0f}ms", flush=True)

    harness_cpu = time.process_time()
    payload = {
        "label": args.label,
        "config": os.path.abspath(args.config),
        "plugin_root": measured_root,
        "cwd": os.path.abspath(args.cwd),
        "n": args.n,
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "wall_s": round(time.monotonic() - started, 1),
        "harness_cpu_s": round(harness_cpu, 2),
        "events": results,
    }
    if args.json:
        existing = []
        if os.path.exists(args.json):
            with open(args.json, encoding="utf-8") as fh:
                existing = json.load(fh)
        existing.append(payload)
        os.makedirs(os.path.dirname(os.path.abspath(args.json)), exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(existing, fh, indent=2)
    shutil.rmtree(bench_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
