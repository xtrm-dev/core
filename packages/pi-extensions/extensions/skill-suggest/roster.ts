/**
 * skill-suggest roster — two-tier discovery over the curated skill packs.
 *
 * Tier 1: skills (SKILL.md frontmatter name/description).
 * Tier 2: their nested references (references/*.md) — the doctrine depth
 * agents never open. Reference descriptions are extracted deterministically
 * from the doc's first heading + first paragraph; no frontmatter required.
 *
 * Discovery covers the XTRM curated packs (.xtrm/skills/<pack>/) and the
 * Agent Skills locations pi discovers (~/.agents/skills, .agents/skills).
 */

import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export interface RosterEntry {
  /** Catalog id: skill name, or `<skill>/<relative path>` for references. */
  id: string;
  skill: string;
  /** Level-1: the skill itself; level-2: a nested reference doc. */
  level: "skill" | "reference";
  name: string;
  description: string;
  /** Absolute path — the injection source. */
  path: string;
  /** H2/H3 headings of the doc, bounded: retrieval terms and the card's router. */
  headings: string[];
}

const CACHE_TTL_MS = 5 * 60_000;
// CORE-2533: the roster is no longer the classifier's criteria list — a
// shortlist (shared/shortlist.ts) picks at most 24 candidates from it — so
// discovery keeps everything. This cap only bounds a pathological tree.
const ROSTER_SAFETY_MAX = 2000;
const DESC_MAX = 240;
const NON_DOCTRINE_DIRS = new Set(["scripts", "refs", "node_modules", "tests", "test", "fixtures", "evals", ".git"]);
let cache: { at: number; key: string; entries: RosterEntry[] } = { at: 0, key: "", entries: [] };

export function resetRosterCache(): void {
  cache = { at: 0, key: "", entries: [] };
}

/** H2/H3 headings, deduped and bounded. The H1 is the title, not a place to look. */
export function headingsOf(md: string, max = 12): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^#{2,3}\s+(.{1,80}?)\s*$/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
    if (out.length >= max) break;
  }
  return out;
}

/** Parse minimal frontmatter (--- fenced) for name/description, folded or inline. */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nm = /^name:\s*(.+)$/.exec(line);
    if (nm) name = nm[1].trim();
    const dm = /^description:\s*(>-?)?\s*(.*)$/.exec(line);
    if (dm) {
      const inline = dm[2].trim();
      if (inline) {
        description = inline;
      } else {
        const folded: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (!/^\s/.test(l) || l.trim() === "") break;
          folded.push(l.trim());
        }
        description = folded.join(" ").trim() || undefined;
      }
    }
  }
  return { name, description };
}

/** First `# ` heading and first non-empty paragraph after it, bounded. */
export function extractReferenceSummary(md: string): { name: string; description: string } {
  const withoutFront = md.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const heading = /^#\s+(.+)$/m.exec(withoutFront)?.[1]?.trim() ?? "";
  const body = withoutFront.slice(withoutFront.indexOf(heading) + heading.length);
  // Reference docs are often list-shaped. A numbered step ("1. Freeze new
  // work assignment to it.") is a procedure fragment, not a summary — feeding
  // it to Jev as criteria produced weak matches (messy-run-recovery at 0.31).
  // Prefer the first prose block; fall back to the first sentence of a list.
  const blocks = body
    .split(/\n\s*\n/)
    .map((s) => s.replace(/[#*`>\[\]]/g, "").replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 30);
  const isList = (s: string) => /^(?:[-*\u2022]|\d+[.)])\s/.test(s);
  const prose = blocks.find((s) => !isList(s));
  const listy = blocks.find((s) => isList(s));
  // Strip list markers (leading and inline "2." "3.") before taking a sentence,
  // otherwise the first "1." wins and the description is one character.
  const unlisted = listy ? listy.replace(/^(?:[-*\u2022]|\d+[.)])\s+/, "").replace(/\s+\d+[.)]\s+/g, " ") : "";
  const para = prose ?? (unlisted ? (unlisted.match(/^(.*?[.:;])(\s|$)/)?.[1] ?? unlisted) : "");
  const name = heading || para.split(/[.:—]/)[0].slice(0, 60) || "reference";
  const description = (para || heading).slice(0, DESC_MAX);
  return { name, description: description.length > 0 ? description : heading };
}

async function skillDirs(repoRoot: string): Promise<string[]> {
  const home = homedir();
  const roots = [
    join(repoRoot, ".xtrm", "skills"),
    join(repoRoot, ".agents", "skills"),
    join(home, ".agents", "skills"),
    // Global user packs (incl. third-party installs like open-code-review
    // and agentrun) and personal pi skills (incl. codemode): without these
    // roots the suggestor can never rank them, however well their triggers
    // are written.
    join(home, ".xtrm", "skills"),
    join(home, ".pi", "agent", "skills"),
  ];
  const present = await Promise.all(roots.map(exists));
  return roots.filter((_, i) => present[i]);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path)).sort(); // sorted: deterministic order for replays
  } catch {
    return [];
  }
}

