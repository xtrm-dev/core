#!/usr/bin/env node
// xtrm-tool-logger.mjs — PostToolUse hook
// Logs every tool call to .xtrm/debug.db with kind=tool.call.
// Captures tool-specific context: cmd for Bash, file path for edits, etc.

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

function buildData(toolName, toolInput) {
  if (!toolInput) return null;
  if (toolName === 'Bash' || toolName === 'bash' || toolName === 'execute_shell_command') {
    return { cmd: (toolInput.command || '').slice(0, 120) };
  }
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return toolInput.file_path ? { file: toolInput.file_path } : null;
  }
  if (toolName === 'Glob')      return { pattern: toolInput.pattern, path: toolInput.path };
  if (toolName === 'Grep')      return { pattern: toolInput.pattern, path: toolInput.path };
  if (toolName === 'WebFetch')  return { url: (toolInput.url   || '').slice(0, 100) };
  if (toolName === 'WebSearch') return { query: (toolInput.query || '').slice(0, 100) };
  if (toolName === 'Agent')     return { prompt: (toolInput.prompt || '').slice(0, 80) };
  return null;
}

// CORE-2339: logging logic exported for dispatch.mjs; CLI entry preserved.
/**
 * Log a PostToolUse tool.call event to .xtrm/debug.db.
 * Never throws — logging must not affect hook behavior.
 */
export function logToolCall(input) {
  if (!input || input.hook_event_name !== 'PostToolUse') return;

  const toolName = input.tool_name;

  // Skip tools that would create noise or cause recursion
  const SKIP = new Set(['TodoRead', 'TodoWrite', 'Task', 'TaskCreate', 'TaskUpdate', 'TaskGet']);
  if (SKIP.has(toolName)) return;

  const cwd = resolveCwd(input) || process.cwd();
  const sessionId = resolveSessionId(input);
  const isError = input.tool_response?.is_error === true;

  logEvent({
    cwd,
    runtime: 'claude',
    sessionId,
    kind: 'tool.call',
    outcome: isError ? 'error' : 'ok',
    toolName,
    data: buildData(toolName, input.tool_input),
  });
}

function main() {
  const input = readInput();
  logToolCall(input);
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
