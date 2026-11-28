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
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callerProcessIds,
  canonicalPath,
  formatWorktreeHolders,
  readProcessCommand,
  readProcessCwds,
  readTmuxPanes,
} from './worktree-liveness.mjs';

/** How deep a nested program is followed: `bash -c "bash -c '...'"`. Past this
 * depth the text is not parsed again, so a removal verb in it blocks as an
 * unbounded target: the parser cannot see what it names (audit round 3). */
const MAX_NESTING = 3;
const MAX_SCRIPT_BYTES = 64 * 1024;
/** Total time spent following script files in one command: a fan-out of scripts
 * that each source the next must not turn the hook into a scanner (N7). */
const PARSE_BUDGET_MS = 40;
/** Scripts a spent fan-out budget may still check for a verb before it blocks
 * the unknown remainder instead (R4). */
const MAX_UNCHECKED_SCRIPTS = 8;
/** Git subcommands that are not aliases: a lookup runs only for an unknown one,
 * so `git status` never costs a spawn (R8). */
const KNOWN_GIT_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'checkout',
  'cherry-pick', 'clean', 'clone', 'commit', 'config', 'describe', 'diff', 'fetch',
  'format-patch', 'fsck', 'gc', 'grep', 'help', 'init', 'log', 'ls-files', 'maintenance',
  'merge', 'mv', 'notes', 'prune', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote',
  'reset', 'restore', 'revert', 'rev-parse', 'rm', 'shortlog', 'show', 'sparse-checkout',
  'stash', 'status', 'submodule', 'switch', 'symbolic-ref', 'tag', 'update-index',
  'update-ref', 'version', 'whatchanged', 'worktree',
]);
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

/** GNU rm accepts every unambiguous abbreviation of `--recursive` (R2). */
function isRecursiveFlag(arg) {
  if (/^-[A-Za-z]*[rR]/.test(arg)) return true;
  return arg.length >= 4 && arg.startsWith('--') && '--recursive'.startsWith(arg);
}

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
/** Commands that delete the file they are given, so `find ... -exec <word>` still
 * removes the tree's contents even without a recursive flag (R3). */
