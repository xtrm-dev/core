#!/usr/bin/env node
// worktree-guard.mjs — Claude Code PreToolUse Bash guard (CORE-2814).
//
// Blocks a shell command that removes a worktree another live process is using:
//   git worktree remove [--force] <path>
//   rm -r / -rf / --recursive <path>
//   find <path> ... -delete, or -exec rm ... {}
//
// The guard reads the command the way a shell would, as far as a bounded parser
// can: wrappers (sudo, env, xargs, setsid, flock, parallel, timeout, ...), git
// global options and same-command aliases, `sh -c` / `eval` / script files,
// `$(...)` and backtick substitution, `cd` / `pushd` through `&&`, `;` and `||`.
// A literal target is checked directly. A target the shell resolves at run time
// (`$w`, `$(...)`, a glob) is bounded by the directory of its literal
// prefix, complete components only: `build/$CONFIG` bounds to `build`. `$HOME`
// and `~` are expanded from the environment first, so they are literal. It blocks
// when that bound equals a live worktree, lies inside one, or is an ancestor of
// one; a bound that merely contains a nested live worktree is not at risk, so
// `rm -rf dist/*` is allowed in any tree. A bare `$X` cannot be bounded and
// blocks while any live worktree exists. This matters because the 2026-11-28
// incident was exactly
//   git worktree list | awk '/xt-pi-/{print $1}' | while read w; do git worktree remove --force "$w"; done
//
// Removal is recognised at token level, never by raw text: `git push --delete`,
// `git branch --delete` and `grep "worktree remove"` are not removals. `env -C`
// and `git -C` change the directory that following targets are relative to.
// Being inside your own worktree exempts only your own pid ancestry, never
// another holder in the same tree.
//
// Known limits, by design: an interpreter the parser cannot read
// (`python -c ...shutil.rmtree`, `perl -e unlink`, `node -e ...`, `rsync
// --delete`, a compiled binary) is invisible unless its text names a removal
// verb. So is a worktree path assembled from a variable the guard cannot bound.
// An executable or script the guard cannot read is treated as unknown and
// allowed, never guessed at. Script fan-out keeps a visited set and a 40 ms
// parse budget; past it a script body is unread, and a command whose text still
// carries a removal verb is blocked. The guard is defence in depth, not a
// sandbox.
//
// `git worktree prune` is deliberately allowed: it removes metadata of missing
// directories, never a live tree (NON_GOAL in the Issue).
//
// Fast path: a command with no removal shape returns null before /proc or tmux
// is touched. Fail-open: any detection error allows the command; the check never
// blocks on a failure to look.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callerProcessIds,
  canonicalPath,
  formatWorktreeHolders,
  readProcessCwds,
  readTmuxPanes,
  worktreeInUse,
} from './worktree-liveness.mjs';

/** A removal further than this in a shell/script nest is out of scope: the
 * guard blocks the outer command anyway, and unbounded recursion is a hazard. */
/** How deep a nested program is followed: `bash -c "bash -c '...'"`. Past this
 * depth the text is not parsed again, so a removal verb in it blocks as an
 * unbounded target: the parser cannot see what it names (audit round 3). */
const MAX_NESTING = 3;
const MAX_SCRIPT_BYTES = 64 * 1024;
/** Total time spent following script files in one command: a fan-out of scripts
 * that each source the next must not turn the hook into a scanner (N7). */
const PARSE_BUDGET_MS = 40;
const SHELL_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'done', 'fi']);
/** Wrappers that run another command; the real command follows them. */
const WRAPPERS = new Set([
  'command', 'builtin', 'nohup', 'time', 'exec', 'env', 'sudo', 'xargs', 'nice', 'timeout',
  'stdbuf', 'ionice', 'setsid', 'flock', 'parallel',
]);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
/** Wrapper options that take a separate value, per wrapper: `sudo -p prompt` takes
 * one, `command -p` does not, so a shared table hides the wrapped command. */
const WRAPPER_OPERAND_FLAGS = {
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  time: new Set(['-f', '-o', '--format', '--output']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-T', '-D', '-R', '-a', '--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type', '--other-user', '--chdir', '--auth-type']),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars']),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  setsid: new Set(),
  flock: new Set(['-w', '-E', '--timeout', '--conflict-exit-code']),
  parallel: new Set(['-j', '--jobs', '-S', '--sshlogin', '--sshloginfile', '--colsep', '--delimiter', '-n', '--max-args', '-L', '--max-lines', '--header', '--results', '--tmpdir', '--joblog', '--timeout', '--retries', '--delay', '--load', '--memfree', '-I', '--replace', '--block', '-N']),
};

