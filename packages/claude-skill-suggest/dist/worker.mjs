import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// worker/worker.ts
import { createHash } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile5, rename, writeFile } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { isAbsolute as isAbsolute2, join as join5, resolve as resolve2 } from "node:path";

// ../pi-extensions/shared/judge.ts
import { readFile as readFile4 } from "node:fs/promises";

// ../pi-extensions/shared/shortlist.ts
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
var SHORTLIST_MAX = 24;
var PER_SKILL_MAX = 4;
var PER_SERVICE_MAX = 3;
var RELATIVE_FLOOR = 0.2;
var TERRITORY_BOOST = 1000;
var STOP = new Set("the and for with that this from into onto over under then than when what which who whom whose why how are was were been being have has had does did doing not but can could should would will shall may might must its it's our ours your yours their theirs them they you she him her his i'm i've we're let's use used using via per also just only very more most some any all each both few other such own same too out off again once here there where these those about above after before below between during through until while against because isn't don't let lets please now okay yes yeah thanks".split(" "));
function stem(t) {
  for (const suf of ["ations", "ation", "ions", "ion", "ings", "ing", "ers", "er", "ies", "es", "ed", "e", "s"]) {
    if (t.length - suf.length >= 4 && t.endsWith(suf))
      return t.slice(0, -suf.length);
  }
  return t;
}
function tokenize(text) {
  const out = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw))
      continue;
    out.push(stem(raw));
  }
  return out;
}
function termFreq(tokens) {
  const tf = new Map;
  for (const t of tokens)
    tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}
