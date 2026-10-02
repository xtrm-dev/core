#!/usr/bin/env node
// dispatch.mjs — single-process xt hook dispatcher (CORE-2339).
//
// Claude Code runs every registered hook command as its own process. The xt
// template used to register up to five separate node/python processes per
// tool call (boundary, agent guard, quality-check.cjs, quality-check.py,
// gitnexus hook, tool logger). On a CPU-saturated host that interpreter
// fan-out alone costs ~0.6 s CPU per tool call (MMD-2235, CORE-2339).
//
// This dispatcher replaces the per-hook registrations for PreToolUse,
// PostToolUse and SessionStart with ONE node process per event that runs all
// xt-managed checks in-process. The guard modules stay the single source of
// truth for their decisions — dispatch.mjs only routes.
//
// Routing (mirrors the old per-hook matchers exactly):
//   pre     Edit|Write|MultiEdit|NotebookEdit → worktree-boundary check
//           Agent                              → specialists-agent-guard check
//   post    (all)                              → xtrm-tool-logger (in-process)
//           Bash|Grep|Read|Glob + Serena tools → gitnexus enrichment (augment
//                                                child only when a pattern is
//                                                extracted and not cached)
//           Edit|Write|MultiEdit|NotebookEdit  → quality check: in-process
//                                                quality-check.cjs for JS/TS,
//                                                quality-check.py child for
//                                                Python, nothing otherwise
//   session (all)                              → quality-check-env probe,
//                                                session logger, reap sweep
//
// Known output deviation (deliberate, asserted in cli/test/hooks/dispatch.test.ts):
// an edit to a file that is neither JS/TS nor Python (e.g. .md, .json) used to
// print "File skipped - not a source file." / "No checks needed for ..." from the
// two gates and now prints nothing. The decision is unchanged — both paths exit
// 0 — and the silence is the saving: two interpreter startups per such edit.
// Guard parity (CONSTRAINT: fail-closed where the old hooks blocked):
//   - boundary/guard checks keep their own fail-open semantics from the
//     standalone hooks; the dispatcher adds no new failure modes (each check
//     is wrapped exactly like the old process boundary was).
//   - the quality gate's exit code is forwarded verbatim, so an exit 2
//     (blocking) still blocks — in-process for JS/TS, from the Python child
//     otherwise.
//   - an exception or timeout in the dispatcher exits 0 — identical to the
//     old behaviour where Claude Code killed a hook at its timeout and the
//     tool call proceeded (non-blocking). A watchdog fire during the quality
//     gate additionally writes a stderr marker, so a dropped blocking decision
//     is never silent.
//
// Anti-stick (RSS root cause, CORE-2339): the old xtrm-tool-logger processes
// could block forever on readFileSync(0) when the parent died before closing
// stdin; orphaned processes accumulated under swap pressure (856 MB RSS+swap
// observed in one pane). This dispatcher reads stdin asynchronously and arms
// a watchdog just under the registered Claude Code timeout so a stalled
// process always exits on its own.
//
// Module loading is deliberately lazy per mode/branch: node's own startup is
// the floor (~45 ms CPU on a loaded host), and pre-edit calls must not pay
// for the sqlite native module or the gitnexus CJS bridge they never use.

import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

