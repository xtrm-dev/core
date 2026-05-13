import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findAbsolutePathLeaks, findForbiddenPackFiles, readTarballFile } from '../check-payload-hygiene.mjs';

test('flags forbidden packed paths', () => {
  const hits = findForbiddenPackFiles([
    '.xtrm/worktrees/tmp/file.txt',
    '.pi/logs/run.log',
    'packages/pi-extensions/.serena/state.json',
    '.beads/issues.jsonl',
    'ok/readme.md',
  ]);

  assert.deepEqual(hits.map((hit) => hit.filePath), [
    '.xtrm/worktrees/tmp/file.txt',
    '.pi/logs/run.log',
    'packages/pi-extensions/.serena/state.json',
    '.beads/issues.jsonl',
  ]);
});

test('flags absolute path leaks in packed text', () => {
  const leaks = findAbsolutePathLeaks(new Map([
    ['README.md', 'see /home/alice/project'],
    ['config.json', '{"url":"file:///home/alice/file"}'],
    ['safe.json', '{"ok":true}'],
  ]));

  assert.deepEqual(leaks, [
    { filePath: 'README.md', match: '/home/alice/' },
    { filePath: 'config.json', match: '/home/alice/' },
  ]);
});

test('reports both denylist hits and absolute-path leaks together', () => {
  const forbidden = findForbiddenPackFiles(['.pi/logs/run.log']);
  const leaks = findAbsolutePathLeaks(new Map([
    ['README.md', 'see /home/alice/project'],
  ]));

  assert.equal(forbidden.length, 1);
  assert.equal(leaks.length, 1);
  assert.equal(forbidden[0].filePath, '.pi/logs/run.log');
  assert.equal(leaks[0].filePath, 'README.md');
});

test('reads large tarball files without buffer exhaustion', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-payload-test-'));
  try {
    const packageDir = path.join(tempDir, 'package');
    await fs.mkdir(packageDir);
    const bigFilePath = path.join(packageDir, 'big.txt');
    await fs.writeFile(bigFilePath, 'x'.repeat(2 * 1024 * 1024 + 1));

    const tarballPath = path.join(tempDir, 'payload.tgz');
    execFileSync('tar', ['-czf', tarballPath, '-C', tempDir, 'package']);

    const content = readTarballFile(tarballPath, 'big.txt');
    assert.equal(content.length, 2 * 1024 * 1024 + 1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
