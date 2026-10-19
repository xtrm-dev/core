import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { ALWAYS_ON, buildPrimer, dispatcherLine, excerpt, MARKER, missingSections, resetPrimerWarnings, resolveHome } from "../extensions/xtrm-primer/index.ts";

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
  // The warn cache is process-wide: without this, an earlier test that warns
  // for a skill would silence the warning in a later one.
  resetPrimerWarnings();
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

  test("no skills or an unreadable file still emits the folded always-on block and does not throw", () => {
    for (const out of [
      buildPrimer(home({}), {}) as string,
      buildPrimer(join(tmpdir(), "xtrm-primer-nonexistent-home"), {}) as string,
    ]) {
      expect(out).toContain(ALWAYS_ON);
      expect(out).not.toContain("CONTRACT-BODY");
    }
    const h = home({});
    // SKILL.md as a directory: readFileSync throws EISDIR.
    mkdirSync(join(h, ".xtrm", "skills", "default", "using-xtrm", "SKILL.md"), { recursive: true });
    expect(buildPrimer(h, {}) as string).toContain(ALWAYS_ON);
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

describe("heading-rename warning dedup (CORE-2405)", () => {
  test("two turns warn once per skill per process (CORE-2405)", async () => {
    resetPrimerWarnings();
    const prevHome = process.env.HOME;
    const warns: string[] = [];
    const orig = console.warn;
    try {
      process.env.HOME = home({ "using-xtrm": USING.replace("## Completion rule", "## Completion rules"), multiplexing: MUX });
      console.warn = (...args: unknown[]) => void warns.push(args.map(String).join(" "));
      let handler: any;
      register({ on: (e: string, hh: any) => e === "before_agent_start" && (handler = hh) } as any);
      await handler({ systemPrompt: "BASE" });
      await handler({ systemPrompt: "BASE" });
    } finally {
      console.warn = orig;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
    expect(warns.join("\n")).toContain("Completion rule");
    expect(warns.filter((w) => w.includes("using-xtrm"))).toHaveLength(1);
  });
});

describe("dedup bounded", () => {
  test("repeated turns with marker stay single-append (no accumulation)", async () => {
    const h = home({ "using-xtrm": USING });
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = h;
      let handler: any;
      register({ on: (e: string, hh: any) => e === "before_agent_start" && (handler = hh) } as any);
      let prompt = "BASE";
      for (let i = 0; i < 5; i++) {
        const res = await handler({ systemPrompt: prompt });
        if (res) prompt = res.systemPrompt;
      }
      expect(prompt.split(MARKER)).toHaveLength(2);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
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
    expect(out).toContain(ALWAYS_ON);
  });

  test("dispatcher line stands first with the always-on block following when no skill yields a section", () => {
    const out = buildPrimer(home({}), ENV) as string;
    expect(out.startsWith(dispatcherLine(ENV) as string)).toBe(true);
    expect(out).toContain(ALWAYS_ON);
  });
});

describe("xtrm-primer extension (CORE-2394)", () => {
  const ENV = {
    XTRM_DISPATCHER_NAME: "coord-1",
    XTRM_DISPATCHER_ADDRESS: "uds:/run/user/1000/cc-socks/42.sock",
    SUBSTRATE_HOLDER: "worker-a",
  };
  const KEYS = ["HOME", ...Object.keys(ENV)] as const;
  let saved: Record<string, string | undefined> = {};

  function withEnv(vars: Record<string, string>): void {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
  }

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    saved = {};
  });

  function load(): (event: any) => Promise<any> {
    let handler: any;
    register({ on: (e: string, h: any) => e === "before_agent_start" && (handler = h) } as any);
    return handler;
  }

  test("appends the primer and dispatcher line to the system prompt, with no user-role message", async () => {
    withEnv({ HOME: home({ "using-xtrm": USING }), ...ENV });
    const result = await load()({ systemPrompt: "BASE" });
    expect(result.message).toBeUndefined();
    expect(result.systemPrompt.startsWith("BASE\n\n")).toBe(true);
    expect(result.systemPrompt).toContain(MARKER);
    expect(result.systemPrompt).toContain("CONTRACT-BODY");
    expect(result.systemPrompt).toContain(dispatcherLine(ENV));
  });

  test("applies on every turn (resume, compaction) because the override is per turn", async () => {
    withEnv({ HOME: home({ "using-xtrm": USING }) });
    const handler = load();
    expect((await handler({ systemPrompt: "BASE" })).systemPrompt).toContain("CONTRACT-BODY");
    expect((await handler({ systemPrompt: "BASE" })).systemPrompt).toContain("CONTRACT-BODY");
  });

  test("two loaded copies append once per turn: the second sees the marker", async () => {
    withEnv({ HOME: home({ "using-xtrm": USING }) });
    const [a, b] = [load(), load()];
    const first = await a({ systemPrompt: "BASE" });
    expect(await b({ systemPrompt: first.systemPrompt })).toBeUndefined();
    expect(first.systemPrompt.split(MARKER)).toHaveLength(2);
  });

  test("no skills and no dispatcher env still injects the always-on block; a malformed event leaves the turn untouched", async () => {
    withEnv({ HOME: home({}) });
    for (const k of Object.keys(ENV)) delete process.env[k];
    const handler = load();
    const result = await handler({ systemPrompt: "BASE" });
    expect(result.systemPrompt).toContain(MARKER);
    expect(result.systemPrompt).toContain(ALWAYS_ON);
    expect(result.message).toBeUndefined();
    expect(await handler({})).toBeUndefined();
  });
});

describe("folded always-on block (XT-138/XT-139, audit fixes CORE-2475)", () => {
  test("ships unconditionally, even with no skills and no dispatcher env", () => {
    const out = buildPrimer(home({}), {}) as string;
    expect(out).toContain("XTRM always-on rules");
    expect(out).toContain(ALWAYS_ON);
  });

  test("(1) rejection semantics: reject-only-on-failure, outputSchema/MCP resolve with isError+structuredContent, pinned to Pi 1.3.0", () => {
    expect(ALWAYS_ON).toContain("rejects only when it failed, was blocked, or had invalid args");
    expect(ALWAYS_ON).toContain("isError + structuredContent");
    expect(ALWAYS_ON).toContain("Pi 1.3.0 docs/codemode.md:44,48, extensions.md:147");
  });

  test("(2) ast_grep guidance is session-scoped and notes its absence from Pi dist", () => {
    expect(ALWAYS_ON).toContain("Session-scoped ast_grep");
    expect(ALWAYS_ON).toContain("absent from Pi 1.3.0 dist/core/tools");
  });

  test("(3) background-monitor rule covers shell/streaming waits only, native agent waits excluded", () => {
    expect(ALWAYS_ON).toContain("Shell/streaming waits only");
    expect(ALWAYS_ON).toContain("BashBackground/Monitor");
    expect(ALWAYS_ON).toContain("Native agent waits");
    expect(ALWAYS_ON).toContain("excluded");
    expect(ALWAYS_ON).not.toContain("always set background monitors");
  });

  test("(4) SendMessage/ListAgents labeled repo intercom extension, never Pi-native", () => {
    expect(ALWAYS_ON).toContain("SendMessage + ListAgents from the repo intercom extension (never Pi-native)");
  });

  test("(5) reconcile cites the status-suggested /updating-service-knowledge action, scoped to installed packs", () => {
    expect(ALWAYS_ON).toContain("/updating-service-knowledge");
    expect(ALWAYS_ON).toContain("where its pack is installed");
    expect(ALWAYS_ON).toContain("last_sync_ref");
  });

  test("(6) python/preflight/background tagged repo-extension, bun/tsx/cargo/dolt are environment guidance, runner sentence kept", () => {
    expect(ALWAYS_ON).toContain("are repo-extension capabilities");
    expect(ALWAYS_ON).toContain("preflight()");
    expect(ALWAYS_ON).toContain("are environment guidance");
    expect(ALWAYS_ON).toContain("bun/tsx");
    expect(ALWAYS_ON).toContain("Project runner:");
    expect(ALWAYS_ON).toContain("uv run, .venv/bin/python, npm/bun run");
  });

  test("(7) all Pi citations pin installed 1.3.0", () => {
    expect(ALWAYS_ON).toMatch(/Pi 1\.3\.0/);
  });
});
