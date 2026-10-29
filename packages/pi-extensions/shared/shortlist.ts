/**
 * Code computes, Jev judges (CORE-2533).
 *
 * The classifier used to receive the whole discovered roster as one choice:
 * 281 criteria, which the API rejects past 255, and whose probability mass
 * split between a skill and its own references. This module builds a small,
 * deterministic candidate set instead — service-registry matches first, then
 * lexical retrieval (BM25 over id, name, description and section headings) —
 * so Jev only ever chooses among a few relevant documents plus `none`.
 *
 * Pure functions over an index built once with async IO; the hot path does no
 * filesystem work.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The slice of a roster entry retrieval needs. */
export interface Retrievable {
  id: string;
  skill: string;
  name: string;
  description: string;
  path: string;
  headings?: string[];
}

/** One service from a service-knowledge registry. */
export interface ServiceRecord {
  id: string;
  name: string;
  description: string;
  container: string | null;
  territory: string[];
  /** Absolute path of the service's SKILL.md. */
  skillPath: string;
}

export interface RetrievalIndex<E extends Retrievable> {
  entries: E[];
  services: ServiceRecord[];
  /** Entry id -> the service it documents (its SKILL.md or a doc under its directory). */
  serviceOf: Map<string, ServiceRecord>;
  /** Service id -> the entry id of its SKILL.md. */
  serviceSkill: Map<string, string>;
  docs: Map<string, Map<string, number>>;
  lengths: Map<string, number>;
  df: Map<string, number>;
  avgLen: number;
  repoRoot: string;
}

export interface ShortlistQuery {
  /** Operator prompt, agent intention, turn excerpt — whatever the seam has. */
  text: string;
  /** Files read or edited in the session, repo-relative or absolute. */
  files?: string[];
}

export interface Shortlist<E extends Retrievable> {
  candidates: E[];
  /** Entries in the index. */
  total: number;
  /** Entries that scored above zero but did not fit the cap. */
  dropped: number;
  /** Services whose territory a session file falls in. */
  territoryHits: string[];
}

export const SHORTLIST_MAX = 24;
/** Per-skill cap: one skill's 33 nested docs must not crowd out everything else. */
const PER_SKILL_MAX = 4;
/** Per-service cap: the service SKILL.md plus its two best docs. */
const PER_SERVICE_MAX = 3;
/** A candidate must score at least this share of the best lexical score. */
const RELATIVE_FLOOR = 0.2;
const TERRITORY_BOOST = 1000;

const STOP = new Set(
  "the and for with that this from into onto over under then than when what which who whom whose why how are was were been being have has had does did doing not but can could should would will shall may might must its it's our ours your yours their theirs them they you she him her his i'm i've we're let's use used using via per also just only very more most some any all each both few other such own same too out off again once here there where these those about above after before below between during through until while against because isn't don't let lets please now okay yes yeah thanks".split(" "),
);

