import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Offline and isolated: a temp HOME (no key file), a temp log and cache, no key in the environment.
const tmp = mkdtempSync(join(tmpdir(), "ss-worker-"));
process.env["HOME"] = tmp;
delete process.env["TYPESAFE_API_KEY"];
process.env["SKILL_SUGGEST_LOG_DIR"] = join(tmp, "log");
process.env["SKILL_SUGGEST_CACHE_DIR"] = join(tmp, "cache");
const { nudgeText, loadIndex, run, NUDGE_MAX } = await import("../worker/worker.ts");

const repo = join(tmp, "repo");
beforeAll(() => {
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".xtrm", "skills", "default", "demo"), { recursive: true });
  writeFileSync(join(repo, ".xtrm", "skills", "default", "demo", "SKILL.md"), "---\nname: demo\ndescription: Use when you debug a failing demo procedure.\n---\n# Demo\n");
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const entry = (over: Partial<Record<string, string>> = {}) => ({
  id: "demo", skill: "demo", level: "skill" as const, name: "demo", description: "Use when you debug a failing demo procedure.", path: "/abs/skills/demo/SKILL.md", headings: [], ...over,
});

describe("nudgeText", () => {
  it("is one line, names an absolute path and the rule text, and stays within 600 characters", () => {
    const n = nudgeText(entry(), "/w");
    expect(n.startsWith("[skill-suggest]")).toBe(true);
    expect(n).not.toContain("\n");
    expect(n).toContain("/abs/skills/demo/SKILL.md");
    expect(n).toContain("debug a failing demo procedure");
    expect(n.length).toBeLessThanOrEqual(NUDGE_MAX);
  });
  it("keeps the path and the closing instruction when the description is huge", () => {
    const n = nudgeText(entry({ description: "word ".repeat(400), path: "/abs/" + "d/".repeat(40) + "SKILL.md" }), "/w");
    expect(n.length).toBeLessThanOrEqual(NUDGE_MAX);
    expect(n).toContain("SKILL.md");
    expect(n.endsWith("Ignore it if it does not fit.")).toBe(true);
  });
  it("resolves a repo-relative roster path against the cwd", () => {
    const n = nudgeText(entry({ path: ".xtrm/skills/default/demo/SKILL.md" }), "/home/u/repo");
    expect(n).toContain(" Read /home/u/repo/.xtrm/skills/default/demo/SKILL.md ");
    expect(n).not.toMatch(/Read \.xtrm/);
  });
  it("names a reference by its parent skill", () => {
    expect(nudgeText(entry({ level: "reference", name: "Causal debugging", skill: "engineering-quality" }) as never, "/w")).toContain('reference "Causal debugging" of skill "engineering-quality"');
  });
});

describe("loadIndex disk cache", () => {
  it("misses, writes, then hits; a corrupt file is a miss, not an error", async () => {
    const a = await loadIndex(repo, 1_000);
    expect(a.cached).toBe(false);
    expect(a.index.entries.some((e) => e.id === "demo")).toBe(true);
    expect((await loadIndex(repo, 2_000)).cached).toBe(true);
    expect((await loadIndex(repo, 1_000 + 6 * 60_000)).cached).toBe(false); // past the TTL
    const f = readdirSync(join(tmp, "cache")).find((n) => n.startsWith("roster-"))!;
    writeFileSync(join(tmp, "cache", f), "{not json");
    expect((await loadIndex(repo, 3_000)).cached).toBe(false);
  });
});

describe("run: fail-open and offline", () => {
  it("a classifier outage is a skip with a reason, never a throw, and leaves a log row", async () => {
    const realFetch = globalThis.fetch;
    process.env["TYPESAFE_API_KEY"] = "test-key-not-real"; // never the real key file: the fetch below is the only door out
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    try {
      const out = await run({ cwd: repo, prompt: "debug the failing demo procedure in staging", sid: "s", epoch: "e" });
      expect(out).toEqual({ outcome: "skip", reason: "classifier:transport" });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env["TYPESAFE_API_KEY"];
    }
    await new Promise((r) => setTimeout(r, 50));
    const rows = readFileSync(join(tmp, "log", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.at(-1)).toMatchObject({ host: "claude", seam: "input", outcome: "skip", reason: "classifier:transport", sid: "s", epoch: "e" });
  });
});

describe("run: Jev failure modes and structured context", () => {
  const withFetch = async (status: number, body: unknown, f: () => Promise<unknown>) => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    process.env["TYPESAFE_API_KEY"] = "test-key-not-real";
    globalThis.fetch = (async (_u: unknown, init?: { body?: string }) => { seen.push(String(init?.body ?? "")); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    try { return { out: await f(), seen }; } finally { globalThis.fetch = realFetch; delete process.env["TYPESAFE_API_KEY"]; }
  };
  const input = { cwd: repo, prompt: "debug the failing demo procedure in staging", sid: "s", epoch: "e", issue: "CORE-2594", tools: ["Read", "Bash"], files: ["/repo/a.py"] };
  it("a 402 from Jev is a skip, never a nudge", async () => {
    const { out } = await withFetch(402, { error: "payment required" }, () => run(input));
    expect(out).toEqual({ outcome: "skip", reason: "classifier:http_402" });
  });
  it("sends the claimed Issue and the last tool names with the request (PRD 12b)", async () => {
    const { seen } = await withFetch(500, {}, () => run(input));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain("CORE-2594");
    expect(seen[0]).toContain("Read, Bash");
  });
  it("a request without context still works", async () => {
    const { out } = await withFetch(402, {}, () => run({ cwd: repo, prompt: "debug the failing demo procedure in staging" }));
    expect(out).toEqual({ outcome: "skip", reason: "classifier:http_402" });
  });
});

describe("worker process contract", () => {
  const exec = (input: string) => spawnSync("bun", [join(import.meta.dir, "..", "worker", "worker.ts")], { input, env: { PATH: process.env["PATH"] ?? "", HOME: tmp, SKILL_SUGGEST_LOG_DIR: join(tmp, "log"), SKILL_SUGGEST_CACHE_DIR: join(tmp, "cache") }, encoding: "utf8", timeout: 20_000 });
  it("prints exactly one JSON line on stdout and exits 0, even for bad input", () => {
    for (const input of ["", "not json", '{"cwd":1}', JSON.stringify({ cwd: repo, prompt: "debug the failing demo procedure in staging" })]) {
      const r = exec(input);
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(JSON.parse(lines[0]!)).toHaveProperty("outcome");
    }
  });
  it("with no key anywhere it skips with no_key and never reaches the network", () => {
    const r = exec(JSON.stringify({ cwd: repo, prompt: "debug the failing demo procedure in staging" }));
    expect(JSON.parse(r.stdout.trim())).toEqual({ outcome: "skip", reason: "no_key" });
  });
});
