/**
 * Jev System One client for substrate-suggest — two paths, best first:
 *
 * 1. Pi's native classifier API (ctx.modelRegistry.classify): credentials,
 *    gateway routing and model selection are Pi's own (auth.json providers,
 *    e.g. the opencode zen `typesafe-system-one` classifier models). Zero key
 *    handling here. Noul questions map to Pi's `bool` classifier questions.
 *
 * 2. Direct REST fallback (scripts/jev_classify.py shape contract):
 *    POST https://api.typesafe.ai/v1/systemone
 *    { model, state, questions: { <id>: { type, instructions, criteria? } } }
 *    -> { answers: { <id>: choice{n} | noul{n|bool} }, usage, model }
 *
 * Security contract (mirrors scripts/jev_classify.py §12):
 *   - REST key from TYPESAFE_API_KEY or ~/.secrets/typesafe_api_key.txt
 *   - key is never printed, never logged, never put in state
 *   - Jev output is advisory only; it never authorizes anything
 *
 * Fail-open: any error (network, shape, timeout) resolves to null and the
 * caller falls back to deterministic-only suggestions.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "jev-latest";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 2500;

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export interface JevChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
}

export interface JevResult {
  choice: JevChoiceAnswer;
  nouls: Record<string, number>;
  model: string | null;
  usage: { input_tokens?: number; output_tokens?: number } | null;
  latencyMs: number;
}

export function readApiKey(): string | null {
  const env = process.env["TYPESAFE_API_KEY"];
  if (env && env.trim()) return env.trim();
  try {
    const raw = readFileSync(join(homedir(), ".secrets", "typesafe_api_key.txt"), "utf8").trim();
    // File holds TYPESAFE_API_KEY=<key> or a bare key.
    const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
    return value.trim() || null;
  } catch {
    return null;
  }
}

export interface ClassifierModelLike {
  provider: string;
  id: string;
}

export interface RegistryLike {
  getAvailableOfType(type: string, provider?: string): Promise<readonly unknown[]>;
  classify(
    model: unknown,
    context: { state: Record<string, unknown>; questions: Record<string, unknown> },
    options?: unknown,
  ): Promise<{
    answers?: Record<string, Record<string, unknown>>;
    stopReason?: string;
    errorMessage?: string;
    usage?: { input?: number; output?: number };
    model?: string;
  }>;
}

/** Pick the best classifier: jev on the typesafe provider first, any jev id next. */
export function pickClassifier(models: readonly unknown[]): ClassifierModelLike | null {
  const jev = models.filter((m) => /jev/i.test(String((m as { id?: unknown })?.id ?? "")));
  const preferred =
    jev.find((m) => String((m as { provider?: unknown })?.provider ?? "") === "typesafe") ??
    jev[0] ??
    null;
  return (preferred as ClassifierModelLike) ?? null;
}

/** Pi-native path: the same credentials and gateways codemode uses. Never rejects. */
export async function classifyViaRegistry(
  registry: RegistryLike,
  state: Record<string, unknown>,
  questions: Record<string, Question>,
): Promise<JevResult | null> {
  try {
    const models = await registry.getAvailableOfType("classifier");
    const model = pickClassifier(models);
    if (!model) return null;
    const mapped: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") mapped[id] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
      else
        mapped[id] = {
          type: "bool",
          instructions: q.instructions,
          criteria: { true: "The answer is yes.", false: "The answer is no." },
        };
    }
    const res = await registry.classify(model, { state, questions: mapped });
    if (!res || res.stopReason === "error" || res.stopReason === "aborted" || !res.answers) return null;
    const choiceRaw = Object.values(res.answers).find((a) => a?.["type"] === "choice");
    if (!choiceRaw) return null;
    const choice: JevChoiceAnswer = {
      choice: String(choiceRaw["choice"] ?? ""),
      probabilities: Object.fromEntries(
        Object.entries((choiceRaw["probabilities"] ?? {}) as Record<string, unknown>).map(([k, v]) => [k, toNumber(v)]),
      ),
      confidence: typeof choiceRaw["confidence"] === "number" ? choiceRaw["confidence"] : null,
    };
    if (!choice.choice) return null;
    const nouls: Record<string, number> = {};
    for (const [id, a] of Object.entries(res.answers)) {
      if (a?.["type"] === "bool") nouls[id] = toNumber(a["probability"]);
    }
    return {
      choice,
      nouls,
      model: res.model ?? `${model.provider}/${model.id}`,
      usage: res.usage ? { input_tokens: res.usage.input, output_tokens: res.usage.output } : null,
      latencyMs: 0,
    };
  } catch {
    return null;
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function parseAnswer(raw: unknown): { choice?: JevChoiceAnswer; noul?: number } {
  return parseAnswerPayload(raw);
}

/** Tolerant answer parser, exported for tests. Accepts number and boolean nouls. */
export function parseAnswerPayload(raw: unknown): { choice?: JevChoiceAnswer; noul?: number } {
  if (raw === null || typeof raw !== "object") return {};
  const a = raw as Record<string, unknown>;
  const type = a["type"];
  if (type === "noul" || (a["noul"] !== undefined && a["choice"] === undefined)) {
    return { noul: toNumber(a["noul"]) };
  }
  if (type === "choice" || a["choice"] !== undefined) {
    const probs =
      a["probabilities"] !== null && typeof a["probabilities"] === "object"
        ? Object.fromEntries(Object.entries(a["probabilities"] as Record<string, unknown>).map(([k, v]) => [k, toNumber(v)]))
        : {};
    return {
      choice: {
        choice: String(a["choice"] ?? ""),
        probabilities: probs,
        confidence: typeof a["confidence"] === "number" ? a["confidence"] : null,
      },
    };
  }
  return {};
}

export async function systemOne(
  state: Record<string, unknown>,
  questions: Record<string, Question>,
  opts: { apiKey?: string | null; model?: string; timeoutMs?: number } = {},
): Promise<JevResult | null> {
  const key = opts.apiKey !== undefined ? opts.apiKey : readApiKey();
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model ?? DEFAULT_MODEL, state, questions }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const answers = body["answers"];
    if (answers === null || typeof answers !== "object") return null;
    const parsed = Object.values(answers as Record<string, unknown>).map(parseAnswer);
    const choice = parsed.find((p) => p.choice)?.choice;
    if (!choice || !choice.choice) return null;
    const nouls: Record<string, number> = {};
    for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
      const p = parseAnswer(raw);
      if (p.noul !== undefined) nouls[id] = p.noul;
    }
    const usage = (body["usage"] ?? null) as Record<string, unknown> | null;
    return {
      choice,
      nouls,
      model: typeof body["model"] === "string" ? body["model"] : null,
      usage: usage ? { input_tokens: Number(usage["input_tokens"]), output_tokens: Number(usage["output_tokens"]) } : null,
      latencyMs: Date.now() - started,
    };
  } catch {
    return null; // network, timeout, bad JSON — fail open
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded dir read so a missing/odd secrets dir never throws at import time. */
export function secretsDirOk(): boolean {
  try {
    readdirSync(join(homedir(), ".secrets"));
    return true;
  } catch {
    return false;
  }
}

/** Neutral question-dict builder, exported for tests (shape contract only). */
export function questionShape(type: "noul" | "choice", instructions: string, criteria?: Record<string, string>): Question {
  const q: Question = { type, instructions } as Question;
  if (criteria) (q as { criteria?: Record<string, string> }).criteria = criteria;
  return q;
}
