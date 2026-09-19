import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const hook = new URL('./statusline.mjs', import.meta.url).pathname;

// Lane 1 (hook cleanup): statusline is git-only. The fixture uses a fake git
// (fast, deterministic) and a fake bd that must NEVER be called — any bd
// invocation is a lane-1 regression. No beads cache is ever written.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xtrm-statusline-'));
  const cwd = join(root, 'repo');
  const cache = join(root, 'cache');
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  mkdirSync(join(cwd, '.xtrm'), { recursive: true });
  mkdirSync(cache); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho git >> '${log}'\ncase \"$*\" in\n  *\"rev-parse --show-toplevel\"*) printf '${cwd}\\n' ;;\n  *\"branch --show-current\"*) printf 'main\\n' ;;\n  *\"rev-parse --short HEAD\"*) printf 'abc1234\\n' ;;\n  *\"status --porcelain\"*) printf '' ;;\n  *\"rev-list\"*) printf '' ;;\n  *) printf '' ;;\nesac\n`);
  // Regression tripwire: statusline must never spawn bd after lane 1.
  writeFileSync(join(bin, 'bd'), `#!/bin/sh\necho bd >> '${log}'\nprintf '[]\\n'\n`);
  spawnSync('chmod', ['+x', join(bin, 'git'), join(bin, 'bd')]);
  return { root, cwd, cache, bin, log };
}

function run({ cwd, cache, bin }) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ workspace: { current_dir: cwd } }),
    encoding: 'utf8',
    env: {
      ...process.env,
      XTRM_STATUSLINE_CACHE_DIR: cache,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return { result, elapsed: performance.now() - started };
}

function bdCalls(log) {
  if (!existsSync(log)) return 0;
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).filter(c => c === 'bd').length;
}

async function waitForGitCache(cache, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (readdirSync(cache).some(f => f.startsWith('xtrm-sl-git-'))) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('background git refresh did not finish');
}

test('renderer never blocks; cold fallback + warm cached read both < 200ms', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const cold = run(fx);
  assert.equal(cold.result.status, 0);
  // Git-only line: path + model, no beads segment.
  assert.match(cold.result.stdout, /repo/);
  assert.doesNotMatch(cold.result.stdout, /o:\d+ p:\d+|beads unavailable|no open issues/);
  assert.ok(cold.elapsed < 200, `renderer blocked for ${cold.elapsed}ms`);
  await waitForGitCache(fx.cache);
  const warm = run(fx);
  assert.equal(warm.result.status, 0);
  assert.match(warm.result.stdout, /main/);
  assert.ok(warm.elapsed < 200, `cached renderer blocked for ${warm.elapsed}ms`);
});

test('never spawns bd (lane 1 regression tripwire)', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  run(fx);
  await waitForGitCache(fx.cache);
  // Warm render + refresh round-trip: still zero bd calls.
  run(fx);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(bdCalls(fx.log), 0, 'statusline spawned bd after lane-1 sever');
});

test('concurrent renders share one git refresh lease (no stampede)', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const children = Array.from({ length: 5 }, () => spawn(process.execPath, [hook], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: {
      ...process.env,
      XTRM_STATUSLINE_CACHE_DIR: fx.cache,
      PATH: `${fx.bin}:${process.env.PATH}`,
    },
  }));
  for (const child of children) child.stdin.end(JSON.stringify({ workspace: { current_dir: fx.cwd } }));
  await Promise.all(children.map(child => new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))))));
  await waitForGitCache(fx.cache);
  assert.equal(bdCalls(fx.log), 0, 'concurrent renders spawned bd');
});

test('corrupt git cache falls back safely without crashing', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  writeFileSync(join(fx.cache, 'xtrm-sl-git-deadbeef.json'), '{bad json');
  const { result } = run({ ...fx, cache: fx.cache });
  assert.equal(result.status, 0);
});
