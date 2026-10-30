/**
 * CORE-2535: rebuild a recorded roster as files under a temp HOME and temp
 * repo, so the replay runs the real discovery and retrieval code. The fixture
 * stores frontmatter and headings only — no document bodies, no real paths.
 * CORE-2555: a doc without a frontmatter description also keeps the bounded,
 * scrubbed summary roster.ts extracts from its first paragraph, so the replay
 * shows the classifier the same text production does.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Doc {
  rel: string;
  id: string;
  frontmatter: string;
  headings: string[];
  summary?: string;
}
interface RepoFixture {
  entries: Doc[];
  ids: string[];
  registries: Record<string, string>;
}
export interface RosterFixture {
  home: Doc[];
  repos: Record<string, RepoFixture>;
}

function write(root: string, doc: Doc): void {
  const abs = join(root, doc.rel);
  mkdirSync(dirname(abs), { recursive: true });
  const fm = doc.frontmatter ? `---\n${doc.frontmatter}\n---\n` : "";
  const [first, ...rest] = doc.headings;
  const h1 = first?.startsWith("# ") ? [first] : [];
  const body = [...h1, ...(doc.summary ? [doc.summary] : []), ...(h1.length ? rest : doc.headings)];
  writeFileSync(abs, `${fm}${body.join("\n\n")}\n`);
}

export interface World {
  home: string;
  repos: Record<string, string>;
  cleanup(): void;
}

/** One temp HOME shared by every repo, one temp repo per recorded repo. */
export function materialize(fixture: RosterFixture): World {
  const base = mkdtempSync(join(tmpdir(), "skill-replay-"));
  const home = join(base, "home");
  for (const doc of fixture.home) write(home, doc);
  const repos: Record<string, string> = {};
  for (const [name, repo] of Object.entries(fixture.repos)) {
    const root = join(base, name);
    mkdirSync(join(root, ".git"), { recursive: true });
    for (const doc of repo.entries) write(root, doc);
    for (const [rel, json] of Object.entries(repo.registries)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), json);
    }
    repos[name] = root;
  }
  return { home, repos, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
