/**
 * XTRM agent host bridge (PRD xtrm-app §35.3, §35.8 items 1 and 5; XTRM-564).
 *
 * Runs inside every Pi session, however it was started, and:
 * - pushes the Pi lifecycle events as xtrm.agent-event.v1 NDJSON frames to the local agent host
 *   socket ($XDG_RUNTIME_DIR/xtrm/agent-host.sock, else ~/.xtrm/run/agent-host.sock);
 * - sends session_identity first on every connection (§11 identity from the xt pi launch context);
 * - executes xtrm.agent-command.v1 frames (prompt, steer, follow_up, abort, extension_ui_response)
 *   and answers each with a command_result;
 * - proxies ctx.ui select / confirm / input so the host can answer them while the terminal dialog
 *   stays open; whichever answer arrives first wins, and extension_ui_resolved reports the end of
 *   every request so the host leaves waiting_for_input. ctx.ui.editor is not proxied: Pi 1.0.0
 *   gives editor() no AbortSignal, so a host answer could not dismiss the terminal editor.
 *
 * It never blocks or slows the turn loop: handlers are synchronous, socket writes are fire-and-forget,
 * streaming updates are coalesced, and a slow host loses update frames instead of stalling Pi. With no
 * host the handlers return after one state check and nothing is printed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type {
  AgentCapability,
  AgentCommandPayload,
  AgentEventPayload,
  AgentImageContent,
  AgentSessionIdentity,
  AgentToolSource,
} from "@xtrm/contracts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };

export const PRODUCER_NAME = "@jaggerxtrm/pi-extensions/xtrm-agent-host";
/** Overrides the socket path (tests, alternate hosts). */
export const SOCKET_ENV = "XTRM_AGENT_HOST_SOCKET";
/** "0" / "off" / "false" disables the bridge. */
export const DISABLE_ENV = "XTRM_AGENT_HOST";
/** Set to "gui" by a GUI launcher; anything else reports a terminal launch. */
export const LAUNCH_ENV = "XTRM_AGENT_LAUNCH";
/** Pane option this extension publishes so child sessions can resolve their parent session id. */
export const PANE_SESSION_OPTION = "@xtrm_agent_session_id";

const CAPABILITIES: AgentCapability[] = ["presence", "stream", "prompt", "steer", "follow_up", "abort", "extension_ui"];
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const UPDATE_COALESCE_MS = 50;
/** Above this socket backlog, coalesced update frames are dropped (the next update or *_end carries the state). */
const SOFT_BACKLOG_BYTES = 8 * 1024 * 1024;
/** Above this backlog the host is not reading: drop the connection and reconnect later. */
const HARD_BACKLOG_BYTES = 64 * 1024 * 1024;
/** Stay well below the host's 32 MiB line limit. */
const MAX_FRAME_CHARS = 16 * 1024 * 1024;
const MAX_CONNECT_QUEUE = 512;
const EXEC_TIMEOUT_MS = 1_500;
const GUI_INGRESS_WINDOW_MS = 10_000;

type Payload = AgentEventPayload;
type UiMethod = "select" | "confirm" | "input";
type UiResponse = Extract<AgentCommandPayload, { type: "extension_ui_response" }>;
type ExecFn = (file: string, args: string[]) => Promise<string>;

export interface AgentHostBridgeOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  exec?: ExecFn;
}

export function defaultAgentHostSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env[SOCKET_ENV]) return env[SOCKET_ENV] as string;
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, "xtrm", "agent-host.sock");
  return path.join(os.homedir(), ".xtrm", "run", "agent-host.sock");
}

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, encoding: "utf8" }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });

/** Schema boundedString: 1..1024 chars, no control characters. */
function bounded(value: unknown, max = 1024): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max);
  return clean.length > 0 ? clean : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

function images(value: unknown): AgentImageContent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((i) => i && i.type === "image" && typeof i.data === "string" && /^image\/[a-z0-9.+-]+$/.test(i.mimeType))
    .map((i) => ({ type: "image" as const, data: i.data as string, mimeType: i.mimeType as string }));
  return out.length > 0 ? out : undefined;
}

