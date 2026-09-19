#!/usr/bin/env node
// xtrm-session-logger.mjs — SessionStart hook
// Logs session.start to .xtrm/debug.db so every session has a clear entry point.

import { readFileSync } from 'node:fs';
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

const input = readInput();
if (!input) process.exit(0);

const cwd = resolveCwd(input) || process.cwd();
const sessionId = resolveSessionId(input);

logEvent({
  cwd,
  runtime: 'claude',
  sessionId,
  kind: 'session.start',
  outcome: 'ok',
});

process.exit(0);
