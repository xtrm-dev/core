import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CACHE_WINDOW,
  detectGitContext,
  gitContextFrom,
  renderHud,
  summarizeHudUsage,
  type GitContext,
  type HudColors,
  type HudEntry,
} from "./hud.ts";

/** Theme stub that records the tokens it was asked for. */
function markTheme(): HudColors & { tokens: string[] } {
  const tokens: string[] = [];
  return {
    tokens,
    fg(token: string, text: string) {
      tokens.push(token);
      return `<${token}>${text}</${token}>`;
    },
    bold(text: string) {
      return `*${text}*`;
    },
  };
}

const usage = (sides: Record<string, number>): HudEntry => ({ message: { role: "assistant", usage: sides } });

describe("session usage scope", () => {
  test("sums session input/output and takes the cache rate as the median of recent responses", () => {
    const entries: HudEntry[] = [
      usage({ input: 10_000, output: 1_000, cacheRead: 30_000, cacheWrite: 2_000 }),
      usage({ input: 4_000, output: 500, cacheRead: 16_000, cacheWrite: 0 }),
    ];
    const result = summarizeHudUsage(entries);
    expect(result.input).toBe(14_000);
    expect(result.output).toBe(1_500);
    expect(result.cacheRead).toBe(46_000);
    // Per response: 30k/42k = 71.4% and 16k/20k = 80%. Median of two = their mean.
    expect(result.cacheRate).toBeCloseTo(75.71, 1);
    expect(result.lastCacheRate).toBeCloseTo(80, 5);
  });

  test("one outlier does not move the median; only the last-response flag shows it", () => {
    const hit = usage({ input: 1_000, output: 100, cacheRead: 99_000 });
    const miss = usage({ input: 100_000, output: 100, cacheRead: 0, cacheWrite: 0 });
    const result = summarizeHudUsage([hit, hit, hit, hit, miss]);
    expect(result.cacheRate).toBeCloseTo(99, 5);
    expect(result.lastCacheRate).toBe(0);
    expect(renderHud({ git: { repo: false }, usage: result }, 200).endsWith("· 99% cache (last 0%)")).toBe(true);
  });

  test("only the last CACHE_WINDOW responses count", () => {
    const old = usage({ input: 100_000, output: 1, cacheRead: 0, cacheWrite: 1 });
    const hit = usage({ input: 1_000, output: 1, cacheRead: 99_000 });
    const result = summarizeHudUsage([old, old, old, old, old, ...Array.from({ length: CACHE_WINDOW }, () => hit)]);
    expect(result.cacheRate).toBeCloseTo(99, 5);
  });

  test("the last-response flag needs a gap of CACHE_MISS_GAP points", () => {
    const base = { git: { repo: false }, usage: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 } };
    expect(renderHud({ ...base, usage: { ...base.usage, cacheRate: 95, lastCacheRate: 76 } }, 200)).toBe("95% cache");
    expect(renderHud({ ...base, usage: { ...base.usage, cacheRate: 95, lastCacheRate: 75 } }, 200)).toBe("95% cache (last 75%)");
    expect(renderHud({ ...base, usage: { ...base.usage, cacheRate: 40, lastCacheRate: 95 } }, 200)).toBe("40% cache");
  });

  test("counts standalone usage entries and ignores non-usage entries", () => {
    const entries: HudEntry[] = [
      { type: "usage", usage: { input: 3_000, output: 200 } },
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "toolResult", usage: { input: 500, output: 0 } } },
    ];
    expect(summarizeHudUsage(entries)).toMatchObject({ input: 3_500, output: 200 });
  });

  test("cacheRead is not mixed into the input total (no overlapping fields)", () => {
    const result = summarizeHudUsage([usage({ input: 1_000, output: 100, cacheRead: 9_000 })]);
    expect(result.input).toBe(1_000);
    expect(result.cacheRead).toBe(9_000);
    expect(result.cacheRate).toBeCloseTo(90, 5);
  });

  test("a provider without cache fields yields no cache rate", () => {
    const result = summarizeHudUsage([usage({ input: 2_000, output: 300 })]);
    expect(result.cacheRead).toBe(0);
    expect(result.cacheWrite).toBe(0);
    expect(result.cacheRate).toBeUndefined();
  });

  test("cache reporting but no cache reads is a 0% rate, not a missing one", () => {
    const result = summarizeHudUsage([usage({ input: 1_000, output: 10, cacheRead: 0, cacheWrite: 2_000 })]);
    expect(result.cacheRate).toBe(0);
  });

  test("empty or missing entries produce zero totals", () => {
    expect(summarizeHudUsage(undefined)).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(summarizeHudUsage([]).cacheRate).toBeUndefined();
  });
});