function wrapperSkipsOperand(wrapper, token) {
  // A directory flag takes a value on every wrapper, so the value is not the
  // command word (audit round 3).
  if (token === '-C' || token === '--chdir' || token === '-D') return true;
  const flags = WRAPPER_OPERAND_FLAGS[wrapper];
  return flags ? flags.has(token) : false;
}
/** A redirection token consumes its operand, which is a file, never a target:
 * `git worktree remove 2>/dev/null --force <path>` removes <path>. */
const REDIRECTION = /^(\d*|&)(>>?|<<?)(.*)$/;
/** find actions that run a command; a `rm` inside one removes the searched tree. */
const EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
/** True when text names a removal, matched at token level: a raw-text scan
 * blocks `git push --delete`, `git branch --delete` and a quoted argument that
 * happens to say "worktree remove" (N3). */
export function hasRemovalVerb(text) {
  return removalOperations(String(text ?? ''), MAX_NESTING, null).some(op => op.kind !== 'warning');
}

/** The escapes `$'...'` decodes; enough that a removal verb and a path inside
 * one survive, and every other escape keeps its character. */
function ansiEscape(ch) {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case 'a': return '\x07';
    case 'b': return '\b';
    case 'f': return '\f';
    case 'v': return '\v';
    case 'e': return '\x1b';
    default: return ch;
  }
}

function tokenize(command) {
  const segments = [];
  let tokens = [];
  let token = '';
  let hasToken = false;
  let quote = null;
  let quoteAnsi = false;
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
        quoteAnsi = false;
      } else if (ch === '\\' && (quote === '"' || quoteAnsi) && i + 1 < command.length) {
        token += quoteAnsi ? ansiEscape(command[i + 1]) : command[i + 1];
        i += 1;
      } else {
        token += ch;
      }
      i += 1;
      continue;
    }
    // `$'...'` (ANSI-C) and `$"..."` (locale) are one quoted word, and the
    // prefix is not part of its text: reading `$'...'` as a word beginning with
    // `$` let `bash -c $'git worktree remove --force <live>'` through.
    if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) {
      quote = command[i + 1];
      quoteAnsi = quote === "'";
      hasToken = true;
      i += 2;
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
            // `$(...)` is one word of the outer command, not a subshell of it: keep it
        // whole so the command word and target stay recognisable.
        if (ch === '$' && command[i + 1] === '(') {
            let depth = 0;
            let j = i + 1;
            for (; j < command.length; j += 1) {
                if (command[j] === '(') depth += 1;
                else if (command[j] === ')') {
                    depth -= 1;
                    if (depth === 0) break;
                }
            }
            if (j < command.length) {
                token += command.slice(i, j + 1);
                hasToken = true;
                i = j + 1;
                continue;
            }
        }
token += ch;
    hasToken = true;
    i += 1;
  }
  pushSegment();
  return segments;
}

/** Program text of `$(...)` and backtick substitutions: they run before the
 * command that contains them, so a removal inside one still removes. */
function substitutionPrograms(command) {
  const programs = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === '`') {
      const end = command.indexOf('`', i + 1);
      if (end < 0) break;
      programs.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (command[i] === '$' && command[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j += 1) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j >= command.length) break;
      programs.push(command.slice(i + 2, j));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return programs;
}

