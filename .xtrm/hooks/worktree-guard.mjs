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
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callerProcessIds,
  formatWorktreeHolders,
  readProcessCwds,
  readTmuxPanes,
  worktreeInUse,
} from './worktree-liveness.mjs';

/** A removal further than this in a shell/script nest is out of scope: the
 * guard blocks the outer command anyway, and unbounded recursion is a hazard. */
const MAX_NESTING = 3;
const MAX_SCRIPT_BYTES = 64 * 1024;
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'done', 'fi']);
/** Wrappers that run another command; the real command follows them. */
const WRAPPERS = new Set(['command', 'builtin', 'nohup', 'time', 'exec', 'env', 'sudo', 'xargs', 'nice', 'timeout', 'stdbuf', 'ionice']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);

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

/** A redirection token consumes its operand, which is a file, never a target:
 * `git worktree remove 2>/dev/null --force <path>` removes <path>. */
const REDIRECTION = /^(\d*|&)(>>?|<<?)(.*)$/;

function stripRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '&>' || token === '&>>') {
      i += 1;
      continue;
    }
    const match = REDIRECTION.exec(token);
    if (match) {
      if (!match[3] && i + 1 < tokens.length) i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** Wrapper options that take a value, so the value is not read as the command. */
const WRAPPER_OPERAND_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-n', '-I', '-L', '-P', '-s', '-E', '-d', '-a', '-i', '-o', '-e', '--unset', '--user', '--group']);

/** Index of the command word after wrappers, their options and assignments. */
function commandIndex(tokens) {
  let start = 0;
  for (;;) {
    if (start >= tokens.length) return start;
    const base = basename(tokens[start]);
    if (!WRAPPERS.has(base)) break;
    start += 1;
    while (start < tokens.length) {
      const token = tokens[start];
      if (/^\d+[smhd]?$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        start += 1;
        continue;
      }
      if (!token.startsWith('-')) break;
      start += WRAPPER_OPERAND_FLAGS.has(token) ? 2 : 1;
    }
  }
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
  return start;
}

function operationsFromSegment(raw, depth = 0) {
  const operations = [];
  const tokens = stripRedirections(raw.filter((token) => !SHELL_KEYWORDS.has(token)));
  const start = commandIndex(tokens);
  const commandName = tokens[start];
  if (!commandName) return operations;
  const name = basename(commandName);
  const rest = tokens.slice(start + 1);
  const record = (kind, targets, extra = {}) => operations.push({ kind, targets, raw: raw.join(' '), ...extra });

  if (SHELLS.has(name) || name === 'eval') {
    const cIndex = name === 'eval' ? -1 : rest.findIndex((token) => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
    if (name === 'eval' || cIndex >= 0) {
      const program = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
      if (program && depth < MAX_NESTING) {
        record('shell', [], { program });
        operations.push(...removalOperations(program, depth + 1));
      } else if (program) {
        record('shell', [], { program });
      }
      return operations;
    }
    const script = rest.find((token) => !token.startsWith('-'));
    if (script) record('script', [script]);
    return operations;
  }

  if (name === 'git') {
    const worktreeAt = tokens.indexOf('worktree', start + 1);
    if (worktreeAt < 0 || tokens[worktreeAt + 1] !== 'remove') return operations;
    const target = tokens.slice(worktreeAt + 2).find((token) => !token.startsWith('-'));
    record('git-worktree-remove', target ? [target] : []);
    return operations;
  }

  if (name === 'rm') {
    const args = stripRedirections(rest);
    const recursive = args.some((arg) => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg));
    if (recursive) record('rm', args.filter((arg) => !arg.startsWith('-')));
    return operations;
  }

  if (name === 'find') {
    const args = stripRedirections(rest);
    if (!args.includes('-delete')) return operations;
    const root = args.find((token) => !token.startsWith('-'));
    record('find-delete', root ? [root] : []);
  }
  return operations;
}

/**
 * Removal operations in a shell command, in execution order.
 * `targets` is always an array; an empty array or an unresolved entry means the
 * path is not statically known. `kind: 'shell'` carries the nested `program`.
 */
export function removalOperations(command, depth = 0) {
  const operations = [];
  for (const raw of tokenize(command)) operations.push(...operationsFromSegment(raw, depth));
  return operations;
}

/** Filesystem identity: a symlinked target and a trailing slash both resolve to
 * the directory the process actually uses. Missing paths fall back to resolve(). */
export function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Read a script the command would run; null when unreadable or not a file. */
function readScript(path) {
  try {
    const canonical = canonicalPath(path);
    if (!statSync(canonical).isFile()) return null;
    return readFileSync(canonical, 'utf8').slice(0, MAX_SCRIPT_BYTES);
  } catch {
    return null;
  }
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
    const canonical = canonicalPath(target);
    if (ownWorktree && canonical === ownWorktree) continue;
    const liveness = probe(canonical);
    const others = liveness.holders.filter((holder) => !ownPids.has(holder.pid));
    if (others.length > 0) blockers.push({ target, holders: others, warnings: liveness.warnings });
  }
  return blockers;
}