function toolSource(info: any): AgentToolSource | undefined {
  const s = info?.sourceInfo;
  const sourcePath = bounded(s?.path, 4096);
  const source = bounded(s?.source);
  if (!sourcePath || !source) return undefined;
  if (!["user", "project", "temporary"].includes(s.scope) || !["package", "top-level"].includes(s.origin)) return undefined;
  const result: AgentToolSource = {
    sourceInfo: compact({ path: sourcePath, source, scope: s.scope, origin: s.origin, baseDir: bounded(s.baseDir, 4096) }),
  };
  const name = bounded(info.namespace?.name);
  if (name) {
    result.namespace = compact({
      name,
      description: typeof info.namespace.description === "string" ? info.namespace.description.slice(0, 4096) : undefined,
    });
  }
  return result;
}

/** The assistant event's `partial` duplicates `message`; drop it to halve update frames. */
function assistantEvent(value: any): { type: string } {
  if (!value || typeof value !== "object" || typeof value.type !== "string") return { type: "unknown" };
  const { partial: _partial, ...rest } = value;
  return rest;
}

const OMITTED = (bytes: number) => ({ xtrmOmitted: "frame_too_large", bytes });

/** Replace the heavy opaque fields of an oversized payload with a marker. */
function shrink(payload: any, bytes: number): any {
  const out = { ...payload };
  for (const key of ["args", "partialResult", "result"]) if (key in out) out[key] = OMITTED(bytes);
  if (out.message) out.message = { role: out.message.role ?? "unknown", ...OMITTED(bytes) };
  if (Array.isArray(out.messages)) out.messages = [];
  if (Array.isArray(out.toolResults)) out.toolResults = [];
  if (out.images) delete out.images;
  if (typeof out.prompt === "string" && out.prompt.length > 1024 * 1024) out.prompt = out.prompt.slice(0, 1024 * 1024);
  return out;
}

interface UiAnswer {
  value: unknown;
  cancelled: boolean;
}

interface PendingUi {
  method: UiMethod;
  options?: string[];
  resolve: (answer: UiAnswer) => void;
}

