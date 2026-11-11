// The PRD body must be a pure function of the page source, and the check must fail when a
// step is missing from PRD.md or when the body is stale. Both failure paths are exercised
// here against a doctored copy of index.html; the passing path is the committed pair.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coverageReport, renderBody, splitDocument } from '../plan-to-md.mjs';

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
  assert.equal(report.counts.phaseSteps, 62, 'phase steps in index.html');
  assert.equal(report.counts.allSteps, 67, 'step entries including the five lettered asks');
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
