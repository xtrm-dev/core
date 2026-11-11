/**
 * The skill-suggest decision, shared by every host (CORE-2594).
 *
 * Moved verbatim out of the Pi extension so the Claude plugin worker and the Pi
 * extension run one judge: the roster, the two Jev stages, and the fitted score.
 * This module owns no state and no caching; a host builds the index (buildIndex)
 * and decides when to rebuild it. tests/skill-suggest/judge-golden.test.ts pins
 * the Jev payloads and every Judgement against the pre-extraction code.
 */

import { readFile } from "node:fs/promises";
import { buildRetrievalIndex, loadServices, shortlist, type RetrievalIndex, type ServiceRecord, type ShortlistQuery } from "./shortlist.ts";
import { classify, type ClassifierFailure, type Question, type RegistryLike } from "./suggest.ts";
import { discoverRoster, repoRootOf, type RosterEntry } from "./roster.ts";

/**
 * The retrieval index for `cwd`: the curated roster plus the service registry.
 * Pure of module state (the caller caches); rejects on an unreadable tree, so a
 * host must treat a rejection as "no index" and fail open.
 *
 * `home` pins the home roots (CORE-2605); it defaults to the process home.
 */
export async function buildIndex(cwd: string, { home }: { home?: string } = {}): Promise<RetrievalIndex<RosterEntry>> {
  const repoRoot = await repoRootOf(cwd);
  const [entries, services] = await Promise.all([discoverRoster(cwd, Date.now(), { home }), loadServices(repoRoot)]);
  return buildRetrievalIndex(entries, services, repoRoot, cwd);
}

/**
 * The classifier's choice criteria: the shortlist plus an explicit `none`.
 *
 * CORE-2553: Jev never sees ids, so each criterion names its document, and a
 * reference names the skill it belongs to with that skill's first sentence.
 * A reference's own summary is often a launch instruction ("Read this file at
 * launch…") that says nothing about when it applies. `none` lists what does
 * not call for a procedure instead of one generic sentence.
 */
export function criteriaOf(
  candidates: RosterEntry[],
  index: { entries: readonly RosterEntry[]; serviceOf?: ReadonlyMap<string, ServiceRecord>; serviceSkill?: ReadonlyMap<string, string> },
): Record<string, string> {
  const skills = new Map(index.entries.filter((e) => e.level === "skill").map((e) => [e.skill, e]));
  const firstSentence = (s: string) => (s.split(/(?<=[.;])\s/)[0] ?? "").slice(0, 140);
  const criterion = (e: RosterEntry) => {
    // CORE-2555: a service's SKILL.md often has no frontmatter; the registry
    // description is written to say when the service applies.
    const svc = index.serviceOf?.get(e.id);
    if (svc && index.serviceSkill?.get(svc.id) === e.id && svc.description) return `${svc.name} service: ${svc.description}`;
    if (svc && index.serviceSkill?.get(svc.id) !== e.id) return `${e.name} (part of the ${svc.name} service) — ${e.description}`;
    if (e.level === "skill") return `${e.name}: ${e.description}`;
    const parent = skills.get(e.skill);
    return `${e.name} (part of ${e.skill}${parent ? `: ${firstSentence(parent.description)}` : ""}) — ${e.description}`;
  };
  return Object.fromEntries([...candidates.map((e) => [e.id, criterion(e)]), ["none", NONE_CRITERION]]);
}

export const NONE_CRITERION =
  "No listed procedure governs this: narration or a status report, a reply or relay to another agent, a decision the operator states, a question answered from the conversation, or work only sharing a topic or keyword with a listed procedure.";

/**
 * The decision (CORE-2564): two Jev calls and one fitted score.
 *
 * Stage 1 ranks a wide BM25 list (120 candidates, 100 characters each, no
 * `none`) and asks the gate nouls; at the input seam it also keeps the
 * 24-candidate choice with `none`, whose weight on `none` was the best single
 * signal there. Stage 2 rereads the three best-ranked documents with their full
 * description and the opening of their body, picks one, and asks one `fits`
 * noul per document. The vendor recipe (TypeSafe skill_suggestion cookbook)
 * has the same two stages.
 *
 * A per-seam logistic score over those answers decides. It replaced a chain of
 * hand-set thresholds (CORE-2366/2553) whose confidence gate separated right
 * picks from quiet turns no better than chance. Fitted on the seeded train half
 * of the 600-row replay (3 live runs, jev-1.14.0), scored on the held-out half:
 * label precision 0.32 -> 0.48, false fires 0.063 -> 0.042, wanted rows with a
 * right pick 0.13 -> 0.20.
 *
 * Missing evidence never fires (CORE-2366): an answer the score needs that is
 * absent abstains, with the missing feature as the reason.
 */
