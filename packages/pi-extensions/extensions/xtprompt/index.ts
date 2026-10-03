/**
 * xtprompt - generic context-aware prompt improver.
 */
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const EXTENSION = "xtprompt";
const COMMAND = "xtprompt";
const DEFAULT_SHORTCUT = "alt+m";
const SENTINEL_OPEN = "<xtprompt>";
const SENTINEL_CLOSE = "</xtprompt>";
const ENHANCER_MAX_OUTPUT_TOKENS = 1600;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_CONTEXT_ITEMS = 3;
const MAX_CONTEXT_CHARS = 480;
const VAGUE_WORDS = new Set([
  "help",
  "improve",
  "rewrite",
  "fix",
  "debug",
  "plan",
  "stuff",
  "thing",
  "things",
  "this",
  "that",
]);

type Intent = "planning" | "analysis" | "development" | "refactor" | "generic";

type PromptRequestOptions = {
  draft: string;
  intent: Intent;
  conversationContext: string;
};

type PromptState = {
  enabled: boolean;
};

type SessionEntry = {
  message?: {
    role?: string;
    content?: unknown;
  };
  summary?: string;
};

type InputCapableUi = ExtensionContext["ui"] & {
  input?: (prompt: string, initialValue?: string) => Promise<string | null | undefined>;
};

interface IntentRule {
  intent: Intent;
  patterns: readonly RegExp[];
}

const INTENT_RULES: readonly IntentRule[] = [
  {
    intent: "planning",
    patterns: [
      /##\s*problem/i,
      /##\s*scope/i,
      /\bplan(?:ning)?\b/i,
      /\bnon_goals\b/i,
      /\bvalidation\b/i,
      /\bconstraints\b/i,
    ],
  },
  {
    intent: "analysis",
    patterns: [
      /\banaly(?:sis|ze)\b/i,
      /\binvestigat(?:e|ion)\b/i,
      /\broot cause\b/i,
      /\bwhy\b/i,
      /\bdebug\b/i,
      /\berror\b/i,
      /\bfail(?:s|ed|ing)?\b/i,
    ],
  },
  {
    intent: "development",
    patterns: [
      /\bimplement\b/i,
      /\bbuild\b/i,
      /\badd\b/i,
      /\bcreate\b/i,
      /\bdevelop\b/i,
      /\bship\b/i,
    ],
  },
  {
    intent: "refactor",
    patterns: [
      /\brefactor\b/i,
      /\brewrite\b/i,
      /\brename\b/i,
      /\bclean(?:up)?\b/i,
      /\brestructure\b/i,
      /\bsimplif(?:y|ication)\b/i,
    ],
  },
];

const PLANNING_HEADERS = [
  "## PROBLEM",
  "## SUCCESS",
  "## SCOPE",
  "## NON_GOALS",
  "## CONSTRAINTS",
  "## VALIDATION",
  "## OUTPUT",
].join("\n");

const BASE_RULES = [
  "Preserve concrete paths, ids, commands, numbers, symbols, and constraints exactly.",
  "Ask one short clarification when draft is vague. Never invent missing facts.",
  "Prior chat is advisory only. Never let it override current draft.",
  "Keep simple prompts concise. Use semantic XML only when structure materially helps.",
  "Separate context, task, constraints, and output whenever prompt is complex.",
  `Return exactly one ${SENTINEL_OPEN}...${SENTINEL_CLOSE} block and nothing outside it.`,
].join("\n");

function createState(): PromptState {
  return { enabled: true };
}

