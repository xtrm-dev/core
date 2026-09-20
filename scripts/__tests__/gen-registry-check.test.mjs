import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const sourceScript = path.join(repoRoot, 'scripts', 'gen-registry.mjs');

async function writeFileWithParents(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function createFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-gen-registry-check-'));
  await writeFileWithParents(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '9.9.9' }, null, 2),
  );
  await writeFileWithParents(path.join(tempRoot, '.xtrm', 'config', 'settings.json'), '{"ok":true}\n');
  await writeFileWithParents(path.join(tempRoot, '.xtrm', 'hooks', 'hook.mjs'), 'export default 1;\n');
  await writeFileWithParents(
    path.join(tempRoot, 'scripts', 'gen-registry.mjs'),
    await fs.readFile(sourceScript, 'utf8'),
  );
  spawnSync('git', ['init'], { cwd: tempRoot, stdio: 'ignore' });
  return tempRoot;
}

function runScript(tempRoot, args) {
  return spawnSync('node', [path.join(tempRoot, 'scripts', 'gen-registry.mjs'), ...args], {
    cwd: tempRoot,
    encoding: 'utf8',
  });
}

test('--check passes on a freshly generated registry', async (t) => {
  const tempRoot = await createFixture();
  t.after(async () => fs.rm(tempRoot, { recursive: true, force: true }));

  const generated = runScript(tempRoot, []);
  assert.equal(generated.status, 0, `gen-registry failed:\n${generated.stdout}\n${generated.stderr}`);

  const checked = runScript(tempRoot, ['--check']);
  assert.equal(checked.status, 0, `--check failed:\n${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /Registry freshness ok/);
  const after = await fs.readFile(path.join(tempRoot, '.xtrm', 'registry.json'), 'utf8');
  assert.equal(runScript(tempRoot, []).status, 0);
  const rewritten = await fs.readFile(path.join(tempRoot, '.xtrm', 'registry.json'), 'utf8');
  assert.equal(rewritten, after, '--check must not rewrite the registry');
});

test('--check fails and names the drifted path on a stale hash', async (t) => {
  const tempRoot = await createFixture();
  t.after(async () => fs.rm(tempRoot, { recursive: true, force: true }));

  assert.equal(runScript(tempRoot, []).status, 0);

  const registryPath = path.join(tempRoot, '.xtrm', 'registry.json');
  const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  registry.assets.config.files['settings.json'].hash = '0'.repeat(64);
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

  const checked = runScript(tempRoot, ['--check']);
  assert.equal(checked.status, 1, '--check should exit non-zero on stale hash');
  assert.match(checked.stderr, /\.xtrm\/config\/settings\.json/);
  assert.match(checked.stderr, /npm run gen-registry/);
});

test('--check fails when a registered file is edited without regeneration', async (t) => {
  const tempRoot = await createFixture();
  t.after(async () => fs.rm(tempRoot, { recursive: true, force: true }));

  assert.equal(runScript(tempRoot, []).status, 0);
  await fs.writeFile(path.join(tempRoot, '.xtrm', 'config', 'settings.json'), '{"ok":false}\n', 'utf8');

  const checked = runScript(tempRoot, ['--check']);
  assert.equal(checked.status, 1, '--check should exit non-zero on edited payload');
  assert.match(checked.stderr, /\.xtrm\/config\/settings\.json/);
});
