// agent-host-reporter.mjs — Claude Code hook → XTRM agent host
// (PRD xtrm-app §35.6, §35.8 item 4, §36.12 item 4; XTRM-569).
//
// One hook invocation is one short-lived producer connection: connect to the agent host
// socket, send session_identity (seq 0) plus the event frames for this hook, close.
// Claude sessions are presence-only producers (capabilities ["presence"]): no assistant
// text, no command channel. The host sets tool origin itself (classifyClaudeTool).
//
// XTRM-592: this is a module, not a hook process. dispatch.mjs imports it and calls
// reportToAgentHost() in the same Node process that runs the xt checks for the event
// (CORE-2339: one xt hook process per Claude event). The module therefore never calls
// process.exit, never touches stdout and never throws; the dispatcher owns the exit code.
//
// Hard rules (unchanged from XTRM-569/583): never print to stdout, never block a tool call,
// never change a check's exit code. No host socket → resolve at once.
//
// Budget (XTRM-583): BUDGET_MS counts from when the hook's own work starts, not from
// process start: Node boot is outside the hook's control and must not eat the delivery
// window. The promise resolves as soon as the frames are flushed to the kernel socket
// buffer (the host reads them after the process is gone); dispatch.mjs bounds the wait
// with BUDGET_MS, so the budget only binds when delivery stalls.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const PRODUCER = { name: 'xtrm-tools/agent-host-reporter', version: '1.0.0' };
/** Same overrides as the Pi xtrm-agent-host extension. */
const SOCKET_ENV = 'XTRM_AGENT_HOST_SOCKET';
const DISABLE_ENV = 'XTRM_AGENT_HOST';
const LAUNCH_ENV = 'XTRM_AGENT_LAUNCH';
const PANE_SESSION_OPTION = '@xtrm_agent_session_id';
/** Delivery budget from the start of hook work (not process start). */
export const BUDGET_MS = 300;
const EXEC_TIMEOUT_MS = 30;
const MAX_ARGS_CHARS = 4096;

/**
 * Send this hook event's frames to the agent host. Resolves (never rejects) once the frames
 * are flushed, the connection fails, or there is nothing to send. Callers bound the wait.
 */
export async function reportToAgentHost(input, env = process.env) {
  try {
    if (/^(0|off|false)$/i.test(env[DISABLE_ENV] ?? '')) return;
    const socketPath =
      env[SOCKET_ENV] ||
      (env.XDG_RUNTIME_DIR
        ? path.join(env.XDG_RUNTIME_DIR, 'xtrm', 'agent-host.sock')
        : path.join(os.homedir(), '.xtrm', 'run', 'agent-host.sock'));
    if (!existsSync(socketPath)) return;
    const sessionId = bounded(input?.session_id, 256);
    if (!sessionId) return;
    const events = eventsFor(input);
    if (events.length === 0) return;

    const now = Date.now();
    const frames = [await identity(input, sessionId, env), ...events].map(
      (payload, seq) => `${JSON.stringify({ schema: 'xtrm.agent-event.v1', seq, sessionId, at: now, payload })}\n`,
    );
    await new Promise((resolve) => {
      const socket = net.createConnection(socketPath);
      socket.on('error', resolve);
      socket.on('close', resolve);
      // Resolve once the frames are flushed to the socket: waiting for 'close' would make
      // the hook wait on the host's scheduling, which is what a loaded machine delays.
      socket.on('connect', () => socket.end(frames.join(''), resolve));
    });
  } catch {
    /* presence is best effort: never affects the hook's outcome */
  }
}

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
async function identity(hook, sessionId, env) {
  const cwd = bounded(hook.cwd, 4096) ?? bounded(env.CLAUDE_PROJECT_DIR, 4096) ?? '/';
  const pane = env.TMUX && /^%[0-9]+$/.test(env.TMUX_PANE ?? '') ? env.TMUX_PANE : null;
  let tmuxSession;
  let role = bounded(env.XTMUX_AGENT_ROLE);
  let bead = bounded(env.XTMUX_AGENT_BEAD);
  let parentTmux;
  let worktree;
  let branch;
  if (pane) {
    const out = await run('tmux', [
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
    const panes = await run('tmux', ['list-panes', '-s', '-t', parentTmux, '-F', `#{${PANE_SESSION_OPTION}}`]);
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

/** Async so the tmux lookups overlap the dispatcher's checks instead of blocking them. */
function run(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) =>
        resolve(error ? undefined : stdout),
      );
    } catch {
      resolve(undefined);
    }
  });
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
