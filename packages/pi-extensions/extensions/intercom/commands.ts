/**
 * Intercom commands (CORE-2435 I4, XT-91 ADR rev 2 + amendment 1).
 *
 * /intercom opens a read-only roster overlay: the same ListAgents text the
 * model tool prints, in an operator overlay that closes on esc. Sending from
 * the overlay is I5's (SendMessage), not this slice's. Without a TUI the
 * command notifies the roster text instead of opening anything.
 *
 * /rename sets this session's name, replacing the retired third-party /alias
 * (there is deliberately no /alias, no pool command and no /handover). The rename
 * reaches both registries the roster reads: pi.setSessionName fires
 * session_info_changed, which the agent-host bridge re-emits as identity so
 * the Pi roster updates; the Claude entry is patched through updatePiPeer,
 * which only touches the entry this session owns and leaves foreign entries
 * alone.
 *
 * Lineage: the overlay and rename behaviours are informed by pi-intercom
 * 0.17.1 (ADOPTION-CREDITS.md: principal behaviour source). Clean
 * reimplementation otherwise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { listClaudeSessions, updatePiPeer } from "./claude-transport/index.ts";
import { buildRoster, fetchPiSessions } from "./roster.ts";

export interface CommandUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom?: <T>(factory: (...args: any[]) => any, options?: Record<string, unknown>) => Promise<T>;
}

export interface CommandCtx {
  mode?: string;
  hasUI?: boolean;
  cwd?: string;
  sessionManager?: { getSessionId?: () => string };
  ui: CommandUi;
}

export interface IntercomCommandDeps {
  fetchPi?: () => Promise<any[]>;
  fetchClaude?: (excludeSock?: string) => Promise<any[]>;
  excludeSock?: string;
  /** Claude registry directory override (tests, alternate hosts); default is ~/.claude/sessions. */
  sessionsDir?: string;
  now?: number;
  /** Overlay fast path: agent-host GET budget (default 700ms; the model tool keeps 2000ms). */
  piTimeoutMs?: number;
  /** Overlay fast path: per-socket liveness budget (default 120ms; the model tool keeps 250ms). */
  claudeLiveTimeoutMs?: number;
  updateName?: (pid: number, patch: { name?: string; nameSource?: string; status?: string }) => Promise<void>;
}

