/**
 * Agent-host self-healing (CORE-2467 A+B).
 *
 * The bridge talks to the agent host over its unix socket
 * ($XDG_RUNTIME_DIR/xtrm/agent-host.sock, else ~/.xtrm/run/agent-host.sock).
 * Nothing on the machine auto-starts that daemon — historically only a
 * desktop-app-driven `xt host ensure` did — so after a reboot or crash every
 * Pi session silently lost its Pi leg (fetchPi reads as empty and every Pi
 * name falls through to its Claude-registry mirror entry).
 *
 * This module restores zero-ops: on session start it probes the socket fast
 * and, when nothing answers, runs one bounded background `xt host ensure`
 * (single-flight per process, never blocking the start). Success stays
 * silent; failure notifies the operator loudly with the runbook instead of
 * degrading silently. It never touches Claude transport state.
 *
 * Opt-in via AgentHostBridgeOptions.hostEnsure (the managed shim passes
 * true; the default is off so unit tests never spawn processes).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export interface HostEnsureOptions {
  /** Master switch. Default false: the managed shim opts in. */
  enabled?: boolean;
  /** Socket override (tests). Default resolves XDG_RUNTIME_DIR else ~/.xtrm. */
  socketPath?: string;
  /** Ensure command override (tests). Default ["xt", "host", "ensure"]. */
  xtCommand?: string[];
  /** Socket probe budget. Default 1500 ms. */
  probeTimeoutMs?: number;
  /** Ensure spawn budget. Default 20000 ms. */
  ensureTimeoutMs?: number;
  /** Spawn seam (tests). Default execFile. Resolves true on exit 0. */
  runEnsure?: (command: string[], timeoutMs: number) => Promise<{ ok: boolean; detail: string }>;
}

export interface HostEnsureEnv {
  /** Warning channel (bound ctx.ui.notify by the caller). Never throws. */
  notify: (line: string) => void;
  /** Debug log; default silent. */
  log?: (line: string) => void;
}

/**
 * The socket the running host announced in its info file (CORE-2554 E4), else the
 * path a host would bind: recomputing alone misses a host started with another
 * XDG_RUNTIME_DIR or socket override.
 */
export function announcedAgentHostSocket(home = os.homedir()): string | undefined {
  try {
    const info = JSON.parse(readFileSync(path.join(home, ".xtrm", "run", "agent-host.json"), "utf8")) as { socket?: unknown };
    return typeof info.socket === "string" && info.socket.startsWith("/") ? info.socket : undefined;
  } catch {
    return undefined;
  }
}

export function defaultAgentHostSocketPath(): string {
  const announced = announcedAgentHostSocket();
  if (announced) return announced;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, "xtrm", "agent-host.sock");
  return path.join(os.homedir(), ".xtrm", "run", "agent-host.sock");
}

/** Fast liveness probe: one connect, no traffic. Never throws. */
export function probeAgentHostSocket(sockPath: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (up: boolean) => {
      if (!done) {
        done = true;
        resolve(up);
      }
    };
    const timer = setTimeout(() => {
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      finish(false);
    }, timeoutMs);
    if (typeof (timer as unknown as { unref?: unknown }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    const conn = net.connect({ path: sockPath });
    conn.on("connect", () => {
      clearTimeout(timer);
      try {
        conn.destroy();
      } catch {
        /* already gone */
      }
      finish(true);
    });
    conn.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function defaultRunEnsure(command: string[], timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    // CORE-2554 E3: the host this may start serves every session; it must not inherit
    // this session's identity (SUBSTRATE_HOLDER, XTRM_*, tmux pane).
    execFile(command[0], command.slice(1), { timeout: timeoutMs, encoding: "utf8", env: ensureSpawnEnv(process.env) }, (error, stdout) => {
      if (!error) return resolve({ ok: true, detail: String(stdout ?? "").slice(0, 256) });
      const message = (error as Error)?.message ?? String(error);
      resolve({ ok: false, detail: message.slice(0, 256) });
    });
  });
}

const ENSURE_ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TZ|TMPDIR|LC_[A-Z_]+|XDG_[A-Z_]+|NODE_[A-Z_]+|XTRM_AGENT_HOST_[A-Z_]+|DBUS_SESSION_BUS_ADDRESS|NVM_[A-Z_]+|BUN_INSTALL)$/;

