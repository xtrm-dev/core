import fs from 'fs-extra';
import path from 'path';

declare const __dirname: string;

async function walkUp(startDir: string, predicate: (dir: string) => Promise<boolean>): Promise<string | null> {
  let dir = path.resolve(startDir);

  while (true) {
    if (await predicate(dir)) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

function resolveBundleRootFromRuntime(): string | null {
  const candidates = [
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, '.xtrm', 'registry.json'))) {
      return candidate;
    }
  }

  return null;
}

async function hasSafePackagedMarkers(dir: string): Promise<boolean> {
  const registryPath = path.join(dir, '.xtrm', 'registry.json');
  const managedSkillsPath = path.join(dir, '.xtrm', 'skills');

  const [registryStat, skillsStat] = await Promise.all([
    fs.lstat(registryPath).catch(() => null),
    fs.lstat(managedSkillsPath).catch(() => null),
  ]);
  if (!registryStat || !skillsStat || registryStat.isSymbolicLink() || skillsStat.isSymbolicLink()) {
    return false;
  }

  const [registryReal, skillsReal, dirReal] = await Promise.all([
    fs.realpath(registryPath).catch(() => null),
    fs.realpath(managedSkillsPath).catch(() => null),
    fs.realpath(dir).catch(() => null),
  ]);

  if (!registryReal || !skillsReal || !dirReal) {
    return false;
  }

  const rootPrefix = `${dirReal}${path.sep}`;
  return registryReal.startsWith(rootPrefix) && skillsReal.startsWith(rootPrefix);
}

async function isSourceRepoRoot(dir: string): Promise<boolean> {
  const legacySkillsPath = path.join(dir, 'skills');
  const legacyHooksPath = path.join(dir, 'hooks');
  if ((await fs.pathExists(legacySkillsPath)) && (await fs.pathExists(legacyHooksPath))) {
    return true;
  }

  return hasSafePackagedMarkers(dir);
}

async function isProjectRoot(dir: string): Promise<boolean> {
  const xtrmPath = path.join(dir, '.xtrm');
  const gitPath = path.join(dir, '.git');
  return (await fs.pathExists(xtrmPath)) || (await fs.pathExists(gitPath));
}

/**
 * Finds the xtrm-tools source repository root (bundle root).
 */
export async function findRepoRoot(): Promise<string> {
  const bundleRoot = resolveBundleRootFromRuntime();
  if (bundleRoot && await isSourceRepoRoot(bundleRoot)) {
    return bundleRoot;
  }

  const fromCwd = await walkUp(process.cwd(), isSourceRepoRoot);
  if (fromCwd) {
    return fromCwd;
  }

  throw new Error(
    'Could not locate xtrm-tools source repo root from current runtime.\n' +
      'Expected one of: .xtrm/registry.json + .xtrm/skills (packaged) or skills/ + hooks/ (source repo). ' +
      'Reinstall xtrm-tools package or run from cloned repository.',
  );
}

/**
 * Finds the current project root for local operations.
 *
 * Resolution order:
 * 1. Nearest ancestor containing `.xtrm/`
 * 2. Nearest ancestor containing `.git/`
 * 3. Fallback to the current working directory
 */
export async function findProjectRoot(): Promise<string> {
  const fromCwd = await walkUp(process.cwd(), isProjectRoot);
  if (fromCwd) {
    return fromCwd;
  }

  return process.cwd();
}
