// Guards that judge the artefact and the resolution root, not the cwd string.
// The defect this exists for: a build run in a worktree whose node_modules is a
// symlink to the main checkout produced a bundle carrying 932 absolute module
// paths, while the prebuild guard (a `/ .xtrm/worktrees/` cwd prefix test)
// reported nothing, because where you build is not what you build with.
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Every needle that occurs in `source`, with its count and first line. */
export function absolutePathOffences(source, needles) {
  const offences = [];
  for (const needle of needles) {
    if (!needle) continue;
    let count = 0;
    let firstLine = 0;
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const hits = lines[index].split(needle).length - 1;
      if (hits > 0 && firstLine === 0) firstLine = index + 1;
      count += hits;
    }
    if (count > 0) offences.push({ needle, count, firstLine });
  }
  return offences;
}

/** Paths a shipped bundle must never carry: this machine's home, the repo, any /home/. */
export function bundleNeedles({ homeDir, repoRoot }) {
  const needles = [];
  if (homeDir) needles.push(homeDir);
  if (repoRoot && repoRoot !== homeDir) needles.push(repoRoot);
  needles.push('/home/');
  return needles;
}

/**
 * Two directories resolve identically when their real paths are equal AND the
 * ones given are not the same spelling of one directory. A worktree whose
 * node_modules links into the main checkout is the shape that produced the
 * broken bundle; a build in the main checkout is the legitimate case with the
 * same real path, so it must not be refused.
 */
export function resolutionRootShared({ worktreeModules, mainModules, realpath = realpathSync }) {
  if (!existsSync(worktreeModules) || !existsSync(mainModules)) return null;
  const worktreeReal = realpath(worktreeModules);
  const mainReal = realpath(mainModules);
  if (worktreeReal !== mainReal) return null;
  return { worktreeReal };
}

/** Git's common dir is the main checkout's .git; its parent is the main checkout. */
export function mainCheckoutFromCommonDir(gitCommonDir) {
  return dirname(resolve(gitCommonDir));
}

/** Decision for a build about to run. */
export function prebuildVerdict({ cwd, gitCommonDir, realpath = realpathSync }) {
  if (!gitCommonDir) return { ok: true, shared: null, reason: null };
  const mainRoot = mainCheckoutFromCommonDir(gitCommonDir);
  const cliRoot = resolve(cwd);
  const repoRoot = dirname(cliRoot);
  if (resolve(repoRoot) === resolve(mainRoot)) return { ok: true, shared: null, reason: null };
  const shared = resolutionRootShared({
    worktreeModules: join(cliRoot, 'node_modules'),
    mainModules: join(mainRoot, 'cli', 'node_modules'),
    realpath,
  });
  if (!shared) {
    const legacyShared = resolutionRootShared({
      worktreeModules: join(repoRoot, 'node_modules'),
      mainModules: join(mainRoot, 'node_modules'),
      realpath,
    });
    if (!legacyShared) return { ok: true, shared: null, reason: null };
    return { ok: false, shared: legacyShared, reason: `this worktree's node_modules resolves to ${legacyShared.worktreeReal}, the same directory the main checkout uses` };
  }
  return { ok: false, shared, reason: `this worktree's cli/node_modules resolves to ${shared.worktreeReal}, the same directory the main checkout uses` };
}

/** Decision on a built bundle. */
export function bundleVerdict({ source, homeDir, repoRoot }) {
  const offences = absolutePathOffences(source, bundleNeedles({ homeDir, repoRoot }));
  return { ok: offences.length === 0, offences };
}

async function main(argv) {
  const mode = argv[0];
  const cwd = process.cwd();
  if (mode === 'prebuild') {
    const { execFileSync } = await import('node:child_process');
    let common = null;
    try {
      common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    } catch {
      common = null;
    }
    const verdict = prebuildVerdict({ cwd, gitCommonDir: common });
    if (!verdict.ok) {
      console.error(`ERROR: refusing to build — ${verdict.reason}.\nA bundle built that way embeds that directory's module paths, so the committed dist would name this machine.\nFix: run npm ci at the worktree root AND in cli/, so this worktree has its own node_modules, then rebuild.\nOr build from the main repo: cd <repo-root>/cli && npm run build`);
      return 1;
    }
    return 0;
  }
  if (mode === 'bundle') {
    const distPath = resolve(cwd, argv[1] ?? 'dist/index.cjs');
    const source = readFileSync(distPath, 'utf8');
    const repoRoot = dirname(cwd);
    const verdict = bundleVerdict({ source, homeDir: process.env.HOME ?? '', repoRoot });
    if (!verdict.ok) {
      const detail = verdict.offences.map((o) => `${o.needle} ${o.count} time(s), first at line ${o.firstLine}`).join('; ');
      console.error(`ERROR: refusing to ship a bundle that names this machine: ${argv[1] ?? 'dist/index.cjs'} contains ${detail}.\nA bundle built through a linked node_modules embeds the linker's absolute paths; CI's dist check cannot see it, and a run from another machine would resolve nothing.\nFix: build where the dependencies resolve inside the checkout (npm ci at the worktree root and in cli/), never through a symlink into another checkout.`);
      return 1;
    }
    return 0;
  }
  console.error('usage: bundle-hermetic.mjs <prebuild|bundle> [distPath]');
  return 2;
}

const invoked = process.argv[1] ?? '';
if (invoked.endsWith('bundle-hermetic.mjs')) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
