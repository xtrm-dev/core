// CORE-2402: `preflight --out` must not default to a random mkdtemp path (tmp
// can be reaped before the later `check` cell reads the stored preview.json),
// and a user-supplied --out that does not exist yet must still be writable.
// Runs under `npm run test:scripts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultOutDir, ensureOutDir } from '../../.xtrm/skills/default/engineering-quality/scripts/ocr-preflight.mjs';

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.xtrm/skills/default/engineering-quality/scripts/ocr-preflight.mjs',
);

test('default --out is stable across runs and lives under ~/.xtrm/cache', () => {
  const first = defaultOutDir();
  assert.equal(first, defaultOutDir(), 'default --out must not be a fresh random dir per run');
  assert.equal(first, path.join(homedir(), '.xtrm', 'cache', 'ocr-preflight'));
  assert.ok(path.isAbsolute(first));
});

test('ensureOutDir creates a user-supplied --out that does not exist yet', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ocr-out-'));
  const nested = path.join(base, 'a', 'b');
  try {
    assert.equal(existsSync(nested), false, 'fixture must start missing');
    assert.equal(ensureOutDir(nested), nested);
    assert.equal(existsSync(nested), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The old selftest created its fixture under the REAL ~/.xtrm/cache and removed
// only the nested leaf, so every run (CI included) left ocr-preflight-selftest
// behind. This fails on that behaviour.
test('selftest leaves no fixture behind in the real home cache', () => {
  const base = path.join(homedir(), '.xtrm', 'cache', 'ocr-preflight-selftest');
  const before = existsSync(base);
  const run = spawnSync(process.execPath, [script, 'selftest'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(base), before, 'selftest must not create or leave the fixture base under the real home');
});

// The guards are unit-tested through selftest, but that does not prove they are
// wired into `check`: reverting the wiring leaves the unit cases green and makes
// `check` throw a TypeError stack again.
test('check reports a malformed --ledger/--findings as a clean error, not a stack', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'ocr-check-'));
  const write = (name, text) => {
    const file = path.join(base, name);
    writeFileSync(file, text);
    return file;
  };
  const preview = write('preview.json', JSON.stringify({ reviewable_files: [], excluded_files: [] }));
  try {
    const badLedger = write('bad-ledger.json', 'null');
    const nullLedger = spawnSync(process.execPath, [script, 'check', '--preview', preview, '--ledger', badLedger], { encoding: 'utf8' });
    assert.equal(nullLedger.status, 2);
    assert.doesNotMatch(nullLedger.stderr, /TypeError/);
    assert.match(JSON.parse(nullLedger.stdout).error, /--ledger/);

    const okLedger = write('ok-ledger.json', JSON.stringify({ files: [] }));
    const badFindings = write('bad-findings.json', JSON.stringify({ path: 'a.ts' }));
    const objectFindings = spawnSync(process.execPath, [script, 'check', '--preview', preview, '--ledger', okLedger, '--findings', badFindings], { encoding: 'utf8' });
    assert.equal(objectFindings.status, 2);
    assert.doesNotMatch(objectFindings.stderr, /TypeError/);
    assert.match(JSON.parse(objectFindings.stdout).error, /--findings/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
