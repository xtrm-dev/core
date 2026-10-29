/**
 * CORE-2548: where does an extension's custom message land in the installed pi?
 *
 * The suggest pipeline delivers classifier answers asynchronously, so it must know
 * which `deliverAs` value reaches the model when. pi's docs say a followUp waits
 * until the run ends; the transcripts said otherwise. This probe drives a real
 * AgentSession of the INSTALLED pi (the runtime that loads these extensions, not
 * the repo's devDependency) with a faux provider, and records which model request
 * first carries the message. No network.
 *
 * Resolution: PI_CODING_AGENT_ROOT, else `npm root -g`/@earendil-works/pi-coding-agent.
 * Skips cleanly when neither exists.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function piRoot(): string | null {
  const fromEnv = process.env["PI_CODING_AGENT_ROOT"];
  if (fromEnv && existsSync(join(fromEnv, "dist", "index.js"))) return fromEnv;
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim();
    const root = join(g, "@earendil-works", "pi-coding-agent");
    return existsSync(join(root, "dist", "index.js")) ? root : null;
  } catch {
    return null;
  }
}

const ROOT = piRoot();

type Seam = "tool_result" | "turn_end" | "final_message" | "agent_end" | "before_agent_start";
interface Observation {
  /** Per model request, in order: did its context contain the probe message? */
  sawProbe: boolean[];
  /** Model requests made by the first prompt's run. */
  firstRunCalls: number;
}

async function observe(seam: Seam, deliverAs: "steer" | "followUp" | "nextTurn" | null): Promise<Observation> {
  const pi = await import(join(ROOT!, "dist", "index.js"));
  const ai = await import(join(ROOT!, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"));
  const dir = mkdtempSync(join(tmpdir(), "pi-delivery-probe-"));
  writeFileSync(join(dir, "a.txt"), "hello");
  const pid = `faux${seam.replace(/_/g, "")}${deliverAs ?? "none"}`;
  const faux = ai.registerFauxProvider({ provider: pid, api: `${pid}-api` });
  const sawProbe: boolean[] = [];
  const reply = (msg: unknown) => (ctx: { messages?: unknown }) => {
    sawProbe.push(JSON.stringify(ctx.messages ?? ctx).includes("PROBE"));
    return msg;
  };
  faux.setResponses([
    reply(ai.fauxAssistantMessage([ai.fauxToolCall("read", { path: join(dir, "a.txt") })], { stopReason: "toolUse" })),
    reply(ai.fauxAssistantMessage("first run done")),
    reply(ai.fauxAssistantMessage("second run done")),
  ]);

  let sent = false;
  const extension = (api: any) => {
    const send = () => {
      if (sent) return;
      sent = true;
      api.sendMessage({ customType: "probe", content: `PROBE ${seam}`, display: true }, { deliverAs, triggerTurn: false });
    };
    if (seam === "tool_result") api.on("tool_result", () => { send(); return undefined; });
    if (seam === "turn_end") api.on("turn_end", () => { send(); return undefined; });
    if (seam === "agent_end") api.on("agent_end", () => { send(); });
    if (seam === "final_message") {
      api.on("message_end", (e: { message?: { role?: string; content?: Array<{ type?: string }> } }) => {
        const m = e.message;
        if (m?.role === "assistant" && !m.content?.some((b) => b.type === "toolCall")) send();
      });
    }
    if (seam === "before_agent_start") {
      api.on("before_agent_start", () => {
        if (sent) return undefined;
        sent = true;
        return { message: { customType: "probe", content: "PROBE before_agent_start", display: true } };
      });
    }
  };

  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new pi.DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, extensionFactories: [extension],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const modelRuntime = await pi.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
  const fauxModel = faux.getModel();
  modelRuntime.registerProvider(pid, {
    api: `${pid}-api`, apiKey: "faux", baseUrl: "http://faux.invalid",
    streamSimple: (_m: unknown, c: unknown, o: unknown) => ai.streamSimple(fauxModel, c, o),
    models: [{ id: fauxModel.id, name: "faux", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 }],
  });
  const { session } = await pi.createAgentSession({
    cwd: dir, agentDir: dir, model: modelRuntime.models.getModel(pid, fauxModel.id), thinkingLevel: "off",
    modelRuntime, resourceLoader: loader, tools: ["read"], sessionManager: pi.SessionManager.inMemory(dir), settingsManager,
  });
  try {
    await session.prompt("please read a.txt");
    const firstRunCalls = faux.state.callCount;
    await session.prompt("second prompt");
    return { sawProbe, firstRunCalls };
  } finally {
    session.dispose();
    faux.unregister();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Requests: [0] first run, before the tool call; [1] first run, after the tool
// result; [2] the second prompt's run.
describe.skipIf(!ROOT)("pi delivery semantics for suggestion messages (CORE-2548)", () => {
  it("steer from tool_result reaches the very next request of the same run", async () => {
    expect(await observe("tool_result", "steer")).toEqual({ sawProbe: [false, true, true], firstRunCalls: 2 });
  });

  it("followUp from tool_result also lands mid-run (contrary to the docs' 'waits until the run ends')", async () => {
    expect(await observe("tool_result", "followUp")).toEqual({ sawProbe: [false, true, true], firstRunCalls: 2 });
  });

  it("nextTurn from tool_result waits for the next prompt", async () => {
    expect(await observe("tool_result", "nextTurn")).toEqual({ sawProbe: [false, false, true], firstRunCalls: 2 });
  });

  it("steer from turn_end reaches the next request of the same run", async () => {
    expect(await observe("turn_end", "steer")).toEqual({ sawProbe: [false, true, true], firstRunCalls: 2 });
  });

  it("steer during the final assistant message costs no extra model call and is read at the next prompt", async () => {
    expect(await observe("final_message", "steer")).toEqual({ sawProbe: [false, false, true], firstRunCalls: 2 });
  });

  it("steer from agent_end (idle) is read at the next prompt and triggers no run", async () => {
    expect(await observe("agent_end", "steer")).toEqual({ sawProbe: [false, false, true], firstRunCalls: 2 });
  });

  it("a before_agent_start message is in the first request", async () => {
    expect(await observe("before_agent_start", null)).toEqual({ sawProbe: [true, true, true], firstRunCalls: 2 });
  });
});
