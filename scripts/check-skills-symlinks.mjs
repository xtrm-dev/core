#!/usr/bin/env node
// Walk .xtrm/skills/default and fail the build if any symlink is broken
// (target doesn't exist) or self-referencing.
//
// Rationale: a broken symlink committed to xtrm-tools gets shipped via npm
// pack and propagated to every consumer install. Real incident: PR #197
// re-added the security-pipeline skill but accidentally included a
// 'security-pipeline/security-pipeline -> ../default/security-pipeline'
// dangling symlink. Caught and removed via xtrm-t5vz; this gate prevents
// recurrence.

import { readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const SKILLS_ROOT = path.join(repoRoot, '.xtrm', 'skills', 'default');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const offenders = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const target = await readlink(full);
        const resolved = path.resolve(path.dirname(full), target);
        // resolve target through filesystem; throws if any link in the chain is broken
        await realpath(full);
        // self-reference check: resolved path equals the symlink itself
        if (resolved === full) {
          offenders.push(`${path.relative(repoRoot, full)}: self-referencing symlink → ${target}`);
        }
      } catch {
        offenders.push(`${path.relative(repoRoot, full)}: broken symlink → ${await readlink(full).catch(() => '?')}`);
      }
      continue;
    }
    if (entry.isDirectory()) {
      offenders.push(...await walk(full));
    }
  }
  return offenders;
}

async function main() {
  const offenders = await walk(SKILLS_ROOT);
  if (offenders.length > 0) {
    console.error('check-skills-symlinks failed');
    console.error('Broken or self-referencing symlinks under .xtrm/skills/default:');
    for (const o of offenders) console.error(`  - ${o}`);
    console.error('');
    console.error('A broken symlink committed here is shipped to every consumer via npm pack.');
    console.error('Remove the file with `git rm <path>` and re-run `npm run gen-registry`.');
    process.exit(1);
  }
  console.log('check-skills-symlinks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
