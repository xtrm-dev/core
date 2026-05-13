import test from 'node:test';
import assert from 'node:assert/strict';
import { findAbsolutePathLeaks, findForbiddenPackFiles } from '../check-payload-hygiene.mjs';

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
