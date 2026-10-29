/**
 * CORE-2533: code computes, Jev judges. The classifier sees a code-built
 * shortlist (<= 24 + none), never the whole roster.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRoster, resetRosterCache } from "../../extensions/skill-suggest/roster.ts";
import { buildRetrievalIndex, loadServices, parseServiceRegistry, shortlist, SHORTLIST_MAX, type Retrievable } from "../../shared/shortlist.ts";

const entry = (id: string, description: string, extra: Partial<Retrievable> = {}): Retrievable => ({
  id, skill: id.split("/")[0]!, name: id, description, path: `/skills/${id}.md`, headings: [], ...extra,
});

describe("shortlist bounds", () => {
  it("326 entries yield at most 24 candidates, so criteria with none stay <= 25", () => {
    const entries = Array.from({ length: 326 }, (_, i) =>
      entry(`skill${i % 40}/doc${i}`, `Procedure ${i} for database deploys, migrations and incident response`));
    const sl = shortlist(buildRetrievalIndex(entries, [], "/repo", "/repo"), { text: "database migration deploy incident" });
    expect(sl.total).toBe(326);
    expect(sl.candidates.length).toBeLessThanOrEqual(SHORTLIST_MAX);
    expect(sl.candidates.length + 1).toBeLessThanOrEqual(240);
    expect(sl.dropped).toBe(326 - sl.candidates.length);
  });

  it("a prompt with no content words yields no candidates", () => {
    const idx = buildRetrievalIndex([entry("a", "Deploy runbook"), entry("b", "Incident response")], [], "/repo", "/repo");
    expect(shortlist(idx, { text: "ok let's go." }).candidates).toEqual([]);
  });

  it("caps one skill's nested docs so they cannot crowd out the rest", () => {
    const entries = [
      ...Array.from({ length: 30 }, (_, i) => entry(`goal-prompt/ref${i}`, "deploy deploy deploy deploy")),
      entry("production-deploy-runbook", "deploy runbook"),
    ];
    const ids = shortlist(buildRetrievalIndex(entries, [], "/repo", "/repo"), { text: "deploy" }).candidates.map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("goal-prompt/")).length).toBeLessThanOrEqual(4);
    expect(ids).toContain("production-deploy-runbook");
  });

  it("is deterministic for the same input", () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`s${i}`, "shared words about deploys"));
    const idx = buildRetrievalIndex(entries, [], "/repo", "/repo");
    expect(shortlist(idx, { text: "deploys" }).candidates.map((c) => c.id)).toEqual(shortlist(idx, { text: "deploys" }).candidates.map((c) => c.id));
  });
});

describe("service-registry matching", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "shortlist-svc-"));
    mkdirSync(join(repo, ".git"));
    const sk = join(repo, ".xtrm", "skills", "pack", "service-knowledge");
    const services: Record<string, unknown> = {};
    const define = (id: string, description: string, territory: string[], container: string) => {
      mkdirSync(join(sk, "services", id, "references"), { recursive: true });
      writeFileSync(join(sk, "services", id, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n# ${id}\n## Operations\n`);
      writeFileSync(join(sk, "services", id, "references", "deep_dive.md"), `# ${id} deep dive\n\nInternals of the ${id} service with enough words to summarise here.\n`);
      services[id] = { name: id, description, territory, container, skill_path: `.xtrm/skills/pack/service-knowledge/services/${id}/SKILL.md` };
    };
    define("migrating-schema", "Database schema migrations: make migrate plan and apply, alembic revisions, production tables.", ["db/migrations/**"], "mmd-migrate");
    define("serving-mcp-tools", "MCP server exposing market data tools; debug tool call failures.", ["api/mcp_server.py"], "mmd-mcp-server");
    define("backing-up-database", "Nightly database backups and restore drills.", ["ops/backup/**"], "mmd-backup");
    writeFileSync(join(sk, "SKILL.md"), "---\nname: service-knowledge\ndescription: Service registry router.\n---\n# Services\n");
    writeFileSync(join(sk, "service-registry.json"), JSON.stringify({ version: 1, services }));
    // Unrelated doctrine with surface-word overlap.
    mkdirSync(join(repo, ".xtrm", "skills", "pack", "board-audit", "scripts"), { recursive: true });
    writeFileSync(join(repo, ".xtrm", "skills", "pack", "board-audit", "SKILL.md"), "---\nname: board-audit\ndescription: Jira board audits.\n---\n");
    writeFileSync(join(repo, ".xtrm", "skills", "pack", "board-audit", "scripts", "RUBRIC.md"), "# Rubric\n\nApply hold rules before production apply, tables of verdicts for every row.\n");
    resetRosterCache();
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  async function index() {
    const [entries, services] = await Promise.all([discoverRoster(repo), loadServices(repo)]);
    return buildRetrievalIndex(entries, services, repo, repo);
  }

  it("a nested service SKILL.md joins the roster with a clean id and its frontmatter description", async () => {
    const roster = await discoverRoster(repo);
    const svc = roster.find((e) => e.id === "service-knowledge/services/migrating-schema");
    expect(svc?.description).toContain("schema migrations");
    expect(svc?.headings).toEqual(["Operations"]);
    // scripts/ is code, not doctrine.
    expect(roster.some((e) => e.id.includes("scripts/"))).toBe(false);
  });

  it("the 2026-10-07 missed prompt shortlists migrating-schema first", async () => {
    const sl = shortlist(await index(), { text: "URGENT HOLD before make migrate APPLY: prod already HAS the 4 mmd2226 tables" });
    expect(sl.candidates[0]?.id).toBe("service-knowledge/services/migrating-schema");
  });

  it("editing a file under a service territory shortlists that service first", async () => {
    const sl = shortlist(await index(), { text: "fix the flaky test", files: [join(repo, "api", "mcp_server.py")] });
    expect(sl.territoryHits).toEqual(["serving-mcp-tools"]);
    expect(sl.candidates[0]?.id).toBe("service-knowledge/services/serving-mcp-tools");
  });

  it("a container name in the text finds its service", async () => {
    const sl = shortlist(await index(), { text: "mmd-backup container restarted twice tonight" });
    expect(sl.candidates[0]?.id).toBe("service-knowledge/services/backing-up-database");
  });

  it("a registry service whose skill file is missing is dropped", () => {
    const parsed = parseServiceRegistry(JSON.stringify({ services: { ghost: { description: "x", skill_path: "nope/SKILL.md" } } }), "/nowhere", "/nowhere");
    expect(parsed).toEqual([]);
  });
});

const MARKET_DATA = "/home/dawid/projects/mercury/market-data";
describe.skipIf(!existsSync(join(MARKET_DATA, ".xtrm", "skills")))("live market-data registry", () => {
  it("the 2026-10-07 missed prompt shortlists migrating-schema first", async () => {
    resetRosterCache();
    const [entries, services] = await Promise.all([discoverRoster(MARKET_DATA), loadServices(MARKET_DATA)]);
    const sl = shortlist(buildRetrievalIndex(entries, services, MARKET_DATA, MARKET_DATA), {
      text: "URGENT HOLD before make migrate APPLY: prod already HAS the 4 mmd2226 tables",
    });
    expect(sl.candidates[0]?.id).toBe("service-knowledge/services/migrating-schema");
    expect(sl.candidates.length).toBeLessThanOrEqual(SHORTLIST_MAX);
  });
});
