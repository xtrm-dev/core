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

// Layout and cache figure match the pi footer (custom-footer/hud.ts).
function runWith(fx, input) {
  return spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ workspace: { current_dir: fx.cwd }, ...input }),
    encoding: 'utf8',
    env: { ...process.env, XTRM_STATUSLINE_CACHE_DIR: fx.cache, PATH: `${fx.bin}:${process.env.PATH}` },
  }).stdout.replace(/\x1b\[[0-9;]*m/g, '');
}

const usageOf = (input, read, written = 0) => ({ context_window: { used_percentage: 12.5, context_window_size: 1_000_000, current_usage: { input_tokens: input, output_tokens: input, cache_creation_input_tokens: written, cache_read_input_tokens: read } } });

test('pi-footer layout: worktree, branch glyph, context, model, separators', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  run(fx);
  await waitForGitCache(fx.cache);
  const out = runWith(fx, { session_id: 'layout', model: { id: 'claude-x', display_name: 'Opus' }, effort: { level: 'high' }, ...usageOf(1, 0) });
  assert.match(out, /^repo {2}⎇ main · 12\.5%\/1\.0M · Opus high/);
});

test('cache figure is the median of recent responses; a miss shows as (last N%)', (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const send = (usage) => runWith(fx, { session_id: 'median', ...usage });
  // Four hits at 99% (input 1k, read 99k), then one total miss (input 100k, read 0, written 1).
  for (let i = 0; i < 4; i += 1) assert.match(send(usageOf(1_000 + i, 99_000)), /99% cache\n$/);
  assert.match(send(usageOf(100_000, 0, 1)), /99% cache \(last 0%\)\n$/);
  // Repeating the same signature is the same response: no extra sample.
  assert.match(send(usageOf(100_000, 0, 1)), /99% cache \(last 0%\)\n$/);
});

test('the last-response flag needs a gap of 20 points under the median', (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  for (const [session, last, expected] of [['gap19', 24, /95% cache\n$/], ['gap20', 25, /95% cache \(last 75%\)\n$/]]) {
    // Four responses at about 95% (distinct signatures), then one at exactly (100 - last)%.
    for (let i = 0; i < 4; i += 1) runWith(fx, { session_id: session, ...usageOf(5, 95 + i) });
    assert.match(runWith(fx, { session_id: session, ...usageOf(last, 100 - last) }), expected);
  }
});

test('no cache figure when the provider reports no cache fields', (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const out = runWith(fx, { session_id: 'nocache', ...usageOf(5_000, 0, 0) });
  assert.doesNotMatch(out, /cache/);
});

test('without a session id the latest response alone is shown and nothing is written', (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  assert.match(runWith(fx, usageOf(2_000, 8_000)), /80% cache\n$/);
  assert.equal(readdirSync(fx.cache).some(f => f.startsWith('xtrm-sl-cache-')), false);
});

test('the worktree name is never truncated, however long', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const long = join(fx.root, 'core-xt-claude-a-very-long-worktree-name-for-an-agent');
  mkdirSync(long);
  writeFileSync(join(fx.bin, 'git'), `#!/bin/sh\ncase "$*" in\n  *"rev-parse --show-toplevel"*) printf '${long}\\n' ;;\n  *"branch --show-current"*) printf 'main\\n' ;;\n  *) printf '' ;;\nesac\n`);
  run({ ...fx, cwd: long });
  await waitForGitCache(fx.cache);
  const out = runWith({ ...fx, cwd: long }, {});
  assert.ok(out.startsWith('core-xt-claude-a-very-long-worktree-name-for-an-agent  ⎇ main'), out);
  assert.doesNotMatch(out, /…/);
});
