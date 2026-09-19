import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServiceSkills, hasServiceRegistry } from '../src/core/service-skills-ensure.js';
import { setRuntimeEnabledPacks } from '../src/core/skills-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Machinery fixture, not a distribution source: the retired service-skills mirror
// (skills/service-skills, removed with the hook-cleanup lane-2 skills wipe) held the last
// in-tree copy of the legacy flat-to-umbrella migrator. ensureServiceSkills stays until
// `service-knowledge migrate` covers the legacy flat path (CORE-2312), so its fixture lives
// here instead of re-vendoring the retired mirror back into the shipped tree.
const SCRIPTS_SRC = path.resolve(__dirname, 'fixtures', 'service-skills', 'scripts');

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => fs.remove(d)));
});

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ss-ensure-'));
  tempDirs.push(dir);
  // install the machinery scripts where ensureServiceSkills resolves them
  await fs.copy(SCRIPTS_SRC, path.join(dir, '.xtrm', 'skills', 'default', 'service-skills', 'scripts'));
  return dir;
}

async function seedFlatPack(repo: string, services: string[]): Promise<void> {
  const pack = path.join(repo, '.xtrm', 'skills', 'user', 'packs', 'market-data');
  const registry: any = { version: '1.0', services: {} };
  for (const svc of services) {
    await fs.ensureDir(path.join(pack, svc));
    await fs.writeFile(path.join(pack, svc, 'SKILL.md'), `# ${svc}\n`, 'utf8');
    registry.services[svc] = { name: svc, territory: [`src/${svc}/**`], skill_path: `.claude/skills/${svc}/SKILL.md`, last_sync: 'never' };
  }
  await fs.writeJson(path.join(pack, 'service-registry.json'), registry, { spaces: 2 });
}

describe('ensureServiceSkills — foolproof registry-gated migration (xtrm-u54wt #3)', () => {
  it('no-ops in a repo with no service-registry', async () => {
    const repo = await makeRepo();
    expect(await hasServiceRegistry(repo)).toBe(false);
    const result = await ensureServiceSkills(repo, { apply: true });
    expect(result.applicable).toBe(false);
    expect(result.migratedPacks).toEqual([]);
  });

  it('migrates a flat-layout service repo to the umbrella layout on apply', async () => {
    const repo = await makeRepo();
    await seedFlatPack(repo, ['serving-mcp-tools', 'db-expert']);
    expect(await hasServiceRegistry(repo)).toBe(true);

    const result = await ensureServiceSkills(repo, { apply: true });
    expect(result.applicable).toBe(true);
    expect(result.migratedPacks).toContain('market-data');

    const pack = path.join(repo, '.xtrm', 'skills', 'user', 'packs', 'market-data');
    // services moved under the umbrella; flat dirs gone; umbrella + relocated registry exist
    expect(await fs.pathExists(path.join(pack, 'service-skills', 'services', 'serving-mcp-tools', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(pack, 'serving-mcp-tools'))).toBe(false);
    expect(await fs.pathExists(path.join(pack, 'service-skills', 'service-registry.json'))).toBe(true);
    expect(await fs.pathExists(path.join(pack, 'service-skills', 'SKILL.md'))).toBe(true);
    // skill_path rewritten to .xtrm
    const reg = await fs.readJson(path.join(pack, 'service-skills', 'service-registry.json'));
    expect(reg.services['serving-mcp-tools'].skill_path.startsWith('.xtrm/')).toBe(true);
    expect(reg.services['serving-mcp-tools'].skill_path).not.toContain('.claude/skills');
  });

  it('is idempotent — a second apply is a no-op', async () => {
    const repo = await makeRepo();
    await seedFlatPack(repo, ['serving-mcp-tools']);
    await ensureServiceSkills(repo, { apply: true });
    const second = await ensureServiceSkills(repo, { apply: true });
    expect(second.applicable).toBe(true);
    expect(second.alreadyCurrent).toBe(true);
    expect(second.migratedPacks).toEqual([]);
  });

  it('syncs PACK.json without recreating retired active view after migration', async () => {
    const repo = await makeRepo();
    await seedFlatPack(repo, ['serving-mcp-tools', 'db-expert']);
    const skillsRoot = path.join(repo, '.xtrm', 'skills');
    const pack = path.join(skillsRoot, 'user', 'packs', 'market-data');
    // a regular (non-service) skill that must survive in PACK.json
    await fs.ensureDir(path.join(pack, 'using-tdd-guard'));
    await fs.writeFile(path.join(pack, 'using-tdd-guard', 'SKILL.md'), '# tdd\n', 'utf8');
    // a STALE PACK.json: lists the flat services + regular, omits the umbrella
    await fs.writeJson(path.join(pack, 'PACK.json'), {
      schemaVersion: '1', name: 'market-data', version: '1.0.0',
      description: 'User-created skill pack',
      skills: ['db-expert', 'serving-mcp-tools', 'using-tdd-guard'],
    }, { spaces: 2 });
    await setRuntimeEnabledPacks(skillsRoot, 'claude', ['market-data']);

    const result = await ensureServiceSkills(repo, { apply: true });
    expect(result.migratedPacks).toContain('market-data');

    // Part 1: PACK.json synced to the post-migration filesystem — ghost services dropped,
    // 'service-skills' umbrella added, regular skill kept.
    const packJson = await fs.readJson(path.join(pack, 'PACK.json'));
    expect(packJson.skills).toEqual(['service-skills', 'using-tdd-guard']);

    // Migration only updates canonical pack metadata. Runtime reconciliation happens in
    // command flow, so this helper must not recreate retired active view.
    expect(await fs.pathExists(path.join(skillsRoot, 'active'))).toBe(false);
  });

  it('dry-run does not migrate', async () => {
    const repo = await makeRepo();
    await seedFlatPack(repo, ['serving-mcp-tools']);
    const result = await ensureServiceSkills(repo, { apply: false });
    expect(result.applicable).toBe(true);
    expect(result.migratedPacks).toEqual([]);
    // flat dir still present (not migrated)
    expect(await fs.pathExists(path.join(repo, '.xtrm', 'skills', 'user', 'packs', 'market-data', 'serving-mcp-tools'))).toBe(true);
  });
});
