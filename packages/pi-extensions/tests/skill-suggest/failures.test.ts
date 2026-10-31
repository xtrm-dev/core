/**
 * CORE-2534: every classifier failure names its reason; repeated failures warn
 * once. The 2026-10-21 outage was an HTTP 422 returned as a bare null.
 */
import "../isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
import { afterEach, describe, expect, it } from "bun:test";
import { classify, systemOne, type ClassifierFailure, type Question } from "../../shared/suggest.ts";
import { createFailureWatch } from "../../extensions/skill-suggest/index.ts";

const QUESTIONS: Record<string, Question> = { skill: { type: "choice", instructions: "pick", criteria: { a: "A", none: "none" } } };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function failureFor(fetchImpl: typeof fetch, timeoutMs?: number): Promise<ClassifierFailure | null> {
  globalThis.fetch = fetchImpl;
  let reason: ClassifierFailure | null = null;
  const r = await systemOne({}, QUESTIONS, { apiKey: "k", timeoutMs, onFailure: (f) => { reason = f; } });
  expect(r).toBeNull();
  return reason;
}

describe("classifier failures carry a reason", () => {
  it("HTTP 422 (the outage) reports http_422", async () => {
    expect(await failureFor((async () => new Response("too many criteria", { status: 422 })) as unknown as typeof fetch)).toBe("http_422");
  });

  it("HTTP 500 reports http_500", async () => {
    expect(await failureFor((async () => new Response("", { status: 500 })) as unknown as typeof fetch)).toBe("http_500");
  });

  it("a request that outlives its timeout reports timeout", async () => {
    const hang = ((_u: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await failureFor(hang, 20)).toBe("timeout");
  });

  it("a network error reports transport", async () => {
    expect(await failureFor((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch)).toBe("transport");
  });

  it("no key reports no_key without a request", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response(""); }) as unknown as typeof fetch;
    let reason: ClassifierFailure | null = null;
    await systemOne({}, QUESTIONS, { apiKey: null, onFailure: (f) => { reason = f; } });
    expect(reason).toBe("no_key");
    expect(called).toBe(false);
  });

  it("classify() returns the reason and the measured wall time", async () => {
    globalThis.fetch = (async () => new Response("", { status: 422 })) as unknown as typeof fetch;
    const prev = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = "k";
    try {
      const out = await classify(null, {}, QUESTIONS);
      expect(out.result).toBeNull();
      expect(out.failure).toBe("http_422");
      expect(out.path).toBeNull();
      expect(out.ms).toBeGreaterThanOrEqual(0);
    } finally {
      if (prev === undefined) delete process.env["TYPESAFE_API_KEY"];
      else process.env["TYPESAFE_API_KEY"] = prev;
    }
  });

  it("a registry whose classifier errors falls back, and both failing reports the fallback reason", async () => {
    globalThis.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    const registry = {
      getAvailableOfType: async () => [{ id: "jev", provider: "typesafe" }],
      classify: async () => ({ stopReason: "error", errorMessage: "402" }),
    };
    const prev = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = "k";
    try {
      expect((await classify(registry, {}, QUESTIONS)).failure).toBe("http_503");
    } finally {
      if (prev === undefined) delete process.env["TYPESAFE_API_KEY"];
      else process.env["TYPESAFE_API_KEY"] = prev;
    }
  });
});

describe("repeated failures warn once per session per class", () => {
  it("three in a row warn once; more of the same class stay quiet", () => {
    const warnings: string[] = [];
    const watch = createFailureWatch((m) => warnings.push(m));
    for (let i = 0; i < 2; i++) watch.failed("http_422");
    expect(warnings).toHaveLength(0);
    for (let i = 0; i < 5; i++) watch.failed("http_422");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("http_422");
  });

  it("a success resets the streak; a different class warns separately", () => {
    const warnings: string[] = [];
    const watch = createFailureWatch((m) => warnings.push(m));
    watch.failed("timeout");
    watch.failed("timeout");
    watch.succeeded();
    watch.failed("timeout");
    watch.failed("timeout");
    expect(warnings).toHaveLength(0);
    watch.failed("timeout");
    for (let i = 0; i < 3; i++) watch.failed("transport");
    expect(warnings).toHaveLength(2);
  });
});
