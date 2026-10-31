/**
 * CORE-2553: record what Jev answers for every replayed decision, once, so the
 * gate can be redesigned and fitted offline without calling Jev again.
 *
 * `recordingRegistry` answers through the REST endpoint (TYPESAFE_API_KEY) and
 * keeps the request and answer per row and seam. `cannedRegistry` answers from
 * such a recording, so a replay over recorded answers is deterministic.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readApiKey } from "../../../shared/suggest.ts";

export interface Recorded {
  row: string;
  seam: "input" | "agent_end";
  state: Record<string, unknown>;
  questions: Record<string, { type: string; instructions?: string; criteria?: Record<string, string> }>;
  /** Answers in the registry shape: choice -> {type,choice,probabilities,confidence}; noul -> {type:"bool",probability}. */
  answers: Record<string, Record<string, unknown>> | null;
  model: string | null;
  ms: number;
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODELS = [{ id: "jev-latest", provider: "typesafe" }];

/** Registry questions map nouls to bool choices; REST takes nouls. */
function toRest(questions: Recorded["questions"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, q]) => [id, q.type === "bool" ? { type: "noul", instructions: q.instructions } : q]),
  );
}

function fromRest(answers: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]) => [
      id,
      a["type"] === "noul" || (a["noul"] !== undefined && a["choice"] === undefined)
        ? { type: "bool", probability: Number(a["noul"]) }
        : { ...a, type: "choice" },
    ]),
  );
}

export async function askJev(
  state: Record<string, unknown>,
  questions: Recorded["questions"],
): Promise<{ answers: Recorded["answers"]; model: string | null; ms: number }> {
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${readApiKey()}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions: toRest(questions) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const body = (await res.json()) as { answers?: Record<string, Record<string, unknown>>; model?: string };
        if (body.answers) return { answers: fromRest(body.answers), model: body.model ?? null, ms: Date.now() - started };
      }
    } catch {
      /* retried below */
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return { answers: null, model: null, ms: Date.now() - started };
}

export function recordingRegistry(sink: Recorded[], row: string, seam: Recorded["seam"]) {
  return {
    getAvailableOfType: async () => MODELS,
    classify: async (_m: unknown, req: { state: Record<string, unknown>; questions: Recorded["questions"] }) => {
      const { answers, model, ms } = await askJev(req.state, req.questions);
      sink.push({ row, seam, state: req.state, questions: req.questions, answers, model, ms });
      return answers ? { stopReason: "stop", answers, model: model ?? "typesafe/jev-latest" } : { stopReason: "error", errorMessage: "jev unavailable" };
    },
  };
}

/** The committed recording (answers.jsonl): answers only, rounded to 4 places. */
export function loadAnswers(): Array<Pick<Recorded, "row" | "seam" | "answers" | "model">> {
  const file = join(new URL(".", import.meta.url).pathname, "answers.jsonl");
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function cannedRegistry(recorded: Array<Pick<Recorded, "row" | "seam" | "answers" | "model">>, row: string, seam: Recorded["seam"]) {
  const hit = recorded.find((r) => r.row === row && r.seam === seam);
  return {
    getAvailableOfType: async () => MODELS,
    classify: async () =>
      hit?.answers ? { stopReason: "stop", answers: hit.answers, model: hit.model ?? "typesafe/jev-latest" } : { stopReason: "error", errorMessage: "not recorded" },
  };
}