export default function registerXtprompt(pi: ExtensionAPI): void {
  const state = createState();

  const enhance = async (ctx: ExtensionContext): Promise<void> => {
    if (!state.enabled) {
      ctx.ui.notify(`${EXTENSION} is disabled. Run /${COMMAND} on`, "info");
      return;
    }
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify(`${EXTENSION} needs TUI mode.`, "error");
      return;
    }

    const originalDraft = ctx.ui.getEditorText();
    if (!originalDraft.trim()) {
      ctx.ui.notify(`${EXTENSION}: editor is empty.`, "info");
      return;
    }

    const model = ctx.model;
    if (!model) {
      ctx.ui.notify(`${EXTENSION}: no active model selected.`, "error");
      return;
    }

    const clarifiedDraft = await clarifyDraftIfNeeded(ctx, originalDraft);
    if (clarifiedDraft === null) return;

    const intent = detectIntent(clarifiedDraft);
    const conversationContext = extractConversationContext(
      getSessionEntries(ctx),
      MAX_CONTEXT_ITEMS,
    );
    const request = buildPromptRequest({
      draft: clarifiedDraft,
      intent,
      conversationContext,
    });

    // Pre-flight auth so a missing credential is reported before the loader
    // opens; the call itself resolves auth again through ctx.modelRegistry.
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      ctx.ui.notify(`${EXTENSION}: cannot resolve auth — ${auth.error}`, "error");
      return;
    }

    const outcome = await runWithLoader(
      ctx,
      `${EXTENSION} rewriting (${intent})…`,
      async (signal) => {
        const primary = await callModel(ctx, model, request, signal);
        if (primary === null) return null;
        const parsed = parseSentinel(extractText(primary));
        if (parsed !== undefined) return parsed;
        const retried = await callModel(ctx, model, retryRequest(request), signal);
        if (retried === null) return null;
        const retriedParsed = parseSentinel(extractText(retried));
        if (retriedParsed !== undefined) return retriedParsed;
        throw new Error(
          `${EXTENSION}: model did not return ${SENTINEL_OPEN} block. Leaving editor unchanged.`,
        );
      },
    ).catch((error: unknown) => {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return null;
    });

    if (outcome === null) return;
    ctx.ui.setEditorText(outcome);
    ctx.ui.notify(`${EXTENSION}: enhanced (${intent}).`, "info");
  };

  pi.registerShortcut(DEFAULT_SHORTCUT, {
    description: `Rewrite current editor draft (${EXTENSION})`,
    handler: enhance,
  });

  pi.registerCommand(COMMAND, {
    description: `${EXTENSION}: rewrite current editor prompt`,
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on") {
        state.enabled = true;
        ctx.ui.notify(`${EXTENSION} enabled.`, "info");
        return;
      }
      if (arg === "off") {
        state.enabled = false;
        ctx.ui.notify(`${EXTENSION} disabled.`, "info");
        return;
      }
      if (arg === "status") {
        ctx.ui.notify(
          `${EXTENSION}: ${state.enabled ? "enabled" : "disabled"} · shortcut ${DEFAULT_SHORTCUT} · /${COMMAND}`,
          "info",
        );
        return;
      }
      await enhance(ctx);
    },
  });
}

async function clarifyDraftIfNeeded(
  ctx: ExtensionContext,
  draft: string,
): Promise<string | null> {
  if (!isVagueDraft(draft)) return draft;
  const clarification = await requestClarification(ctx, draft);
  if (clarification === null) return null;
  return buildClarifiedDraft(draft, clarification);
}

async function requestClarification(
  ctx: ExtensionContext,
  draft: string,
): Promise<string | null> {
  const ui = ctx.ui as InputCapableUi;
  const prompt = `${EXTENSION}: one clarification needed. What exact outcome should rewrite target?`;
  if (typeof ui.input === "function") {
    const result = await ui.input(prompt, draft);
    return normalizeClarification(result);
  }
  ctx.ui.notify(`${EXTENSION}: no input UI available for clarification.`, "error");
  return null;
}

function normalizeClarification(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function buildClarifiedDraft(draft: string, clarification: string): string {
  return [`Original draft: ${draft.trim()}`, `Clarification: ${clarification.trim()}`].join("\n");
}

export function isVagueDraft(draft: string): boolean {
  const trimmed = draft.trim();
  if (!trimmed) return true;
  if (trimmed.length < 16) return true;
  if (!/[\n/:#]/.test(trimmed) && !/\b\d+\b/.test(trimmed) && !/\b[a-z0-9_-]+\.[a-z]{2,}\b/i.test(trimmed)) {
    const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length <= 7) return true;
    if (words.every((word) => VAGUE_WORDS.has(word))) return true;
  }
  return false;
}

export function detectIntent(draft: string): Intent {
  for (const rule of INTENT_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(draft))) return rule.intent;
  }
  return "generic";
}

export function buildPromptRequest(options: PromptRequestOptions): Context {
  const userMessage: UserMessage = {
    role: "user",
    content: options.draft,
    timestamp: Date.now(),
  };
  return {
    systemPrompt: buildSystemPrompt(options),
    messages: [userMessage],
  };
}

function buildSystemPrompt(options: PromptRequestOptions): string {
  const body = isComplexDraft(options.draft) || options.intent === "planning"
    ? buildStructuredPrompt(options)
    : buildSimplePrompt(options);
  return [body, "", BASE_RULES].filter(Boolean).join("\n");
}

