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

  it("xtrm-ui:1723 heading match guard (linearity, non-discriminating)", () => {
    const md = "###" + "x".repeat(100000);
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

  it("skill-suggest:136 peer-relay guard (linearity, non-discriminating)", () => {
    const { value, ms } = timed(() => isPeerRelay(" ".repeat(100000) + "coord: hello"));
    expect(ms).toBeLessThan(100);
    expect(isPeerRelay("Coordinator abc: hello")).toBe(true);
  });
});
