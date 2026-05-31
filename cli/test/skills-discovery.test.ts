import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  discoverDefaultSkills,
  discoverDirectSkills,
  discoverTierPacks,
  validateSkillsInvariants,
} from '../src/core/skill-discovery.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(tempDir => rm(tempDir, { recursive: true, force: true })));
});

async function createTempSkillsRoot(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-skill-discovery-test-'));
  tempDirs.push(tempDir);
  return path.join(tempDir, '.xtrm', 'skills');
}

async function createSkill(parentDir: string, skillName: string): Promise<void> {
  const skillDir = path.join(parentDir, skillName);
  await fs.ensureDir(skillDir);
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `# ${skillName}\n`, 'utf8');
}

async function createPack(
  tierRoot: string,
  packName: string,
  metadataSkills: readonly string[],
  filesystemSkills: readonly string[],
): Promise<void> {
  const packRoot = path.join(tierRoot, packName);
  await fs.ensureDir(packRoot);
  await fs.writeJson(path.join(packRoot, 'PACK.json'), {
    schemaVersion: '1',
    name: packName,
    version: '1.0.0',
    description: `${packName} description`,
    skills: metadataSkills,
  });

  for (const skillName of filesystemSkills) {
    await createSkill(packRoot, skillName);
  }
}

function normalize(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

const nameArbitrary = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,8}$/)
  .filter(value => value.length > 0);