describe("git context detection", () => {
  test("uses the worktree's own branch and HEAD", () => {
    const git = gitContextFrom({ toplevel: "/repo/.xtrm/worktrees/core-xt-colors", branch: "xt/colors", head: "abc1234" });
    // Identifier is the worktree name; the SHA is metadata, not the label.
    expect(git).toEqual({ repo: true, name: "core-xt-colors", branch: "xt/colors", head: "abc1234" });
  });

  test("working-tree and ahead/behind flags ride the branch label", () => {
    const line = renderHud({
      git: gitContextFrom({ toplevel: "/repo", branch: "xt/colors", head: "abc1234", flags: "*+↑" }),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }, 200);
    expect(line).toBe("repo ⎇ xt/colors*+↑");
  });

  test("detached HEAD keeps the short commit and no branch", () => {
    const git = gitContextFrom({ toplevel: "/repo", branch: "", head: "deadbee" });
    expect(git.repo).toBe(true);
    expect(git.branch).toBeUndefined();
    expect(git.head).toBe("deadbee");
    expect(git.name).toBe("repo");
  });

  test("missing git metadata means no git group", () => {
    expect(gitContextFrom({ toplevel: null, branch: "main", head: "abc" })).toEqual({ repo: false });
    expect(gitContextFrom({ toplevel: "   ", branch: "main" })).toEqual({ repo: false });
  });

  test("every probe runs with the active worktree cwd", () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const cwd = "/repo/.xtrm/worktrees/core-xt-colors";
    const git = detectGitContext(cwd, (args, dir) => {
      calls.push({ args, cwd: dir });
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return cwd;
      if (command === "branch --show-current") return "xt/colors";
      if (command === "rev-parse --short HEAD") return "abc1234";
      return null;
    });
    expect(git).toEqual({ repo: true, name: "core-xt-colors", branch: "xt/colors", head: "abc1234" });
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.cwd).toBe(cwd);
  });

  test.skipIf(!hasGit)("a real linked worktree reports its own branch, never the parent's", () => {
    const root = mkdtempSync(join(tmpdir(), "xtrm-hud-git-"));
    const identity = ["-c", "user.email=hud@test", "-c", "user.name=hud"];
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", [...identity, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: root });
      const worktree = join(root, "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", "xt/colors", worktree], { cwd: root });

      expect(detectGitContext(root, realGit).branch).toBe("main");
      expect(detectGitContext(worktree, realGit)).toMatchObject({ repo: true, branch: "xt/colors" });

      execFileSync("git", ["checkout", "-q", "--detach"], { cwd: worktree });
      const detached = detectGitContext(worktree, realGit);
      expect(detached.branch).toBeUndefined();
      expect(detached.head).toMatch(/^[0-9a-f]{7,}$/);
      // Rendered, the detached worktree says so instead of borrowing a branch.
      expect(renderHud({ git: detached, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 200))
        .toMatch(/^wt ⎇ detached@[0-9a-f]{7,}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a worktree branch that differs from the parent is what gets displayed", () => {
    const parent = { toplevel: "/repo", branch: "main", head: "1111111" };
    const worktree = { toplevel: "/repo/.xtrm/worktrees/core-xt-colors", branch: "xt/colors", head: "2222222" };
    const runner = (_args: readonly string[], cwd: string) => {
      const source = cwd.includes("/worktrees/") ? worktree : parent;
      const command = _args.join(" ");
      if (command === "rev-parse --show-toplevel") return source.toplevel;
      if (command === "branch --show-current") return source.branch;
      return source.head;
    };
    expect(detectGitContext("/repo", runner).branch).toBe("main");
    expect(detectGitContext("/repo/.xtrm/worktrees/core-xt-colors", runner).branch).toBe("xt/colors");
  });
});

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

