import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { buildPrimer, CUSTOM_TYPE, dispatcherLine } from "../extensions/xtrm-primer/index.ts";

const homes: string[] = [];

function home(skills: Record<string, string>): string {
  const h = mkdtempSync(join(tmpdir(), "xtrm-primer-"));
  homes.push(h);
  for (const [name, text] of Object.entries(skills)) {
    const dir = join(h, ".xtrm", "skills", "default", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), text);
  }
  return h;
}

afterEach(() => {
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
});

const USING = "---\nname: using-xtrm\n---\n# Using\n\nPreamble U.\n\n## The system contract\n\nCONTRACT-BODY\n\n## Completion rule\n\nCOMPLETION-BODY\n\n## Other\n\nOTHER-U\n";
const MUX = "---\nname: multiplexing\n---\n# Mux\n\nPreamble M.\n\n## Native first\n\nNATIVE-BODY\n\n## Durable work is separate from transport\n\nDURABLE-BODY\n\n## Failure rules\n\nFAILURE-BODY\n\n## Other\n\nOTHER-M\n";

describe("buildPrimer", () => {
  test("both skills present emit both skills, their sections and load pointers, without other sections", () => {
    const out = buildPrimer(home({ "using-xtrm": USING, multiplexing: MUX })) as string;
    for (const s of ["Preamble U.", "CONTRACT-BODY", "COMPLETION-BODY", "Preamble M.", "NATIVE-BODY", "DURABLE-BODY", "FAILURE-BODY", "/skill:using-xtrm", "/skill:multiplexing"]) {
      expect(out).toContain(s);
    }
    expect(out).not.toContain("OTHER-U");
    expect(out).not.toContain("OTHER-M");
  });

  test("a missing skill drops only that skill", () => {
    const out = buildPrimer(home({ "using-xtrm": USING })) as string;
    expect(out).toContain("CONTRACT-BODY");
    expect(out).not.toContain("NATIVE-BODY");
    expect(out).not.toContain("/skill:multiplexing");
  });

  test("a renamed heading drops only that section", () => {
    const out = buildPrimer(home({ "using-xtrm": USING.replace("## Completion rule", "## Completion rules"), multiplexing: MUX })) as string;
    expect(out).toContain("CONTRACT-BODY");
    expect(out).not.toContain("COMPLETION-BODY");
    expect(out).toContain("FAILURE-BODY");
  });

  test("no skills or an unreadable file emits nothing and does not throw", () => {
    expect(buildPrimer(home({}), {})).toBeNull();
    const h = home({});
    // SKILL.md as a directory: readFileSync throws EISDIR.
    mkdirSync(join(h, ".xtrm", "skills", "default", "using-xtrm", "SKILL.md"), { recursive: true });
    expect(buildPrimer(h, {})).toBeNull();
    expect(buildPrimer(join(tmpdir(), "xtrm-primer-nonexistent-home"), {})).toBeNull();
  });
});

describe("dispatcher line (CORE-2390)", () => {
  const ENV = {
    XTRM_DISPATCHER_NAME: "coord-1",
    XTRM_DISPATCHER_ADDRESS: "uds:/run/user/1000/cc-socks/42.sock",
    SUBSTRATE_HOLDER: "worker-a",
  };

  test("present when dispatcher env is set: names dispatcher, reply address and holder", () => {
    const out = buildPrimer(home({ "using-xtrm": USING }), ENV) as string;
    const first = out.split("\n", 1)[0];
    expect(first).toContain("coord-1");
    expect(first).toContain("uds:/run/user/1000/cc-socks/42.sock");
    expect(first).toContain("--holder worker-a");
    expect(out).toContain("CONTRACT-BODY");
  });

  test("absent without dispatcher env, even with SUBSTRATE_HOLDER set", () => {
    expect(dispatcherLine({})).toBeNull();
    expect(dispatcherLine({ SUBSTRATE_HOLDER: "worker-a" })).toBeNull();
    const out = buildPrimer(home({ "using-xtrm": USING }), { SUBSTRATE_HOLDER: "worker-a" }) as string;
    expect(out).not.toContain("Dispatcher:");
  });

  test("stands alone when no skill yields a section", () => {
    expect(buildPrimer(home({}), ENV)).toBe(dispatcherLine(ENV));
  });
});

describe("xtrm-primer extension", () => {
  test("injects once per session and not again when the branch already carries it", async () => {
    const prev = process.env.HOME;
    process.env.HOME = home({ "using-xtrm": USING });
    try {
      const handlers: Record<string, (...a: any[]) => any> = {};
      register({ on: (e: string, h: any) => (handlers[e] = h) } as any);
      await handlers.session_start({}, { sessionManager: { getBranch: () => [], getSessionId: () => "s-once" } });
      const first = await handlers.before_agent_start({});
      expect(first.message.customType).toBe(CUSTOM_TYPE);
      expect(first.message.display).toBe(false);
      expect(await handlers.before_agent_start({})).toBeUndefined();
      await handlers.session_start({}, { sessionManager: { getBranch: () => [{ customType: CUSTOM_TYPE }], getSessionId: () => "s-once" } });
      expect(await handlers.before_agent_start({})).toBeUndefined();
    } finally {
      process.env.HOME = prev;
    }
  });

  test("two loaded copies inject once per session", async () => {
    const prev = process.env.HOME;
    process.env.HOME = home({ "using-xtrm": USING });
    try {
      const copies = [0, 1].map(() => {
        const h: Record<string, (...a: any[]) => any> = {};
        register({ on: (e: string, fn: any) => (h[e] = fn) } as any);
        return h;
      });
      const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => "s-dup" } };
      for (const h of copies) await h.session_start({}, ctx);
      const results = [];
      for (const h of copies) results.push(await h.before_agent_start({}));
      expect(results.filter((r) => r?.message?.customType === CUSTOM_TYPE)).toHaveLength(1);
    } finally {
      process.env.HOME = prev;
    }
  });
});
