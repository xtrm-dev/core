import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const MAX_BUFFER_LINES = 2000;
const DEFAULT_VISIBLE_LINES = 24;
const RENDER_THROTTLE_MS = 100;
const ANSI_SGR_PATTERN = /^\x1b\[[0-9;]*m$/u;
const DISALLOWED_SGR_CODES = new Set([5, 6, 8]);

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function resetAnsi(text: string): string {
  return text.includes("\x1b") ? `${text}\x1b[0m` : text;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveSpFeedCommand(args: string): string {
  const trimmed = args.trim();
  return trimmed ? `sp feed -f ${trimmed}` : "sp feed -f";
}

function resolveSpPsCommand(args: string): string {
  const snapshotArgs = args
    .trim()
    .split(/\s+/u)
    .filter((part) => part && part !== "--follow" && part !== "-f")
    .join(" ");
  return snapshotArgs ? `sp ps ${snapshotArgs}` : "sp ps";
}

function openTerminalOverlay(ctx: ExtensionCommandContext, title: string, command: string): Promise<void> {
  return ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      const terminal = new StreamingTerminalOverlay({
        title,
        command,
        cwd: process.cwd(),
        theme,
        requestRender: () => {
          tui.requestRender();
        },
        close: () => {
          terminal.dispose();
          done(undefined);
        },
      });
      return terminal;
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 72,
        maxHeight: "80%",
        margin: 1,
      },
    } as Parameters<ExtensionCommandContext["ui"]["custom"]>[1],
  ).then(() => undefined);
}

type StreamingTerminalOverlayOptions = {
  title: string;
  command: string;
  cwd: string;
  theme: Theme;
  requestRender: () => void;
  close: () => void;
};

class StreamingTerminalOverlay {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: string[] = [];
  private currentLine = "";
  private screenLines: string[] = [];
  private cursorRow = 0;
  private cursorCol = 0;
  private terminalMode = false;
  private scrollOffset = 0;
  private status = "starting";
  private closed = false;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRenderAt = 0;

