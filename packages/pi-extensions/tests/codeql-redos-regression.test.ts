import { describe, expect, it } from "bun:test";

// CORE-2655: ReDoS regression — each flagged regex now has a bounded/linear
// form. "(discriminating)" cases feed an input that is slow on the old pattern
// (verified red pre-fix) and fast on the new one; "(linearity,
// non-discriminating)" cases guard linear behaviour where the old pattern was
// already linear but CodeQL-flagged. All assert <100 ms plus unchanged
// behaviour on well-formed input.
import {
  fitThinkingRowToWidth,
  ultraExternalPrimary,
  buildUltraExternalLine,
  boldMarkdownHeadings,
  stripSetupPrefix,
  ultraBashSubject,
  renderExternalToolLines,
} from "../extensions/xtrm-ui/index.ts";
import { stripEndPeriod } from "../shared/suggest.ts";
import { repositoryFromRemote } from "../extensions/xtrm-agent-host/index.ts";
import { isControlNudge, isPeerRelay } from "../extensions/skill-suggest/index.ts";
import { numberReadText } from "../extensions/read-line-numbers/index.ts";

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe("CORE-2655 ReDoS regression", () => {
  it("xtrm-ui:454 color runs stay linear on a long ANSI run", () => {
    // Near-miss tail: 30000 complete SGR runs plus a partial one force the
    // old (\\x1b\\[[0-9;?]*m)+$ into ~500 ms of backtracking; the bounded
    // {1,50} form answers in ~10 ms.
    const row = "Thinking... " + "padding words ".repeat(30) + "\x1b[1m".repeat(30000) + "\x1b[1";
    const { value, ms } = timed(() => fitThinkingRowToWidth(row, 80));
    expect(ms).toBeLessThan(100);
    expect(typeof value).toBe("string");
    // Well-formed behaviour: a short colored recap keeps its prefix.
    const short = "Thinking... \x1b[31mhello world this is a long recap that must be cut";
    expect(fitThinkingRowToWidth(short, 40)).toContain("Thinking...");
  });

  it("xtrm-ui:1113 bracket framing guard (linearity, non-discriminating)", () => {
    const joined = "[" + "x".repeat(100000) + "\n{\"a\":1}";
    const { value, ms } = timed(() => ultraExternalPrimary("bash", [joined]));
    expect(ms).toBeLessThan(100);
    expect(value).toBeUndefined(); // not JSON, no summary — but must return fast
    // Well-formed: GitNexus framing still strips, JSON summarizes.
    expect(ultraExternalPrimary("bash", ["[GitNexus]\n{\"a\":1}"])).toBe("{a}");
  });

  it("xtrm-ui:1191 result framing guard (linearity, non-discriminating)", () => {
    const payload = "[" + "y".repeat(100000);
    const { ms } = timed(() => buildUltraExternalLine("specialist", {}, [payload], "success", 1000));
    expect(ms).toBeLessThan(100);
  });

  it("xtrm-ui:1307 trailing-whitespace strip stays linear (discriminating)", () => {
    // "a" + spaces + "b": old /\\s+$/u backtracks the space run (~580 ms at 50k);
    // trimEnd sees the trailing "b" and returns at once.
    const lines = ["code line 1", "code line 2   ", "a" + " ".repeat(50000) + "b", "   "];
    const { value, ms } = timed(() =>
      renderExternalToolLines(lines, 200, "external", false, "codemode", 10, "success", true, 6, "x", 2),
    );
    expect(ms).toBeLessThan(100);
    expect(Array.isArray(value)).toBe(true);
  });

  it("xtrm-ui:1723 heading match guard (CodeQL-cited space run)", () => {
    const md = "  ".repeat(50000);
    const { value, ms } = timed(() => boldMarkdownHeadings(md));
    expect(ms).toBeLessThan(100);
    expect(typeof value).toBe("string");
    expect(boldMarkdownHeadings("## Real heading")).toContain("Real heading");
  });

  it("xtrm-ui:2556/2569 timeout/setup prefixes guard (linearity, non-discriminating)", () => {
    const cmd = "timeout " + "-x ".repeat(20000) + "5 echo hi";
    const { value, ms } = timed(() => stripSetupPrefix(cmd));
    expect(ms).toBeLessThan(100);
    expect(value).toContain("echo hi");
    expect(stripSetupPrefix("timeout 5 echo hi")).toBe("echo hi");
    // Sibling wrapper prefixes share the bounded shape.
    const nice = "nice " + "-n 5 ".repeat(5000) + "echo hi";
    const tn = performance.now();
    expect(stripSetupPrefix(nice)).toContain("echo hi");
    expect(performance.now() - tn).toBeLessThan(100);
  });

  it("xtrm-ui:2611 trailing-operator strip stays linear on spaced input", () => {
    const cmd = "echo hi" + " ".repeat(100000) + "&";
    const { value, ms } = timed(() => ultraBashSubject(cmd));
    expect(ms).toBeLessThan(100);
    expect(typeof value).toBe("string");
  });

  it("suggest:825 trailing-period strip stays linear (discriminating)", () => {
    // Old /\\.+$/ backtracks over the dot run when the end anchor fails (~580 ms
    // at 50k chars); the manual scan sees the trailing "x" and returns at once.
    const adversarial = ".".repeat(50000) + "x";
    const { value, ms } = timed(() => stripEndPeriod(adversarial));
    expect(ms).toBeLessThan(100);
    expect(value).toBe(adversarial);
    expect(stripEndPeriod("Ends here.")).toBe("Ends here");
  });

  it("agent-host:274 scp parse stays linear on a long host run", () => {
    const { value, ms } = timed(() =>
      repositoryFromRemote("git@" + "h".repeat(100000) + ":org/repo.git"),
    );
    expect(ms).toBeLessThan(100);
    expect(value).toBeUndefined(); // over the 256-char host bound
    expect(repositoryFromRemote("git@github.com:org/repo.git")).toBe("org/repo");
  });

  it("skill-suggest:123 control-nudge strip stays linear (discriminating)", () => {
    // Old /[.!…]+$/ backtracks over the run when the anchor fails; the manual
    // scan returns at once. Not a nudge either way — the point is timing.
    const adversarial = "!".repeat(50000) + "x";
    const { value, ms } = timed(() => isControlNudge(adversarial));
    expect(ms).toBeLessThan(100);
    expect(value).toBe(false);
    expect(isControlNudge("go!!!")).toBe(true);
    expect(isControlNudge("continue please")).toBe(true);
  });

  it("skill-suggest:136 peer-relay guard (CodeQL-cited !→ run)", () => {
    // Exact shape from the CodeQL report: "!→" repetitions partition S+ runs
    // around arrows on the old pattern; bounded runs answer at once.
    const { value, ms } = timed(() => isPeerRelay("!→".repeat(50000)));
    expect(ms).toBeLessThan(100);
    expect(value).toBe(false);
    expect(isPeerRelay("Coordinator abc: hello")).toBe(true);
    expect(isPeerRelay("a -> b: hi")).toBe(true);
  });

  it("xtrm-ui:1113/1191 framing scan stays linear and keeps its rules (CORE-2694)", () => {
    // Discriminating: /\n+---\s*\n/ backtracks over the newline run when the
    // separator never completes (measured 424 ms old vs 1 ms new at 40k).
    const payload = "{\"a\":1}" + "\n".repeat(40000) + "---\n";
    const second = timed(() => ultraExternalPrimary("bash", [payload]));
    expect(second.ms).toBeLessThan(100);
    // Behaviour: header line and trailing `---` hint are still stripped.
    expect(ultraExternalPrimary("bash", ["[GitNexus]\n{\"a\":1}\n---\nhint {x}"])).toBe("{a}");
    // A body that opens with `---` is content, never a separator: a split
    // there would leave an empty body and no primary at all.
    expect(ultraExternalPrimary("bash", ["---\n{\"a\":1}"])).toBe("{\"a\":1}");
  });

  it("read-line-numbers:39 notice match stays linear (discriminating)", () => {
    // Discriminating: the old `/\d+.*Use offset=` splits the digit run across
    // `\d+` and `.*` with no terminator in sight (measured 474 ms old vs
    // <1 ms new at 40k). The unbounded form is why CodeQL flagged line 39.
    const adversarial = "[Showing lines 1-1 of " + "1".repeat(40000) + "x";
    const { value, ms } = timed(() => numberReadText(adversarial, 1, false));
    expect(ms).toBeLessThan(100);
    expect(value).toContain("1 | [Showing lines 1-1 of ");
    // Behaviour: the three Pi notices are still recognised verbatim.
    expect(numberReadText("foo\nbar\n\n[Showing lines 1-2 of 5000. Use offset=3 to continue.]", 1, true))
      .toBe("1 | foo\n2 | bar\n\n[Showing lines 1-2 of 5000. Use offset=3 to continue.]");
    expect(numberReadText("foo\n\n\n\n[3 more lines in file. Use offset=4 to continue.]", 1, false))
      .toBe("1 | foo\n2 | \n3 | \n\n[3 more lines in file. Use offset=4 to continue.]");
    const banner = "[Line 5 is 60KB, exceeds 50KB limit. Use bash: sed -n '5p' /a/b.txt | head -c 51200]";
    expect(numberReadText(banner, 1, false)).toBe(banner);
    // A long file path is still a notice, not file content: a real banner can
    // carry a deep path, so the path runs are bounded at 8 KiB, not 2 KiB.
    const longPath = "/very/deep/" + "nested/".repeat(400) + "file.txt";
    const longBanner = `[Line 5 is 60KB, exceeds 50KB limit. Use bash: sed -n '5p' ${longPath} | head -c 51200]`;
    expect(longPath.length).toBeGreaterThan(2000);
    expect(numberReadText(longBanner, 1, false)).toBe(longBanner);
    // Past NOTICE_MAX_LENGTH a notice-shaped line is content: the guard turns
    // the patterns off rather than letting file content reach them.
    const oversized = "[Showing lines 1-1 of 1" + "0".repeat(20000) + " Use offset=2 to continue.]";
    expect(oversized.length).toBeGreaterThan(16384);
    expect(numberReadText(oversized, 1, false)).toContain("1 | [Showing lines ");
  });

  it("agent-host:274 trailing-slash trim stays linear (discriminating)", () => {
    // Discriminating: `/\/+$/` backtracks the whole slash run when the end
    // anchor fails (measured 379 ms old vs <1 ms new at 40k).
    const adversarial = "https://github.com/a" + "/".repeat(40000) + "b";
    const { value, ms } = timed(() => repositoryFromRemote(adversarial));
    expect(ms).toBeLessThan(100);
    expect(value).toBe("a/b"); // inner slashes survive; only the tail run trims
    // Behaviour: trailing slashes and one .git suffix are still dropped.
    expect(repositoryFromRemote("https://github.com/org/repo.git")).toBe("org/repo");
    expect(repositoryFromRemote("git@github.com:org/repo.git/")).toBe("org/repo");
  });
});