const MODE = process.argv[2] ?? '';
// Fail-open watchdog. Claude Code kills a hook at its registered timeout and the
// tool call proceeds, so exiting 0 here matches that outcome. Two deliberate
// refinements (CORE-2339 review):
//   1. It is armed AFTER stdin resolves, so it never races the stdin read or
//      drops a `tool.call` row for a slow-drained payload.
//   2. When it fires during the blocking quality gate it writes a stderr marker
//      first. Claude Code surfaces a killed hook as a hook-timeout notice to the
//      operator; a silent exit-0 would discard the exit-2 decision invisibly,
//      which is a failure-mode inversion.
const WATCHDOG_MS = { pre: 1500, post: 29500, session: 9500 }[MODE] ?? 1500;
// Defensive cap on stdin: a PostToolUse payload carries tool_response content
// and can be large; anything past this is pathological and would only feed a
// memory spike (old hooks parsed unbounded input and could balloon).
const MAX_STDIN_BYTES = 32 * 1024 * 1024;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// The old registration matcher was Bash|Grep|Read|Glob, but the runtime sync
// has historically widened the *installed* matcher to Serena symbol/file tools
// (mergeMatcher in cli/src/utils/atomic-config.ts). Those machines were getting
// enrichment; excluding them here would silently drop it, and
// gitnexus-hook.cjs still carries the Serena branches.
const GITNEXUS_TOOLS = new Set([
  'Bash', 'Grep', 'Read', 'Glob',
  'mcp__serena__find_symbol',
  'mcp__serena__find_referencing_symbols',
  'mcp__serena__replace_symbol_body',
  'mcp__serena__insert_after_symbol',
  'mcp__serena__insert_before_symbol',
  'mcp__serena__get_symbols_overview',
  'mcp__serena__search_for_pattern',
  'mcp__serena__rename_symbol',
]);
const JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs']);

// Set when the watchdog may fire, so its exit can be made diagnosable.
let watchdogArmed = false;
let inQualityGate = false;

// Two deadlines (CORE-2339 review B3):
//   - stall: armed immediately, covers the stdin read. A payload that never
//     EOFs is exactly the mechanism that produced the stuck 47 MB loggers, and
//     exiting here loses nothing: no payload was read, so there is no tool.call
//     row and no guard decision to drop.
//   - work: armed once stdin has resolved, covers the checks themselves. When
//     it fires during the quality gate it says so on stderr first, because a
//     silent exit-0 there would discard a blocking exit-2 decision invisibly.
const stallTimer = setTimeout(() => { process.exit(0); }, WATCHDOG_MS);

function armWatchdog() {
  if (watchdogArmed) return;
  watchdogArmed = true;
  clearTimeout(stallTimer);
  setTimeout(() => {
    if (inQualityGate) {
      // A blocking exit 2 is about to be discarded. Fail-open is still the
      // contract (Claude Code would have killed the hook too), but make it
      // visible instead of silently reporting a broken file as clean.
      writeSync(2, 'xt hook dispatcher: quality-check exceeded its time budget; '
        + 'blocking decision dropped (same outcome as a Claude hook timeout)\n');
    }
    process.exit(0);
  }, WATCHDOG_MS);
}

// ── stdin ─────────────────────────────────────────────────────────────────────

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const stream = process.stdin;
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_STDIN_BYTES) {
        stream.destroy();
        finish(null); // treat like a parse failure — fail-open, as before
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(null));
  });
}

// ── quality check ─────────────────────────────────────────────────────────────
// JS/TS files: run quality-check.cjs IN-PROCESS (CORE-2339 — same process, so
// the output bytes and the exit code are identical to running it standalone,
// without a second node startup per edited file).
// Python files: quality-check.py stays a child process (different runtime),
// spawned only when the edited file is Python — previously it ran for EVERY
// edit and exited early after paying full interpreter startup.
function qualityPlan(toolInput) {
  const filePath = toolInput?.file_path ?? toolInput?.path ?? toolInput?.notebook_path ?? toolInput?.relative_path;
  if (!filePath) return null;
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (ext === '.py') {
    return { kind: 'child', bin: 'python3', args: [join(HOOKS_DIR, 'quality-check.py')] };
  }
  if (JS_EXTS.has(ext)) return { kind: 'inproc' };
  return null;
}

