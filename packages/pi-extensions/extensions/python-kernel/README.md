# python-kernel extension

A persistent Python kernel as the `python` tool. State (variables, imports,
functions) survives across calls until `reset: true`; `os.chdir()` persists and
reset returns to the working directory. One kernel process per session.

The kernel runs with your user permissions — **not a sandboxed** environment.
Treat a cell like a shell command. Requires `python3` on PATH (or
`pythonBin`).

## Tool surface

- **name**: `python`
- **executionMode**: `sequential`
- **parameters**:
  - `code` (string, required) — Python code to execute.
  - `reset` (boolean, optional) — clear the kernel namespace and return to the
    working directory. Reset does NOT execute the cell.
  - `reload_skills` (boolean, optional) — re-import every mounted skill module
    (`del sys.modules` + fresh import) and refresh the namespace. Returns
    per-module status (`{module: ok|error}`).

## Prelude

The following stdlib names are pre-loaded into the kernel namespace at boot
(no import needed):

```
json, re, os, sys, subprocess, Path (from pathlib)
```

Documented in the tool description. Example first cell that works with zero
boilerplate:

```python
Path("out").mkdir(exist_ok=True)
subprocess.run(["echo", "hi"], capture_output=True, text=True).stdout
```

The prelude also binds one function:

```python
preflight(repo, path, n=4)
```

File-scoped memory retrieval (memory doctrine: progressive retrieval, never
bulk). For one file: full commit messages with bodies (`git log --follow`),
pending `diff --stat`, and `bd memories` keys for the basename — printed as a
bounded digest, returning the commit records. Read-only. 0 commits means a
wrong path. Run it before editing a file, fixing a bug, implementing, or when
gitnexus flags a file/symbol as critical or medium impact. Successful digests
are also stashed in `_preflight_cache[(repo, path)]` for later cells.

Two more prelude bindings round out the workbench:

```python
kns()          # namespace mirror: user bindings -> shape hint; run when resuming,
               # after long threads, or before re-deriving anything
_              # last expression result (exec branches leave it untouched)
```

## skillbridge — python-backed skills as importable modules

> Status: first consumer `forensics` ships with this package
> (`skills/forensics`, discovered via `bundledSkillsDir()`); user and env
> roots keep precedence. Zero install-time deps is a hard requirement.

Skill modules following the prime-agent Agent Skills convention
(`SKILL.md` + `src/<import_name>/__init__.py`) are discovered at extension init
from these roots:

1. `$PI_SKILL_PATHS` (colon-separated), if set
2. `$PI_SKILL_ROOTS` (colon-separated), if set
3. `~/.pi/agent/skills/`
4. `~/.claude/skills/`

A root is scanned for directories containing `SKILL.md` and exactly one
package under `src/` (`src/<pkg>/__init__.py`). The **import name is the
package dir basename** (`src/sre_chain/` → import name `sre_chain`), which may
differ from the skill directory name.

At kernel spawn, roots are prepended to `sys.path` and each module is imported
and bound into the namespace under its import name (zero-install mount —
skills must have no external deps; use `pythonBin` as the escape hatch).
Per-module import failures are recorded, never fatal: a broken skill does not
kill the kernel.

The tool description appends, when any module is mounted:

```
Importable skill modules: sre_chain — pre-imported in namespace; help(x) for docs.
```

Example cell (no host round trips):

```python
sre_chain.load("config")     # calls into the mounted skill module directly
help(sre_chain)              # introspection works in-kernel
```

### Reload (dev-loop)

`reload_skills: true` deletes each mounted module from `sys.modules` and
re-imports it, so edits to a skill's `__init__.py` are picked up without
restarting the kernel. The driver sets `sys.dont_write_bytecode = True` so
reloads never serve a stale `.pyc` (Python's bytecode cache is mtime-resolution
stale).

## Output truncation

Per-cell output is capped (default 20,000 chars; configurable via
`maxOutputBytes`). Over-cap stdout/stderr becomes:

```
<first 8192 chars>
...[truncated 3000001 chars]...
<last 4096 chars>
```

- A **shape hint** is added when the cell's expression result is sized
  (type + `len`, e.g. `list len=100000`).
