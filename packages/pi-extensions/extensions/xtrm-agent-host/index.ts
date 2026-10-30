/**
 * XTRM agent host bridge (PRD xtrm-app §35.3, §35.8 items 1 and 5; XTRM-564).
 *
 * Runs inside every Pi session, however it was started, and:
 * - pushes the Pi lifecycle events as xtrm.agent-event.v1 NDJSON frames to the local agent host
 *   socket ($XDG_RUNTIME_DIR/xtrm/agent-host.sock, else ~/.xtrm/run/agent-host.sock);
 * - sends session_identity first on every connection (§11 identity from the xt pi launch context, with the
 *   repository owner/name from the git remote), then session_status (model, thinking level, context usage)
 *   and again whenever one of those changes;
 * - executes xtrm.agent-command.v1 frames (prompt, steer, follow_up, abort, extension_ui_response)
 *   and answers each with a command_result; the session counts as working from the moment a run is
 *   requested until agent_settled, including the Pi startup window before agent_start (see `startingAt`);
 * - proxies ctx.ui select / confirm / input so the host can answer them while the terminal dialog
 *   stays open; whichever answer arrives first wins, and extension_ui_resolved reports the end of
 *   every request so the host leaves waiting_for_input. ctx.ui.editor is not proxied: Pi 1.0.0
 *   gives editor() no AbortSignal, so a host answer could not dismiss the terminal editor.
 *
 * One listener per Pi session (CORE-2433 I2): the bridge keeps a binding per
 * session id, keyed (pid, sessionId, generation). An in-process child session
 * (native specialist) gets its own binding and can never replace its parent's
 * listener; the parent binding — socket, generation, deferred queues — is
 * untouched while the child runs. Inbound wakes inject with pi.sendMessage as
 * customType "intercom_message" (see ../intercom/delivery.ts) and are
 * acknowledged only after the injection succeeded; an injection failure
 * answers `failed` so the registry reports the wake `undelivered`.
 *
 * It never blocks or slows the turn loop: handlers are synchronous, socket writes are fire-and-forget,
 * streaming updates are coalesced, and a slow host loses update frames instead of stalling Pi. With no
 * host the handlers return after one state check; session start additionally runs the bounded
 * background self-heal (./host-ensure.ts, opt-in) which warns loudly once when the host stays down.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type {
  AgentCapability,
  AgentCommandPayload,
  AgentEventPayload,
  AgentImageContent,
  AgentSessionIdentity,
  AgentSessionStatus,
  AgentToolSource,
} from "@xtrm/contracts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { injectIntercomWake, wakeDeliveryOptions, WakeDedupe } from "../intercom/delivery.ts";
import type { WakeSender } from "../intercom/delivery.ts";
import { monitorAgentHostSession, type HostEnsureOptions } from "./host-ensure.ts";

/**
 * One successfully injected inbound wake (CORE-2436 I5). The intercom
 * extension registers a listener to resolve pending asks (replyTo) and to
 * arm idle-notice subscriptions (notifyWhenIdle); the bridge itself never
 * imports the intercom tool, so the layering stays one-directional.
 */
export interface InjectedWakeNotice extends WakeSender {
  messageId: string;
  ref: string;
  fromSessionId?: string;
  replyTo?: string;
  notifyWhenIdle?: boolean;
  /** The ExtensionAPI of the session the wake was injected into (CORE-2554 B7). */
  receiver?: unknown;
}

const wakeInjectedListeners = new Set<(notice: InjectedWakeNotice) => void>();

/** Register a listener for injected inbound wakes. Returns an unsubscribe function. */
export function onWakeInjected(listener: (notice: InjectedWakeNotice) => void): () => void {
  wakeInjectedListeners.add(listener);
  return () => {
    wakeInjectedListeners.delete(listener);
  };
}

function emitWakeInjected(notice: InjectedWakeNotice): void {
  for (const listener of [...wakeInjectedListeners]) {
    try {
      listener(notice);
    } catch {
      /* a faulty listener must never break delivery */
    }
  }
}
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
/** A requested run that has not reached agent_start this long after the request, while Pi is idle, never started. */
const STARTUP_STALE_MS = 60_000;
/**
 * First-turn grace (CORE-2436 I5 review): after session_start, wakes hold
 * only until the first agent_start or this long with no run starting.
 * Past the grace with no run, the session counts as an idle interactive
 * session and wakes inject with triggerTurn. Short enough to keep sends
 * snappy, long enough to cover the initial-turn loadout race.
 */
const FIRST_TURN_GRACE_MS = 1_500;
/**
 * Hard cap on the initial-prompt hold (CORE-2438 review): even with a
 * prompt pending, a wake falls back to the normal grace flush after this
 * long, so a session that never starts its first turn still receives it.
 */
const INITIAL_PROMPT_HOLD_CAP_MS = 30_000;

type Payload = AgentEventPayload;
type UiMethod = "select" | "confirm" | "input";
type UiResponse = Extract<AgentCommandPayload, { type: "extension_ui_response" }>;
type ExecFn = (file: string, args: string[]) => Promise<string>;

export interface AgentHostBridgeOptions {
  env?: NodeJS.ProcessEnv;
  socketPath?: string;
  exec?: ExecFn;
  /** First-turn grace in ms (tests); default FIRST_TURN_GRACE_MS. */
  firstTurnGraceMs?: number;
  /**
   * Hard cap on the initial-prompt hold in ms (tests); default
   * INITIAL_PROMPT_HOLD_CAP_MS. Past it the hold falls back to the normal
   * grace flush, so a mispredicted prompt never parks a wake forever.
   */
  initialPromptCapMs?: number;
  /**
   * The process was launched with an initial prompt pending (CORE-2438 I7).
   * Default: env XTRM_INITIAL_PROMPT=1/true, else argv sniffing
   * (`--print`/`-p` or a positional prompt). While set and no
   * before_agent_start has been seen, pre-first-turn wakes hold past the
   * grace instead of racing the initial turn.
   */
  initialPromptPending?: boolean;
  /** argv for initial-prompt sniffing (tests); default process.argv. */
  argv?: readonly string[];
  /**
   * Agent-host self-healing (CORE-2467 A+B). When true (or an options
   * object), session start probes the host socket fast and, when nothing
   * answers, runs one bounded background `xt host ensure` (single-flight,
   * never blocking the start); failure notifies loudly with the runbook.
   * Default false: the managed shim opts in, unit tests never spawn.
   */
  hostEnsure?: boolean | HostEnsureOptions;
}

/** Environment override for the initial-prompt hold (launchers, tests). */
export const INITIAL_PROMPT_ENV = "XTRM_INITIAL_PROMPT";

