// CORE-2402: `preflight --out` must not default to a random mkdtemp path (tmp
// can be reaped before the later `check` cell reads the stored preview.json),
// and a user-supplied --out that does not exist yet must still be writable.
// Runs under `npm run test:scripts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { defaultOutDir, ensureOutDir } from '../../.xtrm/skills/default/engineering-quality/scripts/ocr-preflight.mjs';

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