/** True when the shell, not the text, decides the path (`$w`, `$(...)`, a glob). */
export function targetIsUnresolved(target) {
  if (!target) return true;
  return /[$`*?[\]{}~]/.test(target);
}

/** The bound of a target the shell expands: the directory of its complete
 * literal components. `build/$CONFIG` bounds to `build`, `dist/*` to `dist`,
 * `out/x$Y` to `out`, `.xtrm/worktrees/*` to `.xtrm/worktrees`. Null means
 * unbounded: a bare `$X`, `~` or a path with no known cwd could be anything.
 * A partial last component is dropped, never used as the bound (N5). */
export function targetBound(target, cwd) {
  if (!target) return cwd ?? null;
  const unresolvedAt = target.search(/[$`*?[\]{}~]/);
  if (unresolvedAt === 0) return null;
  const literal = unresolvedAt < 0 ? target : target.slice(0, unresolvedAt);
  const base = /\/$/.test(literal) ? literal : literal.slice(0, literal.lastIndexOf('/') + 1);
  if (base === '') return cwd ?? null;
  if (base.startsWith('/')) return canonicalPath(base.replace(/\/+$/, '') || '/');
  if (!cwd) return null;
  return canonicalPath(resolve(cwd, base.replace(/\/+$/, '') || '.'));
}

/** The directory a `git -C` / `env -C` / `sudo -D` operand names; null when it
 * cannot be known, so everything after it is unresolvable too (N2). */
function changeDirectory(cwd, dir) {
  const expanded = expandHome(dir);
  if (!expanded || targetIsUnresolved(expanded)) return null;
  if (expanded.startsWith('/')) return canonicalPath(expanded);
  return cwd ? canonicalPath(resolve(cwd, expanded)) : null;
}

/** `$HOME` and `~` come from the environment, so they resolve rather than
 * leaving every target unbounded (N4). */
function expandHome(token, env = process.env) {
  const home = env.HOME;
  if (!home || typeof token !== 'string') return token;
  if (token === '~') return home;
  if (token.startsWith('~/')) return `${home}/${token.slice(2)}`;
  if (token === '$HOME' || token === '${HOME}') return home;
  if (token.startsWith('$HOME/')) return `${home}/${token.slice(6)}`;
  if (token.startsWith('${HOME}/')) return `${home}/${token.slice(8)}`;
  return token;
}

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

/** The file a redirection reads as the program: `bash < script.sh`. */
function inputRedirect(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '<') return tokens[i + 1] ?? null;
    const match = /^<(.+)$/.exec(token);
    if (match) return match[1];
  }
  return null;
}

/** Index of the command word after wrappers, their options and assignments. */
function commandIndex(tokens) {
  let start = 0;
  let flockOperand = false;
  for (;;) {
    if (start >= tokens.length) return start;
    const base = tokens[start].split('/').pop() ?? tokens[start];
    if (!WRAPPERS.has(base)) break;
    if (base === 'flock') flockOperand = true;
    start += 1;
    while (start < tokens.length) {
      const token = tokens[start];
      if (/^\d+[smhd]?$/.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        start += 1;
        continue;
      }
      if (!token.startsWith('-')) break;
      start += wrapperSkipsOperand(base, token) ? 2 : 1;
    }
    // flock's next positional is the lock file, not the command.
    if (flockOperand && start < tokens.length && !tokens[start].startsWith('-')) {
      start += 1;
      flockOperand = false;
    }
  }
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
  return start;
}

/** The git config key that defines an alias: `alias.<name>`, or a qualified form. */
const ALIAS_KEY = /^(?:.*\.)?alias\.([^.=]+)$/;
/** Git global options that take a separate value before the subcommand. */
const GIT_GLOBAL_OPERAND_FLAGS = new Set(['-c', '--config', '--config-env', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--shallow-file', '--attr-source']);

function addGitAlias(config, aliases, envAliases, fromEnv = false) {
  const eq = config.indexOf('=');
  if (eq <= 0) return;
  const match = ALIAS_KEY.exec(config.slice(0, eq));
  if (!match) return;
  if (fromEnv) {
    envAliases.add(match[1]);
    return;
  }
  aliases.set(match[1], config.slice(eq + 1));
}

/** Walk the git global options; return the subcommand position and alias table. */
function parseGitPrefix(tokens, from) {
  const aliases = new Map();
  const envAliases = new Set();
  const chdirs = [];
  let i = from;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '-C') {
      chdirs.push(tokens[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (token === '-c' || token === '--config') {
      addGitAlias(tokens[i + 1] ?? '', aliases, envAliases);
      i += 2;
      continue;
    }
    if (token.startsWith('-c') && token.length > 2) {
      addGitAlias(token.slice(2), aliases, envAliases);
      i += 1;
      continue;
    }
    if (token === '--config-env') {
      addGitAlias(tokens[i + 1] ?? '', aliases, envAliases, true);
      i += 2;
      continue;
    }
    if (token.startsWith('--config-env=')) {
      addGitAlias(token.slice('--config-env='.length), aliases, envAliases, true);
      i += 1;
      continue;
    }
    if (!token.startsWith('-')) break;
    i += GIT_GLOBAL_OPERAND_FLAGS.has(token) ? 2 : 1;
  }
  return { subcommandAt: i, aliases, envAliases, chdirs };
}

function gitRemovalOperations(tokens, start, record, operations, depth, cwd, ctx) {
  const { subcommandAt, aliases, envAliases, chdirs } = parseGitPrefix(tokens, start + 1);
  // `git -C <dir> worktree remove <relative>` removes a path relative to <dir>.
  let gitCwd = cwd;
  for (const dir of chdirs) gitCwd = changeDirectory(gitCwd, dir);
  const subcommand = tokens[subcommandAt] ?? '';
  const args = tokens.slice(subcommandAt + 1);
  const aliasValue = aliases.get(subcommand);
  if (aliasValue !== undefined) {
    const program = aliasValue.startsWith('!')
      ? `${aliasValue.slice(1)} ${args.join(' ')}`
      : `git ${aliasValue} ${args.join(' ')}`;
    operations.push(...removalOperations(program, depth + 1, gitCwd, ctx));
    return operations;
  }
  if (envAliases.has(subcommand)) {
    record('git-worktree-remove', args.filter(token => !token.startsWith('-')), {}, gitCwd);
    return operations;
  }
  if (subcommand !== 'worktree' || args[0] !== 'remove') return operations;
  const target = args.slice(1).find(token => !token.startsWith('-'));
  record('git-worktree-remove', target ? [target] : [], {}, gitCwd);
  return operations;
}

/** A script the parser can read is parsed as its own program; one it cannot read
 * (a missing file, a non-shell binary, an executable the guard cannot name) is
 * allowed, never guessed at (N4). */
function readScript(path) {
  if (!path) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_SCRIPT_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Read a script once, inside the parse budget. A second read of the same path
 * would only repeat its operations, and a fan-out past the deadline stops the
 * walk with one warning (N7). */
function readScriptProgram(token, cwd, state, operations) {
  const path = localScript(expandHome(token), cwd);
  if (!path) return null;
  if (state.ctx.visited.has(path)) return null;
  state.ctx.visited.add(path);
  const program = readScript(path);
  if (program === null) return null;
  if (Date.now() > state.ctx.deadline) {
    if (!state.ctx.expired) {
      state.ctx.expired = true;
      operations.push({
        kind: 'warning',
        targets: [],
        raw: '',
        warning: `script fan-out budget spent (${PARSE_BUDGET_MS} ms): unread scripts were not parsed`,
      });
    }
    return null;
  }
  return program;
}

function localScript(token, cwd) {
  if (!token || targetIsUnresolved(token)) return null;
  if (token.startsWith('/')) return token;
  return cwd ? resolve(cwd, token) : null;
}

/** Track `cd` / `pushd` through `&&`, `;` and `||`: a relative target after a
 * `cd` is relative to the new directory, and an unresolvable `cd` makes it
 * unknown. */
function trackDirectory(rest, state) {
  const target = rest.find(token => token !== '-P' && token !== '-L' && !token.startsWith('-'));
  if (!target || target === '-') {
    state.cwd = null;
    return;
  }
  const expanded = expandHome(target);
  if (targetIsUnresolved(expanded)) {
    state.cwd = null;
    return;
  }
  if (expanded.startsWith('/')) {
    state.cwd = resolve(expanded);
    return;
  }
  state.cwd = state.cwd ? resolve(state.cwd, expanded) : null;
}

function operationsFromSegment(raw, depth, state) {
  const operations = [];
  const unfiltered = stripRedirections(raw.filter(token => !SHELL_KEYWORDS.has(token)));

  // `parallel rm -rf {} ::: a b`: each `:::`-separated group is a command.
  const leading = unfiltered[0] ?? '';
  if (leading === 'parallel' || leading.endsWith('/parallel')) {
    const groups = [[]];
    for (const token of unfiltered.slice(1)) {
      if (token === ':::') groups.push([]);
      else groups[groups.length - 1].push(token);
    }
    for (const group of groups) {
      if (group.length > 0) operations.push(...removalOperations(group.join(' '), depth + 1, state.cwd, state.ctx));
    }
    return operations;
  }

  const start = commandIndex(unfiltered);
  const commandName = unfiltered[start];
  if (!commandName) return operations;
  const name = commandName.split('/').pop() ?? commandName;
  const rest = unfiltered.slice(start + 1);
  // `env -C dir cmd` and `sudo -D dir cmd` change the directory the wrapped
  // command runs in, so a relative target after them is relative to dir (N2).
  let opCwd = state.cwd;
  let wrapperName = '';
  for (let i = 0; i < start; i += 1) {
    const token = unfiltered[i];
    const base = token.split('/').pop() ?? token;
    if (WRAPPERS.has(base)) {
      wrapperName = base;
      continue;
    }
    if (token.startsWith('--chdir=')) {
      opCwd = changeDirectory(opCwd, token.slice('--chdir='.length));
      continue;
    }
    // Every wrapper may name the directory the wrapped command runs in:
    // `env -C`, `command -C`, `sudo -D`, `--chdir[=dir]` (audit round 3).
    if (token === '-C' || token === '--chdir' || (wrapperName === 'sudo' && token === '-D')) {
      opCwd = changeDirectory(opCwd, unfiltered[i + 1]);
    }
  }
  const record = (kind, targets, extra = {}, at = opCwd) => {
    operations.push({ kind, targets, raw: raw.join(' '), cwd: at, ...extra });
  };

  if (name === 'cd' || name === 'pushd') {
    trackDirectory(rest, state);
    return operations;
  }

  // A command word the shell computes, such as `$(which rm) -rf live`: the
  // executable is unknown, so a removal flag in the arguments makes it a removal
  // of the literal arguments.
  if (/[$`]/.test(name) && rest.some(token => token === '--recursive' || /^-[A-Za-z]*[rR]/.test(token))) {
    record('rm', rest.filter(token => !token.startsWith('-') && !/[$`]/.test(token)));
    return operations;
  }

  if (SHELLS.has(name) || name === 'eval') {
    const cIndex = name === 'eval' ? -1 : rest.findIndex(token => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
    if (name === 'eval' || cIndex >= 0) {
      const program = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
      if (program) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
      return operations;
    }
    // `bash < script`, `bash script`: the program text comes from a file.
    const scriptToken = rest.find(token => !token.startsWith('-') && !token.startsWith('<'));
    const program = readScriptProgram(inputRedirect(raw) ?? scriptToken, state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
    return operations;
  }

  if (name === 'source' || name === '.') {
    const program = readScriptProgram(rest.find(token => !token.startsWith('-')), state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
    return operations;
  }

  if (name === 'parallel') {
    // `parallel rm -rf {} ::: a b`: each `:::`-separated group is a command.
    const groups = [[]];
    for (const token of rest) {
      if (token === ':::') groups.push([]);
      else groups[groups.length - 1].push(token);
    }
    for (const group of groups) {
      if (group.length > 0) operations.push(...removalOperations(group.join(' '), depth + 1, opCwd, state.ctx));
    }
    return operations;
  }

  if (name === 'git') return gitRemovalOperations(unfiltered, start, record, operations, depth, opCwd, state.ctx);

  if (name === 'rm') {
    const args = rest;
    const recursive = args.some(arg => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg));
    if (recursive) record('rm', args.filter(arg => !arg.startsWith('-')));
    return operations;
  }

  if (name === 'find') {
    const args = rest;
    const root = args.find(token => !token.startsWith('-') && !token.startsWith('(')) ?? '.';
    if (args.includes('-delete')) record('find-delete', [root]);
    for (let i = 0; i < args.length; i += 1) {
      if (!EXEC_ACTIONS.has(args[i])) continue;
      const sub = args.slice(i + 1).filter(token => token !== '{}' && token !== '+' && token !== ';');
      if (sub.some(token => token === 'rm' || token.endsWith('/rm')) || hasRemovalVerb(sub.join(' '))) {
        record('find-delete', [root]);
      }
    }
  }

  // An executable the parser cannot name, such as `./script.sh`: read it as a
  // script. This runs AFTER the known verbs, so `/usr/bin/git worktree remove`
  // and `/bin/rm -rf` are recognised by their basename, never read as a script.
  // One it cannot read is allowed: an unknown executable is not a removal (N4).
  if (commandName.includes('/')) {
    const program = readScriptProgram(commandName, state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx));
  }
  return operations;
}

/**
 * Removal operations in a shell command, in execution order.
 * `targets` is always an array; an empty array or an unresolved entry means the
 * path is not statically known, and `cwd` says what a relative one is relative to.
 */
export function removalOperations(command, depth = 0, cwd = null, ctx = null) {
  const context = ctx ?? { visited: new Set(), deadline: Date.now() + PARSE_BUDGET_MS, expired: false };
  const operations = [];
  // Past the cap the text is checked for a removal verb but not parsed, so a
  // literal target deeper than the cap blocks as an unbounded one instead of
  // slipping through (audit round 3).
  if (depth > MAX_NESTING) {
    if (mentionsRemovalVerb(command)) {
      operations.push({ kind: 'rm', targets: [], raw: String(command), cwd: cwd ?? undefined });
    }
    return operations;
  }
  const state = { cwd, ctx: context };
  for (const raw of tokenize(command)) operations.push(...operationsFromSegment(raw, depth, state));
  for (const program of substitutionPrograms(command)) {
    operations.push(...removalOperations(program, depth + 1, cwd, context));
  }
  return operations;
}

/** Token-level removal check on text that is not parsed further (the nesting
 * cap). It asks whether the words name a removal, so a quoted argument still
 * does not count (N3). */
function mentionsRemovalVerb(text) {
  let remaining = String(text ?? '');
  // A `bash -c` at the cap hides one more level, so follow the wrapper chain a
  // bounded number of rounds without parsing the rest of the command.
  for (let round = 0; round < 8 && remaining; round += 1) {
    let program = null;
    for (const raw of tokenize(remaining)) {
      const tokens = stripRedirections(raw);
      const start = commandIndex(tokens);
      const name = (tokens[start] ?? '').split('/').pop() ?? '';
      const rest = tokens.slice(start + 1);
      if (name === 'rm' && rest.some(arg => arg === '--recursive' || /^-[A-Za-z]*[rR]/.test(arg))) return true;
      if (name === 'find' && (rest.includes('-delete') || (rest.includes('rm') && rest.some(arg => EXEC_ACTIONS.has(arg))))) return true;
      if (name === 'git' && rest.some((arg, index) => arg === 'worktree' && rest[index + 1] === 'remove')) return true;
      if (SHELLS.has(name) || name === 'eval') {
        const cIndex = name === 'eval' ? -1 : rest.findIndex(arg => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
        const nested = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
        if (nested) program = nested;
      }
    }
    if (!program) return false;
    remaining = program;
  }
  return false;
}

function gitIn(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500 });
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? '';
}

/** Every registered worktree of the repository the command runs in. */
function registeredWorktrees(cwd) {
  const output = gitIn(cwd, ['worktree', 'list', '--porcelain']);
  if (output === null) return [];
  return output.split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

function ownWorktree(cwd) {
  const output = gitIn(cwd, ['rev-parse', '--show-toplevel']);
  return output ? canonicalPath(output.trim()) : null;
}

function isInside(child, parent) {
  return child === parent || child.startsWith(`${parent}/`);
}

function blockReason(holderLines, detail, warnings) {
  const lines = ['🚫 Worktree liveness guard (CORE-2814): this command removes a worktree a live process is using.'];
  if (holderLines.length > 0) lines.push('', ...holderLines);
  if (detail) lines.push('', detail);
  lines.push('', 'Removing a live worktree discards another session\'s uncommitted work.', 'Stop the holder first, or target a worktree that is not in use.');
  if (warnings && warnings.length > 0) lines.push('', ...warnings.map(warning => `note: ${warning}`));
  return lines.join('\n');
}

/**
 * null allows the command; a string blocks it and is shown to the agent.
 * `options.tmuxSockets` pins the sockets for a test, so an ambient server can
 * never decide a test result.
 */
export function worktreeGuardDecision(input = {}, options = {}) {
  const toolName = input.tool_name ?? input.toolName;
  if (toolName !== 'Bash' && toolName !== 'bash') return null;
  const command = input.tool_input?.command ?? input.toolInput?.command;
  if (typeof command !== 'string' || command.trim() === '') return null;

  const cwd = typeof input.cwd === 'string' && input.cwd !== ''
    ? input.cwd
    : (process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const parsed = removalOperations(command, 0, cwd);
  // Fast path: no removal shape, so /proc and tmux are never touched.
  if (parsed.length === 0) return null;
  const warnings = parsed.filter(op => op.kind === 'warning').map(op => op.warning);
  const operations = parsed.filter(op => op.kind !== 'warning');
  if (operations.length === 0) {
    // Only a spent parse budget: nothing found in what was read, so allow.
    for (const warning of warnings) process.stderr.write(`worktree-guard: ${warning}\n`);
    return null;
  }

  const ownPids = callerProcessIds();
  const ownRoot = ownWorktree(cwd);
  const cwds = readProcessCwds('/proc');
  const tmux = readTmuxPanes({ procRoot: '/proc', tmuxSockets: options.tmuxSockets });
  warnings.push(...tmux.warnings);
  const panes = tmux.panes;
  const probe = path => worktreeInUse(path, { cwds, panes, skipTmux: true });
  // Inside your own worktree only your own pid ancestry is exempt; another
  // holder in the same tree still blocks.
  const holdersOutside = path => probe(path).holders.filter(holder => !ownPids.has(holder.pid));

  const candidates = [...new Set([
    ...registeredWorktrees(cwd),
    ...panes.map(pane => pane.agentWorktree).filter(Boolean),
  ])].map(canonicalPath);
  // A holder inside a nested worktree belongs to that worktree, not to the tree
  // that contains it: the main checkout is not live because a session runs in
  // its .xtrm/worktrees/* (N1).
  const ownerOf = holderPath => candidates
    .filter(path => isInside(holderPath, path))
    .sort((a, b) => b.length - a.length)[0];
  const livePaths = candidates.filter(path => holdersOutside(path).some(holder => ownerOf(holder.path) === path));
  const liveHolders = paths => paths.flatMap(path => holdersOutside(path));

  const check = (rawTarget, opCwd, op) => {
    const target = expandHome(rawTarget);
    if (targetIsUnresolved(target)) {
      const bound = targetBound(target, opCwd);
      if (bound === null) {
        if (livePaths.length === 0) return null;
        const holders = liveHolders(livePaths);
        return blockReason(
          holders.length ? formatWorktreeHolders(holders) : [],
          `The target ${JSON.stringify(target)} cannot be bounded statically: use a literal path, or stop the live holder first.`,
          warnings,
        );
      }
      // Equal to a live worktree, inside one, or an ancestor of one. A bound
      // that merely contains a nested live worktree is not at risk (N1, N5).
      const atRisk = livePaths.filter(path => isInside(path, bound) || isInside(bound, path));
      if (atRisk.length === 0) return null;
      return blockReason(formatWorktreeHolders(liveHolders(atRisk)), `The target ${JSON.stringify(target)} resolves inside or around ${atRisk.join(', ')}.`, warnings);
    }
    const resolved = isAbsolute(target) ? canonicalPath(target) : (opCwd ? canonicalPath(resolve(opCwd, target)) : null);
    if (!resolved) {
      if (livePaths.length === 0) return null;
      return blockReason([], `The target ${JSON.stringify(target)} is relative to a directory the guard could not resolve: use a literal path.`, warnings);
    }
    // A literal target blocks on any holder inside it, even one attributed to a
    // nested worktree: removing the parent tree destroys that worktree too.
    const holders = holdersOutside(resolved);
    if (holders.length === 0) return null;
    return blockReason(formatWorktreeHolders(holders), `${op.kind} would remove ${resolved}.`, warnings);
  };

  for (const op of operations) {
    const opCwd = op.cwd === undefined ? cwd : op.cwd;
    if (op.targets.length === 0) {
      if (livePaths.length === 0) continue;
      return blockReason(formatWorktreeHolders(liveHolders(livePaths)), `${op.kind} has no statically known target: use a literal path.`, warnings);
    }
    for (const target of op.targets) {
      const reason = check(target, opCwd, op);
      if (reason) return reason;
    }
  }

  return null;
}

function main() {
  try {
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      // The callback body sits inside the try too: a guard that cannot decide
      // must allow, never crash the hook (N8).
      try {
        let input = {};
        try {
          input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          return;
        }
        const reason = worktreeGuardDecision(input);
        if (reason) process.stdout.write(`${JSON.stringify({ decision: 'block', reason })}\n`);
      } catch {
        // Fail open.
      }
    });
  } catch {
    // Fail open: a guard that cannot run must not block the agent.
  }
}

function isCliMain() {
  try {
    return process.argv[1] && statSync(process.argv[1]).ino === statSync(fileURLToPath(import.meta.url)).ino;
  } catch {
    return false;
  }
}

if (isCliMain()) main();
