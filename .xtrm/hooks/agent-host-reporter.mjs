#!/usr/bin/env node
// agent-host-reporter.mjs — Claude Code hook → XTRM agent host
// (PRD xtrm-app §35.6, §35.8 item 4, §36.12 item 4; XTRM-569).
//
// One hook invocation is one short-lived producer connection: connect to the agent host
// socket, send session_identity (seq 0) plus the event frames for this hook, close.
// Claude sessions are presence-only producers (capabilities ["presence"]): no assistant
// text, no command channel. The host sets tool origin itself (classifyClaudeTool).
//
// Hard rules: exit 0 always, print nothing to stdout, never block a tool call, finish
// within the time budget whether or not the host runs. No host socket → exit at once.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const PRODUCER = { name: 'xtrm-tools/agent-host-reporter', version: '1.0.0' };
/** Same overrides as the Pi xtrm-agent-host extension. */
const SOCKET_ENV = 'XTRM_AGENT_HOST_SOCKET';
const DISABLE_ENV = 'XTRM_AGENT_HOST';
const LAUNCH_ENV = 'XTRM_AGENT_LAUNCH';
const PANE_SESSION_OPTION = '@xtrm_agent_session_id';
/** Wall-clock budget from process start; the process exits 0 when it runs out. */
const BUDGET_MS = 80;
const EXEC_TIMEOUT_MS = 30;
const MAX_ARGS_CHARS = 4096;

const exit = () => process.exit(0);
setTimeout(exit, Math.max(1, BUDGET_MS - performance.now())).unref();
process.on('uncaughtException', exit);
process.stdout.write = () => true;

const env = process.env;
if (/^(0|off|false)$/i.test(env[DISABLE_ENV] ?? '')) exit();
const socketPath =
  env[SOCKET_ENV] ||
  (env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, 'xtrm', 'agent-host.sock')
    : path.join(os.homedir(), '.xtrm', 'run', 'agent-host.sock'));
if (!existsSync(socketPath)) exit();

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  exit();
}
const sessionId = bounded(input?.session_id, 256);
if (!sessionId) exit();

const events = eventsFor(input);
if (events.length === 0) exit();
const now = Date.now();
const frames = [identity(input), ...events].map(
  (payload, seq) => `${JSON.stringify({ schema: 'xtrm.agent-event.v1', seq, sessionId, at: now, payload })}\n`,
);

const socket = net.createConnection(socketPath);
socket.on('error', exit);
socket.on('close', exit);
socket.on('connect', () => socket.end(frames.join('')));

// --- mapping -------------------------------------------------------------------------------

/** PRD §35.8 item 4: the v0 hook set, mapped onto xtrm.agent-event.v1 payloads. */
function eventsFor(hook) {
  switch (hook.hook_event_name) {
    case 'SessionStart': {
      const reason = { startup: 'startup', resume: 'resume', clear: 'new' }[hook.source];
      return reason ? [{ type: 'session_start', reason }] : [];
    }
    case 'UserPromptSubmit':
      return [{ type: 'agent_start' }];
    case 'PreToolUse':
    case 'PostToolUse': {
      const toolCallId = bounded(hook.tool_use_id, 512);
      const toolName = bounded(hook.tool_name);
      if (!toolCallId || !toolName) return [];
      return hook.hook_event_name === 'PreToolUse'
        ? [{ type: 'tool_execution_start', toolCallId, toolName, args: boundedArgs(hook.tool_input) }]
        : [{ type: 'tool_execution_end', toolCallId, toolName, result: null, isError: hook.tool_response?.is_error === true }];
    }
    case 'Notification': {
      const kind = typeof hook.notification_type === 'string' ? hook.notification_type.toLowerCase() : '';
      return [
        compact({
          type: 'notification',
          kind: /^[a-z][a-z0-9_]{0,63}$/.test(kind) ? kind : 'unknown',
          title: bounded(hook.title),
          message: bounded(hook.message),
        }),
      ];
    }
    case 'Stop':
      return [{ type: 'agent_end', messages: [] }, { type: 'agent_settled' }];
    case 'SubagentStop':
      return [compact({ type: 'subagent_end', agentId: bounded(hook.agent_id), agentType: bounded(hook.agent_type) })];
    case 'SessionEnd': {
      const reason = { clear: 'new', resume: 'resume' }[hook.reason] ?? 'quit';
      return [{ type: 'session_shutdown', reason }];
    }
    default:
      return [];
  }
}

