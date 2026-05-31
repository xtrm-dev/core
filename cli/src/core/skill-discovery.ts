import fs from 'fs-extra';
import path from 'node:path';
import {
  PACK_FILE_NAME,
  RUNTIME_ROOT_MARKERS,
  SKILL_FILE_NAME,
  type SkillsTier,
  resolveDefaultTierRoot,
  resolveOptionalTierRoot,
  resolveUserPacksRoot,
} from './skills-layout.js';
import { diffPackMetadataSkills, readPackMetadata, type PackMetadataMismatch } from './pack-metadata.js';

export type DiscoveredSkill = {
  /** Filesystem directory name — the identity used for PACK.json metadata invariants. */
  readonly name: string;
  /** Runtime skill name from SKILL.md frontmatter `name:` (falls back to the dir name).
   *  Used for runtime materialization + duplicate detection so a pack skill whose
   *  directory differs from its declared name (e.g. the per-repo umbrella dir
   *  `service-skills` declaring `name: <repo>-services`) does not collide with a
   *  default skill of the same directory name. */
  readonly runtimeName: string;
  readonly path: string;
};

export type InvariantViolationCode =
  | 'SKILL_AND_PACK_CONFLICT'
  | 'NESTED_RUNTIME_ROOT'
  | 'PACK_METADATA_MISMATCH'
  | 'PACK_NAME_COLLISION';

export type InvariantViolation = {
  readonly code: InvariantViolationCode;
  readonly path: string;
  readonly message: string;
};

export type DiscoveredPack = {
  readonly name: string;
  readonly path: string;
  readonly tier: Exclude<SkillsTier, 'default'>;
  readonly skills: DiscoveredSkill[];
  readonly metadataMismatch: PackMetadataMismatch;
};

