import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findBadTrackedSymlinks, findAbsolutePathLeaks, findForbiddenPackFiles, readTarballFile } from '../check-payload-hygiene.mjs';

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

test('flags tracked symlinks that point outside the repo or dangle, passes in-repo ones', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-symlink-test-'));
  try {
    const repo = path.join(tempDir, 'repo');
    await fs.mkdir(path.join(repo, 'bin'), { recursive: true });
    await fs.writeFile(path.join(repo, 'real.js'), '');
    await fs.symlink('../real.js', path.join(repo, 'bin', 'ok'));
    await fs.mkdir(path.join(tempDir, 'out'));
    await fs.writeFile(path.join(tempDir, 'out', 'f'), '');
    await fs.symlink('../../out/f', path.join(repo, 'bin', 'outside'));
    await fs.symlink('../missing.js', path.join(repo, 'bin', 'dangling'));
    await fs.symlink('../../out', path.join(repo, 'bin', 'dirlink'));
    await fs.symlink('dirlink/f', path.join(repo, 'bin', 'via'));
    await fs.symlink('../real.js', path.join(repo, 'bin', 'gone'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
    await fs.rm(path.join(repo, 'bin', 'gone'));

    assert.deepEqual(findBadTrackedSymlinks(repo).sort((a, b) => a.filePath.localeCompare(b.filePath)), [
      { filePath: 'bin/dangling', reason: 'dangling target' },
      { filePath: 'bin/dirlink', reason: 'target outside repo' },
      { filePath: 'bin/gone', reason: 'missing from working tree' },
      { filePath: 'bin/outside', reason: 'target outside repo' },
      { filePath: 'bin/via', reason: 'target outside repo' },
    ]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
