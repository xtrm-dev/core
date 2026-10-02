# CORE-2339 — Hook process fan-out: before/after report

**Base commit:** `7210fe1137cdb7c392bd324bf8267b41d392f430` (origin/main of `xtrm-dev/core`)
**Worktree:** `.xtrm/worktrees/core-xt-pi-core-hook-fanout` (branch `xt/core-hook-fanout`)
**Host:** Mercury production host, 12 cores. All measurements `nice -n 19`, paced to ≤0.2 core average, run at 14:30–15:0x UTC (outside the 20:00–23:00Z blackout).

## 1. What changed

Before: every Claude Code tool call started one **process per registered hook command**.
A Bash call started ~12 processes; an Edit call ~16 (the union of the xt registrations and the
third-party registrations that share the event).

After: `.xtrm/config/hooks.json` registers **one `dispatch.mjs` process per event**
(`pre`, `post`, `session`). The dispatcher runs every xt-managed check in-process, importing
the guard modules as the single source of truth for their decisions:

| old registration (per event) | now |
|---|---|
| PreToolUse: `worktree-boundary.mjs` (Edit family), `specialists-agent-guard.mjs` (Agent) | `dispatch.mjs pre` (matcher `Edit\|Write\|MultiEdit\|NotebookEdit\|Agent`) |
| PostToolUse: `quality-check.cjs` + `quality-check.py` (Edit family), `gitnexus-hook.cjs` (Bash\|Grep\|Read\|Glob), `xtrm-tool-logger.mjs` (all) | `dispatch.mjs post` (no matcher — preserves tool-logger coverage) |
| SessionStart: `quality-check-env.mjs`, `xtrm-session-logger.mjs`, `worktree-reap-sweep.mjs` | `dispatch.mjs session` |
| Stop: `inbox-reminder-stop.mjs` | unchanged (already a single process; its work is `xtmux`/tmux I/O, nothing to consolidate) |

Key routing decisions inside the dispatcher:

