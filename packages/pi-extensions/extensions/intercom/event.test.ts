/**
 * Intercom rendering through the shared event module (CORE-2438 I7).
 *
 * The intercom extension registers one `intercom_message` renderer that maps
 * the injected wake details to the shared card: ● identity, tinted state,
 * dim facts, up to 3 preview lines with the ctrl+o expander hint, and the
 * Claude-style › Message preview for incoming messages.
 */

import { describe, expect, test } from "bun:test";

import { INTERCOM_MESSAGE_TYPE } from "./index.ts";

const { default: intercomExtension } = await import("./index.ts");

type Renderer = (message: unknown, options: unknown, theme: unknown) => unknown;

function fakePiWithRenderer() {
  const renderers = new Map<string, Renderer>();
  const pi = {
    on: () => () => {},
    sendUserMessage: () => {},
    sendMessage: () => {},
    getSessionName: () => "probe",
    getSettings: () => ({}),
    getAllTools: () => [],
    registerTool: () => {},
    registerCommand: () => {},
    setSessionName: () => {},
    registerMessageRenderer: (type: string, fn: Renderer) => {
      renderers.set(type, fn);
    },
  };
  return { pi: pi as never, renderers };
}

function tagTheme(mode: string) {
  return {
    fg: (token: string, text: string) => `<${mode}:${token}>${text}</${mode}:${token}>`,
    bold: (text: string) => `<${mode}:bold>${text}</${mode}:bold>`,
  };
}

function visible(text: string | string[]): string[] {
  const lines = Array.isArray(text) ? text : text.split("\n");
  return lines.map((l) => l.replace(/<[^>]+>/g, ""));
}

describe("intercom card rendering through the shared module (CORE-2438 I7)", () => {
  test("the extension registers the intercom_message renderer", () => {
    const { pi, renderers } = fakePiWithRenderer();
    intercomExtension(pi, { env: {}, exec: async () => "" } as never);
    expect(renderers.has(INTERCOM_MESSAGE_TYPE)).toBe(true);
  });

  test("an inbound wake renders the › Message preview with dim facts", () => {
    const { pi, renderers } = fakePiWithRenderer();
    intercomExtension(pi, { env: {}, exec: async () => "" } as never);
    const renderer = renderers.get(INTERCOM_MESSAGE_TYPE) as unknown as (
      message: unknown,
      options: unknown,
      theme: unknown,
    ) => { render: (width: number) => string[] };
    const lines = visible(
      renderer(
        {
          content: "ignored: the card reads details",
          details: { messageId: "m7", payloadRef: "hello world\nsecond line", from: "bob", fromName: "Bob" },
        },
        {},
        tagTheme("dark"),
      ).render(80).join("\n"),
    );
    expect(lines[0]).toBe("● @Bob delivered");
    expect(lines[1]).toBe("  › Message from @Bob: hello world");
    expect(lines[2]).toBe("  second line  m7");
  });

  test("a long inbound wake wraps at the render width with the ctrl+o hint", () => {
    const { pi, renderers } = fakePiWithRenderer();
    intercomExtension(pi, { env: {}, exec: async () => "" } as never);
    const renderer = renderers.get(INTERCOM_MESSAGE_TYPE) as unknown as (
      message: unknown,
      options: unknown,
      theme: unknown,
    ) => { render: (width: number) => string[] };
    const ref = ["one", "two", "three", "four", "five", "six"].join("\n");
    const at80 = visible(
      renderer({ details: { messageId: "m8", payloadRef: ref, from: "bob" } }, {}, tagTheme("light")).render(80),
    );
    expect(at80).toHaveLength(1 + 3 + 1);
    expect(at80[at80.length - 1]).toBe("  +3 lines · ctrl+o expands");
    for (const line of at80) expect(line.length).toBeLessThanOrEqual(80);
  });

  test("a message without details renders nothing", () => {
    const { pi, renderers } = fakePiWithRenderer();
    intercomExtension(pi, { env: {}, exec: async () => "" } as never);
    const renderer = renderers.get(INTERCOM_MESSAGE_TYPE) as unknown as (
      message: unknown,
      options: unknown,
      theme: unknown,
    ) => unknown;
    expect(renderer({ content: "no details" }, {}, tagTheme("light"))).toBeUndefined();
  });
});
