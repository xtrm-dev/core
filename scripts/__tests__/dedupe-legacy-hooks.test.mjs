import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The module resolves the global hooks dir from os.homedir() at load time, and the
// audit hashes files inside it. Point HOME at a throwaway tree with a stand-in global
// install so the test does not depend on the machine running it having xtrm installed
// — it passed on a dev box and failed on a clean CI runner (ENOENT on
// ~/.xtrm/hooks/beads-compact-save.mjs). os.homedir() reads $HOME on POSIX, and the
// import must be dynamic so it happens after the assignment.
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dedupe-hooks-home-'));
process.env.HOME = HOME;
const GLOBAL_HOOKS = path.join(HOME, '.xtrm', 'hooks');
await fs.mkdir(GLOBAL_HOOKS, { recursive: true });
await fs.writeFile(path.join(GLOBAL_HOOKS, 'beads-compact-save.mjs'), '// global beads-compact-save\n');
await fs.writeFile(path.join(GLOBAL_HOOKS, 'beads-stop-gate.mjs'), '// global beads-stop-gate\n');

const { normaliseCommand, indexGlobal, pruneSettings, auditProject } = await import(
  '../dedupe-legacy-hooks.mjs'
);

test('normalises project hook paths onto the global hooks dir', () => {
  const cmd = normaliseCommand('node "/repo/.xtrm/hooks/beads-compact-save.mjs"', '/repo');
  assert.equal(cmd, `node "${GLOBAL_HOOKS}/beads-compact-save.mjs"`);
});

test('leaves commands that do not reference project hooks untouched', () => {
  const cmd = normaliseCommand('python3 "$CLAUDE_PROJECT_DIR/tool.py"', '/repo');
  assert.equal(cmd, 'python3 "$CLAUDE_PROJECT_DIR/tool.py"');
});

test('prune drops only the planned commands and collapses empty entries', () => {
  const settings = {
    permissions: { allow: ['Read'] },
    hooks: {
      Stop: [{ hooks: [{ command: 'a' }, { command: 'b' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'c' }] }],
    },
  };
  const next = pruneSettings(settings, [
    { event: 'Stop', matcher: '', command: 'a' },
    { event: 'PreToolUse', matcher: 'Bash', command: 'c' },
  ]);

  assert.deepEqual(next.permissions, { allow: ['Read'] }, 'non-hook keys survive');
  assert.deepEqual(next.hooks, { Stop: [{ hooks: [{ command: 'b' }] }] });
});

test('prune removes the hooks key entirely when nothing survives', () => {
  const next = pruneSettings({ hooks: { Stop: [{ hooks: [{ command: 'a' }] }] } }, [
    { event: 'Stop', matcher: '', command: 'a' },
  ]);
  assert.equal('hooks' in next, false);
});

test('audit plans identical duplicates and preserves drift, uncovered and foreign entries', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedupe-hooks-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const hooksDir = path.join(dir, '.xtrm', 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

  // matches the real global copy byte-for-byte -> safe duplicate
  const canonical = await fs.readFile(path.join(GLOBAL_HOOKS, 'beads-compact-save.mjs'));
  await fs.writeFile(path.join(hooksDir, 'beads-compact-save.mjs'), canonical);
  // same name as a global hook but different bytes -> must be preserved
  await fs.writeFile(path.join(hooksDir, 'beads-stop-gate.mjs'), '// locally patched\n');

  const q = (name) => `node "${path.join(hooksDir, name)}"`;
  await fs.writeFile(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              { command: q('beads-compact-save.mjs') },
              { command: q('beads-stop-gate.mjs') },
              { command: q('not-in-global.mjs') },
              { command: 'python3 "$CLAUDE_PROJECT_DIR/mine.py"' },
            ],
          },
        ],
      },
    }),
  );

  const globalIndex = indexGlobal({
    hooks: {
      Stop: [
        {
          hooks: [
            { command: `node "${GLOBAL_HOOKS}/beads-compact-save.mjs"` },
            { command: `node "${GLOBAL_HOOKS}/beads-stop-gate.mjs"` },
          ],
        },
      ],
    },
  });

  const result = await auditProject(dir, globalIndex);

  assert.deepEqual(
    result.planned.map((p) => p.command),
    [q('beads-compact-save.mjs')],
    'only the byte-identical, globally-covered hook is planned for removal',
  );
  assert.deepEqual(
    result.preserved.map((p) => p.classification),
    ['xt-owned-drift', 'xt-owned-uncovered', 'foreign'],
  );
  assert.equal(result.failed.length, 0);
});