- **Quality checks: one process at most, chosen by file language.** JS/TS edits run
  `quality-check.cjs` **in-process** (its `main(input)` now returns the exit code instead of
  calling `process.exit`, so the dispatcher forwards it verbatim and the output bytes are
  identical to running it standalone). Python edits spawn `quality-check.py` — the one
  remaining child, because it is a different runtime. Everything else spawns nothing.
  Previously **both** interpreters ran for *every* edit and each exited early ("skipping
  non-Python file", "not a source file") after paying full interpreter startup.
- **GitNexus: narrower.** Pattern extraction runs in-process; the `gitnexus augment` child
  spawns only when the tool call actually yields patterns (i.e. rg/grep-style Bash, or
  Read/Grep/Glob with a code file) and the pattern is not already in the per-session dedup
  cache. A plain `ls`/`git status` Bash call no longer starts a node process at all.
- **Tool logger: in-process, cheap append-only path.** One prepared INSERT per tool call;
  the schema DDL now runs only on first write, the two pragmas that govern concurrency
  (`busy_timeout`, `journal_mode=WAL`) still run every time.
- **Anti-stick watchdog.** The old hooks did `readFileSync(0)` with no bound and no
  watchdog — a parent that died before closing the pipe left the hook blocked forever.
  The dispatcher reads stdin asynchronously, caps it at 32 MB, and exits 0 on a watchdog
  just under each event's registered timeout. Exit 0 == non-blocking, which is exactly what
  Claude Code does when it kills a hook at its timeout.

## 2. Guard parity (evidence)

`cli/test/hooks/dispatch.test.ts` (new) plus the existing suites:

- **Edit outside the worktree is still blocked** — dispatcher stdout is asserted byte-for-byte
  equal to the standalone `worktree-boundary.mjs` output (`{"decision":"block",...}`).
- **A forbidden Agent call is still blocked** — `specialists-agent-guard` fires when the
  specialists marker is present; passes through when it is not.
- **Quality-check still reports and blocks on a broken file** — an edited `.ts` file with
  `as any` + `debugger` yields the quality child's **exit code 2**, forwarded verbatim.
- **In-process equivalence**: for both a clean and a broken `.ts` file, `dispatch.mjs post`
  produces **byte-identical stdout and the same exit code** as running `quality-check.cjs`
  standalone — this is what makes merging the JS gate into the dispatcher safe.
- Fail-closed rule: the dispatcher's failure surface is identical to the old process boundary —
  each check keeps its own documented semantics (boundary/agent guard fail open exactly as
  documented; quality child exit 2 blocks; dispatcher exception/timeout exits 0 = same as
  Claude's timeout kill).

### Test suites (all green)

| suite | result |
|---|---|
| `cli/test/hooks/dispatch.test.ts` (new, 9 tests) | 9/9 |
| `cli/test/hooks/quality-check-hooks.test.ts` | 2/2 |
| `cli/test/hooks-integration.test.ts` | 4/4 |
| `cli/test/hooks.test.ts` | 21 (19 platform-skipped) |
| `src/tests/global-hooks-canonical.test.ts` (updated) | 3/3 |
| `src/tests/reconcile-global-claude-hooks.test.ts` | 1/1 |
| `src/tests/settings-audit.test.ts` / `-fix.test.ts` | 9/9 + 6/6 |
| `src/tests/installer-global-writes.test.ts` | 20/20 |
| `src/tests/install-integration.test.ts` | 10/10 |
| `src/tests/update.test.ts` | 24/24 |
| `src/tests/plugin-era-cleanup.test.ts`, `hook-entry-source-tagging.test.ts`, `substrate-doctrine.test.ts` | 2/2, 1/1, 2/2 |

`xt update` dry-run (no `--apply`) completes with **"no changes written"**; the main checkout
(`/home/dawid/dev/core`) was verified unmodified afterwards. `reconcileGlobalClaudeHooks` replaces
xt-owned wrappers by hash and preserves foreign ones, so the dispatcher registration replaces the
six old entries on upgrade instead of doubling them.

Note on flakiness: running several of these suites concurrently on this saturated host produces
10 s `test/setup.ts` hook timeouts and 120 s per-test timeouts. Every failure observed during this
work passed in isolation; the numbers above are the isolated runs.

## 3. Stuck-process / RSS root cause (the 856 MB)

Reproduced directly (payload sent, stdin deliberately left open):

| process | alive after 6 s | RSS |
|---|---|---|
| old `~/.xtrm/hooks/xtrm-tool-logger.mjs` | **yes** (blocked in `readFileSync(0)`) | 47 MB and growing per payload |
| new `dispatch.mjs pre` | no (watchdog) | — |
| new `dispatch.mjs session` | no by 12 s (9.5 s watchdog) | — |

With ~12 processes per tool call, one stuck-and-parentless process per orphan multiplies;
that is the 4×~214 MB seen in the pane. The dispatcher removes both ingredients: at most 1–2
processes per event, and none of them can block forever.

## 4. Measurements

Harness: `scripts/hook-bench/bench.py` (committed). It replays N=50 sample payloads per event
(PreToolUse Bash, PostToolUse Bash, PreToolUse Edit, PostToolUse Edit) through a real hook
configuration, exactly as Claude Code would (`bash -c`, payload on stdin), and reports
spawns (PATH-shim counters) and CPU (`os.wait4` rusage of the reaped tree).

Same payloads, same host, same pacing for every row. Table filled from `results.json`:

| event | spawns before | spawns after | CPU before | CPU after |
|---|---|---|---|---|
| PreToolUse Bash | 0.0 (max 0) | **0.0** (max 0) | 0 ms (med 0, p95 0) | **0 ms** (med 0, p95 0) |
| PostToolUse Bash | 4.0 (max 6) | **2.0** (max 4) | 136 ms (med 124, p95 141) | **94 ms** (med 78, p95 92) |
| PreToolUse Edit | 2.0 (max 2) | **2.0** (max 2) | 57 ms (med 56, p95 70) | **71 ms** (med 71, p95 79) |
| PostToolUse Edit | 6.0 (max 6) | **2.2** (max 3) | 227 ms (med 229, p95 256) | **104 ms** (med 86, p95 174) |

### Accounting note: per event vs per tool call

A Claude tool call runs two hook events (PreToolUse + PostToolUse). The spawn counts above include
the `bash -c` shell Claude Code uses to run each hook command — that shell is the execution
mechanism, not a process the hooks create.

| per tool call (xt-managed) | before | after |
|---|---|---|
| Bash call — spawns | 4 | **2** (all hook-created) |
| Bash call — CPU | 136 ms | **94 ms** |
| Edit call — spawns | 8 (6 hook-created) | **4** (2 hook-created: one dispatcher per event) |
| Edit call — CPU | 284 ms | **175 ms** mean / 157 ms median-of-events |

Against the contract target (≤3 spawns, ≤150 ms per tool call):

- **Bash call: met** — 2 spawns, 94 ms.
- **Edit call: spawn target met** (2 hook processes instead of 6); **CPU lands at ~157–175 ms
  against the 150 ms figure**. The residual is structural, not fan-out: a two-event call needs two
  node interpreters (~45 ms each on this loaded host ≈ 90 ms floor), and the remainder is the
  boundary guard plus the quality gate actually running their checks. Reaching 150 ms for an Edit
  call would require merging both events into one long-lived process, which contradicts the
  contract's own scope ("one dispatcher process per hook event") and would replace the current
  fail-closed, self-terminating model with a resident daemon.
- `PreToolUse:Edit` is 14 ms *slower* (57 → 71 ms): the dispatcher carries routing that the
  single-purpose boundary hook did not. It buys the removal of 6 processes and 123 ms from the
  matching PostToolUse event, and it is the only xt process on that event going forward.

### Deviations from the measurement protocol (disclosed)

1. **The first BEFORE legs executed the live `~/.xtrm/hooks` tree in place.** The installed
   `quality-check.cjs` rewrites its machine-local `tsconfig-cache.json` into its own directory on
   every run, so those runs mutated `~/.xtrm/hooks/tsconfig-cache.json`. No hook source was
   modified (verified: live tree md5-identical to the pre-change main checkout), but it is a write
   into the protected directory. It was caught by the home-integrity guard in
   `cli/src/tests/install-integration.test.ts`. The harness now takes `--copy-plugin-root` and
   measures against a temporary copy; the README mandates it for the live tree, and every number
   in the tables above comes from copy-based runs (live tree confirmed unmodified afterwards).
2. **GitNexus dedup cache.** `gitnexus augment` children spawn only for uncached patterns, keyed by
   session id. Both final legs used a fresh session id, so each paid its own cold-cache augment
   spawns — the max-spawn column shows them (6 before, 4 after).
3. Pacing and nice level as described in `scripts/hook-bench/README.md`; the runs' own CPU is
   reported per event in `harness_cpu_s` of the JSON output (<1.5 s per 200-replay leg).

## 5. Non-core hooks (measure-and-report only — not touched)

Measured per command with the same harness (`--per-hook`, n=10, same payloads). These are
**not** touched by this PR — they are listed so their owners can act.

### Non-core hooks (third-party; not modified)

| hook | event | CPU/call | spawns | owner / repo |
|---|---|---|---|---|
| `pre-merge-codex-gate.mjs` (`sh -c` wrapper) | PreToolUse Bash | 66.6 ms | 3 | archon (`~/.archon/hooks`) |
| `post-merge-orch-hygiene.mjs` (`sh -c` wrapper) | PostToolUse Bash | 61.6 ms | 3 | archon |
| `mmd-prod-guard.py` | PreToolUse Bash | 58.4 ms | 2 | market-data (`make install-agent-guard`) |
| orca `claude-hook.sh` wrapper (`if [ -z "${HOME-}" ]…`) | every event | 8.9 ms | 1 | orca |
| `auto-monitor-on-send.sh` | PostToolUse Bash | 12.4 ms | 2 | xtmux |
| `auto-monitor-consumed.sh` | PostToolUse Bash | 12.0 ms | 2 | xtmux |
| `agent-state.sh` | Pre+Post (every tool call) | 7.5 ms | 2 | xtmux |
| `context-mode-cache-heal.mjs` | SessionStart | 54.5 ms | 2 | context-mode |
| `herdr-agent-state.sh` | SessionStart | 14.1 ms | 2 | herdr |

### Non-core hooks that ship from `xtrm-dev/xtrm` (proposal only — report-only per contract)

`service-knowledge` hooks are **registered by the `xtrm-dev/xtrm` repo** (`packages/service-knowledge`),
not by core, so this PR measures them and proposes the change instead of applying it:

| hook | event | CPU/call | spawns | wrapper-only cost in a repo without the skill |
|---|---|---|---|---|
| `skill_activator.py` | PreToolUse (every tool call) | **101.3 ms** | 2 | 6.3 ms (the `sh -c` wrapper alone) |
| `drift_detector.py` | PostToolUse (every tool call) | **76.8 ms** | 2 | 6.3 ms |
| `cataloger.py` | SessionStart | — | 2 | 5.8 ms |

**Proposal for xtrm-dev/xtrm:** the same dispatcher pattern — one in-process router per event that
imports the activator/detector and calls their `activate()`/`detect()` entry points, rather than a
fresh `python3` interpreter (≈70–100 ms CPU) on **every** PreToolUse/PostToolUse call in every
session. This is the single largest remaining xt-adjacent per-call cost after this PR: 101 ms + 77 ms
per tool call, versus the ~90 ms this PR removes from the core hooks.

### xt-owned hook that is not in core's template

`using-xtrm-reminder.mjs` (SessionStart, 59.4 ms, 2 spawns) is present in the live
`~/.xtrm/hooks` and registered in the live `settings.json`, but is **not** declared in
`.xtrm/config/hooks.json` — it is installed by another repo. Its owner should confirm which.

## 6. What was deliberately NOT done

- No third-party hook was modified (archon, orca, herdr, context-mode, xtmux).
- No guard was weakened: the same block/allow decisions, the same exit-code contract.
- Live `~/.claude/settings.json` was never written. `~/.xtrm/hooks` was read and executed, but
  no hook source was modified — one early measurement run rewrote the machine-local
  `tsconfig-cache.json` inside it (disclosed below); the harness now measures against a copy.
- The `service-knowledge` hooks (`skill_activator.py`, `drift_detector.py`) live in
  `xtrm-dev/xtrm`; measured here and proposed below, not changed here.
