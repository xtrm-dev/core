#!/usr/bin/env node
// worktree-guard.mjs — Claude Code PreToolUse Bash guard (CORE-2814).
//
// Blocks a shell command that removes a worktree another live process is using:
//   git worktree remove [--force] <path>
//   rm -r / -rf / --recursive <path>
//   find <path> ... -delete
//
// A literal target is checked directly. A target the shell resolves at run time
// (`$w`, `$(...)`, a glob) is checked against every registered worktree: the
// 2026-11-28 incident was exactly the loop
//   git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done
// so "unresolved removal plus at least one live worktree" must block.
//
// `git worktree prune` is deliberately allowed: it removes metadata of missing
// directories, never a live tree (NON_GOAL in the Issue).
//
// Fast path: a command with no removal shape returns null before /proc or tmux
// is touched. Fail-open: any detection error allows the command; the check never
// blocks on a failure to look.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callerProcessIds,
  formatWorktreeHolders,
  readProcessCwds,
  readTmuxPanes,
  worktreeInUse,
} from './worktree-liveness.mjs';

const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'done', 'fi']);
const WRAPPERS = new Set(['command', 'builtin', 'nohup', 'time', 'exec']);

function tokenize(command) {
  const segments = [];
  let tokens = [];
  let token = '';
  let hasToken = false;
  let quote = null;
  let i = 0;

  const pushToken = () => {
    if (hasToken) {
      tokens.push(token);
      token = '';
      hasToken = false;
    }
  };
  const pushSegment = () => {
    pushToken();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };

  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        token += command[i + 1];
        i += 1;
      } else {
        token += ch;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      token += command[i + 1];
      hasToken = true;
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pushToken();
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      pushSegment();
      i += 1;
      continue;
    }
    if (ch === '#' && !hasToken) {
      while (i < command.length && command[i] !== '\n') i += 1;
      continue;
    }
    token += ch;
    hasToken = true;
    i += 1;
  }
  pushSegment();
  return segments;
}