function warningLines(ctx) {
  return [...ctx.warnings, ...ctx.notes].map((warning) => `warning: ${warning}`);
}

/** Evaluate one command text against the live-process snapshot in `ctx`. */
function evaluateCommand(command, ctx, depth = 0) {
  const operations = removalOperations(command, depth);
  const literalTargets = [];
  const unresolved = [];

  for (const operation of operations) {
    if (operation.kind === 'script') {
      for (const target of operation.targets) {
        const scriptPath = resolve(ctx.cwd, target);
        const contents = readScript(scriptPath);
        if (contents === null) {
          ctx.notes.push(`could not read script ${scriptPath}`);
          continue;
        }
        const inner = evaluateCommand(contents, ctx, depth + 1);
        if (inner) return inner;
      }
      continue;
    }
    for (const target of operation.targets) {
      if (targetIsUnresolved(target)) unresolved.push({ target, operation });
      else literalTargets.push(resolve(ctx.cwd, target));
    }
    if (operation.targets.length === 0) unresolved.push({ target: '', operation });
  }

  const blockers = literalBlockers(literalTargets, ctx.probe, ctx.ownWorktree, ctx.ownPids);
  if (blockers.length > 0) {
    const lines = blockers.flatMap((blocker) => {
      const holderLines = formatWorktreeHolders(blocker.holders).map((line) => `${blocker.target}: ${line}`);
      const blockerWarnings = blocker.warnings.map((warning) => `${blocker.target}: warning: ${warning}`);
      return [...holderLines, ...blockerWarnings];
    });
    return blockReason([...lines, ...warningLines(ctx)]);
  }

  if (unresolved.length > 0) {
    const live = [];
    const candidates = new Set(registeredWorktrees(ctx.cwd).map((candidate) => canonicalPath(candidate)));
    for (const pane of ctx.panes) {
      if (pane.agentWorktree) candidates.add(canonicalPath(pane.agentWorktree));
    }
    for (const candidate of candidates) {
      if (ctx.ownWorktree && candidate === ctx.ownWorktree) continue;
      const liveness = ctx.probe(candidate);
      const others = liveness.holders.filter((holder) => !ctx.ownPids.has(holder.pid));
      if (others.length > 0) live.push({ target: candidate, holders: others });
    }

    if (live.length > 0) {
      const lines = [
        `the command removes a path it resolves at run time (${unresolved[0].target || 'no literal target'})`,
        ...live.flatMap((entry) => formatWorktreeHolders(entry.holders).map((line) => `${entry.target}: ${line}`)),
        ...warningLines(ctx),
      ];
      return blockReason(lines);
    }
  }

  return null;
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

  if (removalOperations(command).length === 0) return null;

  const cwd = input?.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const ownWorktreeRoot = worktreeRoot(cwd);
  const ownWorktree = ownWorktreeRoot ? canonicalPath(ownWorktreeRoot) : null;
  const ownPids = callerProcessIds();
  const cwds = readProcessCwds('/proc');
  const { panes, warnings } = readTmuxPanes({ procRoot: '/proc', tmuxSockets: options.tmuxSockets });
  const ctx = {
    cwd,
    ownWorktree,
    ownPids,
    panes,
    warnings,
    notes: [],
    probe: (path) => worktreeInUse(path, { cwds, panes, skipTmux: true }),
  };

  return evaluateCommand(command, ctx);
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
