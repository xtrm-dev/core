#!/usr/bin/env node
// worktree-boundary.mjs — Claude Code PreToolUse hook
// Blocks Write/Edit when the target file is outside the active worktree root.
// Only active when session cwd is inside .xtrm/worktrees/<name>.
// Fail-open: any unexpected error allows the edit through.
//
// Installed by: xtrm install
// CORE-2339: the decision logic is exported for dispatch.mjs (single-process
// fan-out). This file remains the standalone CLI entry so direct invocation,
// tests and rollback keep working.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Decide the worktree boundary for an Edit-family PreToolUse payload.
 * Returns a block reason string, or null when the edit is allowed.
 * Fail-open: callers treat any exception as allow (same as the old hook).
 */
export function boundaryDecision(input = {}) {
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const filePath = input?.tool_input?.file_path;
  if (!filePath) return null;

  // Detect worktree root from cwd
  const m = cwd.match(/^(.+\/\.xtrm\/worktrees\/[^/]+)/);
  if (!m) return null; // not in a worktree — no constraint

  const worktreeRoot = m[1];
  const abs = resolve(cwd, filePath);

  if (abs === worktreeRoot || abs.startsWith(worktreeRoot + '/')) return null;

  return `🚫 Edit outside worktree boundary.\n  File:    ${abs}\n  Allowed: ${worktreeRoot}\n\n  All edits must stay within the active worktree.`;
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }

  const reason = boundaryDecision(input);
  if (!reason) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.stdout.write('\n');
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
