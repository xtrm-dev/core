import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
//     at any moment, so an unattributed survivor is reported as a warning; the
//     families this suite demonstrably owns still fail the run.
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

// Families this suite creates, used only in the shared-temp-dir mode. The list
// is not the contract: the contract is the count above.
const KNOWN_FAMILIES = [
  'xtrm-',
  'xt-',
  'npm-latest-',
  'xt-release-',
];

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

let before = new Set<string>();
let registry = '';

export async function setup(): Promise<void> {
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

  const leaked = dedicated
    ? settled
    : settled.filter(name => KNOWN_FAMILIES.some(prefix => name.startsWith(prefix)));
  const unattributed = settled.filter(name => !leaked.includes(name));

  if (unattributed.length > 0) {
    console.warn(
      `[CORE-2612] ${unattributed.length} new entries in the shared temp dir were not attributed to this suite: `
      + `${unattributed.slice(0, 20).join(', ')}. Run with TMPDIR=<fresh dir> to count them strictly.`,
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