export function createAgentHostBridge(pi: ExtensionAPI, options: AgentHostBridgeOptions = {}) {
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const socketPath = options.socketPath ?? defaultAgentHostSocketPath(env);
  const disabled = ["0", "off", "false"].includes(String(env[DISABLE_ENV] ?? "").toLowerCase());

  /** connecting: frames queue; open: frames are written; down: frames are dropped; closed: disposed. */
  let state: "idle" | "connecting" | "open" | "down" | "closed" = "idle";
  let ctx: ExtensionContext | null = null;
  let sessionId: string | null = null;
  let identity: AgentSessionIdentity | null = null;
  let socket: net.Socket | null = null;
  let seq = 0;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let queue: string[] = [];
  /** Coalesced streaming updates, keyed by stream; insertion order is preserved. */
  const updates = new Map<string, { at: number; payload: Payload }>();
  const pendingUi = new Map<string, PendingUi>();
  const patchedUis = new Map<object, Record<string, unknown>>();
  let toolCache: Map<string, AgentToolSource | undefined> | null = null;
  let guiIngress: { commandId: string; message: string; at: number } | null = null;
  let readBuffer = "";

  const live = () => state === "connecting" || state === "open";

  // --- framing -----------------------------------------------------------------------------

  function frame(at: number, payloadJson: string): string {
    return `{"schema":"xtrm.agent-event.v1","seq":${seq++},"sessionId":${JSON.stringify(sessionId)},"at":${at},"payload":${payloadJson}}\n`;
  }

  function serialize(payload: Payload): string | null {
    try {
      const json = JSON.stringify(payload);
      if (json.length <= MAX_FRAME_CHARS) return json;
      return JSON.stringify(shrink(payload, json.length));
    } catch {
      return null;
    }
  }

  function write(line: string): void {
    if (!socket) return;
    if (socket.writableLength > HARD_BACKLOG_BYTES) {
      socket.destroy();
      return;
    }
    socket.write(line);
  }

  /** Emit one event in order: pending updates go first so the stream order is preserved. */
  function emit(payload: Payload, at = Date.now()): void {
    if (!live() || !sessionId) return;
    flushUpdates();
    const json = serialize(payload);
    if (json === null) return;
    if (state === "open") write(frame(at, json));
    else {
      queue.push(`${at}\u0000${json}`);
      if (queue.length > MAX_CONNECT_QUEUE) queue.shift();
    }
  }

  function emitUpdate(key: string, payload: Payload): void {
    if (!live() || !sessionId) return;
    if (!updates.has(key)) updates.set(key, { at: Date.now(), payload });
    else updates.get(key)!.payload = payload;
    if (!flushTimer) {
      flushTimer = setTimeout(flushUpdates, UPDATE_COALESCE_MS);
      flushTimer.unref?.();
    }
  }

  function flushUpdates(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (updates.size === 0) return;
    const pending = [...updates.values()];
    updates.clear();
    if (state !== "open" || !socket || socket.writableLength > SOFT_BACKLOG_BYTES) return;
    for (const { at, payload } of pending) {
      const json = serialize(payload);
      if (json !== null) write(frame(at, json));
    }
  }

  // --- connection --------------------------------------------------------------------------

  function connect(): void {
    if (state === "closed" || state === "open" || !sessionId || !ctx || socket) return;
    state = "connecting";
    const conn = net.createConnection(socketPath);
    socket = conn;
    conn.setEncoding("utf8");
    conn.on("connect", async () => {
      if (socket !== conn) return;
      conn.unref();
      // Identity costs tmux/git subprocesses: build it only once a host answers.
      if (!identity) {
        const id = sessionId!;
        const built = await buildIdentity(ctx!, id);
        if (socket !== conn || state === "closed" || sessionId !== id) return;
        identity = built;
      }
      state = "open";
      seq = 0;
      reconnectDelay = RECONNECT_MIN_MS;
      write(frame(Date.now(), JSON.stringify(identity)));
      const queued = queue;
      queue = [];
      for (const entry of queued) {
        const split = entry.indexOf("\u0000");
        write(frame(Number(entry.slice(0, split)), entry.slice(split + 1)));
      }
      flushUpdates();
    });
    conn.on("data", (chunk: string) => onData(chunk));
    // A missing or refused host is the normal no-host case: never print anything.
    conn.on("error", () => {});
    conn.on("close", () => {
      if (socket !== conn) return;
      socket = null;
      readBuffer = "";
      queue = [];
      updates.clear();
      pendingUi.clear();
      if (state === "closed") return;
      state = "down";
      scheduleReconnect();
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || state === "closed") return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectTimer.unref?.();
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function dispose(): void {
    state = "closed";
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (flushTimer) clearTimeout(flushTimer);
    reconnectTimer = flushTimer = null;
    socket?.end();
    socket = null;
    pendingUi.clear();
    for (const [ui, originals] of patchedUis) Object.assign(ui, originals);
    patchedUis.clear();
  }

  // --- identity ----------------------------------------------------------------------------

  async function buildIdentity(current: ExtensionContext, id: string): Promise<AgentSessionIdentity> {
    const pane = env.TMUX && /^%[0-9]+$/.test(env.TMUX_PANE ?? "") ? (env.TMUX_PANE as string) : null;
    const cwd = current.cwd;
    let tmuxSession: string | undefined;
    let role = bounded(env.XTMUX_AGENT_ROLE);
    let bead = bounded(env.XTMUX_AGENT_BEAD);
    let parentTmux: string | undefined;
    let worktree: string | undefined;
    let branch: string | undefined;

    const tmuxInfo = pane
      ? exec("tmux", [
          "display-message", "-p", "-t", pane,
          "#{session_name}\t#{@agent_role}\t#{@agent_bead}\t#{@agent_parent_session}\t#{@agent_worktree}\t#{@agent_branch}",
        ])
      : Promise.resolve("");
    const gitInfo = exec("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
    if (pane) void exec("tmux", ["set-option", "-p", "-t", pane, PANE_SESSION_OPTION, id]);

    const [tmuxOut, gitOut] = await Promise.all([tmuxInfo, gitInfo]);
    if (tmuxOut) {
      const [name, paneRole, paneBead, parent, paneWorktree, paneBranch] = tmuxOut.replace(/\n$/, "").split("\t");
      tmuxSession = bounded(name);
      role = bounded(paneRole) ?? role;
      bead = bounded(paneBead) ?? bead;
      parentTmux = bounded(parent);
      worktree = bounded(paneWorktree, 4096);
      branch = bounded(paneBranch);
    }
    const [gitTop, gitBranch] = gitOut.split("\n");
    worktree ??= bounded(gitTop, 4096);
    if (gitBranch && gitBranch !== "HEAD") branch ??= bounded(gitBranch);

    // @agent_parent_session holds the parent's tmux session id; the parent's bridge publishes
    // its Pi session id on its pane, which turns that into a session id the host can join on.
    let parentSessionId: string | undefined;
    if (parentTmux) {
      const panes = await exec("tmux", ["list-panes", "-s", "-t", parentTmux, "-F", `#{${PANE_SESSION_OPTION}}`]);
      parentSessionId = bounded(panes.split("\n").find((line) => line.trim().length > 0), 256);
    }

    let sessionFile: string | undefined;
    try {
      sessionFile = bounded(current.sessionManager.getSessionFile(), 4096);
    } catch {
      sessionFile = undefined;
    }

    return compact({
      type: "session_identity" as const,
      runtime: { name: "pi" as const, version: typeof VERSION === "string" ? VERSION.slice(0, 128) : null },
      producer: { name: PRODUCER_NAME, version: String(pkg.version) },
      sessionFile,
      sessionName: bounded(pi.getSessionName()) ?? bounded(env.XTRM_SESSION_NAME) ?? tmuxSession,
      cwd: bounded(cwd, 4096) ?? "/",
      worktree,
      branch,
      role,
      workItem: bead ? compact({ ref: bead, system: /^[A-Z][A-Z0-9]*-[0-9]+$/.test(bead) ? ("substrate" as const) : undefined }) : undefined,
      parentSessionId,
      tmux: pane && tmuxSession ? { session: tmuxSession, paneId: pane } : undefined,
      launch: env[LAUNCH_ENV] === "gui" ? ("gui" as const) : ("terminal" as const),
      capabilities: CAPABILITIES,
    });
  }

  // --- tools ------------------------------------------------------------------------------

  function lookupTool(name: string): AgentToolSource | undefined {
    if (toolCache?.has(name)) return toolCache.get(name);
    toolCache = new Map();
    try {
      for (const info of pi.getAllTools()) if (!toolCache.has(info.name)) toolCache.set(info.name, toolSource(info));
    } catch {
      /* tool registry unavailable */
    }
    if (!toolCache.has(name)) toolCache.set(name, undefined);
    return toolCache.get(name);
  }

  function toolPayload(type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end", event: any): Payload {
    const base = {
      type,
      toolCallId: String(event.toolCallId).slice(0, 512),
      toolName: bounded(event.toolName) ?? "unknown",
      parentToolCallId: typeof event.parentToolCallId === "string" && event.parentToolCallId ? event.parentToolCallId.slice(0, 512) : undefined,
      tool: lookupTool(event.toolName),
    };
    if (type === "tool_execution_start") return compact({ ...base, args: event.args ?? null }) as Payload;
    if (type === "tool_execution_update") return compact({ ...base, args: event.args ?? null, partialResult: event.partialResult ?? null }) as Payload;
    return compact({ ...base, result: event.result ?? null, isError: Boolean(event.isError) }) as Payload;
  }

  // --- ctx.ui proxy ------------------------------------------------------------------------

  /** Ask the host and the local dialog at once; the first answer wins and dismisses the other. */
  async function race<T>(
    method: UiMethod,
    request: { title: string; message?: string; options?: string[]; placeholder?: string; timeout?: number },
    opts: { signal?: AbortSignal; timeout?: number } | undefined,
    local: (opts: { signal?: AbortSignal; timeout?: number } | undefined) => Promise<T>,
  ): Promise<T> {
    if (state !== "open" || !ctx?.hasUI) return local(opts);
    const id = randomUUID();
    const controller = new AbortController();
    const signal = opts?.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const hostAnswer = new Promise<UiAnswer>((resolve) => pendingUi.set(id, { method, options: request.options, resolve }));
    emit(
      compact({
        type: "extension_ui_request" as const,
        id,
        method,
        title: request.title.slice(0, 1024),
        message: request.message?.slice(0, 16384),
        options: request.options?.map((o) => String(o).slice(0, 1024)),
        placeholder: request.placeholder?.slice(0, 1024),
        timeout: typeof request.timeout === "number" && request.timeout >= 0 ? Math.floor(request.timeout) : undefined,
      }),
    );
    // A throwing local dialog leaves these defaults: the request still ends, as cancelled.
    let resolvedBy: "local" | "host" = "local";
    let outcome: "answered" | "cancelled" = "cancelled";
    try {
      const localAnswer = local({ ...opts, signal });
      const winner = await Promise.race([
        localAnswer.then((value) => ({ from: "local" as const, value, cancelled: localCancelled(value, opts?.signal) })),
        hostAnswer.then((answer) => ({ from: "host" as const, value: answer.value as T, cancelled: answer.cancelled })),
      ]);
      if (winner.from === "host") {
        controller.abort();
        localAnswer.catch(() => {});
      }
      resolvedBy = winner.from;
      outcome = winner.cancelled ? "cancelled" : "answered";
      return winner.value;
    } finally {
      pendingUi.delete(id);
      emit({ type: "extension_ui_resolved", id, resolvedBy, outcome });
    }
  }

  /**
   * Pi's dialogs return undefined (select, input) when dismissed or timed out. confirm() returns false for both
   * "No" and a dismissal, so only an aborted caller signal marks a local confirm cancelled.
   */
  function localCancelled(value: unknown, callerSignal: AbortSignal | undefined): boolean {
    return value === undefined || callerSignal?.aborted === true;
  }

  function patchUi(current: ExtensionContext): void {
    const ui = current.ui as any;
    if (!ui || patchedUis.has(ui)) return;
    const original = { select: ui.select, confirm: ui.confirm, input: ui.input };
    if (typeof original.select !== "function" || typeof original.confirm !== "function" || typeof original.input !== "function") return;
    patchedUis.set(ui, original);
    ui.select = (title: string, choices: string[], opts?: any) =>
      race("select", { title, options: choices, timeout: opts?.timeout }, opts, (o) => original.select.call(ui, title, choices, o));
    ui.confirm = (title: string, message: string, opts?: any) =>
      race("confirm", { title, message, timeout: opts?.timeout }, opts, (o) => original.confirm.call(ui, title, message, o));
    ui.input = (title: string, placeholder?: string, opts?: any) =>
      race("input", { title, placeholder, timeout: opts?.timeout }, opts, (o) => original.input.call(ui, title, placeholder, o));
  }

  /** Map an RpcExtensionUIResponse onto the ctx.ui return value; null means the answer does not fit. */
  function uiValue(entry: PendingUi, response: UiResponse): UiAnswer | null {
    const r = response as { value?: unknown; confirmed?: unknown; cancelled?: unknown };
    if (r.cancelled === true) return { value: entry.method === "confirm" ? false : undefined, cancelled: true };
    if (entry.method === "confirm") return typeof r.confirmed === "boolean" ? { value: r.confirmed, cancelled: false } : null;
    if (typeof r.value !== "string") return null;
    if (entry.method === "select" && !entry.options?.includes(r.value)) return null;
    return { value: r.value, cancelled: false };
  }

  // --- commands -----------------------------------------------------------------------------

  function onData(chunk: string): void {
    readBuffer += chunk;
    let newline = readBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = readBuffer.slice(0, newline);
      readBuffer = readBuffer.slice(newline + 1);
      if (line.trim()) handleCommandLine(line);
      newline = readBuffer.indexOf("\n");
    }
    if (readBuffer.length > MAX_FRAME_CHARS) readBuffer = "";
  }

  function handleCommandLine(line: string): void {
    let frameIn: any;
    try {
      frameIn = JSON.parse(line);
    } catch {
      return;
    }
    const command = frameIn?.payload;
    if (frameIn?.schema !== "xtrm.agent-command.v1" || typeof command?.commandId !== "string") return;
    const result = (status: "accepted" | "rejected" | "failed", reason?: string, message?: string) =>
      emit(compact({ type: "command_result" as const, commandId: command.commandId, status, reason, message: message?.slice(0, 1024) }));
    if (frameIn.sessionId !== sessionId) return result("rejected", "session_mismatch", `this producer serves ${sessionId}`);
    try {
      executeCommand(command as AgentCommandPayload, result);
    } catch (error) {
      result("failed", "command_error", error instanceof Error ? error.message : String(error));
    }
  }

  function executeCommand(
    command: AgentCommandPayload,
    result: (status: "accepted" | "rejected" | "failed", reason?: string, message?: string) => void,
  ): void {
    if (command.type === "extension_ui_response") {
      const entry = pendingUi.get(command.id);
      if (!entry) return result("rejected", "unknown_ui_request", `no pending extension UI request ${command.id}`);
      const mapped = uiValue(entry, command);
      if (!mapped) return result("rejected", "invalid_ui_response", `the answer does not fit a ${entry.method} prompt`);
      pendingUi.delete(command.id);
      entry.resolve(mapped);
      return result("accepted");
    }
    if (!ctx) return result("failed", "no_session_context", "the session is not ready");
    if (command.type === "abort") {
      ctx.abort();
      return result("accepted");
    }
    if (command.type !== "prompt" && command.type !== "steer" && command.type !== "follow_up") {
      return result("rejected", "unsupported_command", `unsupported command ${(command as { type?: unknown }).type}`);
    }
    if (typeof command.message !== "string" || command.message.length === 0) return result("rejected", "invalid_command", "message is empty");
    const idle = ctx.isIdle();
    // §35.8 item 5: a normal submit never queues behind running work.
    if (command.type === "prompt" && !idle) return result("rejected", "busy", "the session is working; use steer or follow_up");
    const attached = images(command.images);
    const content = attached ? [{ type: "text" as const, text: command.message }, ...attached] : command.message;
    // An idle session starts a new Frame from this message; mark it as GUI ingress.
    if (idle) guiIngress = { commandId: command.commandId, message: command.message, at: Date.now() };
    if (command.type === "prompt") pi.sendUserMessage(content);
    else pi.sendUserMessage(content, { deliverAs: command.type === "steer" ? "steer" : "followUp" });
    result("accepted");
  }

  function ingressFor(prompt: string): { origin: "gui" | "terminal"; commandId?: string } {
    const pending = guiIngress;
    guiIngress = null;
    if (pending && (pending.message === prompt || Date.now() - pending.at < GUI_INGRESS_WINDOW_MS)) {
      return { origin: "gui", commandId: pending.commandId.slice(0, 1024) };
    }
    return { origin: "terminal" };
  }

  // --- Pi events ----------------------------------------------------------------------------

  function track(current: ExtensionContext | undefined): void {
    if (!current) return;
    ctx = current;
    patchUi(current);
  }

  function register(): void {
    if (disabled) return;

    pi.on("session_start", (event, current) => {
      if (state === "closed") return;
      let id: string | undefined;
      try {
        id = bounded(current.sessionManager.getSessionId(), 256);
      } catch {
        id = undefined;
      }
      if (!id) return;
      sessionId = id;
      track(current);
      state = "connecting";
      emit(compact({ type: "session_start" as const, reason: event.reason, previousSessionFile: bounded(event.previousSessionFile, 4096) }));
      connect();
    });

    pi.on("session_info_changed", (_event, current) => {
      track(current);
      if (!identity) return;
      const name = bounded(pi.getSessionName());
      identity = compact({ ...identity, sessionName: name ?? identity.sessionName });
      emit(identity);
    });

    pi.on("before_agent_start", (event, current) => {
      track(current);
      if (!live()) {
        guiIngress = null;
        return;
      }
      emit(compact({ type: "before_agent_start" as const, prompt: event.prompt, images: images(event.images), ingress: ingressFor(event.prompt) }));
    });

    pi.on("agent_start", (_event, current) => {
      track(current);
      toolCache = null;
      emit({ type: "agent_start" });
    });

    pi.on("turn_start", (event, current) => {
      track(current);
      emit({ type: "turn_start", turnIndex: event.turnIndex, timestamp: Math.floor(event.timestamp) });
    });

    pi.on("message_start", (event) => {
      emit({ type: "message_start", message: event.message as any });
    });

    pi.on("message_update", (event) => {
      if (!live()) return;
      emitUpdate("message", { type: "message_update", message: event.message as any, assistantMessageEvent: assistantEvent(event.assistantMessageEvent) });
    });

    pi.on("message_end", (event) => {
      emit({ type: "message_end", message: event.message as any });
    });

    pi.on("tool_execution_start", (event) => {
      if (!live()) return;
      emit(toolPayload("tool_execution_start", event));
    });

    pi.on("tool_execution_update", (event) => {
      if (!live()) return;
      emitUpdate(`tool:${event.toolCallId}`, toolPayload("tool_execution_update", event));
    });

    pi.on("tool_execution_end", (event) => {
      if (!live()) return;
      updates.delete(`tool:${event.toolCallId}`);
      emit(toolPayload("tool_execution_end", event));
    });

    pi.on("turn_end", (event) => {
      if (!live()) return;
      emit(
        compact({
          type: "turn_end" as const,
          turnIndex: event.turnIndex,
          message: event.message as any,
          toolResults: (event.toolResults ?? []) as any[],
          messageEntryId: typeof (event as any).messageEntryId === "string" ? (event as any).messageEntryId.slice(0, 256) : undefined,
          toolResultEntryIds: Array.isArray((event as any).toolResultEntryIds) ? (event as any).toolResultEntryIds.map((e: unknown) => String(e).slice(0, 256)) : undefined,
        }),
      );
    });

    // Pi extensions never see willRetry on agent_end; only agent_settled closes a Frame.
    pi.on("agent_end", (event) => {
      if (!live()) return;
      emit({ type: "agent_end", messages: (event.messages ?? []) as any[] });
    });

    pi.on("agent_settled", (_event, current) => {
      track(current);
      emit({ type: "agent_settled" });
    });

    pi.on("session_compact", (event) => {
      if (!live()) return;
      emit(
        compact({
          type: "session_compact" as const,
          reason: event.reason,
          willRetry: Boolean(event.willRetry),
          fromExtension: Boolean(event.fromExtension),
          compactionEntryId: typeof event.compactionEntry?.id === "string" ? event.compactionEntry.id.slice(0, 256) : undefined,
        }),
      );
    });

    pi.on("session_compact_failed", (event) => {
      if (!live()) return;
      emit(
        compact({
          type: "session_compact_failed" as const,
          reason: event.reason,
          willRetry: Boolean(event.willRetry),
          aborted: Boolean(event.aborted),
          fromExtension: Boolean(event.fromExtension),
          errorMessage: typeof event.errorMessage === "string" ? event.errorMessage.slice(0, 4096) : undefined,
        }),
      );
    });

    // The extension runtime is torn down after this event; a replacement session gets a fresh bridge.
    pi.on("session_shutdown", (event) => {
      emit(compact({ type: "session_shutdown" as const, reason: event.reason, targetSessionFile: bounded(event.targetSessionFile, 4096) }));
      flushUpdates();
      dispose();
    });
  }

  return {
    register,
    dispose,
    /** Test seam: current connection state. */
    get state() {
      return state;
    },
  };
}

export default function xtrmAgentHostExtension(pi: ExtensionAPI): void {
  createAgentHostBridge(pi).register();
}