- The **full output is written to a temp file** whose path is appended to the
  reply: `[full output: /tmp/pi-py-kernel-*/cell-N.out]`. The file lives in
  the kernel temp dir and is removed when the kernel is torn down.

## service_knowledge in-kernel binding (xtrm-6z6.4)

When the session cwd carries a canonical service registry (the same gating
signal the service-knowledge extension uses — `.xtrm/skills/<pack>/` with a
`service-knowledge` or legacy `service-skills` umbrella + `service-registry.json`,
reserved pack names skipped), the driver pre-imports the installed
`service_knowledge` Python package into the namespace. The package location is
resolved via the kernel's own interpreter (venv-aware, honors `pythonBin`).

```python
import service_knowledge
service_knowledge.__version__                     # e.g. '0.7.0'
from service_knowledge.index import search
search(Path('.'), 'alerting', limit=2)            # in-kernel index query
```

An in-kernel index-rebuild helper is bound as `sk_rebuild()` — it calls
`service_knowledge.index.build()` and appends an `_AUDIT` entry so the mutation
rides the audit seam (host sees it in tool details):

```python
sk_rebuild()   # -> {'items': N, 'duration_ms': ...}; _AUDIT gains an entry
```

No registry → the package is not mounted (mirrors the extension's self-gating).
A missing/unimportable package is recorded in `sk_errors`, never fatal.

## Audit seam

> Status: dormant until the first skill module (or cell) appends to `_AUDIT`.
> The policy hook stays report-only and off by default.

The driver reserves `_AUDIT` (a list) in the kernel namespace and copies it
into every cell reply. Skill modules may append mutation events:

```python
_AUDIT.append({"op": "write", "path": "/etc/hosts"})
```

The host surfaces non-empty `audit` in the tool `details`. A **report-only
policy hook** (off by default) flags writes whose path lies outside the
session cwd. Enable it with the extension option `auditPolicy: true` or the
env `PI_KERNEL_AUDIT_POLICY=1`; when on, out-of-session writes produce:

```
[audit policy] blocked 1 mutation(s) outside session cwd:
[ { "op": "write", "path": "/etc/hosts" } ]
```

and `details.auditPolicy` = `blocked N out-of-session writes` (or
`allowed N mutations`). It is convention-first and report-only — it never
blocks execution.

## Options

| Option | Default | Meaning |
|--------|---------|---------|
| `pythonBin` | `python3` | Interpreter binary |
| `cellTimeoutMs` | 120000 | Per-cell timeout; on timeout the kernel is killed and restarts on the next call |
| `startTimeoutMs` | 10000 | Driver-ready timeout |
| `maxOutputBytes` | 20000 | Per-cell output cap (chars) |
| `auditPolicy` | `false` | Enable the report-only audit policy hook |

## Error semantics

- Missing/unlaunchable interpreter → structured tool error on every call, host
  never crashes.
- Cell exception → `error` with `ename`, `evalue`, `traceback` in details;
  `isError: true`.
- Timeout → `KernelTimeout` error, kernel killed, state lost, next call
  restarts.
- Abort → kernel killed, pending cells fail immediately.
- Crash/exit → `KernelExited`, temp dir removed, next call spawns fresh.

## Example session

```python
# cell 1
x = 41
# cell 2
x + 1                    # -> 42 (state persists)
# cell 3 (reset)
reset: true
# cell 4
x + 1                    # NameError (namespace was cleared)
```

### Lifetime contract: session scratch, not storage

Kernel state lives with the session and dies with it (timeout kill, reset
swallowing the kernel, session end). Anything that must survive — findings,
artifacts, ledgers — goes to files/bd/journal. The kernel holds working
state: corpus variables, tallies, half-finished parses. `kns()` is how a
resumed (or compacted) session re-orients instead of re-deriving.

### Recipe: one cell per question (subprocess capture in-cell)

```python
import subprocess
raw = subprocess.run(["rg", "--no-messages", "-c", "hook_success", path],
                     capture_output=True, text=True).stdout
recs = forensics.load_jsonl(path)          # corpus held once, filtered across cells
forensics.top(forensics.tally(recs, "type"))
```
