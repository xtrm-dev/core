#!/usr/bin/env node
// worktree-liveness.mjs — shared liveness check for the Claude PreToolUse guard
// and worktree-guard.mjs (CORE-2814).
//
// A worktree is live when a process's cwd is inside it, or when a tmux pane on
// any reachable server reports pane_current_path or @agent_worktree inside it.
// This is the plain-ESM twin of cli/src/core/worktree-liveness.ts: the hook
// ships beside cli/dist, not cli/src, so it cannot import the TypeScript module.
// cli/src/tests/worktree-liveness.test.ts keeps the two implementations in
// agreement on one fixture.
//
// Failure policy: an unreadable /proc entry counts as not live; a tmux query
// failure is reported in warnings and does not by itself make a worktree live.
// The check never throws.

import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const PANE_FORMAT = ['#{pane_id}', '#{pane_pid}', '#{pane_current_command}', '#{pane_current_path}', '#{@agent_worktree}'].join('\t');

function isInside(child, parent) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** Map every readable process cwd on this host. Unreadable entries are skipped. */
export function readProcessCwds(procRoot = '/proc') {
  const cwds = new Map();
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return cwds;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let target;
    try {
      target = readlinkSync(join(procRoot, entry, 'cwd'));
    } catch {
      continue;
    }
    // The kernel renders a cwd whose directory was removed as "<path> (deleted)".
    if (target.endsWith(' (deleted)')) target = target.slice(0, -' (deleted)'.length);
    const existing = cwds.get(target);
    if (existing) existing.push(pid);
    else cwds.set(target, [pid]);
  }
  return cwds;
}

/** The kernel-real path, so comparisons use what /proc reports. */
export function canonicalPath(target) {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

export function readProcessCommand(pid, procRoot = '/proc') {
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8');
    const command = raw.replace(/\0/g, ' ').trim();
    if (command) return command.slice(0, 160);
  } catch {
    // fall through
  }
  try {
    return readFileSync(join(procRoot, String(pid), 'comm'), 'utf8').trim().slice(0, 160);
  } catch {
    return '(unknown)';
  }
}

export function discoverTmuxSockets(env = process.env, uid = typeof process.getuid === 'function' ? process.getuid() : 0) {
    const base = env.TMUX_TMPDIR && env.TMUX_TMPDIR.length > 0 ? env.TMUX_TMPDIR : '/tmp';
    const isSocket = (candidate) => {
        try {
            return lstatSync(candidate).isSocket();
        } catch {
            return false;
        }
    };

    // The cheap, bounded set first: the caller's own server and this uid's
    // default server. Scanning every socket in the tmp dir means one tmux spawn
    // per stale test socket (~150 on this host) for no liveness gain, because a
    // stale socket cannot host a pane.
    const preferred = [];
    const tmuxEnv = env.TMUX?.split(',')[0];
    if (tmuxEnv) preferred.push(tmuxEnv);
    const defaultSocket = join(base, `tmux-${uid}`, 'default');
    if (isSocket(defaultSocket)) preferred.push(defaultSocket);

    const existing = preferred.filter(isSocket);
    if (existing.length > 0) return [...new Set(existing)];

    // No live server in the bounded set: fall back to discovery for a private
    // socket, capped so a directory full of dead probes cannot dominate a call.
    const sockets = [];
    const addSocketEntries = (dir) => {
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            if (sockets.length >= 20) return;
            const full = join(dir, name);
            if (isSocket(full)) sockets.push(full);
        }
    };
    addSocketEntries(base);
    addSocketEntries(join(base, `tmux-${uid}`));

    return [...new Set(sockets)];
}