function territoryMatches(pattern, path) {
  const p = pattern.replace(/^\.\//, "");
  if (p.includes("**"))
    return path.startsWith(p.split("**")[0]);
  if (p.endsWith("*"))
    return path.startsWith(p.slice(0, -1));
  return path === p || path.endsWith(`/${p}`) || path.startsWith(`${p}/`);
}
function parseServiceRegistry(json, packDir, repoRoot) {
  try {
    const parsed = JSON.parse(json);
    const out = [];
    for (const [id, svc] of Object.entries(parsed.services ?? {})) {
      const description = typeof svc?.description === "string" ? svc.description.trim() : "";
      if (!description)
        continue;
      const skillPath = svc.skill_path ? join(repoRoot, svc.skill_path) : join(packDir, "services", id, "SKILL.md");
      out.push({
        id,
        name: svc.name ?? id,
        description,
        container: typeof svc.container === "string" ? svc.container : null,
        territory: Array.isArray(svc.territory) ? svc.territory.filter((t) => typeof t === "string").slice(0, 40) : [],
        skillPath
      });
    }
    return out;
  } catch {
    return [];
  }
}
async function loadServices(repoRoot) {
  const skillsRoot = join(repoRoot, ".xtrm", "skills");
  let packs;
  try {
    packs = (await readdir(skillsRoot)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const pack of packs) {
    const packDir = join(skillsRoot, pack, "service-knowledge");
    try {
      const parsed = parseServiceRegistry(await readFile(join(packDir, "service-registry.json"), "utf8"), packDir, repoRoot);
      for (const svc of parsed) {
        try {
          await access(svc.skillPath);
          out.push(svc);
        } catch {}
      }
    } catch {}
  }
  return out;
}
function buildRetrievalIndex(entries, services, repoRoot, cwd) {
  const abs = (p) => isAbsolute(p) ? p : resolve(cwd, p);
  const serviceDirs = services.map((s) => ({ dir: `${dirname(abs(s.skillPath))}/`, svc: s }));
  const serviceOf = new Map;
  const serviceSkill = new Map;
  const docs = new Map;
  const lengths = new Map;
  const df = new Map;
  let totalLen = 0;
  for (const e of entries) {
    const path = abs(e.path);
    const svc = serviceDirs.find((d) => path.startsWith(d.dir))?.svc;
    if (svc) {
      serviceOf.set(e.id, svc);
      if (path === abs(svc.skillPath))
        serviceSkill.set(svc.id, e.id);
    }
    const text = [
      e.id.replace(/[/_-]/g, " "),
      e.name,
      e.description,
      ...e.headings ?? [],
      svc ? `${svc.id.replace(/-/g, " ")} ${svc.name} ${svc.container ?? ""} ${svc.description}` : ""
    ].join(" ");
    const tokens = tokenize(text);
    const tf = termFreq(tokens);
    docs.set(e.id, tf);
    lengths.set(e.id, tokens.length);
    totalLen += tokens.length;
    for (const t of tf.keys())
      df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { entries, services, serviceOf, serviceSkill, docs, lengths, df, avgLen: entries.length ? totalLen / entries.length : 1, repoRoot };
}
function bm25(index, id, query) {
  const tf = index.docs.get(id);
  if (!tf)
    return 0;
  const len = index.lengths.get(id) ?? 0;
  const n = index.entries.length;
  let score = 0;
  for (const term of query.keys()) {
    const f = tf.get(term);
    if (!f)
      continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += idf * (f * 2.2 / (f + 1.2 * (0.25 + 0.75 * (len / index.avgLen))));
  }
  return score;
}
function territoryServices(services, files, repoRoot) {
  const rels = files.map((f) => isAbsolute(f) ? relative(repoRoot, f) : f.replace(/^\.\//, "")).filter((r) => r && !r.startsWith(".."));
  return services.filter((s) => s.territory.some((pattern) => rels.some((r) => territoryMatches(pattern, r))));
}
function shortlist(index, query, max = SHORTLIST_MAX) {
  const files = query.files ?? [];
  const terms = termFreq(tokenize(`${query.text} ${files.join(" ")}`));
  const hits = new Set(territoryServices(index.services, files, index.repoRoot).map((s) => s.id));
  const lexical = new Map;
  for (const e of index.entries)
    lexical.set(e.id, bm25(index, e.id, terms));
  const bestOfService = new Map;
  for (const [id, svc] of index.serviceOf)
    bestOfService.set(svc.id, Math.max(bestOfService.get(svc.id) ?? 0, lexical.get(id) ?? 0));
  const top = Math.max(0, ...lexical.values());
  const scored = [];
  for (const e of index.entries) {
    const svc = index.serviceOf.get(e.id);
    let score = lexical.get(e.id) ?? 0;
    const best = svc ? bestOfService.get(svc.id) ?? 0 : 0;
    if (best > 0 && index.serviceSkill.get(svc.id) === e.id)
      score = Math.max(score, best + 0.000001);
    const territory = svc !== undefined && hits.has(svc.id);
    if (!territory && (score <= 0 || score < RELATIVE_FLOOR * top))
      continue;
    scored.push({ e, score: score + (territory ? TERRITORY_BOOST : 0) });
  }
  scored.sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
  const perGroup = new Map;
  const candidates = [];
  for (const { e } of scored) {
    if (candidates.length >= max)
      break;
    const svc = index.serviceOf.get(e.id);
    const group = svc ? `service:${svc.id}` : `skill:${e.skill}`;
    const n = perGroup.get(group) ?? 0;
    if (n >= (svc ? PER_SERVICE_MAX : PER_SKILL_MAX))
      continue;
    perGroup.set(group, n + 1);
    candidates.push(e);
  }
  return { candidates, total: index.entries.length, dropped: scored.length - candidates.length, territoryHits: [...hits].sort() };
}

// ../pi-extensions/shared/suggest.ts
import { readFile as readFile2 } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var DEFAULT_MODEL = "jev-latest";
var ENDPOINT = "https://api.typesafe.ai/v1/systemone";
var DEFAULT_TIMEOUT_MS = 2500;
var fileKey;
var fileKeyLoad = null;
function primeApiKey() {
  fileKeyLoad ??= (async () => {
    try {
      const raw = (await readFile2(join2(homedir(), ".secrets", "typesafe_api_key.txt"), "utf8")).trim();
      const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : raw;
      fileKey = value.trim() || null;
    } catch {
      fileKey = null;
    }
  })();
  return fileKeyLoad;
}
function readApiKey() {
  const env = process.env["TYPESAFE_API_KEY"];
  if (env && env.trim())
    return env.trim();
  if (fileKey === undefined)
    primeApiKey();
  return fileKey ?? null;
}
function pickClassifiers(models) {
  const jev = models.filter((m) => /jev/i.test(String(m?.id ?? "")));
  jev.sort((a, b) => {
    const pa = String(a?.provider ?? "") === "typesafe" ? 0 : 1;
    const pb = String(b?.provider ?? "") === "typesafe" ? 0 : 1;
    if (pa !== pb)
      return pa - pb;
    const fa = /free/i.test(String(a?.id ?? "")) ? 1 : 0;
    const fb = /free/i.test(String(b?.id ?? "")) ? 1 : 0;
    return fa - fb;
  });
  return jev;
}
async function classifyViaRegistry(registry, state, questions, opts = {}) {
  const fail = (reason) => {
    opts.onFailure?.(reason);
    return null;
  };
  try {
    const models = await registry.getAvailableOfType("classifier");
    const candidates = pickClassifiers(models);
    if (candidates.length === 0)
      return fail("no_classifier");
    const mapped = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice")
        mapped[id] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
      else
        mapped[id] = {
          type: "bool",
          instructions: q.instructions,
          criteria: { true: "The answer is yes.", false: "The answer is no." }
        };
    }
    let res = null;
    let used = null;
    for (const candidate of candidates) {
      const attempt = await registry.classify(candidate, { state, questions: mapped });
      if (attempt && attempt.stopReason !== "error" && attempt.stopReason !== "aborted" && attempt.answers) {
        res = attempt;
        used = candidate;
        break;
      }
    }
    if (!res || !used)
      return fail("provider_error");
    const answers = res.answers;
    if (!answers)
      return fail("bad_answer");
    const choiceRaw = Object.values(answers).find((a) => a?.["type"] === "choice");
    if (!choiceRaw)
      return fail("bad_answer");
    const choice = {
      choice: String(choiceRaw["choice"] ?? ""),
      probabilities: Object.fromEntries(Object.entries(choiceRaw["probabilities"] ?? {}).map(([k, v]) => [k, toNumber(v)])),
      confidence: typeof choiceRaw["confidence"] === "number" ? choiceRaw["confidence"] : null
    };
    if (!choice.choice)
      return fail("bad_answer");
    const nouls = {};
    const choices = {};
    for (const [id, a] of Object.entries(answers)) {
      if (a?.["type"] === "bool")
        nouls[id] = toNumber(a["probability"]);
      else if (a?.["type"] === "choice") {
        const c = parseAnswerPayload(a).choice;
        if (c)
          choices[id] = c;
      }
    }
    return {
      choice,
      choices,
      nouls,
      model: res.model ?? `${used.provider}/${used.id}`,
      usage: res.usage ? { input_tokens: res.usage.input, output_tokens: res.usage.output } : null,
      latencyMs: 0
    };
  } catch {
    return fail("transport");
  }
}
function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v))
    return v;
  if (typeof v === "boolean")
    return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return 0;
}
function parseAnswer(raw) {
  return parseAnswerPayload(raw);
}
function parseAnswerPayload(raw) {
  if (raw === null || typeof raw !== "object")
    return {};
  const a = raw;
  const type = a["type"];
  if (type === "noul" || a["noul"] !== undefined && a["choice"] === undefined) {
    return { noul: toNumber(a["noul"]) };
  }
  if (type === "choice" || a["choice"] !== undefined) {
    const probs = a["probabilities"] !== null && typeof a["probabilities"] === "object" ? Object.fromEntries(Object.entries(a["probabilities"]).map(([k, v]) => [k, toNumber(v)])) : {};
    return {
      choice: {
        choice: String(a["choice"] ?? ""),
        probabilities: probs,
        confidence: typeof a["confidence"] === "number" ? a["confidence"] : null
      }
    };
  }
  return {};
}
async function systemOne(state, questions, opts = {}) {
  const fail = (reason) => {
    opts.onFailure?.(reason);
    return null;
  };
  const key = opts.apiKey !== undefined ? opts.apiKey : readApiKey();
  if (!key)
    return fail("no_key");
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model ?? DEFAULT_MODEL, state, questions }),
      signal: controller.signal
    });
    if (!res.ok)
      return fail(`http_${res.status}`);
    const body = await res.json();
    const answers = body["answers"];
    if (answers === null || typeof answers !== "object")
      return fail("bad_answer");
    const parsed = Object.values(answers).map(parseAnswer);
    const choice = parsed.find((p) => p.choice)?.choice;
    if (!choice || !choice.choice)
      return fail("bad_answer");
    const nouls = {};
    const choices = {};
    for (const [id, raw] of Object.entries(answers)) {
      const p = parseAnswer(raw);
      if (p.noul !== undefined)
        nouls[id] = p.noul;
      if (p.choice)
        choices[id] = p.choice;
    }
    const usage = body["usage"] ?? null;
    return {
      choice,
      choices,
      nouls,
      model: typeof body["model"] === "string" ? body["model"] : null,
      usage: usage ? { input_tokens: Number(usage["input_tokens"]), output_tokens: Number(usage["output_tokens"]) } : null,
      latencyMs: Date.now() - started
    };
  } catch {
    return fail(controller.signal.aborted ? "timeout" : "transport");
  } finally {
    clearTimeout(timer);
  }
}
async function classify(registry, state, questions, opts = {}) {
  const started = Date.now();
  let registryFailure = null;
  let fallbackFailure = null;
  const attempt = (async () => {
    if (registry) {
      const r = await classifyViaRegistry(registry, state, questions, { onFailure: (f) => {
        registryFailure = f;
      } });
      if (r)
        return { result: r, path: "registry" };
    }
    const r = await systemOne(state, questions, { onFailure: (f) => {
      fallbackFailure = f;
    } });
    return { result: r, path: r ? "fallback" : null };
  })();
  let timer = null;
  const bounded = opts.timeoutMs === undefined ? await attempt : await Promise.race([attempt, new Promise((done) => {
    timer = setTimeout(() => done(null), opts.timeoutMs);
  })]);
  if (timer)
    clearTimeout(timer);
  const ms = Date.now() - started;
  if (bounded === null)
    return { result: null, path: null, ms, failure: "timeout" };
  if (bounded.result)
    return { ...bounded, ms, failure: null };
  const failure = fallbackFailure === "no_key" && registryFailure ? registryFailure : fallbackFailure ?? registryFailure ?? "transport";
  return { result: null, path: null, ms, failure };
}
var CATALOG = [
  {
    id: "claim_start",
    action: "sb issue claim",
    oneLine: "Active work on an unclaimed issue; claim it before continuing.",
    instruction: (ref) => `Claim before continuing: sb issue claim ${ref} --holder <holder>.`,
    severity: "high",
    cooldownMin: 15,
    source: "deterministic"
  },
  {
    id: "attest_ready",
    action: "sb issue attest",
    oneLine: "The draft contract must be attested ready before it can be claimed.",
    instruction: (ref) => `Attest readiness first: sb issue attest ${ref} --outcome ready --policy <policy> --attested-by <you>, then claim.`,
    severity: "normal",
    cooldownMin: 20,
    source: "deterministic"
  },
  {
    id: "claim_renew",
    action: "sb issue claim · renew",
    oneLine: "The live claim on this issue is about to expire; renew or release it.",
    instruction: (ref) => `Renew the claim you still hold: sb issue claim ${ref} --holder <holder>, or release it if the work ended.`,
    severity: "high",
    cooldownMin: 10,
    source: "deterministic"
  },
  {
    id: "close_due",
    action: "sb issue close",
    oneLine: "A bounded result was journaled and evidence exists; close the issue with cited refs.",
    instruction: (ref) => `Close with the evidence: sb issue close ${ref} --outcome completed --reason "…" --result <ref> --receipt <ref>.`,
    severity: "high",
    cooldownMin: 30,
    source: "deterministic"
  },
  {
    id: "revise_contract",
    action: "sb issue edit + attest",
    oneLine: "Work drifted from the attested contract revision; revise through planning and re-attest.",
    instruction: (ref) => `Stop and revise the contract: sb issue edit ${ref} (new revision), then attest readiness again before continuing.`,
    severity: "high",
    cooldownMin: 30,
    source: "deterministic"
  },
  {
    id: "checkpoint",
    action: "sb journal checkpoint",
    oneLine: "Enough uncheckpointed journal activity has accumulated; write a resumability boundary.",
    instruction: (ref) => `Checkpoint now: sb journal checkpoint ${ref} — mechanical state commits before any summarizer runs.`,
    severity: "normal",
    cooldownMin: 20,
    source: "deterministic"
  },
  {
    id: "journal_decision",
    action: "sb journal append · kind=decision",
    oneLine: "A course was chosen with rationale; record it as a decision.",
    instruction: (ref) => `Append the decision: substrate_journal_append ${ref} kind=decision with the chosen course and rationale.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev"
  },
  {
    id: "journal_finding",
    action: "sb journal append · kind=finding",
    oneLine: "A material discovered fact appeared; record it as a finding.",
    instruction: (ref) => `Append the finding: substrate_journal_append ${ref} kind=finding with the discovered fact.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev"
  },
  {
    id: "journal_blocker",
    action: "sb journal append · kind=blocker",
    oneLine: "An unresolved condition is preventing progress; record it as a blocker.",
    instruction: (ref) => `Append the blocker: substrate_journal_append ${ref} kind=blocker, then relate it if it blocks another issue.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev"
  },
  {
    id: "journal_milestone",
    action: "sb journal append · kind=milestone",
    oneLine: "A meaningful execution boundary was reached; record it as a milestone.",
    instruction: (ref) => `Append the milestone: substrate_journal_append ${ref} kind=milestone naming the boundary reached.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev"
  },
  {
    id: "journal_handoff",
    action: "sb journal append · kind=handoff",
    oneLine: "Work is being handed to another participant; record bounded continuation state.",
    instruction: (ref) => `Append the handoff: substrate_journal_append ${ref} kind=handoff with the continuation state the next worker needs.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev"
  },
  {
    id: "journal_result",
    action: "sb journal append · kind=result",
    oneLine: "A bounded settlement was produced; record it as a result, not a progress note.",
    instruction: (ref) => `Append the bounded result: substrate_journal_append ${ref} kind=result with summary/outcome and artifact refs.`,
    severity: "normal",
    cooldownMin: 15,
    source: "jev"
  },
  {
    id: "issue_note",
    action: "sb issue note",
    oneLine: "A bounded clarification about the contract surfaced; record it as a note.",
    instruction: (ref) => `Record the note: sb issue note ${ref} "<clarification>" — notes are continuity, never contract changes.`,
    severity: "normal",
    cooldownMin: 20,
    source: "jev"
  },
  {
    id: "defer_work",
    action: "sb issue defer",
    oneLine: "Work should pause past this cycle; defer the issue with a reason.",
    instruction: (ref) => `Defer deliberately: sb issue defer ${ref} --reason "<why>" — a deferred issue leaves the ready pool cleanly.`,
    severity: "normal",
    cooldownMin: 30,
    source: "jev"
  },
  {
    id: "dep_relate",
    action: "sb issue relate",
    oneLine: "A dependency or relation between issues surfaced; link them so the board knows.",
    instruction: (ref) => `Relate the issues: sb issue relate ${ref} <other> — dependency-aware scheduling needs the edge.`,
    severity: "normal",
    cooldownMin: 30,
    source: "jev"
  },
  {
    id: "provenance_receipt",
    action: "sb provenance receipt",
    oneLine: "External evidence arrived (CI run, published artifact, review); bind a receipt.",
    instruction: (ref) => `Bind the evidence: sb provenance receipt ${ref} --kind <kind> --ref <external ref> — closure cites receipts.`,
    severity: "normal",
    cooldownMin: 30,
    source: "jev"
  },
  {
    id: "resume_capsule",
    action: "sb issue resume",
    oneLine: "Continuing earlier work; read the Resume Capsule, not the compacted transcript.",
    instruction: (ref) => `Resume properly: sb issue resume ${ref} — revision + checkpoint + Journal delta + claim state, the durable state.`,
    severity: "normal",
    cooldownMin: 20,
    source: "jev"
  }
];
var VERB_BY_ID = new Map(CATALOG.map((v) => [v.id, v]));
var TERMINAL_LIFECYCLE = new Set(["done", "cancelled", "archived"]);
var TUNING = {
  claimExpiryWindowMs: 5 * 60 * 1000,
  entriesSinceCheckpoint: 8,
  checkpointAgeMs: 20 * 60 * 1000
};
var BODY_FG = [208, 208, 208];
var BODY_ON = `\x1B[38;2;${BODY_FG[0]};${BODY_FG[1]};${BODY_FG[2]}m`;

// ../pi-extensions/shared/roster.ts
import { access as access2, readdir as readdir2, readFile as readFile3, stat } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join3, relative as relative3 } from "node:path";
var CACHE_TTL_MS = 5 * 60000;
var ROSTER_SAFETY_MAX = 2000;
var DESC_MAX = 240;
var NON_DOCTRINE_DIRS = new Set(["scripts", "refs", "node_modules", "tests", "test", "fixtures", "evals", ".git"]);
var cache = { at: 0, key: "", entries: [] };
function headingsOf(md, max = 12) {
  const out = [];
  for (const line of md.split(`
`)) {
    const m = /^#{2,3}\s+(\S.{0,79})$/.exec(line.trimEnd());
    if (m && !out.includes(m[1]))
      out.push(m[1]);
    if (out.length >= max)
      break;
  }
  return out;
}
function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m)
    return {};
  const lines = m[1].split(/\r?\n/);
  let name;
  let description;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    const nm = /^name:\s*(.+)$/.exec(line);
    if (nm)
      name = nm[1].trim();
    const dm = /^description:\s*(>-?)?\s*(.*)$/.exec(line);
    if (dm) {
      const inline = dm[2].trim();
      if (inline) {
        description = inline;
      } else {
        const folded = [];
        for (let j = i + 1;j < lines.length; j++) {
          const l = lines[j];
          if (!/^\s/.test(l) || l.trim() === "")
            break;
          folded.push(l.trim());
        }
        description = folded.join(" ").trim() || undefined;
      }
    }
  }
  return { name, description };
}
function extractReferenceSummary(md) {
  const withoutFront = md.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const heading = /^#\s+(.+)$/m.exec(withoutFront)?.[1]?.trim() ?? "";
  const body = withoutFront.slice(withoutFront.indexOf(heading) + heading.length);
  const blocks = body.split(/\n\s*\n/).map((s) => s.replace(/[#*`>\[\]]/g, "").replace(/\s+/g, " ").trim()).filter((s) => s.length > 30);
  const isList = (s) => /^(?:[-*\u2022]|\d+[.)])\s/.test(s);
  const prose = blocks.find((s) => !isList(s));
  const listy = blocks.find((s) => isList(s));
  const unlisted = listy ? listy.replace(/^(?:[-*\u2022]|\d+[.)])\s+/, "").replace(/\s+\d+[.)]\s+/g, " ") : "";
  const para = prose ?? (unlisted ? unlisted.match(/^(.*?[.:;])(\s|$)/)?.[1] ?? unlisted : "");
  const name = heading || para.split(/[.:—]/)[0].slice(0, 60) || "reference";
  const description = (para || heading).slice(0, DESC_MAX);
  return { name, description: description.length > 0 ? description : heading };
}
async function skillDirs(repoRoot) {
  const home = homedir2();
  const roots = [
    join3(repoRoot, ".xtrm", "skills"),
    join3(repoRoot, ".agents", "skills"),
    join3(home, ".agents", "skills"),
    join3(home, ".xtrm", "skills"),
    join3(home, ".pi", "agent", "skills")
  ];
  const present = await Promise.all(roots.map(exists));
  return roots.filter((_, i) => present[i]);
}
async function exists(path) {
  try {
    await access2(path);
    return true;
  } catch {
    return false;
  }
}
async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function listDir(path) {
  try {
    return (await readdir2(path)).sort();
  } catch {
    return [];
  }
}
async function scanSkillDir(entries, cwd, skillDir, skill) {
  const shown = (full) => {
    const rel = relative3(cwd, full) || full;
    return rel.startsWith("..") ? full : rel;
  };
  try {
    const md = await readFile3(join3(skillDir, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(md);
    entries.push({
      id: skill,
      skill,
      level: "skill",
      name: fm.name ?? skill,
      description: (fm.description ?? "").slice(0, DESC_MAX),
      path: shown(join3(skillDir, "SKILL.md")),
      headings: headingsOf(md)
    });
  } catch {
    return;
  }
  const walk = async (dir) => {
    for (const name of await listDir(dir)) {
      const full = join3(dir, name);
      if (await isDir(full)) {
        if (!NON_DOCTRINE_DIRS.has(name))
          await walk(full);
        continue;
      }
      if (!name.endsWith(".md") || full === join3(skillDir, "SKILL.md"))
        continue;
      try {
        const refMd = await readFile3(full, "utf8");
        const summary = extractReferenceSummary(refMd);
        const fm = name === "SKILL.md" ? parseFrontmatter(refMd) : {};
        const description = (fm.description ?? summary.description).slice(0, DESC_MAX);
        if (!description)
          continue;
        const relInside = relative3(skillDir, full).replace(/\.md$/, "").split(/[\\/]/).join("/").replace(/\/SKILL$/, "");
        const idPart = relInside.startsWith("references/") ? relInside.slice("references/".length) : relInside;
        entries.push({
          id: `${skill}/${idPart}`,
          skill,
          level: "reference",
          name: fm.name ?? summary.name,
          description,
          path: shown(full),
          headings: headingsOf(refMd)
        });
      } catch {}
    }
  };
  await walk(skillDir);
}
async function repoRootOf(cwd) {
  let dir = cwd;
  for (let guard = 0;guard < 8; guard++) {
    if (await exists(join3(dir, ".git")))
      return dir;
    const parent = join3(dir, "..");
    if (parent === dir)
      break;
    dir = parent;
  }
  return cwd;
}
async function discoverRoster(cwd, now = Date.now()) {
  if (cache.key === cwd && now - cache.at < CACHE_TTL_MS)
    return cache.entries;
  const repoRoot = await repoRootOf(cwd);
  const entries = [];
  try {
    for (const root of await skillDirs(repoRoot)) {
      for (const childName of await listDir(root)) {
        const childDir = join3(root, childName);
        if (await exists(join3(childDir, "SKILL.md"))) {
          await scanSkillDir(entries, cwd, childDir, childName);
          continue;
        }
        if (childName === "active")
          continue;
        const packSkills = async (dir, depth) => {
          const names = await listDir(dir);
          const has = await Promise.all(names.map((s) => exists(join3(dir, s, "SKILL.md"))));
          const direct = names.filter((_, i) => has[i]);
          if (direct.length === 0 && depth > 0) {
            for (const s of names) {
              for (const nested of await packSkills(join3(dir, s), depth - 1))
                direct.push(`${s}/${nested}`);
            }
          }
          return direct;
        };
        for (const rel of await packSkills(childDir, 1)) {
          const parts = rel.split(/[\\/]/);
          const bare = (parts.length > 1 && parts[parts.length - 1] === "skills" ? parts[parts.length - 2] : parts[parts.length - 1]) ?? rel;
          await scanSkillDir(entries, cwd, join3(childDir, ...rel.split("/")), bare);
        }
      }
    }
  } catch {
    return [];
  }
  const seen = new Set;
  const deduped = entries.filter((e) => {
    if (seen.has(e.id))
      return false;
    seen.add(e.id);
    return true;
  });
  const bounded = deduped.slice(0, ROSTER_SAFETY_MAX);
  cache = { at: now, key: cwd, entries: bounded };
  return bounded;
}

// ../pi-extensions/shared/judge.ts
function criteriaOf(candidates, index) {
  const skills = new Map(index.entries.filter((e) => e.level === "skill").map((e) => [e.skill, e]));
  const firstSentence = (s) => (s.split(/(?<=[.;])\s/)[0] ?? "").slice(0, 140);
  const criterion = (e) => {
    const svc = index.serviceOf?.get(e.id);
    if (svc && index.serviceSkill?.get(svc.id) === e.id && svc.description)
      return `${svc.name} service: ${svc.description}`;
    if (svc && index.serviceSkill?.get(svc.id) !== e.id)
      return `${e.name} (part of the ${svc.name} service) — ${e.description}`;
    if (e.level === "skill")
      return `${e.name}: ${e.description}`;
    const parent = skills.get(e.skill);
    return `${e.name} (part of ${e.skill}${parent ? `: ${firstSentence(parent.description)}` : ""}) — ${e.description}`;
  };
  return Object.fromEntries([...candidates.map((e) => [e.id, criterion(e)]), ["none", NONE_CRITERION]]);
}
var NONE_CRITERION = "No listed procedure governs this: narration or a status report, a reply or relay to another agent, a decision the operator states, a question answered from the conversation, or work only sharing a topic or keyword with a listed procedure.";
var WIDE_MAX = 120;
var WIDE_TEXT = 100;
var RERANK_TOP = 3;
var BODY_CHARS = 700;
var oneLine = (s, n) => s.replace(/\s+/g, " ").trim().slice(0, n);
var SCORE_MODEL = {
  input: {
    intercept: -4.220655,
    weights: { fits_win: 1.809604, wide_p1: 1.646026, skill_none_inv: 2.636992, task: 0.426932, n_named: 0.685306, prose_inv: -1.365487 },
    threshold: 0.35
  },
  agent_end: {
    intercept: -6.120762,
    weights: { fits_win: 3.286472, wide_p1: 2.247342, task: 0.950195, prose_inv: 0.826815, fits_max: 2.640259 },
    threshold: 0.55
  }
};
var TASK_NOUL = "Does the request (or the agent's stated next step) start a concrete piece of work, such as debugging, reviewing, releasing, deploying, planning, coordinating workers or operating a named service, rather than chat, a status check, a decision the operator states, or a reply to another agent?";
var PROSE_NOUL = {
  input: "Could a knowledgeable generalist fully satisfy this request in prose, with no tools and no access to the user's files? (Counts against suggesting.)",
  agent_end: "Is the stated next step purely mechanical or narrative, needing no doctrine? (Counts against suggesting.)"
};
var NAMED_NOUL = "Does the request name a specific tool, service, command, workflow or documented procedure to use?";
var SKILL_INSTRUCTIONS = "Pick the single skill or reference document whose stated use applies to the task this request starts, so that following it would change what the agent does next; otherwise pick none. A procedure that only shares a topic or keyword does not apply. Base it only on the request and the provided descriptions.";
var PICK_INSTRUCTIONS = {
  input: "Which of these documents is the right one for the agent to read before it starts on this request? Judge what each document is for, not shared words.",
  agent_end: "Which of these documents is the right one for the agent to read before its next step? Judge what each document is for, not shared words."
};
var RERANK_INSTRUCTIONS = {
  input: "Exactly one of these documents is the right one for the agent to read before it starts on this request. Which one? Read what each actually covers, not just its name.",
  agent_end: "Exactly one of these documents is the right one for the agent to read before its next step. Which one? Read what each actually covers, not just its name."
};
function fitsQuestion(seam, name, description) {
  return seam === "input" ? `Does the document '${name}' describe how to do the specific work this request asks for? It is described as: ${description}` : `Does the document '${name}' describe how to do the agent's next step? It is described as: ${description}`;
}
function rankedIds(probabilities) {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([k]) => k);
}
function decisionFeatures(a) {
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
  const fitsValues = Object.values(a.fits).map(num).filter((v) => v !== null);
  const wideTop = Math.max(...Object.values(a.wide), Number.NEGATIVE_INFINITY);
  const task = num(a.nouls["starts_governed_task"]);
  const prose = num(a.nouls["prose_suffices"]);
  return {
    fits_win: a.winner ? num(a.fits[a.winner]) : null,
    fits_max: fitsValues.length ? Math.max(...fitsValues) : null,
    wide_p1: Number.isFinite(wideTop) ? wideTop : null,
    skill_none_inv: num(a.skillNone) === null ? null : 1 - a.skillNone,
    task,
    prose_inv: prose === null ? null : 1 - prose,
    n_named: num(a.nouls["n_named"])
  };
}
function decisionScore(seam, features) {
  const model = SCORE_MODEL[seam];
  let z = model.intercept;
  for (const [k, w] of Object.entries(model.weights)) {
    const v = features[k];
    if (typeof v !== "number" || !Number.isFinite(v))
      return { score: null, missing: k };
    z += w * v;
  }
  return { score: 1 / (1 + Math.exp(-z)), missing: null };
}
async function docOpening(path) {
  try {
    const text = await readFile4(path, "utf8");
    return oneLine(text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#\s.*\n/, ""), BODY_CHARS);
  } catch {
    return "";
  }
}
async function judge(seam, registry, index, state, query, timeoutMs) {
  const sl = shortlist(index, query);
  const wide = shortlist(index, query, WIDE_MAX);
  const facts = { roster: wide.total, shortlist: sl.candidates.length, wide: wide.candidates.length, dropped: wide.dropped, territory: wide.territoryHits };
  if (wide.candidates.length === 0)
    return { skip: "no_candidates", facts };
  const full = criteriaOf(wide.candidates, index);
  const q1 = {};
  if (seam === "input")
    q1["skill"] = { type: "choice", instructions: SKILL_INSTRUCTIONS, criteria: criteriaOf(sl.candidates, index) };
  q1["starts_governed_task"] = { type: "noul", instructions: TASK_NOUL };
  q1["prose_suffices"] = { type: "noul", instructions: PROSE_NOUL[seam] };
  q1["wide"] = {
    type: "choice",
    instructions: PICK_INSTRUCTIONS[seam],
    criteria: Object.fromEntries(wide.candidates.map((e) => [e.id, oneLine(full[e.id] ?? e.id, WIDE_TEXT)]))
  };
  if (seam === "input")
    q1["n_named"] = { type: "noul", instructions: NAMED_NOUL };
  const one = await classify(registry, state, q1, { timeoutMs });
  facts["jev_ms"] = one.ms;
  facts["jev_path"] = one.path;
  if (!one.result)
    return { skip: `classifier:${one.failure}`, failure: one.failure ?? "transport", facts };
  const wideAnswer = one.result.choices["wide"];
  const byId = new Map(wide.candidates.map((e) => [e.id, e]));
  const top = wideAnswer ? rankedIds(wideAnswer.probabilities).filter((id) => byId.has(id)).slice(0, RERANK_TOP) : [];
  if (!wideAnswer || top.length === 0)
    return { skip: "classifier:bad_answer", failure: "bad_answer", facts };
  const openings = await Promise.all(top.map((id) => docOpening(byId.get(id).path)));
  const q2 = {
    rr_wide: { type: "choice", instructions: RERANK_INSTRUCTIONS[seam], criteria: Object.fromEntries(top.map((id, i) => [id, `${full[id]} — ${openings[i]}`])) }
  };
  top.forEach((id, i) => {
    q2[`fits::${i}`] = { type: "noul", instructions: fitsQuestion(seam, byId.get(id).name, full[id] ?? "") };
  });
  const two = await classify(registry, state, q2, { timeoutMs });
  facts["jev_ms"] = one.ms + two.ms;
  if (!two.result)
    return { skip: `classifier:${two.failure}`, failure: two.failure ?? "transport", facts };
  const winner = two.result.choices["rr_wide"]?.choice ?? null;
  const fits = Object.fromEntries(top.map((id, i) => [id, two.result.nouls[`fits::${i}`]]));
  const skill = one.result.choices["skill"];
  const features = decisionFeatures({
    skillNone: seam === "input" && skill ? skill.probabilities["none"] ?? 0 : null,
    wide: wideAnswer.probabilities,
    nouls: one.result.nouls,
    winner,
    fits
  });
  const { score, missing } = decisionScore(seam, features);
  const entry = winner ? byId.get(winner) ?? null : null;
  const reason = missing ? `missing-${missing}` : !entry ? "unknown-entry" : score < SCORE_MODEL[seam].threshold ? "below-score" : "fire";
  facts["score"] = score === null ? null : Number(score.toFixed(3));
  facts["wide_top"] = top;
  facts["features"] = Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v === null ? null : Number(v.toFixed(3))]));
  return { skip: null, entry: reason === "fire" ? entry : null, pick: winner, score, reason, model: two.result.model, facts };
}

