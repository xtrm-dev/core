import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import yaml from 'yaml';

export type BdAutoStageConfigState = 'not-applicable' | 'already-disabled' | 'updated';
export type BdAutoStageHookState = 'not-applicable' | 'already-present' | 'updated' | 'misconfigured-hooks-path';

export interface BdAutoStagePatchResult {
  changed: boolean;
  config: BdAutoStageConfigState;
  hook: BdAutoStageHookState;
  hookPath?: string;
  warnings: string[];
}

const STAGE_COMMAND = 'git add -f .beads/issues.jsonl 2>/dev/null || true';
const STAGE_BLOCK = `# --- BEGIN XTRM bd auto-stage snapshot ---
# Keep bd export.git-add=false for quiet mid-work bd ops, then stage the
# freshly exported JSONL snapshot at commit time. This block lives outside
# bd-managed hook markers so bd hooks install/upgrade will not clobber it.
${STAGE_COMMAND}
# --- END XTRM bd auto-stage snapshot ---`;

function parseYamlObject(raw: string): Record<string, unknown> {
  const parsed = raw.trim() ? yaml.parse(raw) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

async function ensureExportGitAddDisabled(repoRoot: string, apply: boolean): Promise<{ changed: boolean; state: BdAutoStageConfigState }> {
  const beadsDir = path.join(repoRoot, '.beads');
  if (!await fs.pathExists(beadsDir)) return { changed: false, state: 'not-applicable' };

  const configPath = path.join(beadsDir, 'config.yaml');
  const raw = await fs.pathExists(configPath) ? await fs.readFile(configPath, 'utf8') : '';
  const config = parseYamlObject(raw);

  if (config['export.git-add'] === false) return { changed: false, state: 'already-disabled' };
  if (!apply) return { changed: true, state: 'updated' };

  await fs.ensureDir(beadsDir);
  await fs.writeFile(configPath, yaml.stringify({ ...config, 'export.git-add': false }), 'utf8');
  return { changed: true, state: 'updated' };
}

function gitOutput(repoRoot: string, args: string[]): string | null {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

function resolveHookPath(repoRoot: string): { hookPath?: string; warning?: string } {
  const hooksPath = gitOutput(repoRoot, ['config', '--get', 'core.hooksPath']);
  const normalizedHooksPath = hooksPath?.replace(/\\/g, '/').replace(/\/$/, '');

  if (hooksPath) {
    const hooksDir = path.isAbsolute(hooksPath) ? hooksPath : path.join(repoRoot, hooksPath);
    const hookPath = path.join(hooksDir, 'pre-commit');
    if (normalizedHooksPath && (normalizedHooksPath === '.beads/hooks' || normalizedHooksPath.endsWith('/.beads/hooks'))) {
      if (fs.existsSync(hookPath)) return { hookPath };
      return {
        warning: `core.hooksPath points at ${hooksPath}, but no pre-commit hook exists there`,
      };
    }
    return { hookPath };
  }

  const gitCommonDirRaw = gitOutput(repoRoot, ['rev-parse', '--git-common-dir']);
  if (!gitCommonDirRaw) return { warning: 'could not resolve git hooks directory' };
  const gitCommonDir = path.isAbsolute(gitCommonDirRaw)
    ? gitCommonDirRaw
    : path.join(repoRoot, gitCommonDirRaw);
  return { hookPath: path.join(gitCommonDir, 'hooks', 'pre-commit') };
}

async function ensureStageShim(repoRoot: string, apply: boolean): Promise<{ changed: boolean; state: BdAutoStageHookState; hookPath?: string; warnings: string[] }> {
  if (!await fs.pathExists(path.join(repoRoot, '.beads'))) {
    return { changed: false, state: 'not-applicable', warnings: [] };
  }

  const resolved = resolveHookPath(repoRoot);
  if (!resolved.hookPath) {
    return { changed: false, state: 'misconfigured-hooks-path', warnings: [resolved.warning ?? 'could not resolve git hooks directory'] };
  }

  const existing = await fs.pathExists(resolved.hookPath) ? await fs.readFile(resolved.hookPath, 'utf8') : '';
  if (existing.includes(STAGE_COMMAND)) {
    return { changed: false, state: 'already-present', hookPath: resolved.hookPath, warnings: [] };
  }

  if (!apply) {
    return { changed: true, state: 'updated', hookPath: resolved.hookPath, warnings: [] };
  }

  const base = existing.trim().length > 0
    ? existing.replace(/\s*$/, '\n\n')
    : '#!/usr/bin/env sh\n';
  await fs.ensureDir(path.dirname(resolved.hookPath));
  await fs.writeFile(resolved.hookPath, `${base}${STAGE_BLOCK}\n`, 'utf8');
  await fs.chmod(resolved.hookPath, 0o755);
  return { changed: true, state: 'updated', hookPath: resolved.hookPath, warnings: [] };
}

export async function ensureBdAutoStagePatch(repoRoot: string, apply: boolean): Promise<BdAutoStagePatchResult> {
  const config = await ensureExportGitAddDisabled(repoRoot, apply);
  const hook = await ensureStageShim(repoRoot, apply);

  return {
    changed: config.changed || hook.changed,
    config: config.state,
    hook: hook.state,
    hookPath: hook.hookPath,
    warnings: hook.warnings,
  };
}

export function summarizeBdAutoStagePatch(result: BdAutoStagePatchResult): string {
  const parts = [`bd export.git-add: ${result.config}`, `pre-commit shim: ${result.hook}`];
  if (result.hookPath) parts.push(`hook=${result.hookPath}`);
  if (result.warnings.length > 0) parts.push(`warnings=${result.warnings.length}`);
  return parts.join(', ');
}
