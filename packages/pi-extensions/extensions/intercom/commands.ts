/**
 * Intercom commands (CORE-2435 I4, XT-91 ADR rev 2 + amendment 1).
 *
 * /intercom opens a read-only roster overlay: the same ListAgents text the
 * model tool prints, in an operator overlay that closes on esc. Sending from
 * the overlay is I5's (SendMessage), not this slice's. Without a TUI the
 * command notifies the roster text instead of opening anything.
 *
 * /rename sets this session's name, replacing pi-intercom's /alias (there is
 * deliberately no /alias, no /intercom-pool and no /handover). The rename
 * reaches both registries the roster reads: pi.setSessionName fires
 * session_info_changed, which the agent-host bridge re-emits as identity so
 * the Pi roster updates; the Claude entry is patched through updatePiPeer,
 * which only touches the entry this session owns and leaves foreign entries
 * (pi-claude-link until M1) alone.
 *
 * Lineage: the overlay and rename behaviours are informed by pi-intercom
 * 0.17.1 (ADOPTION-CREDITS.md: principal behaviour source). Clean
 * reimplementation otherwise.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
  updateName?: (pid: number, patch: { name: string }) => Promise<void>;
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
  const [piSessions, claudePeers] = await Promise.all([
    (deps.fetchPi ?? (() => fetchPiSessions()))().catch(() => []),
    (deps.fetchClaude ?? ((excludeSock?: string) => listClaudeSessions(excludeSock ? { excludeSock } : {})))(deps.excludeSock).catch(() => []),
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

/**
 * The overlay's whole keyboard: literal input sequences, no keybinding
 * table. A shared matcher (pi-tui matchesKey) reads false under the
 * process-wide test mocks of neighbouring suites, which broke this overlay
 * in full-suite runs; these six keys have stable sequences.
 */
function overlayKey(data: string): "close" | "up" | "down" | "pageUp" | "pageDown" | "home" | "end" | null {
  if (data === "\u001b" || data === "q" || data === "Q" || data === "\u0003" || data === "\r") return "close";
  if (data === "\u001b[A") return "up";
  if (data === "\u001b[B") return "down";
  if (data === "\u001b[5~") return "pageUp";
  if (data === "\u001b[6~") return "pageDown";
  if (data === "\u001b[H" || data === "\u001b[1~") return "home";
  if (data === "\u001b[F" || data === "\u001b[4~") return "end";
  return null;
}

export interface RosterOverlayOptions {
  lines: string[];
  theme: { fg(color: string, text: string): string; bold(text: string): string };
  close: () => void;
  requestRender?: () => void;
}

const OVERLAY_VISIBLE_LINES = 20;

/** Read-only roster overlay: the ListAgents text, scrollable, esc closes. */
export class IntercomRosterOverlay {
  private scrollOffset = 0;

  constructor(private readonly options: RosterOverlayOptions) {}

  handleInput(data: string): void {
    const key = overlayKey(data);
    if (key === "close") {
      this.options.close();
      return;
    }
    const maxOffset = Math.max(0, this.options.lines.length - OVERLAY_VISIBLE_LINES);
    if (key === "up") this.scrollOffset = Math.min(this.scrollOffset + 1, maxOffset);
    else if (key === "down") this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    else if (key === "pageUp") this.scrollOffset = Math.min(this.scrollOffset + OVERLAY_VISIBLE_LINES, maxOffset);
    else if (key === "pageDown") this.scrollOffset = Math.max(0, this.scrollOffset - OVERLAY_VISIBLE_LINES);
    else if (key === "home") this.scrollOffset = maxOffset;
    else if (key === "end") this.scrollOffset = 0;
    else return;
    this.options.requestRender?.();
  }

  render(width: number): string[] {
    const { lines, theme } = this.options;
    const safe = Math.max(20, width);
    const out = [theme.bold("intercom"), ""];
    const maxOffset = Math.max(0, lines.length - OVERLAY_VISIBLE_LINES);
    const offset = Math.min(this.scrollOffset, maxOffset);
    const visible = lines.slice(offset, offset + OVERLAY_VISIBLE_LINES);
    for (const line of visible) out.push(truncateToWidth(line, safe));
    if (lines.length > OVERLAY_VISIBLE_LINES) {
      out.push(theme.fg("dim", `… ${maxOffset - offset} more above · ${offset} below · ↑↓ scroll`));
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
    await (deps.updateName ?? ((pid: number, patch: { name: string }) => updatePiPeer(pid, patch, deps.sessionsDir)))(process.pid, { name: wanted });
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
