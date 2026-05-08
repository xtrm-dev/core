import fs from 'fs-extra';
import path from 'path';

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

async function isSourceRepoRoot(dir: string): Promise<boolean> {
  const skillsPath = path.join(dir, 'skills');
  const hooksPath = path.join(dir, 'hooks');
  return (await fs.pathExists(skillsPath)) && (await fs.pathExists(hooksPath));
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
  const fromCwd = await walkUp(process.cwd(), isSourceRepoRoot);
  if (fromCwd) {
    return fromCwd;
  }

  const fromBundle = await walkUp(path.resolve(__dirname, '..', '..'), isSourceRepoRoot);
  if (fromBundle) {
    return fromBundle;
  }

  throw new Error(
    'Could not locate xtrm-tools source repo root.\n' +
      'Run via `npx -y github:Jaggerxtrm/jaggers-agent-tools` or from within the cloned repository.',
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