  constructor(private readonly options: StreamingTerminalOverlayOptions) {
    this.start();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.options.close();
      return;
    }
    if (matchesKey(data, "r")) {
      this.restart();
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollOffset = Math.min(this.scrollOffset + 1, Math.max(0, this.renderSourceLines().length - 1));
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, "pageup")) {
      this.scrollOffset = Math.min(this.scrollOffset + DEFAULT_VISIBLE_LINES, Math.max(0, this.renderSourceLines().length - 1));
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, "pagedown")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - DEFAULT_VISIBLE_LINES);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, "home")) {
      this.scrollOffset = Math.max(0, this.renderSourceLines().length - 1);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, "end")) {
      this.scrollOffset = 0;
      this.options.requestRender();
    }
  }

  render(width: number): string[] {
    const theme = this.options.theme;
    const overlayWidth = Math.max(40, width);
    const innerWidth = overlayWidth - 2;
    const contentWidth = Math.max(1, innerWidth - 2);
    const allLines = this.renderSourceLines();
    const visibleCount = DEFAULT_VISIBLE_LINES;
    const end = Math.max(0, allLines.length - this.scrollOffset);
    const start = Math.max(0, end - visibleCount);
    const visible = allLines.slice(start, end);
    const hiddenAbove = start;
    const hiddenBelow = Math.max(0, allLines.length - end);

    const border = (text: string) => theme.fg("border", text);
    const title = ` ${theme.fg("accent", theme.bold(this.options.title))} ${theme.fg("dim", this.status)} `;
    const top = border("╭") + truncateToWidth(title, Math.max(0, innerWidth), "") + border("─".repeat(Math.max(0, innerWidth - visibleWidth(title)))) + border("╮");
    const row = (content: string) => {
      const truncated = resetAnsi(truncateToWidth(content, contentWidth));
      return `${border("│")} ${padVisible(truncated, contentWidth)} ${border("│")}`;
    };

    const output = [top];
    output.push(row(theme.fg("dim", `$ ${this.options.command}`)));
    output.push(row(theme.fg("dim", "Esc/q close • r restart • ↑↓ scroll • PgUp/PgDn page")));
    output.push(row(""));
    const bodyRows: string[] = [];
    if (hiddenAbove > 0) bodyRows.push(theme.fg("dim", `… ${hiddenAbove} lines above`));
    bodyRows.push(...visible);
    if (visible.length === 0) bodyRows.push(theme.fg("dim", "waiting for output…"));
    if (hiddenBelow > 0) bodyRows.push(theme.fg("dim", `… ${hiddenBelow} lines below`));

    for (let index = 0; index < visibleCount; index++) {
      output.push(row(bodyRows[index] ?? ""));
    }
    output.push(border("╰" + "─".repeat(innerWidth) + "╯"));
    return output;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.stop();
  }

  private start(): void {
    this.stop();
    this.status = "running";
    this.lines = [];
    this.currentLine = "";
    this.screenLines = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.terminalMode = false;
    this.scrollOffset = 0;

    const shell = process.env.SHELL || "/bin/sh";
    this.child = spawn(shell, ["-lc", this.options.command], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
        TERM: process.env.TERM ?? "xterm-256color",
        COLUMNS: process.env.COLUMNS ?? "120",
        LINES: process.env.LINES ?? "40",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this.append(String(chunk)));
    this.child.stderr.on("data", (chunk) => this.append(String(chunk)));
    this.child.on("error", (error) => {
      this.status = "error";
      this.append(`\n[error] ${error.message}\n`);
    });
    this.child.on("close", (code, signal) => {
      this.flushCurrentLine();
      this.status = signal ? `stopped (${signal})` : `exited ${code ?? "unknown"}`;
      this.requestRenderSoon(true);
    });

    this.requestRenderSoon(true);
  }

  private restart(): void {
    this.start();
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 750).unref?.();
    }
  }

  private requestRenderSoon(immediate = false): void {
    if (this.closed) return;
    if (immediate) {
      if (this.renderTimer) clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
      this.lastRenderAt = Date.now();
      this.options.requestRender();
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastRenderAt;
    if (elapsed >= RENDER_THROTTLE_MS) {
      this.lastRenderAt = now;
      this.options.requestRender();
      return;
    }

    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.lastRenderAt = Date.now();
      this.options.requestRender();
    }, RENDER_THROTTLE_MS - elapsed);
    this.renderTimer.unref?.();
  }

  private renderSourceLines(): string[] {
    if (this.terminalMode) {
      return this.screenLines.map((line) => line.replace(/\s+$/u, ""));
    }
    return this.currentLine ? [...this.lines, this.currentLine] : this.lines;
  }

  private append(text: string): void {
    if (this.closed) return;
    for (let index = 0; index < text.length; index++) {
      const char = text[index]!;
      if (char === "\x1b") {
        const sgrMatch = text.slice(index).match(/^\x1b\[[0-9;]*m/u);
        if (sgrMatch?.[0]) {
          this.appendSafeSgr(sgrMatch[0]);
          index += sgrMatch[0].length - 1;
          continue;
        }
        const nextIndex = this.consumeEscape(text, index);
        if (nextIndex !== index) {
          index = nextIndex;
          continue;
        }
      }
      this.appendChar(char);
    }
    this.trimBuffer();
    this.requestRenderSoon();
  }

  private appendSafeSgr(sequence: string): void {
    if (!ANSI_SGR_PATTERN.test(sequence)) return;
    const params = sequence.slice(2, -1).split(";").filter(Boolean).map((part) => Number.parseInt(part, 10));
    if (params.some((param) => Number.isNaN(param) || DISALLOWED_SGR_CODES.has(param))) return;

    // Cursor-addressed dashboards need cell-aware mutation. Keeping raw SGR inside
    // screenLines makes cursorCol slicing unsafe, so preserve colors only for
    // append-only feed output.
    if (this.terminalMode) return;
    this.currentLine += sequence;
  }

  private appendChar(char: string): void {
    if (char === "\r") {
      if (this.terminalMode) this.cursorCol = 0;
      else this.currentLine = "";
      return;
    }
    if (char === "\n") {
      if (this.terminalMode) {
        this.cursorRow++;
        this.cursorCol = 0;
        this.ensureScreenLine(this.cursorRow);
      } else {
        this.flushCurrentLine();
      }
      return;
    }
    if (char === "\b" || char === "\x7f") {
      if (this.terminalMode) this.cursorCol = Math.max(0, this.cursorCol - 1);
      else this.currentLine = this.currentLine.slice(0, -1);
      return;
    }
    if (char < " " && char !== "\t") return;

    if (this.terminalMode) {
      this.writeScreenChar(char === "\t" ? " " : char);
      return;
    }
    this.currentLine += char;
  }

  private consumeEscape(text: string, start: number): number {
    const introducer = text[start + 1];
    if (introducer === "[") {
      let end = start + 2;
      while (end < text.length && !/[A-Za-z~]/.test(text[end]!)) end++;
      if (end >= text.length) return start;
      this.handleCsi(text.slice(start + 2, end), text[end]!);
      return end;
    }
    if (introducer === "]") {
      let end = start + 2;
      while (end < text.length) {
        if (text[end] === "\x07") return end;
        if (text[end] === "\x1b" && text[end + 1] === "\\") return end + 1;
        end++;
      }
      return start;
    }
    if (introducer) return start + 1;
    return start;
  }

  private handleCsi(params: string, final: string): void {
    const numbers = params
      .replace(/[?>!]/g, "")
      .split(";")
      .map((part) => Number.parseInt(part || "0", 10));
    const first = numbers[0] ?? 0;

    if (final === "m") return;
    if (final === "H" || final === "f") {
      this.enterTerminalMode();
      this.cursorRow = Math.max(0, (numbers[0] || 1) - 1);
      this.cursorCol = Math.max(0, (numbers[1] || 1) - 1);
      this.ensureScreenLine(this.cursorRow);
      return;
    }
    if (final === "J") {
      this.enterTerminalMode();
      if (first === 2 || first === 3) {
        this.screenLines = [];
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.ensureScreenLine(0);
      } else if (first === 0) {
        this.screenLines = this.screenLines.slice(0, this.cursorRow + 1);
        this.clearScreenLineFromCursor();
      }
      return;
    }
    if (final === "K") {
      this.enterTerminalMode();
      if (first === 2) this.screenLines[this.cursorRow] = "";
      else this.clearScreenLineFromCursor();
      return;
    }
    if (final === "A") {
      this.enterTerminalMode();
      this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, first));
      return;
    }
    if (final === "B") {
      this.enterTerminalMode();
      this.cursorRow += Math.max(1, first);
      this.ensureScreenLine(this.cursorRow);
      return;
    }
    if (final === "C") {
      this.enterTerminalMode();
      this.cursorCol += Math.max(1, first);
      return;
    }
    if (final === "D") {
      this.enterTerminalMode();
      this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, first));
    }
  }

  private enterTerminalMode(): void {
    if (this.terminalMode) return;
    this.terminalMode = true;
    this.screenLines = this.currentLine ? [...this.lines, this.currentLine] : [...this.lines];
    if (this.screenLines.length === 0) this.screenLines.push("");
    this.cursorRow = Math.max(0, this.screenLines.length - 1);
    this.cursorCol = visibleWidth(this.screenLines[this.cursorRow] ?? "");
    this.currentLine = "";
  }

  private ensureScreenLine(row: number): void {
    while (this.screenLines.length <= row) this.screenLines.push("");
  }

  private writeScreenChar(char: string): void {
    this.ensureScreenLine(this.cursorRow);
    const line = this.screenLines[this.cursorRow] ?? "";
    const padded = line.length < this.cursorCol ? line + " ".repeat(this.cursorCol - line.length) : line;
    this.screenLines[this.cursorRow] = padded.slice(0, this.cursorCol) + char + padded.slice(this.cursorCol + 1);
    this.cursorCol++;
  }

  private clearScreenLineFromCursor(): void {
    this.ensureScreenLine(this.cursorRow);
    this.screenLines[this.cursorRow] = (this.screenLines[this.cursorRow] ?? "").slice(0, this.cursorCol);
  }

  private flushCurrentLine(): void {
    if (this.terminalMode) return;
    this.lines.push(this.currentLine);
    this.currentLine = "";
    this.trimBuffer();
  }

  private trimBuffer(): void {
    if (this.lines.length > MAX_BUFFER_LINES) this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES);
    if (this.screenLines.length > MAX_BUFFER_LINES) this.screenLines.splice(0, this.screenLines.length - MAX_BUFFER_LINES);
  }
}

