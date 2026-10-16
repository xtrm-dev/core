import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { buildPrimer, dispatcherLine, MARKER } from "../extensions/xtrm-primer/index.ts";

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

  test("no skills and no dispatcher env, or a malformed event, leave the turn untouched", async () => {
    withEnv({ HOME: home({}) });
    for (const k of Object.keys(ENV)) delete process.env[k];
    const handler = load();
    expect(await handler({ systemPrompt: "BASE" })).toBeUndefined();
    expect(await handler({})).toBeUndefined();
  });
});