/** Shell-resolved targets: a variable, command substitution, or a glob. */
export function targetIsUnresolved(target) {
  if (!target) return true;
  return /[$`*?[\]{}~]/.test(target) || target === '~';
}

/**
 * Removal operations in a shell command, in execution order.
 * `targets` is always an array; an empty array or an unresolved entry means the
 * path is not statically known.
 */
export function removalOperations(command) {
  const operations = [];

  for (const raw of tokenize(command)) {
    const tokens = raw.filter((token) => !SHELL_KEYWORDS.has(token));
    let start = 0;
    while (start < tokens.length && WRAPPERS.has(tokens[start])) start += 1;
    while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
    const commandName = tokens[start];
    if (!commandName) continue;

    const name = basename(commandName);

    if (name === 'git') {
      const worktreeAt = tokens.indexOf('worktree', start + 1);
      if (worktreeAt < 0 || tokens[worktreeAt + 1] !== 'remove') continue;
      const target = tokens.slice(worktreeAt + 2).find((token) => !token.startsWith('-'));
      operations.push({ kind: 'git-worktree-remove', targets: target ? [target] : [], raw: raw.join(' ') });
      continue;
    }

    if (name === 'rm') {
      const args = tokens.slice(start + 1);
      const recursive = args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg));
      if (!recursive) continue;
      operations.push({ kind: 'rm', targets: args.filter((arg) => !arg.startsWith('-')), raw: raw.join(' ') });
      continue;
    }

    if (name === 'find') {
      const args = tokens.slice(start + 1);
      if (!args.includes('-delete')) continue;
      const root = args.find((token) => !token.startsWith('-'));
      operations.push({ kind: 'find-delete', targets: root ? [root] : [], raw: raw.join(' ') });
    }
  }

  return operations;
}

function worktreeRoot(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 1500,
  });
  if (result.status !== 0) return null;
  const root = (result.stdout ?? '').trim();
  return root || null;
}

function registeredWorktrees(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    timeout: 1500,
  });
  if (result.status !== 0) return [];
  return (result.stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

function blockReason(lines) {
  return [
    '🚫 Worktree liveness guard (CORE-2814): this command removes a worktree a live process is using.',
    ...lines.map((line) => `  - ${line}`),
    '',
    'Removing a live worktree discards another session\'s uncommitted work.',
    'Stop the holder first, or target a worktree that is not in use.',
  ].join('\n');
}

function literalBlockers(targets, probe, ownWorktree, ownPids) {
  const blockers = [];
  for (const target of [...new Set(targets)]) {
    if (ownWorktree && target === ownWorktree) continue;
    const liveness = probe(target);
    const others = liveness.holders.filter((holder) => !ownPids.has(holder.pid));
    if (others.length > 0) blockers.push({ target, holders: others, warnings: liveness.warnings });
  }
  return blockers;
}

/**
 * Decide a Claude PreToolUse payload. Returns null to allow, or a reason string
 * to block. `dispatch.mjs pre` routes Bash here; the standalone CLI entry prints
 * the same decision as the other guards.
 */
/**
 * @param {object} input PreToolUse payload.
 * @param {{tmuxSockets?: string[]}} [options] tests pass `[]` so ambient servers
 *   cannot decide the answer.
 */
export function worktreeGuardDecision(input = {}, options = {}) {
  const toolName = input?.tool_name ?? input?.toolName ?? '';
  if (toolName !== 'Bash' && toolName !== 'bash') return null;

  const command = input?.tool_input?.command ?? input?.toolInput?.command ?? '';
  if (typeof command !== 'string' || !command) return null;

  const operations = removalOperations(command);
  if (operations.length === 0) return null;

  const cwd = input?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const ownWorktree = worktreeRoot(cwd);
  const ownPids = callerProcessIds();
  const cwds = readProcessCwds('/proc');
  const { panes, warnings } = readTmuxPanes({ procRoot: '/proc', tmuxSockets: options.tmuxSockets });
  const probe = (path) => worktreeInUse(path, { cwds, panes, skipTmux: true });

  const literalTargets = [];
  const unresolved = [];
  for (const operation of operations) {
    for (const target of operation.targets) {
      if (targetIsUnresolved(target)) unresolved.push({ target, operation });
      else literalTargets.push(resolve(cwd, target));
    }
    if (operation.targets.length === 0) unresolved.push({ target: '', operation });
  }

  const blockers = literalBlockers(literalTargets, probe, ownWorktree, ownPids);
  if (blockers.length > 0) {
    const lines = blockers.flatMap((blocker) => {
      const holderLines = formatWorktreeHolders(blocker.holders).map((line) => `${blocker.target}: ${line}`);
      const warningLines = blocker.warnings.map((warning) => `${blocker.target}: warning: ${warning}`);
      return [...holderLines, ...warningLines];
    });
    return blockReason(lines);
  }

  if (unresolved.length > 0) {
    const live = [];
    const candidates = new Set(registeredWorktrees(cwd));
    for (const pane of panes) {
      if (pane.agentWorktree) candidates.add(pane.agentWorktree);
    }
    for (const candidate of candidates) {
      if (ownWorktree && resolve(candidate) === ownWorktree) continue;
      const liveness = probe(candidate);
      const others = liveness.holders.filter((holder) => !ownPids.has(holder.pid));
      if (others.length > 0) live.push({ target: candidate, holders: others });
    }

    if (live.length > 0) {
      const lines = [
        `the command removes a path it resolves at run time (${unresolved[0].target || 'no literal target'})`,
        ...live.flatMap((entry) => formatWorktreeHolders(entry.holders).map((line) => `${entry.target}: ${line}`)),
        ...warnings.map((warning) => `warning: ${warning}`),
      ];
      return blockReason(lines);
    }
  }

  return null;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const reason = worktreeGuardDecision(input);
  if (!reason) process.exit(0);

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.stdout.write('\n');
  process.exit(0);
}

// Symlink-safe CLI entry: repo-root `hooks/` is a symlink to .xtrm/hooks.
function isCliMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliMain()) main();