const DELETE_WORDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'srm', 'trash', 'trash-put']);
function isDeleteWord(word) {
  return DELETE_WORDS.has(word.split('/').pop() ?? word);
}
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
function changeDirectory(cwd, dir, env = process.env) {
  const expanded = expandHome(dir, env);
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

function gitRemovalOperations(tokens, start, record, operations, depth, cwd, ctx, env = process.env) {
  const { subcommandAt, aliases, envAliases, chdirs } = parseGitPrefix(tokens, start + 1);
  // `git -C <dir> worktree remove <relative>` removes a path relative to <dir>.
  let gitCwd = cwd;
  for (const dir of chdirs) gitCwd = changeDirectory(gitCwd, dir, env);
  const subcommand = tokens[subcommandAt] ?? '';
  const args = tokens.slice(subcommandAt + 1);
  const aliasValue = aliases.get(subcommand);
  if (aliasValue !== undefined) {
    const program = aliasValue.startsWith('!')
      ? `${aliasValue.slice(1)} ${args.join(' ')}`
      : `git ${aliasValue} ${args.join(' ')}`;
    operations.push(...removalOperations(program, depth + 1, gitCwd, ctx, env));
    return operations;
  }
  if (envAliases.has(subcommand)) {
    record('git-worktree-remove', args.filter(token => !token.startsWith('-')), {}, gitCwd);
    return operations;
  }
  if (subcommand !== 'worktree' || args[0] !== 'remove') {
    // A persisted alias is authoritative too: `git rmlive <path>` in a repo that
    // sets `alias.rmlive` (R8). Only an unknown subcommand costs a lookup, and
    // the lookup is bounded by the parse budget.
    if (ctx && subcommand && !KNOWN_GIT_SUBCOMMANDS.has(subcommand) && Date.now() <= ctx.deadline) {
      const key = `git-alias\0${gitCwd ?? ''}\0${subcommand}`;
      if (!ctx.visited.has(key)) {
        ctx.visited.add(key);
        const value = gitIn(gitCwd, ['config', '--get', `alias.${subcommand}`]);
        const alias = value ? value.trim() : '';
        if (alias) {
          const program = alias.startsWith('!')
            ? `${alias.slice(1)} ${args.join(' ')}`
            : `git ${alias} ${args.join(' ')}`;
          operations.push(...removalOperations(program, depth + 1, gitCwd, ctx, env));
        }
      }
    }
    return operations;
  }
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
    state.ctx.unchecked = (state.ctx.unchecked ?? 0) + 1;
    if (!state.ctx.expired) {
      state.ctx.expired = true;
      // The budget is spent, so the rest is not parsed. It is still checked for a
      // removal verb, and a chain longer than MAX_UNCHECKED_SCRIPTS blocks the
      // unknown remainder instead of allowing it (R4).
      operations.push({
        kind: 'warning',
        targets: [],
        raw: '',
        warning: `script fan-out budget spent (${PARSE_BUDGET_MS} ms): remaining scripts were checked for a removal verb only`,
      });
    }
    if (mentionsRemovalVerb(program) || state.ctx.unchecked > MAX_UNCHECKED_SCRIPTS) {
      operations.push({ kind: 'rm', targets: [], raw: '', cwd: state.cwd ?? undefined });
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
    // The first group is the command; `{}` stands for each argument of the
    // others, so `parallel rm -rf {} ::: <live>` removes <live> (R1).
    const [command, ...arguments_] = groups;
    if (command && command.length > 0) {
      const args = arguments_.flat();
      const template = command.join(' ');
      if (args.length > 0 && template.includes('{}')) {
        for (const arg of args) {
          operations.push(...removalOperations(template.split('{}').join(arg), depth + 1, state.cwd, state.ctx, state.childEnv));
        }
      } else {
        operations.push(...removalOperations(template, depth + 1, state.cwd, state.ctx, state.childEnv));
      }
    }
    return operations;
  }

  // `HOME=/x rm -rf ~` sets the environment of the child only: `~` in this
  // command still expands with the shell's own HOME, while a nested
  // `bash -c 'rm -rf ~'` inherits the new one (F-3).
  for (const token of unfiltered) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
    if (!assignment) break;
    if (assignment[1] === 'HOME') state.childEnv = { ...state.childEnv, HOME: assignment[2] };
  }

  // `env -S "<command>"` runs the string as a command, so the string is the
  // command word and the flags before it are env's own (R5).
  if ((unfiltered[0] ?? '').split('/').pop() === 'env') {
    for (let i = 1; i < unfiltered.length; i += 1) {
      const token = unfiltered[i];
      const program = token === '-S' || token === '--split-string'
        ? unfiltered[i + 1]
        : (token.startsWith('-S') && token.length > 2 ? token.slice(2) : null);
      if (program) {
        operations.push(...removalOperations(program, depth + 1, state.cwd, state.ctx, state.childEnv));
        return operations;
      }
      if (!token.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) break;
    }
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
      opCwd = changeDirectory(opCwd, token.slice('--chdir='.length), state.env);
      continue;
    }
    // Every wrapper may name the directory the wrapped command runs in:
    // `env -C`, `command -C`, `sudo -D`, `--chdir[=dir]`, and the joined forms
    // `env -C<dir>` / `sudo -D<dir>` (audit round 3, R6).
    if (token.startsWith('-C') && token.length > 2) {
      opCwd = changeDirectory(opCwd, token.slice(2), state.env);
      continue;
    }
    if (wrapperName === 'sudo' && token.startsWith('-D') && token.length > 2) {
      opCwd = changeDirectory(opCwd, token.slice(2), state.env);
      continue;
    }
    if (token === '-C' || token === '--chdir' || (wrapperName === 'sudo' && token === '-D')) {
      opCwd = changeDirectory(opCwd, unfiltered[i + 1], state.env);
      continue;
    }
    // `env -S "<command>"` runs the string as a command (R5).
    if (wrapperName === 'env' && (token === '-S' || token === '--split-string' || token.startsWith('-S'))) {
      const program = token === '-S' || token === '--split-string' ? unfiltered[i + 1] : token.slice(2);
      if (program) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx, state.childEnv));
    }
  }
  const record = (kind, targets, extra = {}, at = opCwd) => {
    operations.push({ kind, targets: targets.map(target => expandHome(target, state.env)), raw: raw.join(' '), cwd: at, ...extra });
  };

  if (name === 'cd' || name === 'pushd') {
    trackDirectory(rest, state);
    return operations;
  }

  // `export HOME=/x` changes it for the commands that follow (R7).
  if (name === 'export') {
    for (const token of rest) {
      const assignment = /^HOME=(.*)$/.exec(token);
      if (assignment) {
        state.env = { ...state.env, HOME: assignment[1] };
        state.childEnv = { ...state.childEnv, HOME: assignment[1] };
      }
    }
    return operations;
  }

  // A command word the shell computes, such as `$(which rm) -rf live`: the
  // executable is unknown, so a removal flag in the arguments makes it a removal
  // of the literal arguments.
  if (/[$`]/.test(name) && rest.some(token => isRecursiveFlag(token))) {
    record('rm', rest.filter(token => !token.startsWith('-') && !/[$`]/.test(token)));
    return operations;
  }

  // A command word that is more than one word is a command string, not a
  // program path (`env -S "<command>"` leaves it as the command word) (R5).
  if (/\s/.test(commandName)) {
    operations.push(...removalOperations(commandName, depth + 1, opCwd, state.ctx, state.childEnv));
    return operations;
  }

  if (SHELLS.has(name) || name === 'eval') {
    const cIndex = name === 'eval' ? -1 : rest.findIndex(token => /^-[A-Za-z]*c[A-Za-z]*$/.test(token));
    if (name === 'eval' || cIndex >= 0) {
      const program = name === 'eval' ? rest.join(' ') : rest[cIndex + 1];
      if (program) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx, state.childEnv));
      return operations;
    }
    // `bash < script`, `bash script`: the program text comes from a file.
    const scriptToken = rest.find(token => !token.startsWith('-') && !token.startsWith('<'));
    const program = readScriptProgram(inputRedirect(raw) ?? scriptToken, state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx, state.childEnv));
    return operations;
  }

  if (name === 'source' || name === '.') {
    const program = readScriptProgram(rest.find(token => !token.startsWith('-')), state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx, state.childEnv));
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
      if (group.length > 0) operations.push(...removalOperations(group.join(' '), depth + 1, opCwd, state.ctx, state.childEnv));
    }
    return operations;
  }

  if (name === 'git') return gitRemovalOperations(unfiltered, start, record, operations, depth, opCwd, state.ctx, state.env);

  if (name === 'rm') {
    const args = rest;
    const recursive = args.some(arg => isRecursiveFlag(arg));
    if (recursive) record('rm', args.filter(arg => !arg.startsWith('-')));
    return operations;
  }

  if (name === 'find') {
    const args = rest;
    const root = args.find(token => !token.startsWith('-') && !token.startsWith('(')) ?? '.';
    if (args.includes('-delete')) record('find-delete', [root]);
    for (let i = 0; i < args.length; i += 1) {
      if (!EXEC_ACTIONS.has(args[i])) continue;
      // The payload is a command, parsed the same way as any other. `{}` is the
      // file find selected, so it stands for find's start path: the search root
      // is what a removal there would destroy (R3).
      const payload = [];
      for (let j = i + 1; j < args.length; j += 1) {
        const token = args[j];
        if (token === ';' || token === '+' || token === '\\;') break;
        payload.push(token.split('{}').join(root));
      }
      if (payload.length === 0) continue;
      const nested = operationsFromSegment(payload, depth, { cwd: opCwd, ctx: state.ctx, env: state.childEnv, childEnv: state.childEnv });
      if (nested.some(op => op.kind !== 'warning') || payload.some(isDeleteWord)) record('find-delete', [root]);
    }
  }

  // An executable the parser cannot name, such as `./script.sh`: read it as a
  // script. This runs AFTER the known verbs, so `/usr/bin/git worktree remove`
  // and `/bin/rm -rf` are recognised by their basename, never read as a script.
  // One it cannot read is allowed: an unknown executable is not a removal (N4).
  if (commandName.includes('/')) {
    const program = readScriptProgram(commandName, state.cwd, state, operations);
    if (program !== null) operations.push(...removalOperations(program, depth + 1, opCwd, state.ctx, state.childEnv));
  }
  return operations;
}

