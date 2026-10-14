# Persistent python kernel: mechanics

Condensed from the extension README (`packages/pi-extensions/extensions/python-kernel/README.md`
in the core repo, read 2026-10-14). The README wins on any conflict. This file exists so
a session outside the core repo can still learn the kernel's limits. Judgment on when
to use the kernel lives in `engineering-quality/references/kernel-workbench.md`.

## Tool surface

Tool `python`, `executionMode: sequential`. One kernel process per session.

| Parameter | Meaning |
|---|---|
| `code` (string, required) | Python to run. |
| `reset` (bool) | Clear the namespace and return to the working directory. The cell does **not** run. |
| `reload_skills` (bool) | Re-import every mounted skill module; returns `{module: ok\|error}`. |

State (variables, imports, functions, `os.chdir`) persists until `reset: true`.

## Not a sandbox

The kernel runs with the user's permissions. Treat a cell like a shell command.
Needs `python3` on PATH (or the `pythonBin` option).

## Prelude (no import needed)

`json, re, os, sys, subprocess, Path`, plus `preflight(repo, path, n=4)`:
file-scoped memory retrieval (full `git log --follow` bodies, pending `diff --stat`,
`bd memories` keys for the basename). Read-only. 0 commits returned means a wrong path.
Run it before editing a file or fixing a bug.

## Limits and failure modes

| Condition | Result |
|---|---|
| Cell exceeds `cellTimeoutMs` (default 120000) | `KernelTimeout`. The kernel is killed and **all state is lost**. The next call restarts it. |
| Output exceeds `maxOutputBytes` (default 20000 chars) | First 8192 + last 4096 chars, a shape hint (e.g. `list len=100000`), and the full output in a temp file named in the reply. |
| Cell exception | `isError: true`; `ename`, `evalue`, `traceback` in details. |
| Abort | Kernel killed; pending cells fail at once. |
| Crash or exit | `KernelExited`; next call spawns a fresh kernel. |
| No usable interpreter | Structured tool error on every call; the host does not crash. |

Keep long work out of a single cell: a timeout costs the whole namespace. Persist
intermediate results to a file when a cell may run long.

## skillbridge: python skills as importable modules

At kernel spawn, skill roots are scanned for directories holding `SKILL.md` and exactly
one package at `src/<pkg>/__init__.py`. Roots, in order: `$PI_SKILL_PATHS`,
`$PI_SKILL_ROOTS`, `~/.pi/agent/skills/`, `~/.claude/skills/`. The import name is the
package directory name, which can differ from the skill name. Modules are pre-imported
into the namespace; skills must have no external dependencies. A broken module is
recorded, never fatal. `reload_skills: true` re-imports after edits (bytecode writing
is disabled, so reloads are not stale).

## service_knowledge binding

When the session cwd has a canonical service registry (`.xtrm/skills/<pack>/` with a
`service-knowledge` umbrella and `service-registry.json`), the kernel pre-imports the
`service_knowledge` package and binds `sk_rebuild()` (rebuilds the index and appends an
`_AUDIT` entry). No registry means no mount. Import failures go to `sk_errors`.

## Audit seam

`_AUDIT` is a reserved list in the namespace, copied into every cell reply. Skill
modules append mutation events (`{"op": "write", "path": ...}`). The host shows a
non-empty `audit` in tool details. An optional report-only policy (`auditPolicy: true`
or `PI_KERNEL_AUDIT_POLICY=1`) flags writes outside the session cwd. It never blocks.

## Options

`pythonBin` (`python3`), `cellTimeoutMs` (120000), `startTimeoutMs` (10000),
`maxOutputBytes` (20000), `auditPolicy` (`false`).

## Inside codemode

`tools.python` routes to the same kernel (the `codemode` skill records a counter test,
612 → 1224 → 1836, as proof). A codemode cell cannot start another codemode cell. The kernel tool
is `sequential` (inferred: parallel `tools.python` calls in one cell then queue).

## Claude Code

Claude Code has no kernel tool. Use `python3 - <<'PY'` heredocs, or
`~/.claude/bin/preflight.py <file>` for the pre-edit history, and keep each probe
self-contained: nothing survives between calls.
