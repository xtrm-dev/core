/** CORE-2555: a tool package's skill (default/<pkg>/skills/SKILL.md) is the package, not "skills". */
import "../isolate-logs.ts"; // CORE-2535: keep production decision logs untouched
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRoster, resetRosterCache } from "../../extensions/skill-suggest/roster.ts";

const repo = mkdtempSync(join(tmpdir(), "roster-id-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("CORE-2555: nested pack skill ids", () => {
  it("names the skill and its docs after the package folder", async () => {
    mkdirSync(join(repo, ".git"));
    const dir = join(repo, ".xtrm", "skills", "default", "service-knowledge", "skills");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: service-knowledge\ndescription: Route service work.\n---\n# Service Knowledge\n");
    writeFileSync(join(dir, "updating.md"), "# Updating\n\nSync a service skill after drift.\n");
    resetRosterCache();
    const ids = (await discoverRoster(repo)).map((e) => e.id);
    expect(ids).toContain("service-knowledge");
    expect(ids).toContain("service-knowledge/updating");
    expect(ids.some((i) => i === "skills" || i.startsWith("skills/"))).toBe(false);
  });
});
