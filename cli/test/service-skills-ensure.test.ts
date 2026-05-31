import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServiceSkills, hasServiceRegistry } from '../src/core/service-skills-ensure.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_SRC = path.resolve(__dirname, '..', '..', 'skills', 'service-skills', 'scripts');

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
