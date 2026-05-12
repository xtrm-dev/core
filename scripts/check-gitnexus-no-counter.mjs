#!/usr/bin/env node
// Fail the build if tracked AGENTS.md or CLAUDE.md contain the GitNexus
// "X symbols, Y relationships, Z execution flows" counter line.
//
// Rationale: GitNexus `analyze` writes that line into AGENTS.md / CLAUDE.md
// when run without `--skip-agents-md --no-stats`. The counter changes on
// every run, dirtying git state and polluting chain branches with noise
// commits. specialists supervisor already passes both flags
// (fd60db04, 2026-05-09); this gate catches anyone (operator, future tool,
// external script) who re-introduces the counter via a non-flagged run.
//
// xtrm-c6sf.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Files we audit. Project-level only; .xtrm/reports/, .specialists/jobs/,
// .beads/issues.jsonl and other historical artifacts are out of scope.
const TARGET_FILES = ['AGENTS.md', 'CLAUDE.md'];

// "indexed by GitNexus as **<name>** (1234 symbols, 5678 relationships, 9 execution flows)"
const COUNTER_PATTERN = /\(\d+\s+symbols,\s*\d+\s+relationships,\s*\d+\s+execution\s+flows\)/;

function trackedFiles() {
  const out = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr || 'git ls-files failed');
  return new Set(out.stdout.split('\0').filter(Boolean));
}

async function main() {
  const tracked = trackedFiles();
  const offenders = [];

  for (const file of TARGET_FILES) {
    if (!tracked.has(file)) continue;
    let text;
    try {
      text = await readFile(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (COUNTER_PATTERN.test(lines[i])) {
        offenders.push(`${file}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  if (offenders.length > 0) {
    console.error('check-gitnexus-no-counter failed');
    console.error('Found GitNexus stats counter in tracked AGENTS.md / CLAUDE.md:');
    for (const x of offenders) console.error(`  - ${x}`);
    console.error('');
    console.error('The counter dirties git state on every `gitnexus analyze` run.');
    console.error('Fix: remove the "(N symbols, M relationships, K execution flows)" clause');
    console.error('from the line, and ensure callers pass `--skip-agents-md --no-stats` or');
    console.error('`--no-stats` to `gitnexus analyze`.');
    process.exit(1);
  }

  console.log('check-gitnexus-no-counter passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