export type Seam = "input" | "agent_end";
export const WIDE_MAX = 120;
const WIDE_TEXT = 100;
const RERANK_TOP = 3;
const BODY_CHARS = 700;
const oneLine = (s: string, n: number): string => s.replace(/\s+/g, " ").trim().slice(0, n);

export const SCORE_MODEL: Record<Seam, { intercept: number; weights: Record<string, number>; threshold: number }> = {
  input: {
    intercept: -4.220655,
    weights: { fits_win: 1.809604, wide_p1: 1.646026, skill_none_inv: 2.636992, task: 0.426932, n_named: 0.685306, prose_inv: -1.365487 },
    threshold: 0.35,
  },
  agent_end: {
    intercept: -6.120762,
    weights: { fits_win: 3.286472, wide_p1: 2.247342, task: 0.950195, prose_inv: 0.826815, fits_max: 2.640259 },
    threshold: 0.55,
  },
};

/** CORE-2553: the task noul, asked at both seams. */
const TASK_NOUL =
  "Does the request (or the agent's stated next step) start a concrete piece of work, such as debugging, reviewing, releasing, deploying, planning, coordinating workers or operating a named service, rather than chat, a status check, a decision the operator states, or a reply to another agent?";
const PROSE_NOUL: Record<Seam, string> = {
  input: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools and no access to the user's files? (Counts against suggesting.)",
  agent_end: "Is the stated next step purely mechanical or narrative, needing no doctrine? (Counts against suggesting.)",
};
const NAMED_NOUL = "Does the request name a specific tool, service, command, workflow or documented procedure to use?";
const SKILL_INSTRUCTIONS =
  "Pick the single skill or reference document whose stated use applies to the task this request starts, so that following it would change what the agent does next; otherwise pick none. A procedure that only shares a topic or keyword does not apply. Base it only on the request and the provided descriptions.";
const PICK_INSTRUCTIONS: Record<Seam, string> = {
  input: "Which of these documents is the right one for the agent to read before it starts on this request? Judge what each document is for, not shared words.",
  agent_end: "Which of these documents is the right one for the agent to read before its next step? Judge what each document is for, not shared words.",
};
const RERANK_INSTRUCTIONS: Record<Seam, string> = {
  input: "Exactly one of these documents is the right one for the agent to read before it starts on this request. Which one? Read what each actually covers, not just its name.",
  agent_end: "Exactly one of these documents is the right one for the agent to read before its next step. Which one? Read what each actually covers, not just its name.",
};
export function fitsQuestion(seam: Seam, name: string, description: string): string {
  return seam === "input"
    ? `Does the document '${name}' describe how to do the specific work this request asks for? It is described as: ${description}`
    : `Does the document '${name}' describe how to do the agent's next step? It is described as: ${description}`;
}

