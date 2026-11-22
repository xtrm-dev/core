import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyEntries,
  describeForeign,
  ownPrefixesFromSources,
  type TmpEntry,
} from './tmp-leak-classifier';

// CORE-2612: fail the suite when it leaves scratch directories behind.
//
// A full cli run used to add one xtrm-cli-home-* per test file plus one
// directory per test that called mkdtemp without a matching removal. On
// 2026-11-11 the operator's 16G tmpfs reached 80% with 48k entries and the
// resulting disk I/O errors read as unrelated test failures.
//
// This is a vitest globalSetup hook, so it observes the whole suite once
// instead of racing parallel test files. It snapshots the temp dir before the
// suite and counts every entry that appeared while it ran:
//
//   - dedicated temp dir (CI job, or TMPDIR given by the caller): every new
//     entry is this run's, so any survivor fails the run. Only the runner's own
//     node-compile-cache is exempt.
//   - shared temp dir (a developer's /tmp): another process can create an entry
//     at any moment, so a survivor fails the run only when this run can show it
//     created it — a name from the sandbox registry, or a mkdtemp prefix that
//     appears in this package's own test sources (CORE-2758). Every other new
//     entry is a warning that names the entry and its age.
//
// Scope, stated because it used to be implied: a run killed by a timeout or a
// signal runs no hook, so its directories are not this guard's to reclaim. They
// sit in the temp dir and become part of the next run's baseline, which is why a
// killed run cannot be named as an offender. Stale run registries are swept
// instead (see sweepStaleRegistries) because a registry names exactly what the
// dead run created, so the reclamation carries evidence with it.
const tempRoot = path.resolve(os.tmpdir());
// Explicit, not inferred: macOS always sets TMPDIR, so its presence cannot mean
// "this directory is mine". CI sets XTRM_TMP_STRICT=1; anywhere else the
// absence of that flag keeps the shared-directory behaviour.
const dedicated = process.env.XTRM_TMP_STRICT === '1'
  || Boolean(process.env.RUNNER_TEMP)
  || process.env.CI === 'true';

// The runner's own state, created before the first test file loads and removed
// when the process exits. It is not a test's leak, and no test can reproduce it.
function isRunnerOwned(name: string): boolean {
  if (name === 'node-compile-cache') return true;
  // Vite writes its SSR module cache into a randomly named temp directory with a
  // single `ssr` child holding sha1-named files.
  const full = path.join(tempRoot, name);
  try {
    if (!fs.statSync(full).isDirectory()) return false;
    const inside = fs.readdirSync(full);
    if (inside.length !== 1 || inside[0] !== 'ssr') return false;
    const cache = fs.readdirSync(path.join(full, 'ssr'));
    return cache.length > 0 && cache.every(entry => /^[0-9a-f]{40}$/.test(entry));
  } catch {
    return false;
  }
}

// Second line of defence for a development machine where /tmp is shared with
// other accounts: an entry owned by another uid cannot be this run's leak. This
// is not the fix for the hosted-runner tmux failure — that directory belonged to
// the run's own uid, and setup.ts now points TMUX_TMPDIR into the sandbox.
function ownedByThisUser(name: string): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return true;
  try {
    return fs.statSync(path.join(tempRoot, name)).uid === uid;
  } catch {
    return false;
  }
}

function entries(): Set<string> {
  return new Set(fs.readdirSync(tempRoot));
}

async function survivors(names: string[], timeoutMs = 6000): Promise<string[]> {
  if (names.length === 0) return names;
  const deadline = Date.now() + timeoutMs;
  let current = names;
  while (Date.now() < deadline && current.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const now = entries();
    current = current.filter(name => now.has(name));
  }
  return current;
}