export default function spTerminalOverlayExtension(pi: ExtensionAPI): void {
  pi.registerCommand("sp-feed", {
    description: "Open a streaming overlay for `sp feed -f`",
    handler: async (args, ctx) => {
      await openTerminalOverlay(ctx, "sp feed", resolveSpFeedCommand(args));
    },
  });

  pi.registerCommand("sp-ps", {
    description: "Open a snapshot overlay for `sp ps`",
    handler: async (args, ctx) => {
      await openTerminalOverlay(ctx, "sp ps", resolveSpPsCommand(args));
    },
  });

  pi.registerCommand("xtrm-ps", {
    description: "Alias for /sp-ps",
    handler: async (args, ctx) => {
      await openTerminalOverlay(ctx, "sp ps", resolveSpPsCommand(args));
    },
  });

  pi.registerCommand("xtrm-terminal", {
    description: "Open a streaming terminal overlay for an arbitrary shell command",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command) {
        ctx.ui.notify("Usage: /xtrm-terminal <command>", "warning");
        return;
      }
      await openTerminalOverlay(ctx, command, command);
    },
  });

  pi.registerCommand("xtrm-terminal-file", {
    description: "Open a streaming overlay for a command with one shell-quoted file/path argument",
    handler: async (args, ctx) => {
      const [commandName, ...rest] = args.trim().split(/\s+/u);
      const fileArg = rest.join(" ");
      if (!commandName || !fileArg) {
        ctx.ui.notify("Usage: /xtrm-terminal-file <command> <path>", "warning");
        return;
      }
      await openTerminalOverlay(ctx, commandName, `${commandName} ${shellQuote(fileArg)}`);
    },
  });
}