export function readTmuxPanes(options = {}) {
  if (options.panes) return { panes: options.panes, warnings: [] };
  if (options.skipTmux) return { panes: [], warnings: [] };

  const sockets = options.tmuxSockets ?? discoverTmuxSockets(options.env ?? process.env, options.uid);
  const panes = [];
  const warnings = [];

  for (const socket of sockets) {
    const result = spawnSync('tmux', ['-S', socket, 'list-panes', '-a', '-F', PANE_FORMAT], {
      encoding: 'utf8',
      timeout: options.commandTimeoutMs ?? 1500,
      env: { ...(options.env ?? process.env), TMUX: '' },
    });
    if (result.error || result.status !== 0) {
      const detail = (result.error && result.error.message)
        || (result.stderr || '').trim()
        || `exit ${result.status ?? 'unknown'}`;
      warnings.push(`tmux list-panes on ${socket} failed: ${String(detail).split('\n')[0]}`);
      continue;
    }
    for (const line of (result.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      const [paneId = '', panePid = '', paneCommand = '', panePath = '', agentWorktree = ''] = line.split('\t');
      panes.push({
        paneId,
        panePid: Number.parseInt(panePid, 10) || 0,
        paneCommand,
        panePath,
        agentWorktree,
        socket,
      });
    }
  }

  return { panes, warnings };
}

/**
 * Find the processes and panes that live inside `worktreePath`.
 *
 * It answers "does another process use this tree". It is not an identity authority:
 * whether a pane owns a tree stays with `readAgentIdentity` in
 * `worktree-release-pane.ts`. `exemptPids` names the holders whose presence is
 * legitimate — `xt worktree release` runs while its pane's agent and its own ancestry
 * sit inside — and only the remaining holders make the tree live.
 */
export function worktreeInUse(worktreePath, options = {}) {
  // /proc/<pid>/cwd is kernel-real; a repo root reached through a symlink would
  // otherwise never match a holder.
  const path = canonicalPath(worktreePath);
  const cwds = options.cwds ?? readProcessCwds(options.procRoot ?? '/proc');
  const readCommand = options.readCommand ?? ((pid) => readProcessCommand(pid, options.procRoot ?? '/proc'));
  const { panes, warnings } = readTmuxPanes(options);

  const holders = [];
  const seen = new Set();

  for (const [cwd, pids] of cwds) {
    if (!isInside(cwd, path)) continue;
    for (const pid of pids) {
      const key = `process:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      holders.push({ kind: 'process', pid, command: readCommand(pid), path: cwd });
    }
  }

  for (const pane of panes) {
    const panePath = pane.panePath && isInside(resolve(pane.panePath), path) ? pane.panePath : '';
    const agentPath = pane.agentWorktree && isInside(resolve(pane.agentWorktree), path) ? pane.agentWorktree : '';
    if (!panePath && !agentPath) continue;
    const key = `pane:${pane.socket}:${pane.paneId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    holders.push({
      kind: 'pane',
      pid: pane.panePid,
      command: pane.paneCommand || 'tmux',
      pane: pane.paneId,
      path: panePath || agentPath,
      socket: pane.socket,
    });
  }

  const exempt = options.exemptPids ? new Set(options.exemptPids) : null;
  const blocking = exempt && exempt.size > 0 ? holders.filter((holder) => !exempt.has(holder.pid)) : holders;
  blocking.sort((a, b) => a.pid - b.pid || a.kind.localeCompare(b.kind));
  return { path, live: blocking.length > 0, holders: blocking, warnings };
}

export function formatWorktreeHolders(holders) {
  return holders.map((holder) => holder.kind === 'pane'
    ? `tmux pane ${holder.pane ?? '(unknown)'} (pid ${holder.pid}, ${holder.command}) at ${holder.path}`
    : `pid ${holder.pid} (${holder.command}) cwd ${holder.path}`);
}

export function callerProcessIds(start = process.pid, procRoot = '/proc') {
  const ids = new Set();
  let pid = start;
  for (let depth = 0; depth < 64 && pid > 0; depth += 1) {
    if (ids.has(pid)) break;
    ids.add(pid);
    let stat;
    try {
      stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    } catch {
      break;
    }
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim();
    const ppid = Number.parseInt(tail.split(/\s+/)[1] ?? '', 10);
    if (!Number.isFinite(ppid) || ppid <= 0) break;
    pid = ppid;
  }
  return ids;
}

export function createLivenessProbe(options = {}) {
  const cwds = options.cwds ?? readProcessCwds(options.procRoot ?? '/proc');
  const { panes, warnings } = readTmuxPanes(options);
  return (path) => {
    const answer = worktreeInUse(path, { ...options, cwds, panes, skipTmux: true });
    return warnings.length > 0 ? { ...answer, warnings: [...warnings, ...answer.warnings] } : answer;
  };
}