// ../pi-extensions/shared/jsonl-log.ts
import { appendFile, mkdir } from "node:fs/promises";
import { join as join4 } from "node:path";
function createJsonlLog(dir, file = "log.jsonl") {
  let queue = [];
  let writing = Promise.resolve();
  let scheduled = false;
  const made = new Set;
  const drain = async () => {
    scheduled = false;
    const lines = queue;
    queue = [];
    if (lines.length === 0)
      return;
    try {
      const target = dir();
      if (!made.has(target)) {
        await mkdir(target, { recursive: true });
        made.add(target);
      }
      await appendFile(join4(target, file), lines.join(""));
    } catch {}
  };
  return {
    append(row) {
      try {
        queue.push(`${JSON.stringify(row)}
`);
      } catch {
        return;
      }
      if (!scheduled) {
        scheduled = true;
        writing = writing.then(drain);
      }
    },
    async flush() {
      while (scheduled || queue.length > 0) {
        if (!scheduled) {
          scheduled = true;
          writing = writing.then(drain);
        }
        await writing;
      }
      await writing;
    }
  };
}

// worker/worker.ts
var NUDGE_MAX = 600;
var STAGE_TIMEOUT_MS = 1800;
var ROSTER_TTL_MS = 5 * 60000;
var logDir = () => process.env["SKILL_SUGGEST_LOG_DIR"] ?? join5(homedir3(), ".xtrm", "skill-suggest");
var cacheDir = () => process.env["SKILL_SUGGEST_CACHE_DIR"] ?? join5(process.env["XDG_CACHE_HOME"] ?? join5(homedir3(), ".cache"), "xtrm-skill-suggest");
var log = createJsonlLog(logDir);
async function loadIndex(cwd, now = Date.now()) {
  const file = join5(cacheDir(), `roster-${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}.json`);
  try {
    const c = JSON.parse(await readFile5(file, "utf8"));
    if (c.cwd === cwd && now - c.at < ROSTER_TTL_MS && Array.isArray(c.entries) && c.entries.length > 0) {
      return { index: buildRetrievalIndex(c.entries, c.services ?? [], c.repoRoot, cwd), cached: true };
    }
  } catch {}
  const repoRoot = await repoRootOf(cwd);
  const [entries, services] = await Promise.all([discoverRoster(cwd), loadServices(repoRoot)]);
  try {
    await mkdir2(cacheDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ at: now, cwd, repoRoot, entries, services }));
    await rename(tmp, file);
  } catch {}
  return { index: buildRetrievalIndex(entries, services, repoRoot, cwd), cached: false };
}
var oneLine2 = (s, n) => s.replace(/\s+/g, " ").trim().slice(0, n);
var absolutePath = (entry, cwd) => isAbsolute2(entry.path) ? entry.path : resolve2(cwd, entry.path);
function nudgeText(entry, cwd) {
  const path = absolutePath(entry, cwd);
  const what = entry.level === "skill" ? `skill "${entry.skill}"` : `reference "${entry.name}" of skill "${entry.skill}"`;
  const tail = " Ignore it if it does not fit.";
  const head = `[skill-suggest] This request may call for ${what}: `;
  const read = ` Read ${path} before you start.`;
  const room = NUDGE_MAX - head.length - read.length - tail.length - 1;
  return `${head}${oneLine2(entry.description, Math.max(40, room)).replace(/[.\s]+$/, "")}.${read}${tail}`.slice(0, NUDGE_MAX);
}
async function run(input) {
  const base = { ts: new Date().toISOString(), host: "claude", seam: "input", sid: input.sid ?? null, epoch: input.epoch ?? null };
  const skip = (reason, extra = {}) => {
    log.append({ ...base, outcome: "skip", reason, ...extra });
    return { outcome: "skip", reason };
  };
  try {
    await primeApiKey();
    if (!readApiKey())
      return skip("no_key");
    const { index, cached } = await loadIndex(input.cwd);
    const tools = (input.tools ?? []).filter((t) => typeof t === "string").slice(-5);
    const files = (input.files ?? []).filter((f) => typeof f === "string").slice(-10);
    const state = { request: input.prompt.slice(0, 2000), recent_conversation: "", cwd: input.cwd };
    if (typeof input.issue === "string" && input.issue)
      state["claimed_issue"] = input.issue;
    if (tools.length)
      state["recent_tools"] = tools.join(", ");
    const j = await judge("input", null, index, state, { text: input.prompt, files }, STAGE_TIMEOUT_MS);
    const facts = { prompt_chars: input.prompt.length, roster_cached: cached, ctx_tools: tools.length, ctx_files: files.length, ctx_issue: Boolean(input.issue), ...j.facts };
    if (j.skip !== null)
      return skip(j.skip, facts);
    if (!j.entry) {
      log.append({ ...base, pick: j.pick ?? "none", outcome: "abstain", reason: j.reason, injected: false, ...facts });
      return { outcome: "skip", reason: j.reason };
    }
    log.append({ ...base, pick: j.entry.id, outcome: "fire", reason: "fire", injected: false, ...facts });
    return { outcome: "fire", pick: j.entry.id, score: j.score, nudge: nudgeText(j.entry, input.cwd), path: absolutePath(j.entry, input.cwd), model: j.model };
  } catch (e) {
    return skip(`error:${e?.name ?? "unknown"}`);
  }
}
if (__require.main == __require.module) {
  let out = { outcome: "skip", reason: "bad_input" };
  try {
    const chunks = [];
    for await (const c of process.stdin)
      chunks.push(c);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof input.cwd === "string" && typeof input.prompt === "string")
      out = await run(input);
  } catch {}
  await log.flush();
  process.stdout.write(JSON.stringify(out) + `
`);
}
export {
  NUDGE_MAX,
  absolutePath,
  loadIndex,
  nudgeText,
  run
};