/** Process basics only; same allowlist as the CLI's hostSpawnEnv. */
export function ensureSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined && ENSURE_ENV_KEEP.test(key)) out[key] = value;
  return out;
}

const HOST_RUNBOOK = "run `xt host ensure` to restore Pi messaging";

function hostDownLine(detail: string): string {
  return (
    `Intercom: agent host is not running — Pi messaging is unavailable. ` +
    `Auto-start failed (${detail}); ${HOST_RUNBOOK}. ` +
    `Pi sessions currently resolve through their Claude entries with no delivery receipts.`
  );
}

// Process-wide ensure state: one flight at a time, silence while recently
// healthy, one loud warning per down episode.
//
// CORE-2554 E3: health no longer latches for the life of the process. It holds
// for HEALTHY_RECHECK_MS, and a lost bridge connection re-arms it at once
// (rearmAgentHostEnsure), so a host that dies after the first session start
// is restarted instead of staying down until the next Pi process.
export const HEALTHY_RECHECK_MS = 60_000;
let flight: Promise<boolean> | null = null;
let healthyUntil = 0;
let warned = false;

/** Test seam: drop all process-wide ensure state. */
export function __resetHostEnsureState(): void {
  flight = null;
  healthyUntil = 0;
  warned = false;
}

/** The host connection was lost: the next monitor call probes again. */
export function rearmAgentHostEnsure(): void {
  healthyUntil = 0;
}

async function runEnsureFlow(env: HostEnsureEnv, options: HostEnsureOptions): Promise<boolean> {
  const log = env.log ?? (() => {});
  const sockPath = options.socketPath ?? defaultAgentHostSocketPath();
  const probeTimeoutMs = options.probeTimeoutMs ?? 1500;
  const ensureTimeoutMs = options.ensureTimeoutMs ?? 20000;
  if (await probeAgentHostSocket(sockPath, probeTimeoutMs)) {
    healthyUntil = Date.now() + HEALTHY_RECHECK_MS;
    warned = false;
    return true;
  }
  log(`agent host socket ${sockPath} is not answering; running ensure`);
  const runEnsure = options.runEnsure ?? defaultRunEnsure;
  const command = options.xtCommand ?? ["xt", "host", "ensure"];
  let result: { ok: boolean; detail: string };
  try {
    result = await runEnsure(command, ensureTimeoutMs);
  } catch (error) {
    result = { ok: false, detail: (error as Error)?.message ?? String(error) };
  }
  if (result.ok && (await probeAgentHostSocket(sockPath, probeTimeoutMs))) {
    healthyUntil = Date.now() + HEALTHY_RECHECK_MS;
    warned = false;
    log("agent host ensure succeeded");
    return true;
  }
  const detail = result.ok ? "ensure ran but the socket still does not answer" : result.detail || "ensure failed";
  if (!warned) {
    warned = true;
    try {
      env.notify(hostDownLine(detail));
    } catch {
      /* notify must never break the start path */
    }
  }
  return false;
}

/**
 * Session-start entry point. Fire-and-forget: returns at once and never
 * rejects. No-op unless options.enabled, after the first healthy probe, or
 * while a flight is already running.
 */
export function monitorAgentHostSession(env: HostEnsureEnv, options: HostEnsureOptions = {}): void {
  if (!options.enabled || Date.now() < healthyUntil || flight) return;
  flight = runEnsureFlow(env, options).finally(() => {
    flight = null;
  });
  void flight.catch(() => {});
}