/** The §11 identity, with the same fields the Pi extension reports. */
function identity(hook) {
  const cwd = bounded(hook.cwd, 4096) ?? bounded(env.CLAUDE_PROJECT_DIR, 4096) ?? '/';
  const pane = env.TMUX && /^%[0-9]+$/.test(env.TMUX_PANE ?? '') ? env.TMUX_PANE : null;
  let tmuxSession;
  let role = bounded(env.XTMUX_AGENT_ROLE);
  let bead = bounded(env.XTMUX_AGENT_BEAD);
  let parentTmux;
  let worktree;
  let branch;
  if (pane) {
    const out = run('tmux', [
      'display-message', '-p', '-t', pane,
      '#{session_name}\t#{@agent_role}\t#{@agent_bead}\t#{@agent_parent_session}\t#{@agent_worktree}\t#{@agent_branch}',
    ]);
    if (out) {
      const [name, paneRole, paneBead, parent, paneWorktree, paneBranch] = out.replace(/\n$/, '').split('\t');
      tmuxSession = bounded(name);
      role = bounded(paneRole) ?? role;
      bead = bounded(paneBead) ?? bead;
      parentTmux = bounded(parent);
      worktree = bounded(paneWorktree, 4096);
      branch = bounded(paneBranch);
    }
    // Child sessions resolve their parent through this pane option (as the Pi extension does).
    // Fire and forget: the write does not need to finish inside the hook budget.
    if (hook.hook_event_name === 'SessionStart') detached('tmux', ['set-option', '-p', '-t', pane, PANE_SESSION_OPTION, sessionId]);
  }
  const git = gitInfo(cwd);
  worktree ??= bounded(git.top, 4096);
  branch ??= bounded(git.branch);
  let parentSessionId;
  if (parentTmux) {
    const panes = run('tmux', ['list-panes', '-s', '-t', parentTmux, '-F', `#{${PANE_SESSION_OPTION}}`]);
    parentSessionId = bounded(panes?.split('\n').find((line) => line.trim().length > 0), 256);
  }
  return compact({
    type: 'session_identity',
    runtime: { name: 'claude', version: null },
    producer: PRODUCER,
    sessionFile: bounded(hook.transcript_path, 4096),
    sessionName: bounded(env.XTRM_SESSION_NAME) ?? tmuxSession,
    cwd,
    worktree,
    branch,
    role,
    workItem: bead ? compact({ ref: bead, system: /^[A-Z][A-Z0-9]*-[0-9]+$/.test(bead) ? 'substrate' : undefined }) : undefined,
    parentSessionId,
    tmux: pane && tmuxSession ? { session: tmuxSession, paneId: pane } : undefined,
    launch: env[LAUNCH_ENV] === 'gui' ? 'gui' : 'terminal',
    capabilities: ['presence'],
  });
}

/** Repository top and branch from the filesystem: no git subprocess inside the hook budget. */
function gitInfo(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    try {
      let gitDir = dotGit;
      if (statSync(dotGit).isFile()) {
        const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
        if (!match) return {};
        gitDir = path.resolve(dir, match[1].trim());
      }
      const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8');
      const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
      return { top: dir, branch: ref ? ref[1].trim() : undefined };
    } catch {
      /* not here; keep walking */
    }
    if (path.dirname(dir) === dir) return {};
  }
}

// --- helpers -------------------------------------------------------------------------------

function run(file, args) {
  try {
    return execFileSync(file, args, { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

function detached(file, args) {
  try {
    spawn(file, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* best effort */
  }
}

/** Schema boundedString: 1..max chars, no control characters. */
function bounded(value, max = 1024) {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, max);
  return clean.length > 0 ? clean : undefined;
}

/** Tool input passes through opaque while small; larger inputs (file bodies) are dropped. */
function boundedArgs(value) {
  try {
    const text = JSON.stringify(value ?? {});
    return text.length <= MAX_ARGS_CHARS ? JSON.parse(text) : { truncated: true, chars: text.length };
  } catch {
    return {};
  }
}

function compact(value) {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}