/**
 * Whether argv shows a pending initial prompt (CORE-2438 I7 review): an
 * explicit print run only (`--print`/`-p`, or a short-flag bundle
 * containing p). Positional prompts, @files and flag values are
 * deliberately NOT sniffed: `-e /abs/ext.ts`, `--session-dir /tmp/x` and
 * `--append-system-prompt "be nice"` must never read as a prompt, and a
 * missed prompt only keeps the old race while a false hold could park a
 * wake forever. Pi SDK 1.3.0 exposes no initial-message API
 * (SessionStartEvent carries reason/previousSessionFile only,
 * extensions/types.d.ts:575-581; ExtensionContext has no prompt field,
 * :215-252; ReadonlySessionManager lists history accessors only,
 * core/session-manager.d.ts:178), so launchers forward the signal via
 * XTRM_INITIAL_PROMPT (proposed; xt to ticket).
 */
export function argvHasInitialPrompt(argv: readonly string[] | undefined): boolean {
  if (!argv || argv.length === 0) return false;
  // Drop the executable; drop the script too when launched through a JS
  // runtime (node pi.js ...). A bare binary (pi ...) has argv = [pi, ...args].
  const runtime = /[/\\]?((node|bun|deno)(\.exe)?)$/.test(argv[0]);
  const args = argv.slice(runtime ? 2 : 1);
  return args.some((token) => {
    if (token === "--print" || token === "-p") return true;
    // Short-flag bundle containing p (e.g. -ap): treat like -p.
    if (/^-[^-]/.test(token) && token.includes("p")) return true;
    return false;
  });
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

const REPOSITORY_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * `owner/name` of a git remote URL (scp-like `git@host:owner/name.git`, or ssh/https/git URLs), without host,
 * scheme or credentials. Local paths and file:// remotes have no owner and return undefined.
 */
export function repositoryFromRemote(url: string): string | undefined {
  const remote = url.trim();
  let repoPath: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      const parsed = new URL(remote);
      if (parsed.protocol === "file:") return undefined;
      repoPath = decodeURIComponent(parsed.pathname);
    } catch {
      return undefined;
    }
  } else {
    // scp-like syntax: [user@]host:path. A colon after a slash means a local path.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(remote);
    if (!scp) return undefined;
    repoPath = scp[2];
  }
  const segments = repoPath.replace(/\/+$/, "").replace(/\.git$/, "").split("/").filter((part) => part.length > 0);
  if (segments.length < 2 || !segments.every((part) => REPOSITORY_SEGMENT.test(part) && part !== "." && part !== "..")) return undefined;
  const name = segments.join("/");
  return name.length <= 512 ? name : undefined;
}

