import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type HookResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type EnvOverrides = Record<string, string | undefined>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS_DIR = path.resolve(__dirname, '../../.xtrm/hooks');

function buildEnv(overrides: EnvOverrides = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
      continue;
    }
    env[key] = value;
  }
  return env;
}

function invokeHook(scriptName: string, payload: object, envOverrides: EnvOverrides = {}): HookResult {
  const scriptPath = path.join(HOOKS_DIR, scriptName);
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: buildEnv(envOverrides),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status ?? 0,
  };
}

function parseHookOutput(stdout: string): { hookSpecificOutput: Record<string, unknown> } {
  return JSON.parse(stdout) as { hookSpecificOutput: Record<string, unknown> };
}

function createTempProject(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function createFakeWhich(scriptBody: string): string {
  const binDir = mkdtempSync(path.join(tmpdir(), 'xtrm-fake-which-'));
  const whichPath = path.join(binDir, 'which');
  writeFileSync(whichPath, scriptBody, 'utf8');
  chmodSync(whichPath, 0o755);
  return binDir;
}
describe('quality-check-env.mjs integration', () => {
  it('checks for tsc/eslint/ruff when quality-check hook is present', () => {
    const projectDir = createTempProject('xtrm-hook-qenv-present-');
    const hooksDir = path.join(projectDir, '.xtrm', 'hooks');
    const fakeWhichDir = createFakeWhich('#!/bin/sh\nexit 1\n');

    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, 'quality-check.cjs'), 'module.exports = {};', 'utf8');
    writeFileSync(path.join(projectDir, 'tsconfig.json'), '{}\n', 'utf8');
    writeFileSync(path.join(projectDir, 'eslint.config.js'), 'export default [];\n', 'utf8');
    writeFileSync(path.join(projectDir, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');

    try {
      const result = invokeHook(
        'quality-check-env.mjs',
        { cwd: projectDir },
        { CLAUDE_PLUGIN_ROOT: undefined, PATH: fakeWhichDir },
      );

      expect(result.exitCode).toBe(0);
      const output = parseHookOutput(result.stdout);
      const prompt = String(output.hookSpecificOutput.additionalSystemPrompt);
      expect(prompt).toContain('tsc not found');
      expect(prompt).toContain('eslint not found');
      expect(prompt).toContain('ruff not found');
    } finally {
      rmSync(fakeWhichDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('exits 0 immediately when quality-check.cjs is not present', () => {
    const projectDir = createTempProject('xtrm-hook-qenv-missing-');

    try {
      const result = invokeHook('quality-check-env.mjs', { cwd: projectDir }, { CLAUDE_PLUGIN_ROOT: undefined });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('warns when tsc is missing', () => {
    const projectDir = createTempProject('xtrm-hook-qenv-tsc-');
    const hooksDir = path.join(projectDir, '.xtrm', 'hooks');
    const fakeWhichDir = createFakeWhich([
      '#!/bin/sh',
      'case "$1" in',
      '  tsc) exit 1 ;;',
      '  eslint|ruff) exit 0 ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'));

    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, 'quality-check.cjs'), 'module.exports = {};', 'utf8');
    writeFileSync(path.join(projectDir, 'tsconfig.json'), '{}\n', 'utf8');
    writeFileSync(path.join(projectDir, 'eslint.config.js'), 'export default [];\n', 'utf8');
    writeFileSync(path.join(projectDir, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');

    try {
      const result = invokeHook(
        'quality-check-env.mjs',
        { cwd: projectDir },
        { CLAUDE_PLUGIN_ROOT: undefined, PATH: fakeWhichDir },
      );
      expect(result.exitCode).toBe(0);

      const output = parseHookOutput(result.stdout);
      const prompt = String(output.hookSpecificOutput.additionalSystemPrompt);
      expect(prompt).toContain('tsc not found');
      expect(prompt).not.toContain('eslint not found');
      expect(prompt).not.toContain('ruff not found');
    } finally {
      rmSync(fakeWhichDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('behaves identically with and without CLAUDE_PLUGIN_ROOT', () => {
    const projectDir = createTempProject('xtrm-hook-qenv-plugin-var-');
    const hooksDir = path.join(projectDir, '.xtrm', 'hooks');
    const fakeWhichDir = createFakeWhich('#!/bin/sh\nexit 1\n');

    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(path.join(hooksDir, 'quality-check.cjs'), 'module.exports = {};', 'utf8');
    writeFileSync(path.join(projectDir, 'tsconfig.json'), '{}\n', 'utf8');

    try {
      const withoutVar = invokeHook(
        'quality-check-env.mjs',
        { cwd: projectDir },
        { CLAUDE_PLUGIN_ROOT: undefined, PATH: fakeWhichDir },
      );
      const withVar = invokeHook(
        'quality-check-env.mjs',
        { cwd: projectDir },
        { CLAUDE_PLUGIN_ROOT: '/tmp/legacy-plugin-root', PATH: fakeWhichDir },
      );

      expect(withoutVar.exitCode).toBe(0);
      expect(withVar.exitCode).toBe(0);
      expect(withoutVar.stdout).toBe(withVar.stdout);
    } finally {
      rmSync(fakeWhichDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