/** Real git: no mocks, so worktree/branch resolution is proven, not modelled. */
const realGit = (args: readonly string[], cwd: string): string | null => {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

const baseGit: GitContext = { repo: true, name: "core-xt-pi-colors", branch: "xt/ui-trim", head: "abc1234" };

describe("HUD layout", () => {
  test("renders the documented group order with dim separators", () => {
    const line = renderHud({
      git: baseGit,
      contextPercent: 31.4,
      contextWindow: 1_000_000,
      modelId: "deepseek-v4.1-flash",
      provider: "openrouter",
      showProvider: false,
      reasoning: true,
      thinkingLevel: "high",
      usage: { input: 42_000, output: 8_000, cacheRead: 86_000, cacheWrite: 0, cacheRate: 86 },
    }, 200, markTheme());

    const plain = line.replace(/\*([^*]*)\*/g, "$1").replace(/<\/?[A-Za-z]+>/g, "");
    expect(plain).toBe("core-xt-pi-colors ⎇ xt/ui-trim · 31.4%/1.0M · deepseek-v4.1-flash high · ↑42k ↓8k · 86% cache");
  });

  test("shows the context window at most once", () => {
    const line = renderHud({
      git: baseGit,
      contextPercent: 12.5,
      contextWindow: 200_000,
      modelId: "m",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }, 200);
    expect(line.split("200k").length - 1).toBe(1);
  });

  test("omits unavailable metrics instead of fabricating them", () => {
    const line = renderHud({
      git: { repo: false },
      contextPercent: null,
      modelId: "m",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }, 200);
    expect(line).toBe("m");
    expect(line).not.toContain("cache");
    expect(line).not.toContain("?");
    expect(line).not.toContain("↑");
    expect(line).not.toContain("HEAD");
  });

  test("labels a detached HEAD with its short commit", () => {
    const line = renderHud({ git: gitContextFrom({ toplevel: "/repo", branch: "", head: "deadbee" }), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 200);
    expect(line).toBe("repo ⎇ detached@deadbee");
  });

  test("narrow widths drop low-priority fields and never wrap", () => {
    const state = {
      git: baseGit,
      contextPercent: 31.4,
      contextWindow: 1_000_000,
      modelId: "deepseek-v4.1-flash",
      reasoning: true,
      thinkingLevel: "high",
      usage: { input: 42_000, output: 8_000, cacheRead: 86_000, cacheWrite: 0, cacheRate: 86 },
    };
    const wide = renderHud(state, 200);
    expect(wide).toContain("cache");

    for (const width of [80, 60, 40, 30, 20, 12]) {
      const line = renderHud(state, width);
      expect([...line].length).toBeLessThanOrEqual(width);
      expect(line).not.toContain("\n");
    }

    const narrow = renderHud(state, 40);
    // The worktree/branch group is the last field to drop.
    expect(narrow).toContain("core-xt-pi-colors");
    expect(narrow).toContain("⎇");
    expect(narrow).not.toContain("cache");
  });

  test("an ANSI-aware truncator is applied when the git group alone overflows", () => {
    const state = {
      git: { repo: true, name: "core", branch: "x".repeat(80), head: "abc1234" },
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const seen: number[] = [];
    const line = renderHud(state, 20, markTheme(), (text, width) => {
      seen.push(width);
      return `${text.slice(0, 10)}…`;
    });
    expect(seen).toEqual([20]);
    expect(line.endsWith("…")).toBe(true);
  });

  test("the worktree name is never shortened, however long", () => {
    const name = "core-xt-claude-a-very-long-worktree-name-for-an-agent";
    const line = renderHud({ git: { repo: true, name, branch: "xt/b", head: "abc1234" }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 200);
    expect(line.startsWith(`${name} ⎇ xt/b`)).toBe(true);
    expect(line).not.toContain("…");
  });

  test("long branch and model labels are shortened, not wrapped", () => {
    const line = renderHud({
      git: { repo: true, name: "core", branch: "feature/".padEnd(60, "x"), head: "abc1234" },
      modelId: "a-very-long-model-identifier-that-keeps-going",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }, 200);
    expect(line).not.toContain("\n");
    expect(line).toContain("…");
  });
});

describe("HUD theme usage", () => {
  test("writes only theme tokens: no hue and no baked hex reaches the line", () => {
    const theme = markTheme();
    const line = renderHud({
      git: baseGit,
      contextPercent: 91,
      contextWindow: 100_000,
      modelId: "m",
      reasoning: true,
      thinkingLevel: "max",
      usage: { input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 0, cacheRate: 66.6 },
    }, 200, theme);

    expect(line).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(line).not.toMatch(/\x1b\[/);
    expect([...new Set(theme.tokens)].every((token) => ["text", "muted", "dim", "toolTitle"].includes(token))).toBe(true);
  });

  test("bold goes through theme.style when the theme provides it", () => {
    const seen: Array<{ text: string; options: Record<string, unknown> }> = [];
    const theme = {
      fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
      // Simulates chalk with no colour level.
      bold: () => "CHALK-NOOP",
      style: (text: string, options: Record<string, unknown>) => {
        seen.push({ text, options });
        return `\u00ab${text}\u00bb`;
      },
    };
    const line = renderHud({
      git: { repo: false },
      contextPercent: 95,
      contextWindow: 100_000,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }, 120, theme);
    expect(line).toContain("\u00ab95.0%/100k\u00bb");
    expect(line).not.toContain("CHALK-NOOP");
    expect(seen.map((call) => call.options)).toContainEqual({ fg: "text", bold: true });
  });

  test("the worktree identifier is upright, not bold", () => {
    const line = renderHud({ git: baseGit, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 200, markTheme());
    expect(line).toContain("<toolTitle>core-xt-pi-colors</toolTitle>");
    expect(line).not.toContain("*<toolTitle>");
    // Only the context threshold may carry weight in this line.
    expect(line).not.toContain("*</toolTitle>*");
  });

  test("the context threshold moves through weight and brightness only", () => {
    const normal = renderHud({ git: { repo: false }, contextPercent: 40, contextWindow: 100_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 120, markTheme());
    const warn = renderHud({ git: { repo: false }, contextPercent: 75, contextWindow: 100_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 120, markTheme());
    const high = renderHud({ git: { repo: false }, contextPercent: 95, contextWindow: 100_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, 120, markTheme());
    expect(normal).toBe("<dim>40.0%/100k</dim>");
    expect(warn).toBe("*<muted>75.0%/100k</muted>*");
    expect(high).toBe("*<text>95.0%/100k</text>*");
  });
});
