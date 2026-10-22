import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPythonBackedSkillsCache,
  selectPythonBackedSkills,
} from "../extensions/python-kernel/select-python-backed-skills.ts";

let fakeHome = "";
let projectRoot = "";
let prevHome: string | undefined;
const origHomedir = os.homedir;

function writeSkillMd(skillDir: string, runtimeName: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${runtimeName}\n---\n# ${runtimeName}\n`);
}

function writePythonPkg(skillDir: string, pkg: string): void {
  mkdirSync(join(skillDir, "src", pkg), { recursive: true });
  writeFileSync(join(skillDir, "src", pkg, "__init__.py"), "VALUE = 1\n");
}

function writePythonSkill(skillDir: string, runtimeName: string, pkg?: string): void {
  writeSkillMd(skillDir, runtimeName);
  writePythonPkg(skillDir, pkg ?? runtimeName);
}

function writeMarkdownSkill(skillDir: string, runtimeName: string): void {
  writeSkillMd(skillDir, runtimeName);
}

function writeOptionalPack(packDir: string, packName: string, skillNames: string[]): void {
  mkdirSync(packDir, { recursive: true });
  writeFileSync(
    join(packDir, "PACK.json"),
    JSON.stringify({
      schemaVersion: "1",
      name: packName,
      version: "1.0.0",
      description: `${packName} test pack`,
      skills: skillNames,
    }),
  );
}

function writeState(skillsRoot: string, enabledPi: string[]): void {
  mkdirSync(skillsRoot, { recursive: true });
  writeFileSync(
    join(skillsRoot, "state.json"),
    JSON.stringify({
      schemaVersion: "2",
      enabledPacks: { claude: [], pi: enabledPi, codex: [] },
      managedLinks: { claude: {}, pi: {}, codex: {} },
    }),
  );
}

function globalRoot(): string {
  return join(fakeHome, ".xtrm", "skills");
}

function repoRoot(): string {
  return join(projectRoot, ".xtrm", "skills");
}

beforeEach(() => {
  prevHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), "sel-py-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "sel-py-proj-"));
  process.env.HOME = fakeHome;
  // bun's os.homedir() ignores process.env.HOME mutations (verified probe);
  // patch at the source so resolveGlobalSkillsRoot() sees the fake home.
  (os as unknown as { homedir: () => string }).homedir = () => fakeHome;
  clearPythonBackedSkillsCache();
});

afterEach(() => {
  process.env.HOME = prevHome;
  (os as unknown as { homedir: () => string }).homedir = origHomedir;
  clearPythonBackedSkillsCache();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("selectPythonBackedSkills (canonical resolver)", () => {
  test("resolves identity from SKILL.md frontmatter, not the directory name", async () => {
    const dir = join(globalRoot(), "default", "mydir");
    writePythonSkill(dir, "front-name", "realpkg");
    writeState(globalRoot(), []);
    writeState(repoRoot(), []);

    const result = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(result).toHaveLength(1);
    expect(result[0].runtimeName).toBe("front-name");
    expect(result[0].skillDir).toBe(realpathSync(dir));
    expect(result[0].importName).toBe("realpkg");
    expect(result[0].srcRoot).toBe(join(realpathSync(dir), "src"));
  });

  test("global default python skills are present with no packs enabled", async () => {
    writePythonSkill(join(globalRoot(), "default", "defskill"), "defskill");
    writeState(globalRoot(), []);
    writeState(repoRoot(), []);

    const result = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(result.map((s) => s.runtimeName)).toEqual(["defskill"]);
  });

  test("repo authoring default/ tree never shadows installed global defaults (CORE-2516)", async () => {
    // Installed global default.
    writePythonSkill(join(globalRoot(), "default", "codemode"), "codemode", "codemod_pkg");
    // Same runtimeName in the repo checkout's authoring default/ tree
    // (release/vendor source, retired as installed scope) — must be ignored,
    // not collide. Markdown-only keeps the focus on identity, not classifier.
    writeMarkdownSkill(join(repoRoot(), "default", "codemode"), "codemode");
    writeState(globalRoot(), []);
    writeState(repoRoot(), []);

    const result = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(result.map((s) => s.runtimeName)).toEqual(["codemode"]);
    expect(result[0].skillDir).toBe(realpathSync(join(globalRoot(), "default", "codemode")));
    expect(result[0].importName).toBe("codemod_pkg");
  });

  test("disabled optional packs are absent; enabled packs are present", async () => {
    const packDir = join(globalRoot(), "optional", "mypack");
    const packSkill = join(packDir, "packskill");
    writePythonSkill(packSkill, "packskill");
    writeOptionalPack(packDir, "mypack", ["packskill"]);
    writeState(globalRoot(), []);
    writeState(repoRoot(), []);

    const disabled = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(disabled.map((s) => s.runtimeName)).not.toContain("packskill");

    writeState(globalRoot(), ["mypack"]);
    const enabled = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(enabled.map((s) => s.runtimeName)).toContain("packskill");
  });

  test("duplicate runtimeName to different realpaths throws, incl python-vs-markdown", async () => {
    const pyDir = join(globalRoot(), "default", "dup-py");
    writePythonSkill(pyDir, "dup");
    const mdDir = join(repoRoot(), "p", "dup-md");
    writeMarkdownSkill(mdDir, "dup");
    writeState(globalRoot(), []);
    writeState(repoRoot(), ["p"]);

    await expect(selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" })).rejects.toThrow(
      /dup/,
    );
    try {
      await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(realpathSync(pyDir));
      expect(msg).toContain(realpathSync(mdDir));
    }
  });

  test("same pack name in two scopes throws", async () => {
    writePythonSkill(join(globalRoot(), "samepack", "a"), "a-skill");
    writePythonSkill(join(repoRoot(), "samepack", "b"), "b-skill");
    writeState(globalRoot(), []);
    writeState(repoRoot(), ["samepack"]);

    await expect(selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" })).rejects.toThrow(
      /samepack/,
    );
  });

  test("skills with zero or multiple src packages are excluded (markdown-only)", async () => {
    const multi = join(globalRoot(), "default", "multi");
    writeSkillMd(multi, "multi");
    writePythonPkg(multi, "a");
    writePythonPkg(multi, "b");
    const plain = join(globalRoot(), "default", "plain");
    writeMarkdownSkill(plain, "plain");
    writeState(globalRoot(), []);
    writeState(repoRoot(), []);

    const result = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(result.map((s) => s.runtimeName)).not.toContain("multi");
    expect(result.map((s) => s.runtimeName)).not.toContain("plain");
  });

  test("per-cwd cache hits on unchanged state and recomputes on mtime change", async () => {
    writePythonSkill(join(globalRoot(), "default", "cached"), "cached");
    writeState(globalRoot(), []);
    writeState(repoRoot(), []);

    const first = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    const second = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(second).toBe(first);

    const packDir = join(globalRoot(), "optional", "newpack");
    const packSkill = join(packDir, "fresh");
    writePythonSkill(packSkill, "fresh");
    writeOptionalPack(packDir, "newpack", ["fresh"]);
    writeState(globalRoot(), ["newpack"]);

    const third = await selectPythonBackedSkills({ cwd: projectRoot, runtime: "pi" });
    expect(third).not.toBe(first);
    expect(third.map((s) => s.runtimeName).sort()).toEqual(["cached", "fresh"]);
  });

  test("rejects runtimes other than pi", async () => {
    writeState(globalRoot(), []);
    writeState(repoRoot(), []);
    await expect(selectPythonBackedSkills({ cwd: projectRoot, runtime: "claude" })).rejects.toThrow(
      /only 'pi'/,
    );
  });
});
