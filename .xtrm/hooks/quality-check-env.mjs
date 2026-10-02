#!/usr/bin/env node
// SessionStart hook — verify quality gate environment is intact.
// Checks for tsc, eslint, ruff so the agent knows early if enforcement
// is silently degraded. Exits 0 always (informational only).

import { readFileSync, realpathSync, existsSync, accessSync, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CORE-2339: check logic exported for dispatch.mjs; CLI entry preserved.
// The `which` probes scan PATH in-process (no execSync spawns) — same result,
// zero extra processes on the fan-out path.
export function envCheck(input = {}) {
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  // Only relevant in projects that have quality gates wired
  const hookPresent = existsSync(path.resolve(cwd, '.xtrm', 'hooks', 'quality-check.cjs'));
  if (!hookPresent) return null;

  function which(cmd) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      try {
        accessSync(path.join(dir, cmd), constants.X_OK);
        if (existsSync(path.join(dir, cmd))) return true;
      } catch { /* not executable here */ }
    }
    // Check node_modules/.bin/ walking up from cwd
    let d = cwd;
    while (true) {
      if (existsSync(path.join(d, 'node_modules', '.bin', cmd))) return true;
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return false;
  }

  const warnings = [];

  // CLAUDE_PROJECT_DIR check
  if (!process.env.CLAUDE_PROJECT_DIR) {
    warnings.push('CLAUDE_PROJECT_DIR is not set — quality gate may target wrong directory');
  }

  // TypeScript project checks
  const hasTsConfig = existsSync(path.join(cwd, 'tsconfig.json')) ||
    existsSync(path.join(cwd, 'cli', 'tsconfig.json'));

  if (hasTsConfig) {
    if (!which('tsc')) warnings.push('tsc not found — TypeScript compilation check will be skipped');
    const hasEslintConfig = ['eslint.config.js', 'eslint.config.mjs', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml']
      .some(f => existsSync(path.join(cwd, f)));
    if (hasEslintConfig && !which('eslint')) warnings.push('eslint not found — ESLint check will be skipped');
  }

  // Python project checks
  const hasPyFiles = existsSync(path.join(cwd, 'pyproject.toml')) ||
    existsSync(path.join(cwd, 'setup.py')) ||
    existsSync(path.join(cwd, 'requirements.txt'));

  if (hasPyFiles) {
    if (!which('ruff')) warnings.push('ruff not found — Python lint check will be skipped');
  }

  if (warnings.length === 0) return null;

  const msg = `⚠️ Quality gate environment issue(s) detected:\n${warnings.map(w => `  • ${w}`).join('\n')}\nFix these to ensure quality gates enforce correctly.`;

  return JSON.stringify({
    hookSpecificOutput: { additionalSystemPrompt: msg },
  });
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }

  const out = envCheck(input);
  if (out) process.stdout.write(out);
  process.exit(0);
}

// Symlink-safe CLI entry: repo-root `hooks/` is a symlink to .xtrm/hooks, and
// node resolves module identity through the real path while argv[1] keeps the
// symlink path — compare realpaths or the standalone entry never fires.
function isCliMain() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliMain()) main();
