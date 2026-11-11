// The PRD body must be a pure function of the page source, and the check must fail when a
// step is missing from PRD.md or when the body is stale. Both failure paths are exercised
// here against a doctored copy of index.html; the passing path is the committed pair.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coverageReport, renderBody, splitDocument } from '../plan-to-md.mjs';

const SCRIPT = fileURLToPath(new URL('../plan-to-md.mjs', import.meta.url));
const planDir = fileURLToPath(new URL('../../docs/plans/xtrm-build-order/', import.meta.url));
const source = readFileSync(`${planDir}index.html`, 'utf8');
const prd = readFileSync(`${planDir}PRD.md`, 'utf8');

test('rendering is deterministic and matches the committed PRD body', () => {
  const first = renderBody(source);
  const second = renderBody(source);
  assert.equal(first, second, 'two renders of the same source must be byte-identical');
  assert.equal(splitDocument(prd).body, first, 'PRD.md body is stale: run npm run plan:md');
});

test('every phase step is covered, in page order', () => {
  const report = coverageReport(source, renderBody(source));
  assert.equal(report.counts.phaseSteps, 63, 'phase steps in index.html');
  assert.equal(report.counts.allSteps, 68, 'step entries including the five lettered asks');
  assert.equal(report.missing.length, 0, 'no step from index.html may be dropped');
  assert.equal(report.inOrder, true, 'step headings follow page order');
});

test('a step missing from PRD.md fails the check', () => {
  // Simulate index.html gaining/renaming a step: PRD.md now lacks that step.
  const doctored = source.replace('<span class="num">12</span>', '<span class="num">12x</span>');
  assert.notEqual(doctored, source, 'scratch copy must differ from index.html');
  const report = coverageReport(doctored, splitDocument(prd).body);
  assert.equal(report.missing.length, 1, 'the renamed step is reported missing');
  assert.equal(report.missing[0].num, '12x');
});

test('an edited step title makes PRD.md stale', () => {
  const doctored = source.replace(
    '<b>Decide how Substrate works across two machines</b>',
    '<b>Decide how Substrate works across two machines, revised</b>',
  );
  assert.notEqual(doctored, source, 'scratch copy must differ from index.html');
  const rendered = renderBody(doctored);
  assert.notEqual(splitDocument(prd).body, rendered, 'check must see the body as stale');
  assert.match(rendered, /^### Step 7 — Decide how Substrate works across two machines, revised$/m);
  // Regeneration converges: the same doctored source renders its own stable body.
  assert.equal(renderBody(doctored), rendered);
});

// --- ruling boxes (CORE-2600) -------------------------------------------------------
// A box is a sequence: two lists, a paragraph and a table must all survive. Each case runs
// the real script inside a scratch repo, so the CLI exit code and message are what is
// asserted, not an internal helper.
const FIXTURE_BODY = `<!doctype html>
<html><body><div class="wrap">
<section class="phase">
  <div class="phase-head"><span class="tag">Phase 1</span><h2>Fixture</h2></div>
  <ol class="steps">
    <li class="step"><span class="num">1</span><div class="step-body">
      <div class="step-title"><b>Fixture step</b><span class="chip done">done</span><span class="refs">CORE-1</span></div>
      <div class="ruling"><span class="ruling-k">Ruling on your note · 11-11</span>
        <ul><li>first list item</li><li>first list second item</li></ul>
        <p>paragraph between the lists</p>
        <ul><li>second list item</li></ul>
        <table class="mini"><tr><th>Measure</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>
      </div>
    </div></li>
  </ol>
</section>
</div></body></html>`;
const FIXTURE_PRD = `# Fixture\n\n<!-- BEGIN GENERATED BODY: scripts/plan-to-md.mjs -->\n`;

function scratchRepo(indexHtml) {
  const dir = mkdtempSync(join(tmpdir(), 'plan-to-md-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'docs/plans/xtrm-build-order'), { recursive: true });
  writeFileSync(join(dir, 'scripts/plan-to-md.mjs'), readFileSync(SCRIPT, 'utf8'));
  writeFileSync(join(dir, 'docs/plans/xtrm-build-order/index.html'), indexHtml);
  writeFileSync(join(dir, 'docs/plans/xtrm-build-order/PRD.md'), FIXTURE_PRD);
  return dir;
}

function runScratch(dir) {
  try {
    const stdout = execFileSync(process.execPath, [join(dir, 'scripts/plan-to-md.mjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('a ruling box keeps every child: two lists, a paragraph and a table, in order', () => {
  const dir = scratchRepo(FIXTURE_BODY);
  try {
    const result = runScratch(dir);
    assert.equal(result.status, 0, result.stderr);
    const prd = readFileSync(join(dir, 'docs/plans/xtrm-build-order/PRD.md'), 'utf8');
    const markers = [
      '> - first list item',
      '> - first list second item',
      '> paragraph between the lists',
      '> - second list item',
      '> | Measure | Value |',
      '> | alpha | 1 |',
    ];
    for (const marker of markers) assert.ok(prd.includes(marker), `missing from PRD: ${marker}`);
    const positions = markers.map((marker) => prd.indexOf(marker));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'box children render in page order');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown element inside a ruling box fails loudly, naming the step', () => {
  const withUnknown = FIXTURE_BODY.replace(
    '<p>paragraph between the lists</p>',
    '<p>paragraph between the lists</p><blockquote>unknown payload</blockquote>',
  );
  const dir = scratchRepo(withUnknown);
  try {
    const result = runScratch(dir);
    assert.equal(result.status, 1, 'the generator must refuse to drop an element it cannot render');
    assert.match(result.stderr, /unknown element <blockquote>/);
    assert.match(result.stderr, /in step 1/);
    assert.equal(readFileSync(join(dir, 'docs/plans/xtrm-build-order/PRD.md'), 'utf8'), FIXTURE_PRD, 'nothing is written on failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first-list-only mutant goes red', () => {
  const dir = scratchRepo(FIXTURE_BODY);
  try {
    const scriptPath = join(dir, 'scripts/plan-to-md.mjs');
    const original = readFileSync(SCRIPT, 'utf8');
    // The CORE-2600 bug, restored verbatim: keep the label and the first <ul>, drop the rest.
    const mutant = `function renderRuling(node, context = {}) {
  const out = [];
  const label = elements(node).find((c) => hasClass(c, 'ruling-k'));
  if (label) out.push(\`> **\${inlineOf(label)}**\`);
  const list = find(node, 'ul');
  if (list) for (const li of elements(list).filter((n) => n.tag === 'li')) out.push(\`> - \${inlineOf(li)}\`);
  out.push('');
  return out;
}

function unknownElement`;
    const patched = original.replace(/function renderRuling\(node, context = \{\}\) \{[\s\S]*?\n\}\n\nfunction unknownElement/, mutant);
    assert.notEqual(patched, original, 'the mutation must apply to the real function');
    writeFileSync(scriptPath, patched);
    const result = runScratch(dir);
    assert.equal(result.status, 1, 'a dropped box element must fail the generator, not pass silently');
    assert.match(result.stderr, /box coverage FAILED: 1 of 1 ruling box\(es\) lost or changed content/);
    assert.match(result.stderr, /second list item|paragraph between the lists/);
    assert.equal(readFileSync(join(dir, 'docs/plans/xtrm-build-order/PRD.md'), 'utf8'), FIXTURE_PRD, 'nothing is written on failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
