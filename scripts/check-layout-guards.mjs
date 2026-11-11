#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Batch G retired the per-REPO active tiers. The global runtime view
// (`~/.xtrm/skills/active/<runtime>`, written by materializeGlobalRuntimeViews and
// read by resolveGlobalRuntimeViewRoot) is still live, so a home-anchored reference
// documents current layout — only an unanchored/repo-relative one is stale.
const staleActiveTiers = ['.xtrm/skills/active/claude', '.xtrm/skills/active/pi'];
const HOME_ANCHOR = /(~|\$HOME|\$\{HOME\})\/$/;

export function staleActiveTierHits(text) {
  const hits = [];
  for (const stale of staleActiveTiers) {
    for (let at = text.indexOf(stale); at >= 0; at = text.indexOf(stale, at + stale.length)) {
      if (HOME_ANCHOR.test(text.slice(Math.max(0, at - 16), at))) continue;
      hits.push(stale);
    }
  }
  return hits;
}
const transientAllowlist = [
  '.beads/',
  '.xtrm/reports/',
  '.specialists/jobs/',
  '.specialists/trace.jsonl',
  '.specialists/executor-result.md',
  '.xtrm/skills/default/update-xt/SKILL.md',
  // self-reference: this script contains the staleActiveTiers strings by
  // necessity to detect them elsewhere; skip itself to avoid a false positive.
  'scripts/check-layout-guards.mjs',
  // its self-test feeds the stale (unanchored) form in and asserts it is flagged
  'scripts/__tests__/check-layout-guards.test.mjs',
  // Legitimate references — code and docs that name the retired paths in
  // order to detect / strip / describe them. Adding these to the guard's
  // stale-tier check would forbid the very mechanism that keeps the
  // fleet clean of the drift.
  //
  //   pi-runtime.ts: LEGACY_XTRM_SKILLS_ENTRIES set (strips them from .pi/settings.json)
  //   pi-runtime-safeguards.test.ts: regression case that feeds them in and asserts they get stripped
  //   cli/dist/*: bundled build artifact of pi-runtime.ts
  //   CHANGELOG.md: describes the strip fix (xtrm-ec9um in v0.10.2)
  'cli/src/core/pi-runtime.ts',
  'cli/src/tests/pi-runtime-safeguards.test.ts',
  'cli/dist/index.cjs',
  'cli/dist/index.cjs.map',
  'CHANGELOG.md',
];

function trackedFiles() {
  const out = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr || 'git ls-files failed');
  return out.stdout.split('\0').filter(Boolean);
}

function ignored(p) {
  return transientAllowlist.some((x) => p === x || p.startsWith(x));
}

async function main() {
  const files = trackedFiles();
  const offenders = [];

  for (const file of files) {
    if (ignored(file)) continue;
    let text;
    try {
      text = await readFile(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const stale of staleActiveTierHits(text)) {
      offenders.push(`${file} -> ${stale}`);
    }
  }

  const packLeaks = files.filter((f) => f.startsWith('.xtrm/skills/active/'));

  if (offenders.length || packLeaks.length) {
    console.error('check-layout-guards failed');
    if (offenders.length) {
      console.error('stale active tier references:');
      for (const x of offenders) console.error(`  - ${x}`);
    }
    if (packLeaks.length) {
      console.error('pack includes forbidden active view paths:');
      for (const x of packLeaks) console.error(`  - ${x}`);
    }
    process.exit(1);
  }

  console.log('check-layout-guards passed');
}

if (process.argv[1] === __filename) {
  await main();
}
