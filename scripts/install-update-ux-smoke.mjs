#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tarball = process.argv[2];
const secret = 'fixture-secret-should-not-leak';

if (!tarball) {
  console.error('usage: node scripts/install-update-ux-smoke.mjs <xtrm-tools-tarball>');
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function combined(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function redacted(value) {
  return value.replaceAll(secret, '[REDACTED]');
}

function assertNoSecret(label, result) {
  assert.doesNotMatch(combined(result), new RegExp(secret), `${label} leaked fixture content`);
}

function assertSuccess(label, result) {
  assert.equal(result.status, 0, `${label} failed (${result.status}): ${redacted(combined(result).slice(-1_000))}`);
  assertNoSecret(label, result);
}

const smokeRoot = mkdtempSync(path.join(os.tmpdir(), 'xtrm-install-update-ux-'));
const home = path.join(smokeRoot, 'home');
const project = path.join(smokeRoot, 'project');
const installPrefix = path.join(smokeRoot, 'install');
const piAgentDir = path.join(home, '.pi', 'agent');
const env = {
  ...process.env,
  HOME: home,
  PI_AGENT_DIR: piAgentDir,
  XTRM_SMOKE_SECRET: secret,
};

try {
  mkdirSync(project, { recursive: true });
  mkdirSync(home, { recursive: true });
  assertSuccess('git init', run('git', ['init', '-q', '-b', 'main'], { cwd: project, env }));

  const installed = run('npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline',
    '--prefix', installPrefix, tarball,
  ], { cwd: repoRoot, env });
  assertSuccess('fresh npm install', installed);

  const packageRoot = path.join(installPrefix, 'node_modules', 'xtrm-tools');
  const cli = path.join(packageRoot, 'cli', 'dist', 'index.cjs');
  assert.ok(existsSync(cli), 'packed install did not contain cli/dist/index.cjs');
  assert.ok(existsSync(path.join(packageRoot, '.xtrm', 'config', 'pi', 'install-schema.json')),
    'packed install did not contain .xtrm/config/pi/install-schema.json');

  const help = run('node', [cli, '--help'], { cwd: project, env });
  assertSuccess('installed CLI help', help);
  assert.match(help.stdout, /update/i);
  assert.match(help.stdout, /doctor/i);

  const piHelp = run('node', [cli, 'pi', '--help'], { cwd: project, env });
  assertSuccess('installed Pi help', piHelp);
  assert.doesNotMatch(piHelp.stdout, /^\s+install\b/im, 'retired install token remains in Pi help');

  const piCheck = run('node', [cli, 'pi', 'setup', '--check'], { cwd: project, env });
  assert.ok([0, 1].includes(piCheck.status), `Pi check crashed (${piCheck.status})`);
  assert.match(combined(piCheck), /Pi Runtime|Missing|Extensions/i);
  assert.doesNotMatch(combined(piCheck), /not bundled in npm package/i,
    'packaged Pi resolver fell through to an unbundled path');
  assertNoSecret('packaged Pi check', piCheck);

  for (const args of [['pi', 'install'], ['pi', 'install', '--help']]) {
    const retired = run('node', [cli, ...args], { cwd: project, env });
    assert.equal(retired.status, 1, `retired ${args.join(' ')} did not fail safely`);
    assert.match(combined(retired), /xt pi install is retired.*xt update --apply/i);
    assertNoSecret(`retired ${args.join(' ')}`, retired);
  }

  // Seed only isolated, known-owned legacy state plus user-owned controls.
  const defaultSkills = path.join(home, '.xtrm', 'skills', 'default');
  const activeSkills = path.join(home, '.xtrm', 'skills', 'active');
  const retiredSkill = path.join(defaultSkills, 'using-specialists-v3');
  const activeRetiredSkill = path.join(activeSkills, 'using-specialists-v3');
  const userSkill = path.join(activeSkills, 'user-owned');
  const userHook = path.join(home, '.claude', 'hooks', 'user-hook.mjs');
  mkdirSync(retiredSkill, { recursive: true });
  mkdirSync(userSkill, { recursive: true });
  mkdirSync(path.dirname(userHook), { recursive: true });
  writeFileSync(path.join(retiredSkill, 'SKILL.md'), '# retired\n');
  writeFileSync(path.join(home, '.xtrm', 'skills', '.installer-manifest.json'), JSON.stringify({
    default: ['using-specialists-v3/SKILL.md'],
  }, null, 2));
  writeFileSync(path.join(userSkill, 'SKILL.md'), '# user\n');
  writeFileSync(userHook, `// ${secret}\n`);
  symlinkSync('../default/using-specialists-v3', activeRetiredSkill);

  const clean = run('node', [cli, 'clean', '--yes'], { cwd: project, env });
  assertSuccess('ownership-safe clean', clean);
  assert.equal(existsSync(retiredSkill), false, 'owned retired skill was not removed');
  assert.equal(existsSync(activeRetiredSkill), false, 'owned active retired link was not removed');
  assert.equal(existsSync(path.join(userSkill, 'SKILL.md')), true, 'user active skill was removed');
  assert.equal(existsSync(userHook), true, 'user hook was removed');
  assert.match(clean.stdout, /Ownership outcome/i);
  assert.match(clean.stdout, /preserved/i);
  assert.match(clean.stdout, /removed/i);

  // ── Global prompt sync surface (xtrm-3ljgz.2) ─────────────────────────────
  // The packed tarball must carry the canonical assets the synchronizer reads
  // and the managed python-kernel extension payload.
  const tarballFiles = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).split('\n');
  for (const required of [
    'package/.xtrm/config/instructions/global-system-prompt.md',
    'package/packages/pi-extensions/extensions/python-kernel/index.ts',
    'package/packages/pi-extensions/extensions/python-kernel/package.json',
  ]) {
    assert.ok(tarballFiles.includes(required), `packed tarball missing canonical asset ${required}`);
  }

  // A real `xt update --repo <scaffolded-repo>` in DRY-RUN mode proves the
  // packed CLI invokes the global prompt sync exactly once per command
  // without any network touch. We deliberately do NOT run `xt update --apply`
  // here: apply drives real installs (oh-pi/pnpm/xt-managed pi packages,
  // tool upgrades via npm install -g) and the update exit-code contract makes
  // package-assurance failures fatal — non-hermetic and flaky in CI. The
  // apply path (marked files created, user bytes preserved, idempotent,
  // no-secret) is covered by cli/src/tests/global-prompt-sync.test.ts against
  // a real temp HOME + temp PI_AGENT_DIR.
  const userPrompt = path.join(piAgentDir, 'APPEND_SYSTEM.md');
  const claudePrompt = path.join(home, '.claude', 'CLAUDE.md');
  // Seed a user-owned prefix/suffix so the sync must preserve it (dry-run
  // reports; the mutating proof lives in the vitest integration suite).
  mkdirSync(piAgentDir, { recursive: true });
  mkdirSync(path.dirname(claudePrompt), { recursive: true });
  writeFileSync(userPrompt, `# user prefix\n\n${secret}\n\n# user suffix\n`);
  writeFileSync(claudePrompt, `# claude user prefix\n\n${secret}\n\n# claude user suffix\n`);
  const xtrmRepo = path.join(smokeRoot, 'xtrm-repo');
  mkdirSync(path.join(xtrmRepo, '.xtrm'), { recursive: true });
  copyFileSync(path.join(packageRoot, '.xtrm', 'registry.json'), path.join(xtrmRepo, '.xtrm', 'registry.json'));

  function assertDryRunDriftExit(label, result) {
    // xtrm-3ljgz.2: `xt update`'s exit-code contract makes package-assurance
    // failures fatal — a clean temp HOME with registry/Pi drift reports the
    // drift and exits 1, while a current environment exits 0. Both are the
    // documented outcomes; anything else is an unexpected exit/crash and must
    // fail the smoke. The content assertions that follow prove the update
    // completed and printed the sync actions instead of dying early, so real
    // failures are never masked.
    assert.ok([0, 1].includes(result.status), `${label} crashed (${result.status}): ${redacted(combined(result).slice(-1_000))}`);
    assertNoSecret(label, result);
  }

  const dryRun = run('node', [cli, 'update', '--repo', xtrmRepo], { cwd: project, env });
  assertDryRunDriftExit('dry-run update with global prompt sync', dryRun);
  assert.match(combined(dryRun), /Global system-prompt sync/i);
  assert.match(combined(dryRun), /pi: \[DRY RUN\] would prepend/i);
  assert.match(combined(dryRun), /claude: \[DRY RUN\] would prepend/i);
  // Dry-run must not mutate the seeded files.
  assert.equal(readFileSync(userPrompt, 'utf8'), `# user prefix\n\n${secret}\n\n# user suffix\n`);
  assert.equal(readFileSync(claudePrompt, 'utf8'), `# claude user prefix\n\n${secret}\n\n# claude user suffix\n`);

  // Second dry-run: idempotent planning output (no duplicate sync block).
  const dryRun2 = run('node', [cli, 'update', '--repo', xtrmRepo], { cwd: project, env });
  assertDryRunDriftExit('second dry-run update', dryRun2);
  assert.equal((combined(dryRun2).match(/Global system-prompt sync/g) ?? []).length, 1);

  console.log('install-update-ux-smoke: PASS');
  console.log('  packed resolver: PASS');
  console.log('  help/retired-token matrix: PASS');
  console.log('  owned-only cleanup and preservation: PASS');
  console.log('  canonical prompt assets in tarball: PASS');
  console.log('  global prompt sync via packed update (dry-run, once): PASS');
  console.log('  command output redaction: PASS');
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