/** Remote URL of `origin`, else of the first remote, from `git config --get-regexp` output. */
function remoteUrl(configOut: string): string | undefined {
  const remotes = configOut
    .split("\n")
    .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  return (remotes.find((match) => match[1] === "origin") ?? remotes[0])?.[2];
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

/**
 * One listener: all mutable state of a single Pi session's host binding.
 * A child session gets its own binding; it never touches its parent's.
 */
interface SessionBinding {
  sessionId: string;
  /** connecting: frames queue; open: frames are written; down: frames are dropped; closed: disposed. */
  state: "idle" | "connecting" | "open" | "down" | "closed";
  ctx: ExtensionContext | null;
  identity: AgentSessionIdentity | null;
  /** JSON of the last session_status sent on the current connection; null forces the next one out. */
  lastStatus: string | null;
  socket: net.Socket | null;
  seq: number;
  reconnectDelay: number;
  reconnectTimer: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  queue: string[];
  /** Coalesced streaming updates, keyed by stream; insertion order is preserved. */
  updates: Map<string, { at: number; payload: Payload }>;
  pendingUi: Map<string, PendingUi>;
  toolCache: Map<string, AgentToolSource | undefined> | null;
  guiIngress: { commandId: string; message: string; at: number } | null;
  /**
   * Set when a run is requested (an idle submit or before_agent_start) and cleared on agent_start. Pi 1.0.0 marks
   * the run active only after the before_agent_start handlers, image normalization and the tool loadout (6-8 s
   * observed), so ctx.isIdle() is true in that window; a message sent then starts a second run (XTRM-607).
   */
  startingAt: number | null;
  /** Steer, follow_up and abort received in the startup window; run on agent_start, when Pi can queue them. */
  deferred: Array<() => void>;
  /**
   * Wakes received while starting (F7): held, not delivered. Each is answered
   * accepted only when agent_start actually delivers it; a run that never
   * starts re-holds them so the registry keeps them instead of forgetting.
   */
  deferredWake: Array<{
    messageId: string;
    ref: string;
    sender: WakeSender & { fromSessionId?: string; replyTo?: string; notifyWhenIdle?: boolean };
    accept: () => void;
    hold: () => void;
    fail: (reason: string, message: string) => void;
  }>;
  /**
   * True once this binding saw agent_start (CORE-2436 I5 first-turn race).
   * Pi reports isIdle() === true until the first agent_start (tool loadout),
   * so a wake injected with triggerTurn before it starts a second run and
   * fails with "Agent is already processing". Wakes hold during the real
   * starting window only: a requested run (startingAt) or the short grace
   * after session_start. Past the grace with no run, the session counts as
   * idle and wakes inject. Reset on every session_start.
   */
  sawAgentStart: boolean;
  /**
   * True once this binding saw before_agent_start (CORE-2438 I7). The
   * initial-prompt hold lasts until the first turn observably begins;
   * reset on every session_start.
   */
  sawBeforeAgentStart: boolean;
  /**
   * The process launched with an initial prompt pending (CORE-2438 I7):
   * pre-first-turn wakes hold past the grace until before_agent_start
   * instead of racing the initial turn. Cleared on before_agent_start;
   * reset on every session_start.
   */
  initialPromptPending: boolean;
  /** session_start timestamp for the first-turn grace; null before the first start. */
  sessionStartedAt: number | null;
  /** Grace-expiry flush for held pre-first-turn wakes; cleared on agent_start/dispose. */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Hard-cap flush for the initial-prompt hold; cleared with the grace timer. */
  promptCapTimer: ReturnType<typeof setTimeout> | null;
  /** A replaced listener re-asserts once per connection; never ping-pongs a replacement (F1). */
  reassertedThisConnection: boolean;
  readBuffer: string;
  /**
   * Listener incarnation (CORE-2432 R1): the registry compares-and-swaps writes
   * on generation (R6). One per binding; bumped when the registry reports this
   * listener replaced so the re-assert wins (R5).
   */
  generation: number;
  /** Message ids already injected into this session (§5 double-delivery guard). */
  deliveredWakes: WakeDedupe;
  /** True between agent_start and agent_settled: owns ctx-less stream events (F6). */
  streaming: boolean;
}

export function createAgentHostBridge(pi: ExtensionAPI, options: AgentHostBridgeOptions = {}) {
  const firstTurnGraceMs = options.firstTurnGraceMs ?? FIRST_TURN_GRACE_MS;
  const initialPromptCapMs = options.initialPromptCapMs ?? INITIAL_PROMPT_HOLD_CAP_MS;
  const env = options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const socketPath = options.socketPath ?? defaultAgentHostSocketPath(env);
  const disabled = ["0", "off", "false"].includes(String(env[DISABLE_ENV] ?? "").toLowerCase());

  /** One listener per Pi session, keyed by session id (CORE-2433 I2). */
  const bindings = new Map<string, SessionBinding>();
  /** Most-recently-active session first for ctx-less events; the tail is the active binding. */
  const recency: string[] = [];
  let activeId: string | null = null;
  let handlersInstalled = false;
  let disposedAll = false;
  const patchedUis = new Map<object, { originals: Record<string, unknown>; bindingId: string }>();

  const live = (b: SessionBinding) => b.state === "connecting" || b.state === "open";

  /**
   * Initial-prompt signal (CORE-2438 I7): explicit option wins, then the
   * XTRM_INITIAL_PROMPT env seam for launchers and tests, then argv
   * sniffing. Recomputed per session_start; argv never changes in-process.
   */
  function resolveInitialPrompt(): boolean {
    if (options.initialPromptPending !== undefined) return options.initialPromptPending;
    const flag = String(env[INITIAL_PROMPT_ENV] ?? "").toLowerCase();
    if (flag === "1" || flag === "true") return true;
    if (flag === "0" || flag === "false") return false;
    return argvHasInitialPrompt(options.argv ?? process.argv);
  }

  function newBinding(sessionId: string): SessionBinding {
    return {
      sessionId,
      state: "idle",
      ctx: null,
      identity: null,
      lastStatus: null,
      socket: null,
      seq: 0,
      reconnectDelay: RECONNECT_MIN_MS,
      reconnectTimer: null,
      flushTimer: null,
      queue: [],
      updates: new Map(),
      pendingUi: new Map(),
      toolCache: null,
      guiIngress: null,
      startingAt: null,
      deferred: [],
      deferredWake: [],
      sawAgentStart: false,
      sawBeforeAgentStart: false,
      initialPromptPending: false,
      promptCapTimer: null,
      sessionStartedAt: null,
      graceTimer: null,
      reassertedThisConnection: false,
      readBuffer: "",
      generation: 1,
      deliveredWakes: new WakeDedupe(),
      streaming: false,
    };
  }

  function touch(id: string): void {
    const at = recency.indexOf(id);
    if (at !== -1) recency.splice(at, 1);
    recency.push(id);
    activeId = id;
  }

  /** The single session with an open run, if exactly one: owns ctx-less stream events (F6). */
  function streamingBinding(): SessionBinding | null {
    const open = [...bindings.values()].filter((b) => b.streaming && b.state !== "closed");
    return open.length === 1 ? open[0]! : null;
  }

  /** Binding for events without a context: the streaming session, else the active one. */
  function streamBinding(): SessionBinding | null {
    return streamingBinding() ?? activeBinding();
  }

  function activeBinding(): SessionBinding | null {
    if (!activeId) return null;
    return bindings.get(activeId) ?? null;
  }

  function sessionIdOf(current: ExtensionContext | undefined): string | null {
    if (!current) return null;
    try {
      const id = current.sessionManager.getSessionId();
      return typeof id === "string" && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  /** Binding for an event carrying a context; notes an unseen session without stealing activity. */
  function bindingFor(current: ExtensionContext | undefined): SessionBinding | null {
    const id = sessionIdOf(current) ?? activeId;
    if (!id) return null;
    const existing = bindings.get(id);
    if (existing) {
      touch(id);
      return existing;
    }
    const b = newBinding(id);
    bindings.set(id, b);
    connect(b);
    return b;
  }

  // --- framing -----------------------------------------------------------------------------

  function frame(b: SessionBinding, at: number, payloadJson: string): string {
    return `{"schema":"xtrm.agent-event.v1","seq":${b.seq++},"sessionId":${JSON.stringify(b.sessionId)},"at":${at},"payload":${payloadJson}}\n`;
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

  function write(b: SessionBinding, line: string): void {
    if (!b.socket) return;
    if (b.socket.writableLength > HARD_BACKLOG_BYTES) {
      b.socket.destroy();
      return;
    }
    b.socket.write(line);
  }

  /** Emit one event in order: pending updates go first so the stream order is preserved. */
  function emit(b: SessionBinding, payload: Payload, at = Date.now()): void {
    if (!live(b)) return;
    flushUpdates(b);
    const json = serialize(payload);
    if (json === null) return;
    if (b.state === "open") write(b, frame(b, at, json));
    else {
      b.queue.push(`${at}\u0000${json}`);
      if (b.queue.length > MAX_CONNECT_QUEUE) b.queue.shift();
    }
  }

  function emitUpdate(b: SessionBinding, key: string, payload: Payload): void {
    if (!live(b)) return;
    if (!b.updates.has(key)) b.updates.set(key, { at: Date.now(), payload });
    else b.updates.get(key)!.payload = payload;
    if (!b.flushTimer) {
      b.flushTimer = setTimeout(() => flushUpdates(b), UPDATE_COALESCE_MS);
      b.flushTimer.unref?.();
    }
  }

  function flushUpdates(b: SessionBinding): void {
    if (b.flushTimer) {
      clearTimeout(b.flushTimer);
      b.flushTimer = null;
    }
    if (b.updates.size === 0) return;
    const pending = [...b.updates.values()];
    b.updates.clear();
    if (b.state !== "open" || !b.socket || b.socket.writableLength > SOFT_BACKLOG_BYTES) return;
    for (const { at, payload } of pending) {
      const json = serialize(payload);
      if (json !== null) write(b, frame(b, at, json));
    }
  }

  // --- connection --------------------------------------------------------------------------

  function connect(b: SessionBinding): void {
    if (disposedAll || b.state === "closed" || b.state === "open" || !b.ctx || b.socket) return;
    b.state = "connecting";
    const conn = net.createConnection(socketPath);
    b.socket = conn;
    conn.setEncoding("utf8");
    conn.on("connect", async () => {
      if (b.socket !== conn) return;
      conn.unref();
      b.reassertedThisConnection = false;
      // Identity costs tmux/git subprocesses: build it only once a host answers.
      if (!b.identity) {
        const built = await buildIdentity(b.ctx!, b.sessionId, b.generation);
        if (b.socket !== conn || disposedAll || b.state === "closed") return;
        b.identity = built;
      }
      b.state = "open";
      b.seq = 0;
      b.reconnectDelay = RECONNECT_MIN_MS;
      write(b, frame(b, Date.now(), JSON.stringify(b.identity)));
      b.lastStatus = JSON.stringify(buildStatus(b.ctx!));
      write(b, frame(b, Date.now(), b.lastStatus));
      const queued = b.queue;
      b.queue = [];
      for (const entry of queued) {
        const split = entry.indexOf("\u0000");
        write(b, frame(b, Number(entry.slice(0, split)), entry.slice(split + 1)));
      }
      flushUpdates(b);
    });
    conn.on("data", (chunk: string) => onData(b, chunk));
    // A missing or refused host is the normal no-host case: never print anything.
    conn.on("error", () => {});
    conn.on("close", () => {
      if (b.socket !== conn) return;
      b.socket = null;
      b.readBuffer = "";
      b.lastStatus = null;
      b.queue = [];
      b.updates.clear();
      b.pendingUi.clear();
      if (disposedAll || b.state === "closed") return;
      b.state = "down";
      scheduleReconnect(b);
    });
  }

  function scheduleReconnect(b: SessionBinding): void {
    if (b.reconnectTimer || disposedAll || b.state === "closed") return;
    b.reconnectTimer = setTimeout(() => {
      b.reconnectTimer = null;
      connect(b);
    }, b.reconnectDelay);
    b.reconnectTimer.unref?.();
    b.reconnectDelay = Math.min(b.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function unpatchBinding(bindingId: string): void {
    for (const [ui, patched] of [...patchedUis]) {
      if (patched.bindingId !== bindingId) continue;
      Object.assign(ui, patched.originals);
      patchedUis.delete(ui);
    }
  }

  function disposeBinding(b: SessionBinding): void {
    if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
    if (b.flushTimer) clearTimeout(b.flushTimer);
    if (b.graceTimer) clearTimeout(b.graceTimer);
    b.reconnectTimer = b.flushTimer = null;
    b.graceTimer = null;
    clearPromptCap(b);
    // Held wakes never deliver now: answer them failed while the socket
    // still writes, so the registry records them undelivered instead of
    // leaving them held. A dead socket drops the frame and the host-side
    // revocation reports them undelivered instead.
    const unanswered = b.deferredWake;
    b.deferredWake = [];
    for (const wake of unanswered) {
      try {
        wake.fail("session_ended", "the session ended before the wake was delivered");
      } catch {
        /* answering must not break teardown */
      }
    }
    b.state = "closed";
    b.socket?.end();
    b.socket = null;
    b.pendingUi.clear();
    b.deferred = [];
    unpatchBinding(b.sessionId);
    bindings.delete(b.sessionId);
    const at = recency.indexOf(b.sessionId);
    if (at !== -1) recency.splice(at, 1);
    if (activeId === b.sessionId) activeId = recency.length > 0 ? recency[recency.length - 1]! : null;
  }

  function dispose(): void {
    disposedAll = true;
    for (const b of [...bindings.values()]) disposeBinding(b);
    for (const [ui, { originals }] of [...patchedUis]) {
      Object.assign(ui, originals);
      patchedUis.delete(ui);
    }
  }

  // --- identity ----------------------------------------------------------------------------

  async function buildIdentity(current: ExtensionContext, id: string, generation: number): Promise<AgentSessionIdentity> {
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
    const gitInfo = exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
    // Separate from rev-parse: HEAD of a repository without commits fails rev-parse but still names a branch.
    const branchInfo = exec("git", ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"]);
    const remoteInfo = exec("git", ["-C", cwd, "config", "--get-regexp", "^remote\\..*\\.url$"]);
    if (pane) void exec("tmux", ["set-option", "-p", "-t", pane, PANE_SESSION_OPTION, id]);

    const [tmuxOut, gitOut, branchOut, remoteOut] = await Promise.all([tmuxInfo, gitInfo, branchInfo, remoteInfo]);
    if (tmuxOut) {
      const [name, paneRole, paneBead, parent, paneWorktree, paneBranch] = tmuxOut.replace(/\n$/, "").split("\t");
      tmuxSession = bounded(name);
      role = bounded(paneRole) ?? role;
      bead = bounded(paneBead) ?? bead;
      parentTmux = bounded(parent);
      worktree = bounded(paneWorktree, 4096);
      branch = bounded(paneBranch);
    }
    const [gitTop, gitCommonDir] = gitOut.split("\n");
    worktree ??= bounded(gitTop, 4096);
    // The common directory is <repo>/.git for a checkout and all of its worktrees; a bare repository is its own root.
    const repositoryPath = gitCommonDir
      ? bounded(path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir, 4096)
      : undefined;
    const remote = remoteUrl(remoteOut);
    const repository = repositoryPath && remote ? repositoryFromRemote(remote) : undefined;
    // A detached HEAD is not a symbolic ref: no branch.
    branch ??= bounded(branchOut.trim());

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
      pid: typeof process.pid === "number" && process.pid > 0 ? process.pid : undefined,
      generation,
      sessionFile,
      sessionName: bounded(pi.getSessionName()) ?? bounded(env.XTRM_SESSION_NAME) ?? tmuxSession,
      cwd: bounded(cwd, 4096) ?? "/",
      worktree,
      repository,
      repositoryPath,
      branch,
      role,
      workItem: bead ? compact({ ref: bead, system: /^[A-Z][A-Z0-9]*-[0-9]+$/.test(bead) ? ("substrate" as const) : undefined }) : undefined,
      parentSessionId,
      tmux: pane && tmuxSession ? { session: tmuxSession, paneId: pane } : undefined,
      launch: env[LAUNCH_ENV] === "gui" ? ("gui" as const) : ("terminal" as const),
      capabilities: CAPABILITIES,
    });
  }

  // --- status ----------------------------------------------------------------------------

  /**
   * Model, thinking level and context usage from the Pi 1.0.0 extension API: ctx.model, pi.getThinkingLevel()
   * (ctx.thinkingLevel as fallback) and ctx.getContextUsage(). `override` carries the value a *_select event
   * reports, which ctx may not reflect yet while the event dispatches.
   */
  function buildStatus(current: ExtensionContext, override: { model?: any; thinkingLevel?: unknown } = {}): AgentSessionStatus {
    const read = <T,>(get: () => T): T | undefined => {
      try {
        return get();
      } catch {
        return undefined;
      }
    };
    const model = override.model ?? read(() => current.model);
    const thinkingLevel = override.thinkingLevel ?? read(() => pi.getThinkingLevel()) ?? read(() => current.thinkingLevel);
    const usage = read(() => current.getContextUsage());
    const contextWindow = usage && Number.isFinite(usage.contextWindow) ? Math.floor(usage.contextWindow) : 0;
    return compact({
      type: "session_status" as const,
      model: model && typeof model.id === "string" ? bounded(typeof model.provider === "string" ? `${model.provider}/${model.id}` : model.id) : undefined,
      thinkingLevel: bounded(thinkingLevel),
      contextUsage:
        usage && contextWindow >= 1
          ? { tokens: typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0 ? Math.round(usage.tokens) : null, contextWindow }
          : undefined,
    });
  }

  /** Send session_status when it differs from the last one sent on this connection. */
  function emitStatus(b: SessionBinding, override?: { model?: any; thinkingLevel?: unknown }): void {
    if (b.state !== "open" || !b.ctx) return;
    const status = buildStatus(b.ctx, override);
    const json = JSON.stringify(status);
    if (json === b.lastStatus) return;
    b.lastStatus = json;
    emit(b, status);
  }

  // --- tools ------------------------------------------------------------------------------

  function lookupTool(b: SessionBinding, name: string): AgentToolSource | undefined {
    if (b.toolCache?.has(name)) return b.toolCache.get(name);
    b.toolCache = new Map();
    try {
      for (const info of pi.getAllTools()) if (!b.toolCache.has(info.name)) b.toolCache.set(info.name, toolSource(info));
    } catch {
      /* tool registry unavailable */
    }
    if (!b.toolCache.has(name)) b.toolCache.set(name, undefined);
    return b.toolCache.get(name);
  }

  function toolPayload(b: SessionBinding, type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end", event: any): Payload {
    const base = {
      type,
      toolCallId: String(event.toolCallId).slice(0, 512),
      toolName: bounded(event.toolName) ?? "unknown",
      parentToolCallId: typeof event.parentToolCallId === "string" && event.parentToolCallId ? event.parentToolCallId.slice(0, 512) : undefined,
      tool: lookupTool(b, event.toolName),
    };
    if (type === "tool_execution_start") return compact({ ...base, args: event.args ?? null }) as Payload;
    if (type === "tool_execution_update") return compact({ ...base, args: event.args ?? null, partialResult: event.partialResult ?? null }) as Payload;
    return compact({ ...base, result: event.result ?? null, isError: Boolean(event.isError) }) as Payload;
  }

  // --- ctx.ui proxy ------------------------------------------------------------------------

  /** Ask the host and the local dialog at once; the first answer wins and dismisses the other. */
  async function race(
    b: SessionBinding,
    method: UiMethod,
    request: { title: string; message?: string; options?: string[]; placeholder?: string; timeout?: number },
    opts: { signal?: AbortSignal; timeout?: number } | undefined,
    local: (opts: { signal?: AbortSignal; timeout?: number } | undefined) => Promise<unknown>,
  ): Promise<unknown> {
    if (b.state !== "open" || !b.ctx?.hasUI) return local(opts);
    const id = randomUUID();
    const controller = new AbortController();
    const signal = opts?.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
    const hostAnswer = new Promise<UiAnswer>((resolve) => b.pendingUi.set(id, { method, options: request.options, resolve }));
    emit(
      b,
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
        hostAnswer.then((answer) => ({ from: "host" as const, value: answer.value, cancelled: answer.cancelled })),
      ]);
      if (winner.from === "host") {
        controller.abort();
        localAnswer.catch(() => {});
      }
      resolvedBy = winner.from;
      outcome = winner.cancelled ? "cancelled" : "answered";
      return winner.value;
    } finally {
      b.pendingUi.delete(id);
      emit(b, { type: "extension_ui_resolved", id, resolvedBy, outcome });
    }
  }

  /**
   * Pi's dialogs return undefined (select, input) when dismissed or timed out. confirm() returns false for both
   * "No" and a dismissal, so only an aborted caller signal marks a local confirm cancelled.
   */
  function localCancelled(value: unknown, callerSignal: AbortSignal | undefined): boolean {
    return value === undefined || callerSignal?.aborted === true;
  }

  function patchUi(b: SessionBinding, current: ExtensionContext): void {
    const ui = current.ui as any;
    if (!ui) return;
    const patched = patchedUis.get(ui);
    if (patched) {
      if (patched.bindingId === b.sessionId) return;
      Object.assign(ui, patched.originals);
      patchedUis.delete(ui);
    }
    const original = { select: ui.select, confirm: ui.confirm, input: ui.input };
    if (typeof original.select !== "function" || typeof original.confirm !== "function" || typeof original.input !== "function") return;
    patchedUis.set(ui, { originals: original, bindingId: b.sessionId });
    ui.select = (title: string, choices: string[], opts?: any) =>
      race(b, "select", { title, options: choices, timeout: opts?.timeout }, opts, (o) => original.select.call(ui, title, choices, o));
    ui.confirm = (title: string, message: string, opts?: any) =>
      race(b, "confirm", { title, message, timeout: opts?.timeout }, opts, (o) => original.confirm.call(ui, title, message, o));
    ui.input = (title: string, placeholder?: string, opts?: any) =>
      race(b, "input", { title, placeholder, timeout: opts?.timeout }, opts, (o) => original.input.call(ui, title, placeholder, o));
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

  function onData(b: SessionBinding, chunk: string): void {
    b.readBuffer += chunk;
    let newline = b.readBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = b.readBuffer.slice(0, newline);
      b.readBuffer = b.readBuffer.slice(newline + 1);
      if (line.trim()) handleCommandLine(b, line);
      newline = b.readBuffer.indexOf("\n");
    }
    if (b.readBuffer.length > MAX_FRAME_CHARS) b.readBuffer = "";
  }

  function handleCommandLine(b: SessionBinding, line: string): void {
    let frameIn: any;
    try {
      frameIn = JSON.parse(line);
    } catch {
      return;
    }
    const command = frameIn?.payload;
    if (frameIn?.schema !== "xtrm.agent-command.v1" || typeof command?.commandId !== "string") return;
    const result = (status: "accepted" | "rejected" | "failed", reason?: string, message?: string) =>
      emit(b, compact({ type: "command_result" as const, commandId: command.commandId, status, reason, message: message?.slice(0, 1024) }));
    if (frameIn.sessionId !== b.sessionId) return result("rejected", "session_mismatch", `this listener serves ${b.sessionId}`);
    try {
      executeCommand(b, command as AgentCommandPayload, result);
    } catch (error) {
      result("failed", "command_error", error instanceof Error ? error.message : String(error));
    }
  }

  function executeCommand(
    b: SessionBinding,
    command: AgentCommandPayload,
    result: (status: "accepted" | "rejected" | "failed", reason?: string, message?: string) => void,
  ): void {
    if (command.type === "extension_ui_response") {
      const entry = b.pendingUi.get(command.id);
      if (!entry) return result("rejected", "unknown_ui_request", `no pending extension UI request ${command.id}`);
      const mapped = uiValue(entry, command);
      if (!mapped) return result("rejected", "invalid_ui_response", `the answer does not fit a ${entry.method} prompt`);
      b.pendingUi.delete(command.id);
      entry.resolve(mapped);
      return result("accepted");
    }
    if (!b.ctx) return result("failed", "no_session_context", "the session is not ready");
    const current = b.ctx;
    const starting = isStarting(b);
    if (command.type === "abort") {
      // Pi ignores abort() before agent_start: the run it would stop is not active yet.
      if (starting) b.deferred.push(() => current.abort());
      else current.abort();
      return result("accepted");
    }
    if (command.type === "listener_replaced") {
      // R5/F1: the registry replaced this listener. Re-assert once per
      // connection with a generation above both the local and the replacing
      // one; a second notice is acknowledged but never wins back, so two live
      // listeners cannot replace each other without end. Replacement is not a
      // reason to win back: the registry also refuses the ping-pong.
      if (b.reassertedThisConnection) return result("accepted");
      b.reassertedThisConnection = true;
      const seen = typeof (command as { generation?: unknown }).generation === "number" ? (command as { generation: number }).generation : 0;
      b.generation = Math.max(b.generation, seen) + 1;
      if (b.identity) {
        b.identity = compact({ ...b.identity, generation: b.generation });
        emit(b, b.identity);
      }
      return result("accepted");
    }
    if (command.type === "wake") {
      // I2 delivery: the wake carries a payload reference only, never a
      // contract or a decision. It injects as customType "intercom_message"
      // with the D2 provenance line (never a plain user message), and the ack
      // answers only after the injection succeeded; an injection failure
      // answers failed so the registry reports the wake undelivered (R3).
      const ref = typeof command.payloadRef === "string" ? command.payloadRef : "";
      if (!ref) return result("rejected", "invalid_command", "payload reference is empty");
      const messageId = typeof command.messageId === "string" && command.messageId ? command.messageId : command.commandId;
      // CORE-2436 I5 sender fields ride the wake frame (optional: I1 senders omit them).
      const optText = (value: unknown, max: number): string | undefined =>
        typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
      const sender = {
        ...(optText((command as { from?: unknown }).from, 256) !== undefined
          ? { from: optText((command as { from?: unknown }).from, 256) as string }
          : {}),
        ...(optText((command as { fromName?: unknown }).fromName, 256) !== undefined
          ? { fromName: optText((command as { fromName?: unknown }).fromName, 256) as string }
          : {}),
        ...(optText((command as { fromSessionId?: unknown }).fromSessionId, 256) !== undefined
          ? { fromSessionId: optText((command as { fromSessionId?: unknown }).fromSessionId, 256) as string }
          : {}),
        ...(optText((command as { replyTo?: unknown }).replyTo, 128) !== undefined
          ? { replyTo: optText((command as { replyTo?: unknown }).replyTo, 128) as string }
          : {}),
        ...((command as { notifyWhenIdle?: unknown }).notifyWhenIdle === true ? { notifyWhenIdle: true as const } : {}),
      };
      // F1: answer a duplicate from its real state — held while still
      // deferred, accepted once injected — and never mark before injecting,
      // so a held-then-flushed or failed-then-resent wake still injects.
      if (b.deliveredWakes.has(messageId)) return result("accepted");
      if (b.deferredWake.some((wake) => wake.messageId === messageId))
        return result("rejected", "held", "the wake is already held for this session");
      const fail = (reason: string, message: string) => result("failed", reason, message);
      // CORE-2436 I5 first-turn race (review: grace window): before the
      // first agent_start Pi reports idle while its initial turn may already
      // be starting, so a triggerTurn injection could start a second run
      // and fail with "Agent is already processing". Hold during a real
      // starting window only: a requested run (starting) or the short grace
      // after session_start. Past the grace with no run, the session counts
      // as idle; the grace timer flushes held wakes with triggerTurn.
      // CORE-2438 I7: with an initial prompt pending, the first turn is
      // imminent even past the grace, so wakes hold until before_agent_start
      // instead of racing it.
      const withinGrace =
        b.sessionStartedAt !== null && Date.now() - b.sessionStartedAt < firstTurnGraceMs;
      const initialTurnPending = b.initialPromptPending && !b.sawBeforeAgentStart;
      const firstTurnPending = !b.sawAgentStart && (starting || withinGrace || initialTurnPending);
      if (starting || firstTurnPending) {
        // F7: only deferred, not delivered: hold the wake and answer accepted
        // only when a flush actually delivers it. The injected hook still
        // fires: a threaded reply (replyTo) resolves its waiting ask from the
        // frame alone, and an idle subscription arms now (re-armed on flush).
        emitWakeInjected({ messageId, ref, ...sender, receiver: pi });
        if (!starting) armGrace(b);
        // The initial-prompt hold is bounded: a mispredicted prompt must
        // not park the wake past the cap (review HIGH-1a).
        if (initialTurnPending && !starting) armPromptCap(b);
        b.deferredWake.push({
          messageId,
          ref,
          sender,
          accept: () => result("accepted"),
          hold: () => result("rejected", "held", "the session never started; the wake stays held"),
          fail,
        });
        return result(
          "rejected",
          "held",
          firstTurnPending && !starting
            ? "the session has not started its first turn; the wake stays held until it is delivered"
            : "the session is starting; the wake stays held until it is delivered",
        );
      }
      const idle = current.isIdle();
      // F5: a peer wake never counts as GUI ingress. A wake that starts a
      // run marks the startup window only after its injection succeeded, so
      // a failed injection leaves no stale starting state behind (F1).
      try {
        injectIntercomWake(pi, messageId, ref, wakeDeliveryOptions({ idle }), sender);
      } catch (error) {
        return fail("injection_failed", error instanceof Error ? error.message : String(error));
      }
      b.deliveredWakes.mark(messageId);
      emitWakeInjected({ messageId, ref, ...sender, receiver: pi });
      if (idle) b.startingAt = Date.now();
      return result("accepted");
    }
    if (command.type !== "prompt" && command.type !== "steer" && command.type !== "follow_up") {
      return result("rejected", "unsupported_command", `unsupported command ${(command as { type?: unknown }).type}`);
    }
    if (typeof command.message !== "string" || command.message.length === 0) return result("rejected", "invalid_command", "message is empty");
    const idle = !starting && current.isIdle();
    // §35.8 item 5: a normal submit never queues behind running work.
    if (command.type === "prompt" && !idle) return result("rejected", "busy", "the session is working; use steer or follow_up");
    const attached = images(command.images);
    const content = attached ? [{ type: "text" as const, text: command.message }, ...attached] : command.message;
    const deliverAs = command.type === "steer" ? "steer" : "followUp";
    if (starting) {
      b.deferred.push(() => pi.sendUserMessage(content, { deliverAs }));
      return result("accepted");
    }
    // An idle session starts a new Frame from this message; mark it as GUI ingress.
    if (idle) {
      b.guiIngress = { commandId: command.commandId, message: command.message, at: Date.now() };
      b.startingAt = Date.now();
    }
    if (command.type === "prompt") pi.sendUserMessage(content);
    else pi.sendUserMessage(content, { deliverAs });
    result("accepted");
  }

  /** Whether a requested run has not reached agent_start yet; a run Pi never started stops counting after STARTUP_STALE_MS. */
  function isStarting(b: SessionBinding): boolean {
    if (b.startingAt !== null && Date.now() - b.startingAt > STARTUP_STALE_MS && b.ctx?.isIdle() !== false) {
      b.startingAt = null;
      b.deferred = [];
      // The run never started, so deferred wakes were never delivered: re-hold
      // them instead of answering accepted for work that never happened (F7).
      const staleWakes = b.deferredWake;
      b.deferredWake = [];
      for (const wake of staleWakes) wake.hold();
    }
    return b.startingAt !== null;
  }

  function clearGrace(b: SessionBinding): void {
    if (b.graceTimer) clearTimeout(b.graceTimer);
    b.graceTimer = null;
    clearPromptCap(b);
  }

  function clearPromptCap(b: SessionBinding): void {
    if (b.promptCapTimer) clearTimeout(b.promptCapTimer);
    b.promptCapTimer = null;
  }

  /**
   * Hard-cap expiry (CORE-2438 review): the first turn never observably
   * began, so the initial-prompt prediction was wrong or the turn died.
   * Drop the hold and flush through the normal grace path (triggerTurn
   * into the idle session), exactly as if no prompt had been pending.
   */
  function flushPromptCap(b: SessionBinding): void {
    b.promptCapTimer = null;
    if (disposedAll || b.sawAgentStart) return;
    b.initialPromptPending = false;
    flushGrace(b);
  }

  function armPromptCap(b: SessionBinding): void {
    if (b.promptCapTimer) return;
    const wait = Math.max(0, initialPromptCapMs);
    const timer = setTimeout(() => flushPromptCap(b), wait);
    timer.unref?.();
    b.promptCapTimer = timer;
  }

  /**
   * Grace-expiry flush (CORE-2436 I5 review): no run started within the
   * grace, so the session counts as an idle interactive session. Held
   * pre-first-turn wakes inject with triggerTurn now. A run that started
   * meanwhile owns the flush instead (isStarting/agent_start), so this is
   * a no-op for it. Failures answer failed so the registry reports
   * undelivered, exactly like the agent_start flush.
   */
  function flushGrace(b: SessionBinding): void {
    b.graceTimer = null;
    if (disposedAll || b.sawAgentStart || isStarting(b)) return;
    // CORE-2438 I7: with an initial prompt pending, the first turn is still
    // coming even past the grace — leave held wakes for before_agent_start
    // (then agent_start), never a triggerTurn race. Dispose fails them if
    // the turn never arrives.
    if (b.initialPromptPending && !b.sawBeforeAgentStart) return;
    const wakes = b.deferredWake;
    if (wakes.length === 0) return;
    b.deferredWake = [];
    let idleInjected = false;
    for (const wake of wakes) {
      try {
        injectIntercomWake(pi, wake.messageId, wake.ref, wakeDeliveryOptions({ idle: true }), wake.sender);
        b.deliveredWakes.mark(wake.messageId);
        emitWakeInjected({ messageId: wake.messageId, ref: wake.ref, ...wake.sender, receiver: pi });
        idleInjected = true;
        wake.accept();
      } catch (error) {
        wake.fail("injection_failed", error instanceof Error ? error.message : String(error));
      }
    }
    if (idleInjected) b.startingAt = Date.now();
  }

  function armGrace(b: SessionBinding): void {
    if (b.graceTimer || b.sessionStartedAt === null) return;
    const wait = Math.max(0, b.sessionStartedAt + firstTurnGraceMs - Date.now());
    const timer = setTimeout(() => flushGrace(b), wait);
    timer.unref?.();
    b.graceTimer = timer;
  }

  function ingressFor(b: SessionBinding, prompt: string): { origin: "gui" | "terminal"; commandId?: string } {
    const pending = b.guiIngress;
    b.guiIngress = null;
    if (pending && (pending.message === prompt || Date.now() - pending.at < GUI_INGRESS_WINDOW_MS)) {
      return { origin: "gui", commandId: pending.commandId.slice(0, 1024) };
    }
    return { origin: "terminal" };
  }

  // --- Pi events ----------------------------------------------------------------------------

  function track(b: SessionBinding, current: ExtensionContext | undefined): void {
    if (!current) return;
    b.ctx = current;
    patchUi(b, current);
    // A session whose start was missed still binds on first contact.
    if (b.state === "idle") connect(b);
  }

  function register(): void {
    if (disabled || handlersInstalled) return;
    handlersInstalled = true;

    pi.on("session_start", (event, current) => {
      if (disposedAll) return;
      let id: string | undefined;
      try {
        id = bounded(sessionIdOf(current), 256) ?? undefined;
      } catch {
        id = undefined;
      }
      if (!id) return;
      let b = bindings.get(id);
      if (!b) {
        // A new session — including an in-process child — gets its own
        // listener. Existing bindings are never rebound (CORE-2433 I2).
        b = newBinding(id);
        bindings.set(id, b);
      }
      touch(id);
      // CORE-2467 A+B: probe the host fast and self-heal in the
      // background. Fire-and-forget: never blocks the start path, and a
      // missing UI only loses the loud warning, never the session.
      try {
        const hostEnsure = options.hostEnsure;
        if (hostEnsure) {
          const ensureOptions: HostEnsureOptions =
            typeof hostEnsure === "object" ? { ...hostEnsure, enabled: true } : { enabled: true };
          const ui = (current as { ui?: { notify?: (line: string, level: string) => void } })?.ui;
          monitorAgentHostSession(
            {
              notify: (line: string) => {
                try {
                  ui?.notify?.(line, "warning");
                } catch {
                  /* notify must never break the start path */
                }
              },
            },
            ensureOptions,
          );
        }
      } catch {
        /* self-healing must never break session start */
      }
      // CORE-2436 I5: every session start opens a fresh first-turn grace
      // window; wakes hold only during a real starting window past it.
      b.sawAgentStart = false;
      // CORE-2438 I7: a pending initial prompt holds pre-first-turn wakes
      // past the grace until the first turn observably begins.
      b.sawBeforeAgentStart = false;
      b.initialPromptPending = resolveInitialPrompt();
      b.sessionStartedAt = Date.now();
      clearGrace(b);
      track(b, current);
      if (b.state === "closed") return;
      // A live socket stays live: only a binding without one (re)connects.
      if (!b.socket && b.state !== "open") b.state = "connecting";
      emit(b, compact({ type: "session_start" as const, reason: event.reason, previousSessionFile: bounded(event.previousSessionFile, 4096) }));
      connect(b);
    });

    pi.on("session_info_changed", (_event, current) => {
      const b = bindingFor(current);
      if (!b) return;
      track(b, current);
      if (!b.identity) return;
      const name = bounded(pi.getSessionName());
      b.identity = compact({ ...b.identity, sessionName: name ?? b.identity.sessionName });
      emit(b, b.identity);
    });

    pi.on("before_agent_start", (event, current) => {
      const b = bindingFor(current);
      if (!b) return;
      track(b, current);
      b.startingAt = Date.now();
      // CORE-2438 I7: the first turn observably began; the initial-prompt
      // hold is over (the starting window owns later wakes until agent_start).
      b.sawBeforeAgentStart = true;
      b.initialPromptPending = false;
      clearPromptCap(b);
      if (!live(b)) {
        b.guiIngress = null;
        return;
      }
      emit(b, compact({ type: "before_agent_start" as const, prompt: event.prompt, images: images(event.images), ingress: ingressFor(b, event.prompt) }));
    });

    pi.on("agent_start", (_event, current) => {
      const b = bindingFor(current);
      if (!b) return;
      track(b, current);
      b.toolCache = null;
      b.streaming = true;
      emit(b, { type: "agent_start" });
      b.sawAgentStart = true;
      clearGrace(b);
      b.startingAt = null;
      const run = b.deferred;
      b.deferred = [];
      for (const action of run) action();
      // F7: wakes held while starting are delivered into the fresh run, and
      // only now answered accepted. A successful injection marks the id so a
      // registry flush of the same wake answers from state instead of
      // injecting twice; a failed injection stays unmarked so a resend can
      // inject, and the registry reports the wake undelivered.
      const wakes = b.deferredWake;
      b.deferredWake = [];
      for (const wake of wakes) {
        try {
          injectIntercomWake(pi, wake.messageId, wake.ref, wakeDeliveryOptions({ idle: false }), wake.sender);
          b.deliveredWakes.mark(wake.messageId);
          emitWakeInjected({ messageId: wake.messageId, ref: wake.ref, ...wake.sender, receiver: pi });
          wake.accept();
        } catch (error) {
          wake.fail("injection_failed", error instanceof Error ? error.message : String(error));
        }
      }
    });

    pi.on("turn_start", (event, current) => {
      const b = bindingFor(current) ?? activeBinding();
      if (!b) return;
      track(b, current);
      emit(b, { type: "turn_start", turnIndex: event.turnIndex, timestamp: Math.floor(event.timestamp) });
    });

    pi.on("message_start", (event) => {
      const b = streamBinding();
      if (!b) return;
      emit(b, { type: "message_start", message: event.message as any });
    });

    pi.on("message_update", (event) => {
      const b = streamBinding();
      if (!b) return;
      emitUpdate(b, "message", { type: "message_update", message: event.message as any, assistantMessageEvent: assistantEvent(event.assistantMessageEvent) });
    });

    pi.on("message_end", (event) => {
      const b = streamBinding();
      if (!b) return;
      emit(b, { type: "message_end", message: event.message as any });
    });

    pi.on("tool_execution_start", (event) => {
      const b = streamBinding();
      if (!b) return;
      emit(b, toolPayload(b, "tool_execution_start", event));
    });

    pi.on("tool_execution_update", (event) => {
      const b = streamBinding();
      if (!b) return;
      emitUpdate(b, `tool:${event.toolCallId}`, toolPayload(b, "tool_execution_update", event));
    });

    pi.on("tool_execution_end", (event) => {
      const b = streamBinding();
      if (!b) return;
      b.updates.delete(`tool:${event.toolCallId}`);
      emit(b, toolPayload(b, "tool_execution_end", event));
    });

    pi.on("model_select", (event, current) => {
      const b = bindingFor(current) ?? activeBinding();
      if (!b) return;
      track(b, current);
      emitStatus(b, { model: event.model });
    });

    pi.on("thinking_level_select", (event, current) => {
      const b = bindingFor(current) ?? activeBinding();
      if (!b) return;
      track(b, current);
      emitStatus(b, { thinkingLevel: event.level });
    });

    pi.on("turn_end", (event) => {
      const b = streamBinding();
      if (!b) return;
      emit(
        b,
        compact({
          type: "turn_end" as const,
          turnIndex: event.turnIndex,
          message: event.message as any,
          toolResults: (event.toolResults ?? []) as any[],
          messageEntryId: typeof (event as any).messageEntryId === "string" ? (event as any).messageEntryId.slice(0, 256) : undefined,
          toolResultEntryIds: Array.isArray((event as any).toolResultEntryIds) ? (event as any).toolResultEntryIds.map((e: unknown) => String(e).slice(0, 256)) : undefined,
        }),
      );
      emitStatus(b);
    });

    // Pi extensions never see willRetry on agent_end; only agent_settled closes a Frame.
    pi.on("agent_end", (event) => {
      const b = streamBinding();
      if (!b) return;
      emit(b, { type: "agent_end", messages: (event.messages ?? []) as any[] });
    });

    pi.on("agent_settled", (_event, current) => {
      const b = bindingFor(current) ?? activeBinding();
      if (!b) return;
      track(b, current);
      b.startingAt = null;
      b.deferred = [];
      b.streaming = false;
      emitStatus(b);
      emit(b, { type: "agent_settled" });
    });

    pi.on("session_compact", (event) => {
      const b = activeBinding();
      if (!b) return;
      emit(
        b,
        compact({
          type: "session_compact" as const,
          reason: event.reason,
          willRetry: Boolean(event.willRetry),
          fromExtension: Boolean(event.fromExtension),
          compactionEntryId: typeof event.compactionEntry?.id === "string" ? event.compactionEntry.id.slice(0, 256) : undefined,
        }),
      );
      emitStatus(b);
    });

    pi.on("session_compact_failed", (event) => {
      const b = activeBinding();
      if (!b) return;
      emit(
        b,
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

    // The shutdown belongs to the session in the event context; without one
    // it belongs to the active session — the one Pi is leaving.
    pi.on("session_shutdown", (event, current) => {
      const b = bindingFor(current) ?? activeBinding();
      if (!b) return;
      emit(b, compact({ type: "session_shutdown" as const, reason: event.reason, targetSessionFile: bounded(event.targetSessionFile, 4096) }));
      flushUpdates(b);
      disposeBinding(b);
    });
  }

  return {
    register,
    dispose,
    /** Test seam: connection state of the active session binding. */
    get state() {
      return activeBinding()?.state ?? "idle";
    },
  };
}

/** One bridge per Pi host: both the agent-host and intercom entries share it, so two active entries never open two listeners. */
const sharedBridges = new WeakMap<object, ReturnType<typeof createAgentHostBridge>>();

export function ensureAgentHostBridge(pi: ExtensionAPI, options: AgentHostBridgeOptions = {}) {
  let bridge = sharedBridges.get(pi);
  if (!bridge) {
    bridge = createAgentHostBridge(pi, options);
    sharedBridges.set(pi, bridge);
  }
  return bridge;
}

export default function xtrmAgentHostExtension(pi: ExtensionAPI, options: AgentHostBridgeOptions = {}): void {
  ensureAgentHostBridge(pi, options).register();
}