async function listDirectChildDirectories(root: string): Promise<string[]> {
  if (!await fs.pathExists(root)) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function hasFile(dirPath: string, fileName: string): Promise<boolean> {
  return fs.pathExists(path.join(dirPath, fileName));
}

async function hasNestedRuntimeRoot(dirPath: string): Promise<boolean> {
  for (const marker of RUNTIME_ROOT_MARKERS) {
    if (await fs.pathExists(path.join(dirPath, marker))) {
      return true;
    }
  }

  return false;
}

export async function detectDirectChildSkill(dirPath: string): Promise<boolean> {
  const hasSkillFile = await hasFile(dirPath, SKILL_FILE_NAME);
  if (!hasSkillFile) {
    return false;
  }

  return !await hasFile(dirPath, PACK_FILE_NAME);
}

/** Extract the `name:` value from a SKILL.md YAML frontmatter block, or null if absent.
 *  Manual parse (no YAML dep, matching the rest of the CLI). Only the first `---`…`---`
 *  block is considered; the value may be quoted. */
async function readSkillFrontmatterName(skillFilePath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(skillFilePath, 'utf8');
  } catch {
    return null;
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) {
    return null;
  }
  const nameLine = fm[1].split(/\r?\n/).find(line => /^name\s*:/.test(line));
  if (!nameLine) {
    return null;
  }
  const raw = nameLine.replace(/^name\s*:/, '').trim().replace(/^["']|["']$/g, '').trim();
  return raw || null;
}

export async function discoverDirectSkills(root: string): Promise<DiscoveredSkill[]> {
  const childDirectories = await listDirectChildDirectories(root);
  const discoveredSkills: DiscoveredSkill[] = [];

  for (const childDirectory of childDirectories) {
    const skillPath = path.join(root, childDirectory);
    if (!await detectDirectChildSkill(skillPath)) {
      continue;
    }

    const frontmatterName = await readSkillFrontmatterName(path.join(skillPath, SKILL_FILE_NAME));
    discoveredSkills.push({ name: childDirectory, runtimeName: frontmatterName ?? childDirectory, path: skillPath });
  }

  return discoveredSkills;
}

export async function discoverDefaultSkills(skillsRoot: string): Promise<DiscoveredSkill[]> {
  return discoverDirectSkills(resolveDefaultTierRoot(skillsRoot));
}

export async function discoverTierPacks(skillsRoot: string, tier: Exclude<SkillsTier, 'default'>): Promise<DiscoveredPack[]> {
  const tierRoot = tier === 'optional' ? resolveOptionalTierRoot(skillsRoot) : resolveUserPacksRoot(skillsRoot);
  const packDirectories = await listDirectChildDirectories(tierRoot);
  const discoveredPacks: DiscoveredPack[] = [];

  for (const packName of packDirectories) {
    const packPath = path.join(tierRoot, packName);
    if (!await hasFile(packPath, PACK_FILE_NAME)) {
      continue;
    }

    const metadata = await readPackMetadata(packPath, tier);
    const discoveredSkills = await discoverDirectSkills(packPath);
    const filesystemSkillNames = discoveredSkills.map(skill => skill.name);

    discoveredPacks.push({
      name: metadata.name,
      path: packPath,
      tier,
      skills: discoveredSkills,
      metadataMismatch: diffPackMetadataSkills(metadata.skills, filesystemSkillNames),
    });
  }

  return discoveredPacks;
}

export async function validateSkillsInvariants(skillsRoot: string): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  const defaultSkills = await discoverDefaultSkills(skillsRoot);
  for (const skill of defaultSkills) {
    if (await hasNestedRuntimeRoot(skill.path)) {
      violations.push({
        code: 'NESTED_RUNTIME_ROOT',
        path: skill.path,
        message: `Skill '${skill.name}' contains a nested runtime root directory (.claude/.agents/.pi).`,
      });
    }

    if (await hasFile(skill.path, PACK_FILE_NAME)) {
      violations.push({
        code: 'SKILL_AND_PACK_CONFLICT',
        path: skill.path,
        message: `Skill '${skill.name}' cannot contain ${PACK_FILE_NAME}.`,
      });
    }
  }

  const optionalPacks = await discoverTierPacks(skillsRoot, 'optional');
  const userPacks = await discoverTierPacks(skillsRoot, 'user');
  const allPacks = [...optionalPacks, ...userPacks];

  const seenPackNames = new Map<string, string>();
  for (const pack of allPacks) {
    const existing = seenPackNames.get(pack.name);
    if (existing) {
      violations.push({
        code: 'PACK_NAME_COLLISION',
        path: pack.path,
        message: `Pack '${pack.name}' collides with '${existing}'.`,
      });
    } else {
      seenPackNames.set(pack.name, pack.path);
    }

    if (await hasFile(pack.path, SKILL_FILE_NAME)) {
      violations.push({
        code: 'SKILL_AND_PACK_CONFLICT',
        path: pack.path,
        message: `Pack '${pack.name}' cannot contain ${SKILL_FILE_NAME} at pack root.`,
      });
    }

    for (const skill of pack.skills) {
      if (await hasNestedRuntimeRoot(skill.path)) {
        violations.push({
          code: 'NESTED_RUNTIME_ROOT',
          path: skill.path,
          message: `Pack skill '${pack.name}/${skill.name}' contains a nested runtime root directory (.claude/.agents/.pi).`,
        });
      }

      if (await hasFile(skill.path, PACK_FILE_NAME)) {
        violations.push({
          code: 'SKILL_AND_PACK_CONFLICT',
          path: skill.path,
          message: `Pack skill '${pack.name}/${skill.name}' cannot contain ${PACK_FILE_NAME}.`,
        });
      }
    }

    const mismatch = pack.metadataMismatch;
    if (mismatch.metadataOnlySkills.length > 0 || mismatch.filesystemOnlySkills.length > 0) {
      violations.push({
        code: 'PACK_METADATA_MISMATCH',
        path: pack.path,
        message: `Pack '${pack.name}' metadata skills do not match filesystem (metadata-only: ${mismatch.metadataOnlySkills.join(', ') || 'none'}, filesystem-only: ${mismatch.filesystemOnlySkills.join(', ') || 'none'}).`,
      });
    }
  }

  return violations;
}