// A registry whose process is gone names directories nothing will ever remove.
// Only a registry older than this, whose pid is dead, is treated as abandoned:
// a live pid may be reused, and a young registry may belong to a run that is
// still starting up.
const STALE_REGISTRY_HOURS = 6;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sweepStaleRegistries(): string[] {
  const prefix = 'xtrm-cli-run-';
  const suffix = '.registry';
  const removed: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(tempRoot);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const pid = Number(name.slice(prefix.length, -suffix.length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const file = path.join(tempRoot, name);
    let ageHours = 0;
    try {
      ageHours = (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000;
    } catch {
      continue;
    }
    if (ageHours < STALE_REGISTRY_HOURS || isProcessAlive(pid)) continue;
    const listed = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const dir of listed) {
      // The registry is a list of absolute paths; only reclaim what is directly
      // inside this temp root, and only what still exists.
      if (path.dirname(path.resolve(dir)) !== tempRoot) continue;
      if (!fs.existsSync(dir)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(path.basename(dir));
    }
    fs.rmSync(file, { force: true });
  }
  return removed;
}

// Prefixes come from this package's own sources, so the guard attributes what
// the suite can be shown to create instead of claiming every `xtrm-` entry.
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function ownPrefixes(): string[] {
  return ownPrefixesFromSources([
    path.join(cliRoot, 'test'),
    path.join(cliRoot, 'src', 'tests'),
  ]);
}

function aged(names: string[]): TmpEntry[] {
  const now = Date.now();
  return names.map((name) => {
    let ageSeconds = 0;
    try {
      ageSeconds = (now - fs.statSync(path.join(tempRoot, name)).mtimeMs) / 1000;
    } catch {
      ageSeconds = 0;
    }
    return { name, ageSeconds };
  });
}

let before = new Set<string>();
let registry = '';

export async function setup(): Promise<void> {
  const reclaimed = sweepStaleRegistries();
  if (reclaimed.length > 0) {
    console.warn(
      `[CORE-2612] reclaimed ${reclaimed.length} entries left by a run that was killed before its teardown: `
      + `${reclaimed.slice(0, 20).join(', ')}${reclaimed.length > 20 ? ` … (${reclaimed.length - 20} more)` : ''}`,
    );
  }
  before = entries();
  // Workers append every sandbox they create to this file (cli/test/setup.ts),
  // so teardown can remove exactly what this run created and nothing else.
  registry = path.join(tempRoot, `xtrm-cli-run-${process.pid}.registry`);
  fs.writeFileSync(registry, '');
  process.env.XTRM_TMP_REGISTRY = registry;
}

export async function teardown(): Promise<void> {
  // Sweep registered sandboxes a file could not remove itself (a skipped file
  // never runs afterAll; a daemonised child can recreate its home afterwards).
  const registered = fs.existsSync(registry)
    ? fs.readFileSync(registry, 'utf8').split('\n').filter(Boolean)
    : [];
  for (const dir of registered) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(registry, { force: true });

  const registryName = path.basename(registry);
  const created = [...entries()]
    .filter(name => !before.has(name) && name !== registryName && !isRunnerOwned(name))
    .filter(ownedByThisUser)
    .sort();

  // A spawned helper can create a directory and remove it seconds later, after
  // the suite has ended. Only an entry that survives the whole observation
  // window counts as a leak.
  const settled = await survivors(created);

  // Ownership is evidence: the run's own registry, or a prefix the package's
  // sources use. A sibling worktree, a payload-hygiene script or a killed run
  // cannot be attributed to this suite, so it cannot fail it (CORE-2758).
  const { leaked, foreign } = classifyEntries(aged(settled), {
    dedicated,
    registered: registered.map(dir => path.basename(dir)),
    ownPrefixes: ownPrefixes(),
  });

  if (foreign.length > 0) {
    console.warn(
      `[CORE-2612] ${foreign.length} new entries in the shared temp dir were not created by this suite: `
      + `${describeForeign(foreign)}. Left in place; run with TMPDIR=<fresh dir> to count this run's own entries strictly.`,
    );
  }
  if (leaked.length === 0) return;

  // A throw from globalSetup teardown is only logged by vitest; the explicit
  // exitCode is what turns the CI job red.
  process.exitCode = 1;
  const shown = leaked.slice(0, 20).join(', ');
  const more = leaked.length > 20 ? ` … (${leaked.length - 20} more)` : '';
  throw new Error(
    `test suite left ${leaked.length} entries in ${tempRoot}: ${shown}${more}. `
    + 'Every mkdtemp must be removed in an afterAll/afterEach/finally hook, '
    + 'including when its test fails (CORE-2612).',
  );
}