function ownSessionIdOf(ctx: CommandCtx): string | undefined {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

async function rosterEntries(
  pi: ExtensionAPI,
  ctx: CommandCtx,
  deps: IntercomCommandDeps,
): Promise<{ ownSessionId?: string; entries: Array<{ kind: "pi" | "claude"; sessionId?: string; name: string }>; text: string }> {
  const ownSessionId = ownSessionIdOf(ctx);
  let ownName: string | undefined;
  try {
    ownName = pi.getSessionName?.() || undefined;
  } catch {
    ownName = undefined;
  }
  // Overlay fast path: the un-overridden fetchers run on tight budgets so
  // /intercom opens promptly; the ListAgents model tool keeps its own
  // (longer) defaults. Injected fetchers (tests, callers) run untouched.
  const [piSessions, claudePeers] = await Promise.all([
    (deps.fetchPi ?? (() => fetchPiSessions({ timeoutMs: deps.piTimeoutMs ?? 700 })))().catch(() => []),
    (deps.fetchClaude ??
      ((excludeSock?: string) =>
        listClaudeSessions({
          ...(excludeSock ? { excludeSock } : {}),
          ...(deps.sessionsDir ? { sessionsDir: deps.sessionsDir } : {}),
          liveTimeoutMs: deps.claudeLiveTimeoutMs ?? 120,
        })))(deps.excludeSock).catch(() => []),
  ]);
  // Without the real own id there is no roster: a fallback id would list
  // the own session as a peer and misresolve names.
  if (!ownSessionId) throw new Error("Intercom needs the current session id, and none was available.");
  const built = buildRoster({
    ownSessionId,
    ...(ownName ? { ownName } : {}),
    piSessions,
    claudePeers,
    ...(deps.excludeSock ? { excludeSock: deps.excludeSock } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return { ownSessionId, entries: built.entries, text: built.text };
}

/** Read-only roster overlay: the ListAgents text, scrollable, esc closes. */
export interface RosterOverlayOptions {
  lines: string[];
  theme: { fg(color: string, text: string): string; bold(text: string): string; italic?(text: string): string };
  close: () => void;
  requestRender?: () => void;
}

const OVERLAY_VISIBLE_LINES = 20;

/** Peer count from the `Peer sessions (N):` line, for the overlay title. */
function overlayPeerCount(lines: string[]): number | null {
  for (const line of lines) {
    const match = /^Peer sessions \((\d+)\):/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * One peer row, styled: bold name, dim ref, italic kind, tinted state
 * (idle green, busy amber, offline dim), dim trailer. Lines that do not
 * match the row shape render as-is. Themes without `italic` fall back to
 * dim for the kind so fakes and old themes keep working.
 */
function styleOverlayRow(line: string, theme: RosterOverlayOptions["theme"]): string {
  const match = /^(\s*)([^[]+?)\s*\[([^\]]*)\](.*)$/.exec(line);
  if (!match) return line;
  const [, indent, name, ref, rest] = match;
  const head = `${indent}${theme.bold((name ?? "").trim())} ${theme.fg("dim", `[${ref ?? ""}]`)}`;
  const segments = (rest ?? "").split("·").map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) return head;
  const styled = segments.map((segment, i) => {
    if (i === 0) return theme.italic ? theme.italic(segment) : theme.fg("dim", segment);
    if (i === 1) {
      const lowered = segment.toLowerCase();
      if (lowered.includes("idle")) return theme.fg("success", segment);
      if (lowered.includes("busy")) return theme.fg("warning", segment);
      if (lowered.includes("offline")) return theme.fg("dim", segment);
      return segment;
    }
    return theme.fg("dim", segment);
  });
  return `${head}  ·  ${styled.join("  ·  ")}`;
}

/** Read-only roster overlay: the ListAgents text, scrollable, esc closes. */
export class IntercomRosterOverlay {
  private scrollOffset = 0;

  constructor(private readonly options: RosterOverlayOptions) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) {
      this.options.close();
      return;
    }
    const maxOffset = Math.max(0, this.options.lines.length - OVERLAY_VISIBLE_LINES);
    if (matchesKey(data, "up")) this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (matchesKey(data, "down")) this.scrollOffset = Math.min(this.scrollOffset + 1, maxOffset);
    else if (matchesKey(data, "pageUp")) this.scrollOffset = Math.max(0, this.scrollOffset - OVERLAY_VISIBLE_LINES);
    else if (matchesKey(data, "pageDown")) this.scrollOffset = Math.min(this.scrollOffset + OVERLAY_VISIBLE_LINES, maxOffset);
    else if (matchesKey(data, "home")) this.scrollOffset = 0;
    else if (matchesKey(data, "end")) this.scrollOffset = maxOffset;
    else return;
    this.options.requestRender?.();
  }

  render(width: number): string[] {
    const { lines, theme } = this.options;
    const safe = Math.max(20, width);
    const count = overlayPeerCount(lines);
    const title = count === null ? "intercom" : `intercom · ${count} peer${count === 1 ? "" : "s"}`;
    const out = [theme.bold(title), ""];
    const maxOffset = Math.max(0, lines.length - OVERLAY_VISIBLE_LINES);
    const offset = Math.min(this.scrollOffset, maxOffset);
    const visible = lines.slice(offset, offset + OVERLAY_VISIBLE_LINES);
    for (const line of visible) {
      const trimmed = line.trim();
      if (trimmed.startsWith("This session is")) out.push(theme.fg("dim", truncateToWidth(line, safe)));
      else if (/^Peer sessions \(\d+\):/.test(trimmed)) out.push(theme.bold(truncateToWidth(line, safe)));
      else if (trimmed === "No other sessions.") out.push(theme.fg("dim", truncateToWidth(line, safe)));
      else if (/^\s\s\S/.test(line)) out.push(truncateToWidth(styleOverlayRow(line, theme), safe));
      else out.push(truncateToWidth(line, safe));
    }
    if (lines.length > OVERLAY_VISIBLE_LINES) {
      out.push(theme.fg("dim", `… ${offset} more above · ${maxOffset - offset} more below · ↑↓ scroll`));
    }
    out.push(theme.fg("dim", "esc closes"));
    return out.map((line) => truncateToWidth(line, safe));
  }
}

/** /intercom: the roster overlay on a TUI, the roster text otherwise. */
export async function runIntercom(pi: ExtensionAPI, ctx: CommandCtx, deps: IntercomCommandDeps = {}): Promise<void> {
  let text: string;
  try {
    text = (await rosterEntries(pi, ctx, deps)).text;
  } catch (error) {
    ctx.ui.notify((error as Error)?.message ?? String(error), "error");
    return;
  }
  const lines = text.split("\n");
  const custom = ctx.ui.custom;
  const canOverlay = ctx.mode === "tui" && ctx.hasUI === true && typeof custom === "function";
  if (!canOverlay) {
    ctx.ui.notify(text, "info");
    return;
  }
  try {
    await custom<void>(
      (tui: any, theme: any, _keybindings: any, done: (result: void) => void) => {
        const overlay = new IntercomRosterOverlay({
          lines,
          theme,
          close: () => {
            done(undefined);
          },
          requestRender: () => {
            try {
              tui.requestRender();
            } catch {
              /* render is best effort */
            }
          },
        });
        return overlay as any;
      },
      { overlay: true, overlayOptions: { width: 88 } },
    );
  } catch {
    ctx.ui.notify(text, "info");
  }
}

function cleanName(value: unknown, max = 128): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (!text || text.length > max) return null;
  return text;
}

export interface RenameResult {
  ok: boolean;
  name?: string;
  error?: string;
}

/**
 * /rename: set this session's name in both registries the roster reads.
 * Never renames to blank; a failing Claude entry patch warns but keeps the
 * Pi rename (the Pi registry is the roster's primary source).
 */
export async function runRename(pi: ExtensionAPI, args: string, ctx: CommandCtx, deps: IntercomCommandDeps = {}): Promise<RenameResult> {
  const wanted = cleanName(args);
  if (!wanted) {
    let current = "";
    try {
      current = pi.getSessionName?.()?.trim() ?? "";
    } catch {
      current = "";
    }
    ctx.ui.notify(
      current ? `Session name: ${current} (usage: /rename <name>)` : "No session name set. Usage: /rename <name>",
      current ? "info" : "warning",
    );
    return { ok: false, error: "empty" };
  }
  // A name another live session already has is refused R7-style, before
  // anything is renamed: the roster (and I5's SendMessage) could not
  // address either session by it. Entries sharing the own session id are
  // the own session on both transports, never a conflict. Without the own
  // id the check cannot attribute self, so it is skipped.
  const ownSessionId = ownSessionIdOf(ctx);
  if (ownSessionId) {
    try {
      const { entries } = await rosterEntries(pi, ctx, deps);
      const holders = entries.filter((entry) => entry.name === wanted && entry.sessionId !== ownSessionId);
      if (holders.length > 0) {
        const named = holders.map((entry) => `${entry.name} [${entry.sessionId ?? entry.kind}]`).join(", ");
        ctx.ui.notify(`Session name "${wanted}" is already taken by another live session: ${named}`, "warning");
        return { ok: false, error: "taken" };
      }
    } catch {
      /* an unreadable roster never blocks the local rename */
    }
  }
  pi.setSessionName(wanted);
  try {
    // A /rename is explicitly human-chosen: advertise nameSource "user" so
    // Claude's /list-agents shows the name instead of "(unnamed session)".
    await (deps.updateName ?? ((pid: number, patch: { name?: string; nameSource?: string }) => updatePiPeer(pid, patch, deps.sessionsDir)))(process.pid, { name: wanted, nameSource: "user" });
  } catch (error) {
    ctx.ui.notify(`Session name set to ${wanted}, but the Claude registry entry kept its old name: ${(error as Error)?.message ?? String(error)}`, "warning");
    return { ok: true, name: wanted };
  }
  ctx.ui.notify(`Session name set to ${wanted}`, "info");
  return { ok: true, name: wanted };
}

/** Register /intercom and /rename. No /alias, no /intercom-pool, no /handover. */
export function registerIntercomCommands(pi: ExtensionAPI, deps: IntercomCommandDeps = {}): void {
  pi.registerCommand("intercom", {
    description: "Open the intercom roster overlay",
    handler: async (_args, ctx) => {
      await runIntercom(pi, ctx as unknown as CommandCtx, deps);
    },
  });
  pi.registerCommand("rename", {
    description: "Set this session's name (usage: /rename <name>)",
    handler: async (args, ctx) => {
      await runRename(pi, args, ctx as unknown as CommandCtx, deps);
    },
  });
}