function runQualityChild(child, payload) {
  return new Promise((resolve) => {
    const proc = spawn(child.bin, child.args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      env: process.env,
    });
    proc.on('error', () => resolve(0)); // spawn failure — old hook absent, allow
    proc.on('close', (code) => resolve(code ?? 0));
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

// ── modes ─────────────────────────────────────────────────────────────────────

async function runPre(input) {
  if (!input) return 0;
  const toolName = input.tool_name ?? input.toolName ?? '';

  if (EDIT_TOOLS.has(toolName)) {
    try {
      const { boundaryDecision } = await import('./worktree-boundary.mjs');
      const reason = boundaryDecision(input);
      if (reason) {
        writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n');
      }
    } catch { /* fail-open, same as the standalone hook */ }
    return 0;
  }

  if (toolName === 'Agent') {
    try {
      const { agentGuardDecision } = await import('./specialists-agent-guard.mjs');
      const decision = agentGuardDecision(input);
      if (decision.block) {
        writeSync(1, JSON.stringify({ decision: 'block', reason: decision.reason }) + '\n');
      }
    } catch { /* fail-open, same as the standalone hook */ }
    return 0;
  }

  return 0;
}

async function runPost(input, rawPayload) {
  if (!input) return 0;
  const toolName = input.tool_name ?? input.toolName ?? '';

  // 1. tool.call logging — in-process, silent, never blocks.
  try {
    const { logToolCall } = await import('./xtrm-tool-logger.mjs');
    logToolCall(input);
  } catch { /* never affects behavior */ }

  // 2. GitNexus enrichment — only for the tools the old matcher covered.
  //    augment children spawn only when a pattern is extracted and uncached.
  if (GITNEXUS_TOOLS.has(toolName)) {
    try {
      const { enrich } = require('./gitnexus/gitnexus-hook.cjs');
      const out = enrich(input);
      if (out) writeSync(1, out);
    } catch { /* graceful failure — always exit 0, as before */ }
  }

  // 3. Quality check — at most one extra process, and only when the edited
  //    file's language warrants it.
  if (EDIT_TOOLS.has(toolName)) {
    const plan = qualityPlan(input.tool_input);
    if (plan) {
      if (plan.kind === 'inproc') {
        try {
          const { main: qualityCheckMain } = require('./quality-check.cjs');
          inQualityGate = true;
          return await qualityCheckMain(input);
        } catch (err) {
          // The standalone hook would have crashed on its own and exited 1
          // (non-blocking for Claude Code). Same outcome, no block.
          writeSync(2, `quality-check.cjs failed: ${err?.message ?? err}\n`);
          return 1;
        }
      }
      return await runQualityChild(plan, rawPayload);
    }
  }

  return 0;
}

async function runSession(input) {
  if (!input) return 0;
    // Order mirrors the compiled policy order: quality-gates-env (10) ->
    // xtrm-debug-logger (45) -> worktree-reap (90).
    try {
      const { envCheck } = await import('./quality-check-env.mjs');
      const out = envCheck(input);
      // No trailing newline: the standalone hook writes none, so Claude Code
      // sees byte-identical output.
      if (out) writeSync(1, out);
    } catch { /* informational only */ }
    try {
      const { logSessionStart } = await import('./xtrm-session-logger.mjs');
      logSessionStart(input);
    } catch { /* silent */ }
    try {
      const { reapSweep } = await import('./worktree-reap-sweep.mjs');
      reapSweep(input);
    } catch { /* never blocks session start */ }
  return 0;
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const raw = await readStdin();
  // stdin resolved: the stall deadline has done its job, hand over to the work
  // deadline so a slow payload can neither hang nor be cut short mid-check.
  armWatchdog();
  let input = null;
  if (raw) { try { input = JSON.parse(raw); } catch { input = null; } }

  let code = 0;
  if (MODE === 'pre') code = await runPre(input);
  else if (MODE === 'post') code = await runPost(input, raw ?? '');
  else if (MODE === 'session') code = await runSession(input);
  else code = 0; // unknown mode — fail-open

  process.exit(code);
})().catch(() => process.exit(0));
