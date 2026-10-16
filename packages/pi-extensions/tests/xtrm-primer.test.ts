import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { buildPrimer, CLAIM_MAX, CUSTOM_TYPE, dispatcherLine, excerpt, missingSections, resolveHome } from "../extensions/xtrm-primer/index.ts";

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

describe("HOME per-call regression (#741)", () => {
  test("mutating HOME between calls changes the resolved home (fails on cached homedir)", () => {
    const a = home({ "using-xtrm": USING });
    const b = home({ "using-xtrm": USING.replace("CONTRACT-BODY", "SECOND-HOME-BODY") });
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      delete process.env.USERPROFILE;
      process.env.HOME = a;
      const first = buildPrimer(undefined, process.env) as string;
      expect(first).toContain("CONTRACT-BODY");
      process.env.HOME = b;
      const second = buildPrimer(undefined, process.env) as string;
      expect(second).toContain("SECOND-HOME-BODY");
      expect(second).not.toContain("CONTRACT-BODY");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
  });

  test("default buildPrimer() follows runtime HOME without an explicit arg", () => {
    const a = home({ "using-xtrm": USING });
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      delete process.env.USERPROFILE;
      process.env.HOME = a;
      expect(buildPrimer() as string).toContain("CONTRACT-BODY");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
  });
});

describe("resolveHome / USERPROFILE", () => {
  test("prefers HOME, then USERPROFILE, then homedir", () => {
    expect(resolveHome({ HOME: "/h", USERPROFILE: "/u" })).toBe("/h");
    expect(resolveHome({ USERPROFILE: "/u" } as any)).toBe("/u");
  });

  test("falls back to USERPROFILE when HOME is unset (Windows)", () => {
    const h = home({ "using-xtrm": USING });
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      delete process.env.HOME;
      process.env.USERPROFILE = h;
      const out = buildPrimer(undefined, process.env) as string;
      expect(out).toContain("CONTRACT-BODY");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
  });
});

describe("frontmatter CRLF/BOM", () => {
  const SECTIONS = ["The system contract", "Completion rule"] as const;
  test("strips CRLF frontmatter", () => {
    const crlf = "---\r\nname: using-xtrm\r\n---\r\n# Using\r\n\r\nPreamble U.\r\n\r\n## The system contract\r\n\r\nCONTRACT-BODY\r\n\r\n## Completion rule\r\n\r\nCOMPLETION-BODY\r\n";
    const out = excerpt(crlf, SECTIONS);
    expect(out).toContain("CONTRACT-BODY");
    expect(out).toContain("COMPLETION-BODY");
    expect(out).not.toContain("name: using-xtrm");
  });

  test("strips BOM frontmatter", () => {
    const bom = "\uFEFF---\nname: using-xtrm\n---\n# Using\n\nPreamble U.\n\n## The system contract\n\nCONTRACT-BODY\n";
    const out = excerpt(bom, ["The system contract"]);
    expect(out).toContain("CONTRACT-BODY");
    expect(out).not.toContain("name: using-xtrm");
    expect(out).not.toContain("\uFEFF");
  });

  test("buildPrimer reads CRLF/BOM skill files", () => {
    const crlfUsing = USING.replace(/\n/g, "\r\n");
    const out1 = buildPrimer(home({ "using-xtrm": crlfUsing })) as string;
    expect(out1).toContain("CONTRACT-BODY");
    expect(out1).not.toContain("name: using-xtrm");
    const bomUsing = `\uFEFF${USING}`;
    const out2 = buildPrimer(home({ "using-xtrm": bomUsing })) as string;
    expect(out2).toContain("CONTRACT-BODY");
  });
});

describe("renamed heading detectable", () => {
  test("missingSections lists renamed headings", () => {
    const renamed = USING.replace("## Completion rule", "## Completion rules");
    expect(missingSections(USING, ["The system contract", "Completion rule"])).toEqual([]);
    expect(missingSections(renamed, ["The system contract", "Completion rule"])).toEqual(["Completion rule"]);
  });

  test("buildPrimer warns when a requested section is missing", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" "));
    try {
      const out = buildPrimer(home({ "using-xtrm": USING.replace("## Completion rule", "## Completion rules") })) as string;
      expect(out).toContain("CONTRACT-BODY");
      expect(out).not.toContain("COMPLETION-BODY");
      expect(warns.join("\n")).toContain("Completion rule");
    } finally {
      console.warn = orig;
    }
  });
});