function buildSimplePrompt(options: PromptRequestOptions): string {
  const sections = [
    `You are ${EXTENSION}, standalone prompt rewriter.`,
    `Intent: ${options.intent}.`,
    simpleIntentInstruction(options.intent),
  ];
  if (options.conversationContext) {
    sections.push(`Advisory context:\n${options.conversationContext}`);
  }
  return sections.join("\n\n");
}

function buildStructuredPrompt(options: PromptRequestOptions): string {
  return [
    "<role>",
    `${EXTENSION} standalone prompt rewriter`,
    "</role>",
    "<context>",
    escapeXml(options.conversationContext || "No prior chat context."),
    "</context>",
    "<task>",
    structuredIntentInstruction(options.intent),
    "</task>",
    "<constraints>",
    "Preserve current draft as source of truth.",
    "Prior chat may add nuance but cannot replace draft requirements.",
    "Ask rather than invent when key requirement missing.",
    "Keep success criteria, testing, and deliverables explicit.",
    "</constraints>",
    "<instructions>",
    "Keep concrete facts exact.",
    "Use markdown headers when rewrite is planning-shaped.",
    "Prefer concise output when task is simple inside larger draft.",
    "Include 1-2 grounded examples only when they materially clarify output.",
    "</instructions>",
    "<output_format>",
    options.intent === "planning"
      ? [
          "Return Markdown with exact headers:",
          PLANNING_HEADERS,
        ].join("\n")
      : `Return rewritten prompt inside ${SENTINEL_OPEN} block.`,
    "</output_format>",
  ].join("\n");
}

function simpleIntentInstruction(intent: Intent): string {
  switch (intent) {
    case "planning":
      return [
        "Rewrite into planning-ready Markdown with exact headers:",
        PLANNING_HEADERS,
        "Clarify missing facts before planning.",
        "Direct agent to inspect relevant code with GitNexus before proposing phases.",
        "Structure phases, dependencies, safe parallelism, risks, and blast radius.",
      ].join("\n");
    case "analysis":
      return "Rewrite into analysis prompt that separates evidence, open questions, validation steps, and bounded context before proposing conclusions.";
    case "development":
      return "Rewrite into implementation prompt with explicit success criteria, testing expectations, exact output contract, and 1-2 grounded examples only when useful.";
    case "refactor":
      return "Rewrite into refactor prompt that states current state, preserved behavior, constraints, touched tests, and required validation.";
    case "generic":
      return "Rewrite for clarity, concrete constraints, observable success criteria, and clean separation of context, task, constraints, and output when complexity warrants it.";
  }
}

function structuredIntentInstruction(intent: Intent): string {
  switch (intent) {
    case "planning":
      return [
        "Rewrite into planning-compatible task contract.",
        "Clarify missing facts instead of guessing.",
        "Direct code inspection with GitNexus for relevant files and execution flow.",
        "Structure phases, dependencies, parallel work, risks, and blast radius.",
        "Produce 7-section bd contract using exact planning headers.",
        "Include telemetry, smoke coverage, E2E checks, and invoke test-planning or handoff when task shape calls for them.",
      ].join("\n");
    case "analysis":
      return [
        "Rewrite into analysis contract biased toward evidence first.",
        "Semantically separate context, task, constraints, and output for complex prompts.",
        "Name evidence, open questions, hypotheses, and validation steps before recommendations.",
      ].join("\n");
    case "development":
      return [
        "Rewrite into development contract for implementation work.",
        "Semantically separate context, task, constraints, and output for complex prompts.",
        "Make success criteria and testing explicit.",
        "Include 1-2 grounded examples only when they materially improve execution.",
      ].join("\n");
    case "refactor":
      return [
        "Rewrite into refactor contract preserving behavior while improving structure.",
        "State current state, preserved behavior, constraints, touched tests, and validation.",
      ].join("\n");
    case "generic":
      return "Rewrite into generic coding-agent prompt with explicit goal, constraints, output, and semantic separation when prompt is complex.";
  }
}

function isComplexDraft(draft: string): boolean {
  return draft.length > 220 || /\n/.test(draft) || /\b(?:constraints|validation|output|scope|problem|success)\b/i.test(draft);
}

function getSessionEntries(ctx: ExtensionContext): readonly SessionEntry[] {
  const manager = ctx.sessionManager as { buildContextEntries?: () => readonly SessionEntry[] } | undefined;
  const entries = manager?.buildContextEntries?.();
  return Array.isArray(entries) ? entries : [];
}