/**
 * Removal operations in a shell command, in execution order.
 * `targets` is always an array; an empty array or an unresolved entry means the
 * path is not statically known, and `cwd` says what a relative one is relative to.
 */
export function removalOperations(command, depth = 0, cwd = null, ctx = null, env = null) {
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
  const inherited = env ?? { ...process.env };
  // `env` expands `~` for this shell; `childEnv` is what a nested program sees.
  const state = { cwd, ctx: context, env: inherited, childEnv: inherited };
  for (const raw of tokenize(command)) operations.push(...operationsFromSegment(raw, depth, state));
  for (const program of substitutionPrograms(command)) {
    operations.push(...removalOperations(program, depth + 1, cwd, context, state.childEnv));
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
      if (name === 'rm' && rest.some(arg => isRecursiveFlag(arg))) return true;
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

/** Every worktree the repository the command runs in registers. Used only to
 * bound a target whose path the shell decides; a literal target is judged
 * against the holders themselves, whatever repo they work in (R1). */
function registeredWorktrees(cwd, cache = null) {
  if (!cwd) return [];
  const key = cwd;
  if (cache && cache.has(key)) return cache.get(key);
  const output = gitIn(cwd, ['worktree', 'list', '--porcelain']);
  const list = output
    ? output.split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => canonicalPath(line.slice('worktree '.length).trim()))
      .filter(Boolean)
    : [];
  if (cache) cache.set(key, list);
  return list;
}

/** A directory test that never throws: a match that is not a directory (or has
 * gone) is a plain file for the glob rule. */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Match one path component against a `*`/`?` pattern without building a
 * RegExp from file-system text. Linear backtracking, no nested quantifiers, so a
 * hostile file name cannot stall the guard. */
function globMatch(pattern, name) {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      resume = n;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * A target whose only unresolved part is a glob in its final component is
 * expanded against the filesystem, so `./*.log` is judged by the files it
 * matches while `.xtrm/worktrees/*` still matches a live tree (R1). null means
 * it is not that shape and the bound rule applies.
 */
function expandTrailingGlob(target, cwd) {
  // `<d>/out/*/` names directories: expanding the cleaned target and resolving
  // each match through realpath follows any symlinked match (F-4).
  const cleaned = target.replace(/\/+$/, '') || '/';
  if (!/[*?]/.test(cleaned)) return null;
  const slash = cleaned.lastIndexOf('/');
  const dirPart = slash < 0 ? '.' : (cleaned.slice(0, slash) || '/');
  const pattern = cleaned.slice(slash + 1);
  if (!pattern || targetIsUnresolved(dirPart) || /[$`[\]{}]/.test(pattern)) return null;
  const dir = isAbsolute(dirPart) ? canonicalPath(dirPart) : (cwd ? canonicalPath(resolve(cwd, dirPart)) : null);
  if (!dir) return null;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    // A directory that does not exist has nothing to remove; any other failure is
    // unknown, so the bound is used instead.
    return error?.code === 'ENOENT' ? [] : null;
  }
  return entries.filter(entry => globMatch(pattern, entry)).map(entry => canonicalPath(`${dir}/${entry}`));
}

/** The directory a final-component glob searches: `*` and `./*` bound to the
 * working directory, so `rm -rf *` has a bound even though it starts unresolved
 * (F-1). null when the directory part is itself unresolved. */
function globBoundDir(target, cwd) {
  const cleaned = target.replace(/\/+$/, '') || '/';
  const slash = cleaned.lastIndexOf('/');
  const dirPart = slash < 0 ? '.' : (cleaned.slice(0, slash) || '/');
  if (targetIsUnresolved(dirPart)) return null;
  if (isAbsolute(dirPart)) return canonicalPath(dirPart);
  return cwd ? canonicalPath(resolve(cwd, dirPart)) : null;
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
  // Tests inject a private process and pane view so a busy host cannot decide a
  // case; production always reads the live ones.
  const cwds = options.cwds ?? readProcessCwds('/proc');
  const tmux = options.panes
    ? { panes: options.panes, warnings: [] }
    : readTmuxPanes({ procRoot: '/proc', tmuxSockets: options.tmuxSockets });
  warnings.push(...tmux.warnings);
  // Every holder, whatever repository it works in: a target is judged against
  // the holders themselves, never against a candidate list from the caller's
  // repo, so a removal aimed at another repo's worktrees is judged the same
  // (R1). Own pid ancestry stays exempt; another holder in your own tree blocks.
  const holders = [];
  const seen = new Set();
  const addHolder = holder => {
    // A pane holder and its process holder share pid and path; the kind keeps both.
    const key = `${holder.kind}\0${holder.pid}\0${holder.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    holders.push(holder);
  };
  // readProcessCwds keys by cwd path and holds the pids seen there.
  for (const [path, pids] of cwds) {
    for (const pid of pids) {
      if (ownPids.has(pid)) continue;
      addHolder({ kind: 'process', pid, command: '', path });
    }
  }
  for (const pane of tmux.panes) {
    if (pane.panePid && ownPids.has(pane.panePid)) continue;
    for (const path of [pane.panePath, pane.agentWorktree]) {
      if (!path) continue;
      addHolder({ kind: 'pane', pid: pane.panePid ?? 0, command: pane.paneCommand ?? '', pane: pane.paneId, path, socket: pane.socket });
    }
  }
  // The command line of a holder is read only when a block is built.
  const describe = list => formatWorktreeHolders(list.map(holder => (
    holder.command ? holder : { ...holder, command: readProcessCommand(holder.pid) }
  )));
  const holdersInside = path => holders.filter(holder => isInside(holder.path, path));
  // The worktrees that are live now: this repo's registered worktrees, every
  // pane's agent worktree, and any worktree a holder's cwd names. A worktree is
  // live when a holder works inside it, and a holder in a nested worktree does
  // not make its parent live (N1).
  const worktreePaths = new Set(tmux.panes.map(pane => pane.agentWorktree).filter(Boolean));
  const derived = [];
  for (const holder of holders) {
    const match = holder.path.match(/^(.*\/\.xtrm\/worktrees\/[^/]+)(?:\/|$)/);
    if (match) derived.push(match[1]);
  }
  // A main checkout is a registered worktree but not a disposable one: it contains
  // the managed worktrees, and a shell parked at its root must not make every
  // bound under it risky (N1). Only worktrees that a session is given are live
  // for a bounded target; any holder still counts for a literal one.
  // A linked worktree has a `.git` file; a main checkout has a `.git` directory
  // and is never disposable, so it is not live for a bounded target (N1).
  const isLinked = path => {
    try {
      return lstatSync(`${path}/.git`).isFile();
    } catch {
      return false;
    }
  };
  const managed = path => isLinked(path) || derived.some(worktree => canonicalPath(worktree) === path);
  const registeredCache = new Map();
  const ownRootCache = new Map();
  const registeredFor = dir => registeredWorktrees(dir, registeredCache);
  const ownRootFor = dir => {
    if (!ownRootCache.has(dir)) ownRootCache.set(dir, ownWorktree(dir));
    return ownRootCache.get(dir);
  };
  const candidates = [...new Set([...registeredFor(cwd), ...[...worktreePaths], ...derived])].map(canonicalPath);
  // The caller's own worktrees are never another session's work: a process there
  // is the caller's own tooling (a pipeline, a watcher), and removing one is
  // governed by the literal rule. The cwd of the command and the cwd of the guard
  // both count, because a hook process runs in the session's directory.
  const selfRoots = [...new Set([ownRootFor(cwd), ownRootFor(process.cwd())].filter(Boolean))].map(canonicalPath);
  // Identity, not containment: a worktree nested inside the caller's repository
  // is another session's tree, so only the caller's own roots are excluded.
  const isSelfTree = path => selfRoots.includes(path);
  const livePaths = candidates.filter(path => managed(path)
    && !isSelfTree(path)
    && holders.some(holder => isInside(holder.path, path)));
  // A target with no bound is checked against the worktrees the command itself
  // reaches: the list of the repo it runs in (`git -C other`, `env -C`) and the
  // panes. Outside a repo there is no list, so any live managed worktree is
  // reachable (R1, F-2).
  const localLiveFor = dir => {
    const registered = registeredFor(dir).map(canonicalPath);
    return registered.length > 0 || ownRootFor(dir) !== null
      ? livePaths.filter(path => registered.includes(path) || worktreePaths.has(path))
      : livePaths;
  };
  const liveTreeHoldersFor = dir => [...new Set(localLiveFor(dir).flatMap(path => holdersInside(path)))];
  const globalLiveHolders = [...new Set(livePaths.flatMap(path => holdersInside(path)))];
  // A bound is at risk when a holder works under it, or when it is, contains, or
  // is contained by a live worktree (R1). A tree that only contains a nested live
  // worktree is not at risk: `rm -rf dist/*` is allowed anywhere.
  const atRisk = bound => holders.filter(holder =>
    isInside(holder.path, bound)
    || livePaths.some(path => (isInside(bound, path) || isInside(path, bound)) && isInside(holder.path, path)));

  const check = (rawTarget, opCwd, op) => {
    const target = expandHome(rawTarget);
    if (targetIsUnresolved(target)) {
      const matches = expandTrailingGlob(target, opCwd);
      const bound = matches !== null ? globBoundDir(target, opCwd) : targetBound(target, opCwd);
      // A glob that matches nothing removes nothing, but its bound still decides:
      // `<live>/dist/*` with no dist directory is bounded by `<live>/dist`, which
      // lies inside a live tree (R1).
      if (matches !== null && matches.length > 0) {
        // A holder whose cwd IS the glob's bound directory loses whatever the
        // glob matches there: removing a directory takes that session's work with
        // it, while plain files are only files (F-1). This is what separates
        // `rm -rf ./*` (blocks) from `rm -rf ./*.log` (allows) at a live root.
        const atBound = bound === null ? [] : holders.filter(holder => holder.path === bound);
        if (atBound.length > 0) {
          const directories = matches.filter(isDirectory);
          if (directories.length > 0) {
            return blockReason(
              describe(atBound),
              `${op.kind} would remove ${directories.length} director${directories.length === 1 ? 'y' : 'ies'} inside ${bound}, where a live process is working.`,
              warnings,
            );
          }
          return null;
        }
        for (const match of matches) {
          const reason = check(match, opCwd, op);
          if (reason !== null) return reason;
        }
        return null;
      }
      if (bound === null) {
        // A target with no bound can reach any tree: every holder inside a live
        // worktree counts, not only the caller's repository (F-2).
        if (globalLiveHolders.length === 0) return null;
        return blockReason(
          describe(globalLiveHolders),
          `The target ${JSON.stringify(target)} cannot be bounded statically: use a literal path, or stop the live holder first.`,
          warnings,
        );
      }
      // Any holder under the bound, or a live tree inside it, is at risk (R1).
      const found = atRisk(bound);
      if (found.length === 0) return null;
      return blockReason(describe(found), `The target ${JSON.stringify(target)} resolves inside or around ${bound}.`, warnings);
    }
    const resolved = isAbsolute(target) ? canonicalPath(target) : (opCwd ? canonicalPath(resolve(opCwd, target)) : null);
    if (!resolved) {
      if (globalLiveHolders.length === 0) return null;
      return blockReason([], `The target ${JSON.stringify(target)} is relative to a directory the guard could not resolve: use a literal path.`, warnings);
    }
    // Another holder inside the target blocks, even when the target is the
    // caller's own worktree: only an empty own worktree may be removed.
    const found = holdersInside(resolved);
    if (found.length > 0) return blockReason(describe(found), `${op.kind} would remove ${resolved}.`, warnings);
    // A path inside a live worktree is that session's working tree too: removing
    // a subtree destroys its work even though no holder sits exactly there.
    const insideLive = livePaths.filter(path => isInside(resolved, path));
    const nested = insideLive.flatMap(path => holdersInside(path));
    if (nested.length > 0) {
      return blockReason(describe(nested), `${op.kind} would remove ${resolved}, inside the live worktree ${insideLive.join(', ')}.`, warnings);
    }
    return null;
  };

  for (const op of operations) {
    const opCwd = op.cwd === undefined ? cwd : op.cwd;
    if (op.targets.length === 0) {
      if (globalLiveHolders.length === 0) continue;
      return blockReason(describe(globalLiveHolders), `${op.kind} has no statically known target: use a literal path.`, warnings);
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
