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

import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const ROSTER_MAX = 60;
const DESC_MAX = 240;
let cache: { at: number; entries: RosterEntry[] } = { at: 0, entries: [] };

export function resetRosterCache(): void {
  cache = { at: 0, entries: [] };
}

/** Parse minimal frontmatter (--- fenced) for name/description. */
export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const block = m[1];
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim();
  const descMatch = /^description:\s*>-?\s*\n([\s\S]*?)(?=^\w+:|\Z)/m.exec(block)
    ?? /^description:\s*(.+)$/m.exec(block);
  const description = descMatch
    ? descMatch[1].replace(/\n\s*/g, " ").trim()
    : undefined;
  return { name, description };
}

/** First `# ` heading and first non-empty paragraph after it, bounded. */
export function extractReferenceSummary(md: string): { name: string; description: string } {
  const withoutFront = md.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const heading = /^#\s+(.+)$/m.exec(withoutFront)?.[1]?.trim() ?? "";
  const body = withoutFront.slice(withoutFront.indexOf(heading) + heading.length);
  const para = body.split(/\n\s*\n/).map((s) => s.replace(/[#*`>\[\]]/g, "").replace(/\s+/g, " ").trim()).find((s) => s.length > 30) ?? "";
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
      for (const pack of readdirSync(root)) {
        const packDir = join(root, pack);
        let skillDirsList: string[] = [];
        try {
          skillDirsList = readdirSync(packDir).filter((d) => existsSync(join(packDir, d, "SKILL.md")));
        } catch { continue; }
        for (const skill of skillDirsList) {
          const skillDir = join(packDir, skill);
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
            // Tier 2: nested references — the doctrine depth.
            const refsDir = join(skillDir, "references");
            if (existsSync(refsDir)) {
              for (const ref of readdirSync(refsDir)) {
                if (!ref.endsWith(".md")) continue;
                const refPath = join(refsDir, ref);
                try {
                  const refMd = readFileSync(refPath, "utf8");
                  const { name, description } = extractReferenceSummary(refMd);
                  if (!description) continue;
                  const refRel = relative(cwd, refPath) || refPath;
                  entries.push({
                    id: `${skill}/${ref.replace(/\.md$/, "")}`,
                    skill,
                    level: "reference",
                    name,
                    description,
                    path: refRel.startsWith("..") ? refPath : refRel,
                  });
                } catch { /* unreadable reference: skip */ }
              }
            }
          } catch { /* unreadable skill: skip */ }
        }
      }
    }
  } catch {
    return [];
  }
  const bounded = entries.slice(0, ROSTER_MAX);
  cache = { at: now, entries: bounded };
  return bounded;
}