/** Crude suffix stemmer: enough to match migrate/migrating/migration. */
function stem(t: string): string {
  for (const suf of ["ations", "ation", "ions", "ion", "ings", "ing", "ers", "er", "ies", "es", "ed", "e", "s"]) {
    if (t.length - suf.length >= 4 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Territory glob semantics, identical to substrate-suggest's: `a/**` and `a/*`
 * are prefixes, a bare path matches itself, a suffix segment, or a directory.
 */
export function territoryMatches(pattern: string, path: string): boolean {
  const p = pattern.replace(/^\.\//, "");
  if (p.includes("**")) return path.startsWith(p.split("**")[0]);
  if (p.endsWith("*")) return path.startsWith(p.slice(0, -1));
  return path === p || path.endsWith(`/${p}`) || path.startsWith(`${p}/`);
}

/** Parse one service-registry.json; services whose skill file is missing are dropped. */
export function parseServiceRegistry(json: string, packDir: string, repoRoot: string): ServiceRecord[] {
  try {
    const parsed = JSON.parse(json) as {
      services?: Record<string, { name?: string; description?: string; container?: string; skill_path?: string; territory?: unknown }>;
    };
    const out: ServiceRecord[] = [];
    for (const [id, svc] of Object.entries(parsed.services ?? {})) {
      const description = typeof svc?.description === "string" ? svc.description.trim() : "";
      if (!description) continue;
      const skillPath = svc.skill_path ? join(repoRoot, svc.skill_path) : join(packDir, "services", id, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      out.push({
        id,
        name: svc.name ?? id,
        description,
        container: typeof svc.container === "string" ? svc.container : null,
        territory: Array.isArray(svc.territory) ? (svc.territory as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 40) : [],
        skillPath,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Every `.xtrm/skills/<pack>/service-knowledge/service-registry.json` in the repo. */
export async function loadServices(repoRoot: string): Promise<ServiceRecord[]> {
  const skillsRoot = join(repoRoot, ".xtrm", "skills");
  let packs: string[];
  try {
    packs = (await readdir(skillsRoot)).sort();
  } catch {
    return [];
  }
  const out: ServiceRecord[] = [];
  for (const pack of packs) {
    const packDir = join(skillsRoot, pack, "service-knowledge");
    try {
      out.push(...parseServiceRegistry(await readFile(join(packDir, "service-registry.json"), "utf8"), packDir, repoRoot));
    } catch {
      /* no registry in this pack */
    }
  }
  return out;
}

/** Build the retrieval index. Pure given its inputs; `cwd` resolves relative entry paths. */
export function buildRetrievalIndex<E extends Retrievable>(entries: E[], services: ServiceRecord[], repoRoot: string, cwd: string): RetrievalIndex<E> {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  // A service owns its SKILL.md and every doc under the same directory.
  const serviceDirs = services.map((s) => ({ dir: `${dirname(abs(s.skillPath))}/`, svc: s }));
  const serviceOf = new Map<string, ServiceRecord>();
  const serviceSkill = new Map<string, string>();
  const docs = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const e of entries) {
    const path = abs(e.path);
    const svc = serviceDirs.find((d) => path.startsWith(d.dir))?.svc;
    if (svc) {
      serviceOf.set(e.id, svc);
      if (path === abs(svc.skillPath)) serviceSkill.set(svc.id, e.id);
    }
    const text = [
      e.id.replace(/[/_-]/g, " "),
      e.name,
      e.description,
      ...(e.headings ?? []),
      svc ? `${svc.id.replace(/-/g, " ")} ${svc.name} ${svc.container ?? ""} ${svc.description}` : "",
    ].join(" ");
    const tokens = tokenize(text);
    const tf = termFreq(tokens);
    docs.set(e.id, tf);
    lengths.set(e.id, tokens.length);
    totalLen += tokens.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { entries, services, serviceOf, serviceSkill, docs, lengths, df, avgLen: entries.length ? totalLen / entries.length : 1, repoRoot };
}

/** BM25 (k1 = 1.2, b = 0.75) of one entry against the query terms. */
function bm25<E extends Retrievable>(index: RetrievalIndex<E>, id: string, query: Map<string, number>): number {
  const tf = index.docs.get(id);
  if (!tf) return 0;
  const len = index.lengths.get(id) ?? 0;
  const n = index.entries.length;
  let score = 0;
  for (const term of query.keys()) {
    const f = tf.get(term);
    if (!f) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (len / index.avgLen))));
  }
  return score;
}

/** Services whose territory contains one of the files. */
export function territoryServices(services: ServiceRecord[], files: string[], repoRoot: string): ServiceRecord[] {
  const rels = files
    .map((f) => (isAbsolute(f) ? relative(repoRoot, f) : f.replace(/^\.\//, "")))
    .filter((r) => r && !r.startsWith(".."));
  return services.filter((s) => s.territory.some((pattern) => rels.some((r) => territoryMatches(pattern, r))));
}

/**
 * At most `max` candidates, deterministic: territory hits first, then BM25
 * score, ties by id. Zero-score entries never enter. `none` is the caller's.
 */
export function shortlist<E extends Retrievable>(index: RetrievalIndex<E>, query: ShortlistQuery, max = SHORTLIST_MAX): Shortlist<E> {
  const files = query.files ?? [];
  const terms = termFreq(tokenize(`${query.text} ${files.join(" ")}`));
  const hits = new Set(territoryServices(index.services, files, index.repoRoot).map((s) => s.id));
  const lexical = new Map<string, number>();
  for (const e of index.entries) lexical.set(e.id, bm25(index, e.id, terms));
  // A service is as relevant as its best doc: its SKILL.md (the load target)
  // ranks just ahead of that doc, so the service, not a stray reference, leads.
  const bestOfService = new Map<string, number>();
  for (const [id, svc] of index.serviceOf) bestOfService.set(svc.id, Math.max(bestOfService.get(svc.id) ?? 0, lexical.get(id) ?? 0));
  const top = Math.max(0, ...lexical.values());
  const scored: Array<{ e: E; score: number }> = [];
  for (const e of index.entries) {
    const svc = index.serviceOf.get(e.id);
    let score = lexical.get(e.id) ?? 0;
    const best = svc ? (bestOfService.get(svc.id) ?? 0) : 0;
    if (best > 0 && index.serviceSkill.get(svc!.id) === e.id) score = Math.max(score, best + 1e-6);
    const territory = svc !== undefined && hits.has(svc.id);
    if (!territory && (score <= 0 || score < RELATIVE_FLOOR * top)) continue;
    scored.push({ e, score: score + (territory ? TERRITORY_BOOST : 0) });
  }
  scored.sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
  const perGroup = new Map<string, number>();
  const candidates: E[] = [];
  for (const { e } of scored) {
    if (candidates.length >= max) break;
    // Services are distinct subjects even though they share a parent skill.
    const svc = index.serviceOf.get(e.id);
    const group = svc ? `service:${svc.id}` : `skill:${e.skill}`;
    const n = perGroup.get(group) ?? 0;
    if (n >= (svc ? PER_SERVICE_MAX : PER_SKILL_MAX)) continue;
    perGroup.set(group, n + 1);
    candidates.push(e);
  }
  return { candidates, total: index.entries.length, dropped: scored.length - candidates.length, territoryHits: [...hits].sort() };
}
