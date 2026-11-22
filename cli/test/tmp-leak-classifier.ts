import fs from 'node:fs';
import path from 'node:path';

// CORE-2758: the CORE-2612 teardown guard used to fail a shared-temp run on
// every entry under a blanket family list (`xtrm-`, `xt-`, `npm-latest-`,
// `xt-release-`). `xtrm-` is not this suite's prefix alone: a payload-hygiene
// script, a sibling worktree's vitest run, or a killed run all create
// `xtrm-…` directories, and the guard named them as this suite's leak.
//
// Ownership is now evidence, not a prefix guess. An entry counts as this run's
// when the run itself left a record of creating it:
//
//   1. the sandbox registry (cli/test/setup.ts writes every sandboxHome it
//      creates into $XTRM_TMP_REGISTRY), matched by exact basename, or
//   2. a mkdtemp prefix that appears in this package's own test sources.
//
// Everything else is reported as a foreign entry with its name and age. The
// classifier is pure over a listing so the rule can be tested without a fs.

export type TmpEntry = {
  name: string;
  ageSeconds: number;
};

export type Ownership = {
  // Dedicated temp dir (CI job, or TMPDIR given by the caller): every new entry
  // is this run's, so every survivor fails. Unchanged from CORE-2612.
  dedicated: boolean;
  // Basenames recorded in the run's sandbox registry.
  registered: string[];
  // mkdtemp prefixes used by this package's own test sources.
  ownPrefixes: string[];
};

export type Classification = {
  leaked: string[];
  foreign: TmpEntry[];
};

export function classifyEntries(created: TmpEntry[], ownership: Ownership): Classification {
  if (ownership.dedicated) {
    return { leaked: created.map(entry => entry.name), foreign: [] };
  }
  const registered = new Set(ownership.registered);
  const leaked: string[] = [];
  const foreign: TmpEntry[] = [];
  for (const entry of created) {
    const owned = registered.has(entry.name)
      || ownership.ownPrefixes.some(prefix => entry.name.startsWith(prefix));
    if (owned) leaked.push(entry.name);
    else foreign.push(entry);
  }
  return { leaked, foreign };
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown age';
  if (seconds < 60) return `${Math.round(seconds)}s old`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m old`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h old`;
  return `${Math.round(seconds / 86400)}d old`;
}

// The warning has to be readable enough that a real leak is still visible: name,
// age, and nothing invented about who owns it.
export function describeForeign(foreign: TmpEntry[], shown = 20): string {
  const listed = foreign.slice(0, shown).map(entry => `${entry.name} (${formatAge(entry.ageSeconds)})`);
  const more = foreign.length > shown ? ` … (${foreign.length - shown} more)` : '';
  return `${listed.join(', ')}${more}`;
}

// A mkdtemp prefix is "what this package's own tests create". Reading the
// sources is how the guard derives it without a list to keep in sync.
// Both call shapes in this package: a literal handed to mkdtemp/mkdtempSync or
// to a per-file helper named `tmpdir`, and a literal as the second argument of
// path.join(os.tmpdir() | tempRoot, …). The trailing dash is the convention that
// keeps ordinary string literals out.
const MKDTEMP_PREFIX = /(?:(?:mkdtemp|tmpdir)[A-Za-z]*\s*\(\s*|path\.join\([^,]+,\s*)['"]([^'"]+-)['"]/gi;

export function ownPrefixesFromSources(directories: string[]): string[] {
  const prefixes = new Set<string>();
  for (const directory of directories) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/.test(entry)) continue;
      let source = '';
      try {
        source = fs.readFileSync(path.join(directory, entry), 'utf8');
      } catch {
        continue;
      }
      for (const match of source.matchAll(MKDTEMP_PREFIX)) {
        const prefix = match[1];
        if (prefix) prefixes.add(prefix);
      }
    }
  }
  return [...prefixes].sort();
}