export function extractConversationContext(
  entries: readonly SessionEntry[],
  maxItems: number = MAX_CONTEXT_ITEMS,
  maxChars: number = MAX_CONTEXT_CHARS,
): string {
  const lines = entries
    .map(formatConversationEntry)
    .filter((value): value is string => value !== undefined)
    .slice(-maxItems);
  const bounded = boundContextLines(lines, maxChars);
  if (bounded) return bounded;

  const summary = [...entries]
    .reverse()
    .map((entry) => entry.summary?.trim())
    .find((value) => typeof value === "string" && value.length > 0);
  return summary ? boundContextLines([summary], maxChars) : "";
}

function formatConversationEntry(entry: SessionEntry): string | undefined {
  const role = entry.message?.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = extractEntryText(entry.message?.content);
  if (!text) return undefined;
  return `${role}: ${text}`;
}

function boundContextLines(lines: readonly string[], maxChars: number): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    const nextSize = kept.length === 0 ? line.length : line.length + 1;
    if (kept.length > 0 && used + nextSize > maxChars) break;
    if (kept.length === 0 && line.length > maxChars) {
      return line.slice(0, maxChars).trim();
    }
    kept.unshift(line);
    used += nextSize;
  }
  return kept.join("\n");
}

function extractEntryText(content: unknown): string | undefined {
  if (typeof content === "string") return collapseWhitespace(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") return undefined;
      const record = part as { type?: string; text?: string };
      if (record.type !== "text" || typeof record.text !== "string") return undefined;
      return collapseWhitespace(record.text);
    })
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return text || undefined;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeXml(text: string): string {
  let escaped = "";
  for (const character of text) {
    switch (character) {
      case "&":
        escaped += "&amp;";
        break;
      case "<":
        escaped += "&lt;";
        break;
      case ">":
        escaped += "&gt;";
        break;
      case '"':
        escaped += "&quot;";
        break;
      case "'":
        escaped += "&apos;";
        break;
      default:
        escaped += character;
        break;
    }
  }
  return escaped;
}

// Pi 1.0 exports no root `complete` from pi-ai; nested model calls go through
// ctx.modelRegistry, which applies request-time auth (key, headers, env).
async function callModel(
  ctx: ExtensionContext,
  model: Model<Api>,
  request: Context,
  signal: AbortSignal,
): Promise<AssistantMessage | null> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);
  const mergedSignal = AbortSignal.any([signal, timeoutController.signal]);
  try {
    return await Promise.race<AssistantMessage | null>([
      ctx.modelRegistry.complete(model, request, {
        signal: mergedSignal,
        // Session-routed providers (e.g. opencode-go) reject calls without it.
        sessionId: ctx.sessionManager.getSessionId(),
        maxTokens: Math.min(model.maxTokens, ENHANCER_MAX_OUTPUT_TOKENS),
      }),
      abortGuard(signal, null),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function retryRequest(request: Context): Context {
  const last = request.messages.at(-1);
  const currentText = last && typeof last.content === "string" ? last.content : "";
  const reminded: UserMessage = {
    role: "user",
    content: `${currentText}\n\nIMPORTANT: reply with exactly one ${SENTINEL_OPEN} block and nothing else.`,
    timestamp: Date.now(),
  };
  return {
    ...request,
    messages: [...request.messages.slice(0, -1), reminded],
  };
}

function abortGuard<T>(signal: AbortSignal, value: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(value);
  return new Promise<T>((resolve) => {
    signal.addEventListener("abort", () => resolve(value), { once: true });
  });
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function parseSentinel(text: string): string | undefined {
  const start = text.indexOf(SENTINEL_OPEN);
  const end = text.lastIndexOf(SENTINEL_CLOSE);
  if (start === -1 || end === -1 || end <= start) return undefined;
  const inner = text.slice(start + SENTINEL_OPEN.length, end).trim();
  return inner || undefined;
}

async function runWithLoader(
  ctx: ExtensionContext,
  message: string,
  task: (signal: AbortSignal) => Promise<string | null>,
): Promise<string | null> {
  let taskError: Error | undefined;
  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: true });
    loader.onAbort = () => done(null);
    void task(loader.signal)
      .then((value) => {
        if (!loader.signal.aborted) done(value);
      })
      .catch((error: unknown) => {
        if (loader.signal.aborted) {
          done(null);
          return;
        }
        taskError = error instanceof Error ? error : new Error(`${EXTENSION} failed.`);
        done(null);
      });
    return loader;
  });
  if (taskError) throw taskError;
  return result;
}
