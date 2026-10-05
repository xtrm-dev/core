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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
}

const CACHE_TTL_MS = 5 * 60_000;
// CORE-2361: the real union (repo packs 131 + top-level home skills) is ~163
// today; the old bound of 60 silently hid more than half the catalog from
// ranking. 200 covers the union with headroom; one-line criteria keep the
// classifier call bounded (~30 tokens per entry).
const ROSTER_MAX = 200;
const DESC_MAX = 240;
let cache: { at: number; entries: RosterEntry[] } = { at: 0, entries: [] };

export function resetRosterCache(): void {
  cache = { at: 0, entries: [] };
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

function skillDirs(repoRoot: string): string[] {
  const home = homedir();
  return [
    join(repoRoot, ".xtrm", "skills"),
    join(repoRoot, ".agents", "skills"),
    join(home, ".agents", "skills"),
  ].filter((d) => existsSync(d));
}

/** Scan one skill dir: the SKILL.md itself plus every other doc under it. */
function scanSkillDir(entries: RosterEntry[], cwd: string, skillDir: string, skill: string): void {
  try {
    const md = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const fm = parseFrontmatter(md);
    const rel = relative(cwd, join(skillDir, "SKILL.md")) || join(skillDir, "SKILL.md");
    entries.push({
      id: skill,
      skill,
      level: "skill",
      name: fm.name ?? skill,
      description: (fm.description ?? "").slice(0, DESC_MAX),
      path: rel.startsWith("..") ? join(skillDir, "SKILL.md") : rel,
    });
  } catch {
    return; // unreadable skill: skip entirely
  }
  // Tier 2 (CORE-2361): every *.md under the skill dir, not just references/ —
  // agents/, assets/, README/REFERENCE are doctrine depth too. Ids keep the
  // legacy `<skill>/<file>` shape for direct references/*.md; other locations
  // carry their relative path (`<skill>/agents/analyzer`).
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".md") || name === "SKILL.md") continue;
      try {
        const refMd = readFileSync(full, "utf8");
        const { name: rName, description } = extractReferenceSummary(refMd);
        if (!description) continue;
        const relInside = relative(skillDir, full).replace(/\.md$/, "").split(/[\\/]/).join("/");
        const idPart = relInside.startsWith("references/") ? relInside.slice("references/".length) : relInside;
        const refRel = relative(cwd, full) || full;
        entries.push({
          id: `${skill}/${idPart}`,
          skill,
          level: "reference",
          name: rName,
          description,
          path: refRel.startsWith("..") ? full : refRel,
        });
      } catch {
        /* unreadable reference: skip */
      }
    }
  };
  walk(skillDir);
}

/** Discover the two-tier roster. 5-min cached; bounded. */
export function discoverRoster(cwd: string, now = Date.now()): RosterEntry[] {
  if (now - cache.at < CACHE_TTL_MS) return cache.entries;
  let repoRoot = cwd;
  let dir = cwd;
  for (let guard = 0; guard < 8; guard++) {
    if (existsSync(join(dir, ".git"))) { repoRoot = dir; break; }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const entries: RosterEntry[] = [];
  try {
    for (const root of skillDirs(repoRoot)) {
      let rootChildren: string[];
      try {
        rootChildren = readdirSync(root);
      } catch {
        continue;
      }
      for (const childName of rootChildren) {
        const childDir = join(root, childName);
        // CORE-2361: pack-less root — ~/.agents/skills/<skill>/SKILL.md sits at
        // the top level; the old pack-only scan found zero entries there.
        if (existsSync(join(childDir, "SKILL.md"))) {
          scanSkillDir(entries, cwd, childDir, childName);
          continue;
        }
        // Pack layout: .xtrm/skills/<pack>/<skill>/SKILL.md.
        let skillNames: string[];
        try {
          skillNames = readdirSync(childDir);
        } catch {
          continue;
        }
        for (const s of skillNames) {
          if (existsSync(join(childDir, s, "SKILL.md"))) scanSkillDir(entries, cwd, join(childDir, s), s);
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
  const bounded = deduped.slice(0, ROSTER_MAX);
  cache = { at: now, entries: bounded };
  return bounded;
}