/** Scan one skill dir: the SKILL.md itself plus every other doc under it. */
async function scanSkillDir(entries: RosterEntry[], cwd: string, skillDir: string, skill: string): Promise<void> {
  const shown = (full: string) => {
    const rel = relative(cwd, full) || full;
    return rel.startsWith("..") ? full : rel;
  };
  try {
    const md = await readFile(join(skillDir, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(md);
    entries.push({
      id: skill,
      skill,
      level: "skill",
      name: fm.name ?? skill,
      description: (fm.description ?? "").slice(0, DESC_MAX),
      path: shown(join(skillDir, "SKILL.md")),
      headings: headingsOf(md),
    });
  } catch {
    return; // unreadable skill: skip entirely
  }
  // Tier 2 (CORE-2361): every *.md under the skill dir, not just references/ —
  // agents/, assets/, README/REFERENCE are doctrine depth too. Ids keep the
  // legacy `<skill>/<file>` shape for direct references/*.md; other locations
  // carry their relative path (`<skill>/agents/analyzer`). A NESTED SKILL.md
  // (service-knowledge/services/<id>/SKILL.md) is a sub-skill: it was skipped
  // before CORE-2533, which hid every per-service skill from the roster. Its id
  // drops the trailing /SKILL and its frontmatter wins over the summary.
  const walk = async (dir: string): Promise<void> => {
    for (const name of await listDir(dir)) {
      const full = join(dir, name);
      if (await isDir(full)) {
        // Code, saved prompt sources and test data are not doctrine: they
        // out-scored real references on surface words (CORE-2533).
        if (!NON_DOCTRINE_DIRS.has(name)) await walk(full);
        continue;
      }
      if (!name.endsWith(".md") || full === join(skillDir, "SKILL.md")) continue;
      try {
        const refMd = await readFile(full, "utf8");
        const summary = extractReferenceSummary(refMd);
        const fm = name === "SKILL.md" ? parseFrontmatter(refMd) : {};
        const description = (fm.description ?? summary.description).slice(0, DESC_MAX);
        if (!description) continue;
        const relInside = relative(skillDir, full).replace(/\.md$/, "").split(/[\\/]/).join("/").replace(/\/SKILL$/, "");
        const idPart = relInside.startsWith("references/") ? relInside.slice("references/".length) : relInside;
        entries.push({
          id: `${skill}/${idPart}`,
          skill,
          level: "reference",
          name: fm.name ?? summary.name,
          description,
          path: shown(full),
          headings: headingsOf(refMd),
        });
      } catch {
        /* unreadable reference: skip */
      }
    }
  };
  await walk(skillDir);
}

/** The enclosing git root (nearest `.git` within 8 levels), else cwd. */
export async function repoRootOf(cwd: string): Promise<string> {
  let dir = cwd;
  for (let guard = 0; guard < 8; guard++) {
    if (await exists(join(dir, ".git"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

/**
 * Discover the two-tier roster with async IO, so a rebuild never blocks pi's
 * event loop. 5-min cached per cwd.
 */
export async function discoverRoster(cwd: string, now = Date.now()): Promise<RosterEntry[]> {
  if (cache.key === cwd && now - cache.at < CACHE_TTL_MS) return cache.entries;
  const repoRoot = await repoRootOf(cwd);
  const entries: RosterEntry[] = [];
  try {
    for (const root of await skillDirs(repoRoot)) {
      for (const childName of await listDir(root)) {
        const childDir = join(root, childName);
        // CORE-2361: pack-less root — ~/.agents/skills/<skill>/SKILL.md sits at
        // the top level; the old pack-only scan found zero entries there.
        if (await exists(join(childDir, "SKILL.md"))) {
          await scanSkillDir(entries, cwd, childDir, childName);
          continue;
        }
        if (childName === "active") continue; // runtime view shadows default skills
        // Pack layout: .xtrm/skills/<pack>/<skill>/SKILL.md. Pack containers
        // hold skills one level deeper (optional/<pack>/<skill>); descend only
        // when no skill sits directly under the pack.
        const packSkills = async (dir: string, depth: number): Promise<string[]> => {
          const names = await listDir(dir);
          const has = await Promise.all(names.map((s) => exists(join(dir, s, "SKILL.md"))));
          const direct = names.filter((_, i) => has[i]);
          if (direct.length === 0 && depth > 0) {
            for (const s of names) {
              for (const nested of await packSkills(join(dir, s), depth - 1)) direct.push(`${s}/${nested}`);
            }
          }
          return direct;
        };
        for (const rel of await packSkills(childDir, 1)) {
          // CORE-2555: an installed tool package keeps its skill in a `skills/`
          // folder (default/service-knowledge/skills/SKILL.md); the skill is
          // the package, not "skills".
          const parts = rel.split(/[\\/]/);
          const bare = (parts.length > 1 && parts[parts.length - 1] === "skills" ? parts[parts.length - 2] : parts[parts.length - 1]) ?? rel;
          await scanSkillDir(entries, cwd, join(childDir, ...rel.split("/")), bare);
        }
      }
    }
  } catch {
    return [];
  }
  // The same skill can be reachable through two roots (repo .agents/skills
  // and ~/.agents/skills both carry multiplexing, gitnexus, ...). First wins —
  // roots are ordered repo-first, so repo state beats home state (CORE-2361).
  const seen = new Set<string>();
  const deduped = entries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  const bounded = deduped.slice(0, ROSTER_SAFETY_MAX);
  cache = { at: now, key: cwd, entries: bounded };
  return bounded;
}
