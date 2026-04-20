import fs from 'fs-extra';
import path from 'node:path';

interface PiSettings {
  skills?: string[];
}

export interface RuntimeViewCheckResult {
  readonly activeReady: boolean;
  readonly claudePointerReady: boolean;
  readonly piPointerReady: boolean;
  readonly activeEntries: string[];
  readonly hasDeprecatedAgentsSkillsPath: boolean;
}

const CLAUDE_POINTER_TARGET = path.join('..', '.xtrm', 'skills', 'active');
const PI_SKILLS_ENTRY = '../.xtrm/skills/active';

async function readSymlinkTarget(linkPath: string): Promise<string | null> {
  const stat = await fs.lstat(linkPath).catch(() => null);
  if (!stat?.isSymbolicLink()) {
    return null;
  }

  return fs.readlink(linkPath);
}

async function listRuntimeEntries(runtimeRoot: string): Promise<string[]> {
  const stat = await fs.lstat(runtimeRoot).catch(() => null);
  if (!stat?.isDirectory()) {
    return [];
  }

  const names = (await fs.readdir(runtimeRoot)).sort((a, b) => a.localeCompare(b));
  return names;
}

async function hasOnlyValidSymlinkEntries(runtimeRoot: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) {
    const entryPath = path.join(runtimeRoot, name);
    const stat = await fs.lstat(entryPath).catch(() => null);
    if (!stat?.isSymbolicLink()) {
      return false;
    }

    const linkTarget = await fs.readlink(entryPath);
    const resolvedTarget = path.resolve(path.dirname(entryPath), linkTarget);
    if (!await fs.pathExists(resolvedTarget)) {
      return false;
    }
  }

  return true;
}

async function hasPiSkillsPointer(projectRoot: string): Promise<boolean> {
  const settingsPath = path.join(projectRoot, '.pi', 'settings.json');
  const exists = await fs.pathExists(settingsPath);
  if (!exists) {
    return false;
  }

  const settings = await fs.readJson(settingsPath).catch(() => ({} as PiSettings)) as PiSettings;
  return Array.isArray(settings.skills) && settings.skills.includes(PI_SKILLS_ENTRY);
}

export async function checkRuntimeSkillsViews(projectRoot: string): Promise<RuntimeViewCheckResult> {
  const activeRoot = path.join(projectRoot, '.xtrm', 'skills', 'active');

  const activeEntries = await listRuntimeEntries(activeRoot);

  const activeReady = activeEntries.length > 0
    && await hasOnlyValidSymlinkEntries(activeRoot, activeEntries);

  const claudePointerReady = await readSymlinkTarget(path.join(projectRoot, '.claude', 'skills')) === CLAUDE_POINTER_TARGET;
  const piPointerReady = await hasPiSkillsPointer(projectRoot);

  const hasDeprecatedAgentsSkillsPath = await fs.pathExists(path.join(projectRoot, '.agents', 'skills'));

  return {
    activeReady,
    claudePointerReady,
    piPointerReady,
    activeEntries,
    hasDeprecatedAgentsSkillsPath,
  };
}

export async function assertRuntimeSkillsViews(projectRoot: string): Promise<void> {
  const check = await checkRuntimeSkillsViews(projectRoot);

  const failures: string[] = [];
  if (!check.activeReady) failures.push('active view is missing, empty, or contains invalid links');
  if (!check.claudePointerReady) failures.push('.claude/skills is not linked to ../.xtrm/skills/active');
  if (!check.piPointerReady) failures.push('.pi/settings.json.skills does not include ../.xtrm/skills/active');

  if (failures.length > 0) {
    throw new Error(`Runtime skills view validation failed: ${failures.join('; ')}`);
  }
}