describe('skills-discovery', () => {
  it('discovers expected model from default + optional + user tiers', async () => {
    const skillsRoot = await createTempSkillsRoot();
    const defaultRoot = path.join(skillsRoot, 'default');
    const optionalRoot = path.join(skillsRoot, 'optional');
    const userPacksRoot = path.join(skillsRoot, 'user', 'packs');

    await createSkill(defaultRoot, 'always-on');
    await createSkill(defaultRoot, 'base-helper');

    await createPack(optionalRoot, 'opt-pack', ['one'], ['one']);
    await createPack(userPacksRoot, 'user-pack', ['alpha'], ['alpha']);

    const defaultSkills = await discoverDefaultSkills(skillsRoot);
    const optionalPacks = await discoverTierPacks(skillsRoot, 'optional');
    const userPacks = await discoverTierPacks(skillsRoot, 'user');

    expect(defaultSkills.map(skill => skill.name)).toEqual(['always-on', 'base-helper']);
    expect(optionalPacks.map(pack => pack.name)).toEqual(['opt-pack']);
    expect(optionalPacks[0]?.skills.map(skill => skill.name)).toEqual(['one']);
    expect(userPacks.map(pack => pack.name)).toEqual(['user-pack']);
    expect(userPacks[0]?.skills.map(skill => skill.name)).toEqual(['alpha']);
  });

  it('rejects invalid pack metadata and reports nested runtime roots + duplicate pack collisions', async () => {
    const skillsRoot = await createTempSkillsRoot();
    const defaultRoot = path.join(skillsRoot, 'default');
    const optionalRoot = path.join(skillsRoot, 'optional');
    const userPacksRoot = path.join(skillsRoot, 'user', 'packs');

    await createSkill(defaultRoot, 'bad-default');
    await fs.ensureDir(path.join(defaultRoot, 'bad-default', '.claude'));

    await createPack(optionalRoot, 'same-pack', ['a'], ['a']);
    await createPack(userPacksRoot, 'same-pack', ['b'], ['b']);

    const invalidPackRoot = path.join(optionalRoot, 'broken-pack');
    await fs.ensureDir(invalidPackRoot);
    await fs.writeJson(path.join(invalidPackRoot, 'PACK.json'), {
      schemaVersion: '1',
      name: 'wrong-name',
      version: '1.0.0',
      description: 'broken',
      skills: [],
    });

    await expect(discoverTierPacks(skillsRoot, 'optional')).rejects.toThrow(
      "name must match directory 'broken-pack'",
    );

    await fs.remove(invalidPackRoot);

    const violations = await validateSkillsInvariants(skillsRoot);

    expect(violations.some(v => v.code === 'NESTED_RUNTIME_ROOT')).toBe(true);
    expect(violations.some(v => v.code === 'PACK_NAME_COLLISION')).toBe(true);
  });

  it('handles edge cases: empty tiers, missing PACK.json, non-skill children, and case-sensitive names', async () => {
    const skillsRoot = await createTempSkillsRoot();
    const defaultRoot = path.join(skillsRoot, 'default');
    const optionalRoot = path.join(skillsRoot, 'optional');
    const userPacksRoot = path.join(skillsRoot, 'user', 'packs');

    await fs.ensureDir(path.join(defaultRoot, 'not-a-skill'));
    await fs.ensureDir(path.join(defaultRoot, 'nested', 'inner'));
    await fs.writeFile(path.join(defaultRoot, 'nested', 'inner', 'SKILL.md'), '# nested\n', 'utf8');
    await createSkill(defaultRoot, 'actual-skill');

    await fs.ensureDir(path.join(optionalRoot, 'missing-pack-json'));

    await createPack(optionalRoot, 'Alpha', ['x'], ['x']);
    await createPack(userPacksRoot, 'alpha', ['y'], ['y']);

    const defaultSkills = await discoverDefaultSkills(skillsRoot);
    const optionalPacks = await discoverTierPacks(skillsRoot, 'optional');
    const userPacks = await discoverTierPacks(skillsRoot, 'user');
    const violations = await validateSkillsInvariants(skillsRoot);

    expect(defaultSkills.map(skill => skill.name)).toEqual(['actual-skill']);
    expect(optionalPacks.map(pack => pack.name)).toEqual(['Alpha']);
    expect(userPacks.map(pack => pack.name)).toEqual(['alpha']);
    expect(violations.some(v => v.code === 'PACK_NAME_COLLISION')).toBe(false);
  });

  it('is deterministic and filesystem-authoritative for membership (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(nameArbitrary, { minLength: 1, maxLength: 6 }),
        fc.uniqueArray(nameArbitrary, { minLength: 0, maxLength: 6 }),
        fc.uniqueArray(nameArbitrary, { minLength: 0, maxLength: 6 }),
        async (defaultSkillNames, metadataSkillNames, filesystemSkillNames) => {
          const skillsRoot = await createTempSkillsRoot();
          const defaultRoot = path.join(skillsRoot, 'default');
          const optionalRoot = path.join(skillsRoot, 'optional');

          for (const name of [...defaultSkillNames].reverse()) {
            await createSkill(defaultRoot, name);
          }

          await createPack(optionalRoot, 'rand-pack', metadataSkillNames, [...filesystemSkillNames].reverse());

          const firstDefault = await discoverDefaultSkills(skillsRoot);
          const secondDefault = await discoverDefaultSkills(skillsRoot);
          const packs = await discoverTierPacks(skillsRoot, 'optional');

          expect(firstDefault.map(skill => skill.name)).toEqual(normalize(defaultSkillNames));
          expect(secondDefault.map(skill => skill.name)).toEqual(normalize(defaultSkillNames));

          const discoveredPack = packs[0];
          expect(discoveredPack?.skills.map(skill => skill.name)).toEqual(normalize(filesystemSkillNames));
          expect(discoveredPack?.metadataMismatch).toEqual({
            metadataOnlySkills: normalize(metadataSkillNames.filter(name => !filesystemSkillNames.includes(name))),
            filesystemOnlySkills: normalize(filesystemSkillNames.filter(name => !metadataSkillNames.includes(name))),
          });
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('frontmatter runtimeName (collision fix — xtrm-u54wt #1)', () => {
  async function createSkillWithFrontmatter(parentDir: string, dirName: string, declaredName: string): Promise<void> {
    const skillDir = path.join(parentDir, dirName);
    await fs.ensureDir(skillDir);
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${declaredName}\ndescription: x\n---\n\n# ${declaredName}\n`,
      'utf8',
    );
  }

  it('runtimeName comes from frontmatter name, name stays the directory', async () => {
    const skillsRoot = await createTempSkillsRoot();
    const defaultRoot = path.join(skillsRoot, 'default');
    await fs.ensureDir(defaultRoot);
    // dir 'service-skills' but declares a different runtime name
    await createSkillWithFrontmatter(defaultRoot, 'service-skills', 'service-skills');
    await createSkillWithFrontmatter(defaultRoot, 'planning', 'planning');
    const skills = await discoverDefaultSkills(skillsRoot);
    const byDir = Object.fromEntries(skills.map(s => [s.name, s.runtimeName]));
    expect(byDir['service-skills']).toBe('service-skills');
    expect(byDir['planning']).toBe('planning');
  });

  it('falls back to directory name when no frontmatter name', async () => {
    const skillsRoot = await createTempSkillsRoot();
    const defaultRoot = path.join(skillsRoot, 'default');
    await fs.ensureDir(defaultRoot);
    await createSkill(defaultRoot, 'legacy-skill'); // helper writes no frontmatter
    const skills = await discoverDefaultSkills(skillsRoot);
    expect(skills.find(s => s.name === 'legacy-skill')?.runtimeName).toBe('legacy-skill');
  });

  it('umbrella dir `service-skills` declaring `<repo>-services` does NOT collide with default `service-skills`', async () => {
    const skillsRoot = await createTempSkillsRoot();
    const defaultRoot = path.join(skillsRoot, 'default');
    const packRoot = path.join(skillsRoot, 'user', 'packs', 'market-data');
    await fs.ensureDir(defaultRoot);
    await fs.ensureDir(packRoot);
    await createSkillWithFrontmatter(defaultRoot, 'service-skills', 'service-skills'); // machinery
    await createSkillWithFrontmatter(packRoot, 'service-skills', 'market-data-services'); // umbrella
    const machinery = (await discoverDirectSkills(defaultRoot)).find(s => s.name === 'service-skills');
    const umbrella = (await discoverDirectSkills(packRoot)).find(s => s.name === 'service-skills');
    // same directory name, DIFFERENT runtime names -> no collision in the materializer's name map
    expect(machinery?.runtimeName).toBe('service-skills');
    expect(umbrella?.runtimeName).toBe('market-data-services');
    expect(machinery?.runtimeName).not.toBe(umbrella?.runtimeName);
  });
});
