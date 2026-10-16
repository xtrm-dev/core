// CORE-2402: the codemode SKILL.md writer pre-flight snippet must resolve the
// script via homedir(), never a "~" literal (JS strings never expand ~, so the
// old snippet failed on every machine). Runs under `npm run test:scripts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skill = path.join(repo, '.xtrm/skills/default/codemode/SKILL.md');

function fence() {
  const text = readFileSync(skill, 'utf8');
  const section = text.indexOf('## Pattern: writer pre-flight');
  assert.notEqual(section, -1, 'snippet section not found');
  const start = text.indexOf('```js', section);
  const end = text.indexOf('```', start + 5);
  assert.notEqual(start, -1, 'snippet fence not found');
  return text.slice(start + 5, end);
}

test('snippet resolves the script without a tilde literal', () => {
  const code = fence();
  assert.doesNotMatch(code, /"~[/\\]/, 'tilde literal never expands in a JS string');
  assert.match(code, /homedir\(\)/, 'script path must derive from homedir()');
});

test('snippet path resolution honors HOME', () => {
  const code = fence();
  const lines = code.split('\n');
  const cut = lines.findIndex((l) => l.includes('Promise.allSettled'));
  assert.notEqual(cut, -1, 'snippet shape changed; update this probe');
  const probe = `${lines.slice(0, cut).join('\n')}\nconsole.log(pf)\n`;
  const home = '/tmp/codemode-snippet-probe';
  const got = execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  }).trim();
  assert.equal(
    got,
    path.join(home, '.xtrm/skills/default/engineering-quality/scripts/ocr-preflight.mjs'),
  );
});