/** Choice ids, most probable first; ties keep the answer's order. */
export function rankedIds(probabilities: Record<string, number>): string[] {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** The score's inputs from both stages' answers; null where an answer is absent. */
export function decisionFeatures(a: {
  skillNone: number | null | undefined;
  wide: Record<string, number>;
  nouls: Record<string, number | null | undefined>;
  winner: string | null;
  fits: Record<string, number | null | undefined>;
}): Record<string, number | null> {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const fitsValues = Object.values(a.fits).map(num).filter((v): v is number => v !== null);
  const wideTop = Math.max(...Object.values(a.wide), Number.NEGATIVE_INFINITY);
  const task = num(a.nouls["starts_governed_task"]);
  const prose = num(a.nouls["prose_suffices"]);
  return {
    fits_win: a.winner ? num(a.fits[a.winner]) : null,
    fits_max: fitsValues.length ? Math.max(...fitsValues) : null,
    wide_p1: Number.isFinite(wideTop) ? wideTop : null,
    skill_none_inv: num(a.skillNone) === null ? null : 1 - (a.skillNone as number),
    task,
    prose_inv: prose === null ? null : 1 - prose,
    n_named: num(a.nouls["n_named"]),
  };
}

/** Logistic score for a seam; abstains (score null) when a weighted feature is missing. */
export function decisionScore(seam: Seam, features: Record<string, number | null | undefined>): { score: number | null; missing: string | null } {
  const model = SCORE_MODEL[seam];
  let z = model.intercept;
  for (const [k, w] of Object.entries(model.weights)) {
    const v = features[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return { score: null, missing: k };
    z += w * v;
  }
  return { score: 1 / (1 + Math.exp(-z)), missing: null };
}

/** The opening of a document's body for the rerank criteria; empty when unreadable. */
export async function docOpening(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return oneLine(text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#\s.*\n/, ""), BODY_CHARS);
  } catch {
    return "";
  }
}

/** One seam's decision: both Jev stages and the score. Never rejects. */
export type Judgement =
  | { skip: string; failure?: ClassifierFailure; facts: Record<string, unknown> }
  | { skip: null; entry: RosterEntry | null; pick: string | null; score: number | null; reason: string; model: string | null; facts: Record<string, unknown> };

export async function judge(
  seam: Seam,
  registry: RegistryLike | null,
  index: RetrievalIndex<RosterEntry>,
  state: Record<string, unknown>,
  query: ShortlistQuery,
  timeoutMs?: number,
): Promise<Judgement> {
  const sl = shortlist(index, query);
  const wide = shortlist(index, query, WIDE_MAX);
  const facts: Record<string, unknown> = { roster: wide.total, shortlist: sl.candidates.length, wide: wide.candidates.length, dropped: wide.dropped, territory: wide.territoryHits };
  if (wide.candidates.length === 0) return { skip: "no_candidates", facts };
  const full = criteriaOf(wide.candidates, index);
  const q1: Record<string, Question> = {};
  if (seam === "input") q1["skill"] = { type: "choice", instructions: SKILL_INSTRUCTIONS, criteria: criteriaOf(sl.candidates, index) };
  q1["starts_governed_task"] = { type: "noul", instructions: TASK_NOUL };
  q1["prose_suffices"] = { type: "noul", instructions: PROSE_NOUL[seam] };
  q1["wide"] = {
    type: "choice",
    instructions: PICK_INSTRUCTIONS[seam],
    criteria: Object.fromEntries(wide.candidates.map((e) => [e.id, oneLine(full[e.id] ?? e.id, WIDE_TEXT)])),
  };
  if (seam === "input") q1["n_named"] = { type: "noul", instructions: NAMED_NOUL };
  const one = await classify(registry, state, q1, { timeoutMs });
  facts["jev_ms"] = one.ms;
  facts["jev_path"] = one.path;
  if (!one.result) return { skip: `classifier:${one.failure}`, failure: one.failure ?? "transport", facts };
  const wideAnswer = one.result.choices["wide"];
  const byId = new Map(wide.candidates.map((e) => [e.id, e]));
  const top = wideAnswer ? rankedIds(wideAnswer.probabilities).filter((id) => byId.has(id)).slice(0, RERANK_TOP) : [];
  if (!wideAnswer || top.length === 0) return { skip: "classifier:bad_answer", failure: "bad_answer", facts };
  const openings = await Promise.all(top.map((id) => docOpening(byId.get(id)!.path)));
  const q2: Record<string, Question> = {
    rr_wide: { type: "choice", instructions: RERANK_INSTRUCTIONS[seam], criteria: Object.fromEntries(top.map((id, i) => [id, `${full[id]} — ${openings[i]}`])) },
  };
  top.forEach((id, i) => {
    q2[`fits::${i}`] = { type: "noul", instructions: fitsQuestion(seam, byId.get(id)!.name, full[id] ?? "") };
  });
  const two = await classify(registry, state, q2, { timeoutMs });
  facts["jev_ms"] = one.ms + two.ms;
  if (!two.result) return { skip: `classifier:${two.failure}`, failure: two.failure ?? "transport", facts };
  const winner = two.result.choices["rr_wide"]?.choice ?? null;
  const fits = Object.fromEntries(top.map((id, i) => [id, two.result!.nouls[`fits::${i}`]]));
  const skill = one.result.choices["skill"];
  const features = decisionFeatures({
    skillNone: seam === "input" && skill ? (skill.probabilities["none"] ?? 0) : null,
    wide: wideAnswer.probabilities,
    nouls: one.result.nouls,
    winner,
    fits,
  });
  const { score, missing } = decisionScore(seam, features);
  const entry = winner ? (byId.get(winner) ?? null) : null;
  const reason = missing ? `missing-${missing}` : !entry ? "unknown-entry" : (score as number) < SCORE_MODEL[seam].threshold ? "below-score" : "fire";
  facts["score"] = score === null ? null : Number(score.toFixed(3));
  facts["wide_top"] = top;
  facts["features"] = Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v === null ? null : Number(v.toFixed(3))]));
  return { skip: null, entry: reason === "fire" ? entry : null, pick: winner, score, reason, model: two.result.model, facts };
}
