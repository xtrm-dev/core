#!/usr/bin/env node
// xtrm-session-logger.mjs — SessionStart hook
// Logs session.start to .xtrm/debug.db so every session has a clear entry point.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logEvent } from './xtrm-logger.mjs';

// Lane 1 (hook cleanup): inlined from retired beads-gate-utils.mjs —
// resolveCwd/resolveSessionId are trivial input fallbacks with no bd/bd-kv
// dependency. The payload file stays until lane 2; live loggers no longer import it.
function resolveCwd(input) {
  return input?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function resolveSessionId(input) {
  return input?.session_id ?? input?.sessionId ?? resolveCwd(input);
}

function readInput() {
  try { return JSON.parse(readFileSync(0, 'utf-8')); } catch { return null; }
}

// CORE-2339: logging logic exported for dispatch.mjs; CLI entry preserved.
export function logSessionStart(input) {
  if (!input) return;
  const cwd = resolveCwd(input) || process.cwd();
  const sessionId = resolveSessionId(input);

  logEvent({
    cwd,
    runtime: 'claude',
    sessionId,
    kind: 'session.start',
    outcome: 'ok',
  });
}

function main() {
  logSessionStart(readInput());
  process.exit(0);
}

// Symlink-safe CLI entry: repo-root `hooks/` is a symlink to .xtrm/hooks, and
// node resolves module identity through the real path while argv[1] keeps the
// symlink path — compare realpaths or the standalone entry never fires.
function isCliMain() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliMain()) main();