describe("claim set bounded", () => {
  test("claim set never exceeds CLAIM_MAX across many sessions (evicts oldest)", async () => {
    const key = Symbol.for("xtrm-primer.injected-sessions");
    const g = globalThis as Record<symbol, Set<string> | undefined>;
    const prevClaims = g[key];
    g[key] = new Set<string>();
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    try {
      delete process.env.USERPROFILE;
      process.env.HOME = home({ "using-xtrm": USING });
      const total = CLAIM_MAX + 10;
      for (let i = 0; i < total; i++) {
        const handlers: Record<string, (...a: any[]) => any> = {};
        register({ on: (e: string, h: any) => (handlers[e] = h) } as any);
        const id = `s-bound-${i}`;
        await handlers.session_start({}, { sessionManager: { getBranch: () => [], getSessionId: () => id } });
        const res = await handlers.before_agent_start({});
        expect(res?.message?.customType).toBe(CUSTOM_TYPE);
      }
      expect(g[key]?.size).toBeLessThanOrEqual(CLAIM_MAX);
      // Oldest evicted: a fresh copy for the first session re-injects (fail-safe duplicate).
      const handlers: Record<string, (...a: any[]) => any> = {};
      register({ on: (e: string, h: any) => (handlers[e] = h) } as any);
      await handlers.session_start({}, { sessionManager: { getBranch: () => [], getSessionId: () => "s-bound-0" } });
      expect((await handlers.before_agent_start({}))?.message?.customType).toBe(CUSTOM_TYPE);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevClaims === undefined) delete g[key];
      else g[key] = prevClaims;
    }
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

  test("injected message carries the primer and dispatcher line", async () => {
    const ENV = {
      XTRM_DISPATCHER_NAME: "coord-1",
      XTRM_DISPATCHER_ADDRESS: "uds:/run/user/1000/cc-socks/42.sock",
      SUBSTRATE_HOLDER: "worker-a",
    };
    const prevHome = process.env.HOME;
    const prevEnv = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
    try {
      process.env.HOME = home({ "using-xtrm": USING });
      Object.assign(process.env, ENV);
      const handlers: Record<string, (...a: any[]) => any> = {};
      register({ on: (e: string, h: any) => (handlers[e] = h) } as any);
      await handlers.session_start({}, { sessionManager: { getBranch: () => [], getSessionId: () => "s-dispatch" } });
      const first = await handlers.before_agent_start({});
      expect(first.message.customType).toBe(CUSTOM_TYPE);
      expect(first.message.content).toContain("CONTRACT-BODY");
      expect(first.message.content).toContain(dispatcherLine(ENV));
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      for (const k of Object.keys(ENV)) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
    }
  });

  test("no skills and no dispatcher env injects nothing and does not throw", async () => {
    const prevHome = process.env.HOME;
    const prevDispatch = ["XTRM_DISPATCHER_NAME", "XTRM_DISPATCHER_ADDRESS", "SUBSTRATE_HOLDER"].map((k) => process.env[k]);
    try {
      process.env.HOME = home({});
      for (const k of ["XTRM_DISPATCHER_NAME", "XTRM_DISPATCHER_ADDRESS", "SUBSTRATE_HOLDER"]) delete process.env[k];
      const handlers: Record<string, (...a: any[]) => any> = {};
      register({ on: (e: string, h: any) => (handlers[e] = h) } as any);
      await handlers.session_start({}, { sessionManager: { getBranch: () => [], getSessionId: () => "s-empty" } });
      expect(await handlers.before_agent_start({})).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      ["XTRM_DISPATCHER_NAME", "XTRM_DISPATCHER_ADDRESS", "SUBSTRATE_HOLDER"].forEach((k, i) => {
        if (prevDispatch[i] === undefined) delete process.env[k];
        else process.env[k] = prevDispatch[i] as string;
      });
    }
  });
});
