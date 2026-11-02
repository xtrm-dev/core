import { describe, expect, test } from "bun:test";

// CORE-2578: the overlay's 24-row window used to lose the NEWEST line as soon
// as an overflow marker appeared. These tests drive the real command handler
// and the real render path (a short-lived POSIX shell prints the lines), so
// they exercise the same component the operator sees, not a copy of its
// arithmetic.
//
// The pin: the last emitted body row is the newest source line, and the body
// is exactly DEFAULT_VISIBLE_LINES (24) rows whatever the buffer length.

import spTerminalOverlayExtension from "./index.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as never;

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function fakePi() {
  const commands = new Map<string, CommandHandler>();
  const pi = {
    registerCommand(name: string, spec: { handler: CommandHandler }) {
      commands.set(name, spec.handler);
      return () => {};
    },
  };
  return { pi, commands };
}

/** Open /xtrm-terminal and return the component `ctx.ui.custom` built. */
async function openTerminal(command: string): Promise<{ render(width: number): string[] }> {
  const { pi, commands } = fakePi();
  spTerminalOverlayExtension(pi as never);
  const handler = commands.get("xtrm-terminal");
  if (!handler) throw new Error("xtrm-terminal is not registered");

  let component: { render(width: number): string[] } | undefined;
  const ctx = {
    ui: {
      notify: () => {},
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: unknown) => unknown) => {
        component = factory({ requestRender: () => {} }, theme, {}, () => {}) as { render(width: number): string[] };
        return Promise.resolve(undefined);
      },
    },
  };
  await handler(command, ctx);
  if (!component) throw new Error("the overlay never built its component");
  return component;
}

/** Render until the child has closed and its status landed on the title. */
async function settledRows(component: { render(width: number): string[] }, timeoutMs = 8000): Promise<string[]> {
  const startedAt = Date.now();
  let rows = component.render(120);
  while (!rows[0]?.includes("exited") && Date.now() - startedAt < timeoutMs) {
    await Bun.sleep(20);
    rows = component.render(120);
  }
  if (!rows[0]?.includes("exited")) throw new Error(`overlay did not settle:\n${rows.join("\n")}`);
  return rows;
}

const HEADER_ROWS = 4;
const FOOTER_ROWS = 1;

function bodyRows(rows: string[]): string[] {
  return rows.slice(HEADER_ROWS, rows.length - FOOTER_ROWS);
}

describe("sp-terminal-overlay visible window", () => {
  test("keeps the newest line once the buffer passes the 24-row cap", async () => {
    // 30 distinct lines, the last one deliberately unterminated so it is the
    // streaming line and not an empty flush.
    const command = `i=0; while [ $i -lt 29 ]; do i=$((i+1)); printf 'L%s\\n' "$i"; done; printf 'L30'`;
    const component = await openTerminal(command);
    const rows = await settledRows(component);
    const body = bodyRows(rows);

    expect(body).toHaveLength(24);
    expect(rows).toHaveLength(HEADER_ROWS + 24 + FOOTER_ROWS);
    expect(body.at(-1)).toContain("L30");
    expect(body[0]).toContain("lines above");
  });

  test("a long buffer still ends on the newest line", async () => {
    const command = `i=0; while [ $i -lt 199 ]; do i=$((i+1)); printf 'L%s\\n' "$i"; done; printf 'L200'`;
    const component = await openTerminal(command);
    const rows = await settledRows(component);
    const body = bodyRows(rows);

    expect(body).toHaveLength(24);
    expect(body.at(-1)).toContain("L200");
    expect(body[0]).toContain("… 177 lines above");
  });
});

describe("sp-terminal-overlay failure status", () => {
  test("a non-zero exit leads with ! and a clean exit does not", async () => {
    const failed = await settledRows(await openTerminal("exit 3"));
    expect(failed[0]).toContain("! exited 3");
    expect(bodyRows(failed)).toHaveLength(24);

    const clean = await settledRows(await openTerminal("exit 0"));
    expect(clean[0]).toContain("exited 0");
    expect(clean[0]).not.toContain("! exited");
  });
});
