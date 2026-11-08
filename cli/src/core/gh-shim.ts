/**
 * The `gh` shim for agent processes (CORE-2528).
 *
 * Agents keep typing plain `gh`. For an agent process (SUBSTRATE_HOLDER or
 * XTRM_ROLE set) the shim intercepts three things and passes everything else to
 * the real binary unchanged:
 *
 *   gh pr review ...   -> `xt identity review-post` (formal review, commit_id
 *                         pinned to the reviewed head, reviewer App token)
 *   gh pr merge ...    -> `xt identity merge-check` first, then the real gh with
 *                         --match-head-commit, then a github-merge Journal ref
 *   gh pr close|edit   -> refused for the reviewer role
 *
 * An operator process (no holder, no role) always reaches the real gh: the shim
 * changes nothing outside an agent tree. The shim never prints or stores a
 * token; the CLI mints what it needs.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GH_SHIM_MARKER = '# xtrm-gh-agent-shim v1';
const REAL_GH_PLACEHOLDER = '__XTRM_REAL_GH__';

export interface ShimDeps {
    env?: NodeJS.ProcessEnv;
    home?: string;
    binDir?: string;
    readFile?: (file: string) => string;
    exists?: (file: string) => boolean;
    readRealPath?: (file: string) => string;
    statMode?: (file: string) => number | null;
}

function realpathOf(deps: ShimDeps, file: string): string {
    const read = deps.readRealPath ?? ((f: string) => realpathSync(f));
    try {
        return read(file);
    } catch {
        return file;
    }
}

function isExecutableFile(deps: ShimDeps, file: string): boolean {
    const stat = deps.statMode
        ? (() => { const mode = deps.statMode!(file); return mode === null ? null : { mode }; })()
        : (() => {
            try {
                const s = statSync(file);
                return s.isFile() ? { mode: s.mode } : null;
            } catch {
                return null;
            }
        })();
    if (!stat) return false;
    return (stat.mode & 0o111) !== 0;
}

function isShimFile(deps: ShimDeps, file: string): boolean {
    const read = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
    try {
        return read(file).slice(0, 512).includes(GH_SHIM_MARKER);
    } catch {
        return false;
    }
}

export function defaultGhShimPath(deps: ShimDeps = {}): string {
    return path.join(deps.binDir ?? path.join(deps.home ?? os.homedir(), '.local', 'bin'), 'gh');
}

/** The first real `gh` on PATH that is neither our shim nor the target we are about to write. */
export function findRealGh(deps: ShimDeps = {}): string | null {
    const env = deps.env ?? process.env;
    const target = defaultGhShimPath(deps);
    const exists = deps.exists ?? ((file: string) => existsSync(file));
    const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = path.join(dir, 'gh');
        if (!exists(candidate)) continue;
        if (realpathOf(deps, candidate) === realpathOf(deps, target)) continue;
        if (isShimFile(deps, candidate)) continue;
        if (!isExecutableFile(deps, candidate)) continue;
        return candidate;
    }
    return null;
}

/** The shim source with the real binary resolved at install time (re-scanned at runtime). */
export function ghShimSource(realGh: string | null): string {
    const body = `#!/usr/bin/env node
${GH_SHIM_MARKER}
// Installed by \`xt identity setup\`. Do not edit; re-run the command instead.
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MARKER = '${GH_SHIM_MARKER}';
const REAL_GH = ${JSON.stringify(realGh ?? '')};
const SELF = (() => { try { return fs.realpathSync(__filename); } catch { return __filename; } })();

function die(message, code) {
  process.stderr.write('gh (xtrm): ' + message + '\\n');
  process.exit(code === undefined ? 1 : code);
}

function isAgent() {
  return Boolean((process.env.SUBSTRATE_HOLDER || '').trim() || (process.env.XTRM_ROLE || '').trim());
}

function isShim(file) {
  try { return fs.readFileSync(file, 'utf8').slice(0, 512).includes(MARKER); } catch { return false; }
}

function findRealGh() {
  const candidates = [];
  if (REAL_GH) candidates.push(REAL_GH);
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'gh'));
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() || !(stat.mode & 0o111)) continue;
      if (fs.realpathSync(candidate) === SELF) continue;
      if (isShim(candidate)) continue;
      return candidate;
    } catch (error) { /* next candidate */ }
  }
  return null;
}

function pass(real, args) {
  const result = spawnSync(real, args, { stdio: 'inherit' });
  if (result.error) die('cannot run ' + real + ': ' + result.error.message);
  process.exit(result.status === null ? 1 : result.status);
}

function capture(real, args) {
  return spawnSync(real, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function xtPassthrough(args) {
  const result = spawnSync('xt', args, { stdio: 'inherit' });
  if (result.error) die('xt is not runnable: ' + result.error.message);
  return result.status === null ? 1 : result.status;
}

function xtQuiet(args) {
  return spawnSync('xt', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function pullInfo(real) {
  const view = capture(real, ['pr', 'view', '--json', 'number,url,headRefOid']);
  if (view.status !== 0) die('cannot read the current PR: ' + ((view.stderr || '').trim() || 'gh pr view failed'));
  let info;
  try { info = JSON.parse(view.stdout); } catch (error) { die('cannot parse gh pr view output'); }
  const match = /^https:\\/\\/github\\.com\\/([^/]+\\/[^/]+)\\/pull\\/(\\d+)$/.exec(info.url || '');
  if (!match) die('cannot read the repository and PR number from ' + info.url);
  return { repo: match[1], pr: Number(match[2]), head: info.headRefOid || '' };
}

function main() {
  const args = process.argv.slice(2);
  const real = findRealGh();
  if (!isAgent()) { if (!real) die('real gh not found on PATH'); pass(real, args); }
  if (!real) die('real gh not found on PATH (the xtrm shim excludes itself)');
  const verb = args[0] === 'pr' ? args[1] : undefined;
  const role = (process.env.XTRM_ROLE || '').trim();

  if (verb === 'review') {
    const info = pullInfo(real);
    process.exit(xtPassthrough(['identity', 'review-post', '--repo', info.repo, '--pr', String(info.pr), ...args.slice(2)]));
  }

  if (verb === 'merge') {
    if (role === 'reviewer') die('the reviewer role may not merge; ask the worker or coordinator');
    const info = pullInfo(real);
    const checked = xtPassthrough(['identity', 'merge-check', '--repo', info.repo, '--pr', String(info.pr)]);
    if (checked !== 0) process.exit(checked);
    const pinned = args.some((arg) => arg === '--match-head-commit');
    const mergeArgs = pinned || !info.head ? args : [...args, '--match-head-commit', info.head];
    const merged = spawnSync(real, mergeArgs, { stdio: 'inherit' });
    if (merged.error) die('cannot run ' + real + ': ' + merged.error.message);
    const status = merged.status === null ? 1 : merged.status;
    if (status === 0) {
      const recorded = xtQuiet(['identity', 'merge-record', '--repo', info.repo, '--pr', String(info.pr), '--head', info.head]);
      if (recorded.status !== 0) {
        process.stderr.write('gh (xtrm): merged, but the Journal receipt failed: ' + ((recorded.stderr || '').trim() || 'unknown error') + '\\n');
      }
    }
    process.exit(status);
  }

  if (role === 'reviewer' && (verb === 'close' || verb === 'edit')) {
    die('the reviewer role may not change PR state (gh pr ' + verb + ')');
  }

  // Everything else: the real gh, unchanged.
  pass(real, args);
}

main();
`;
    return body;
}

export interface InstallResult {
    ok: boolean;
    path: string;
    realGh: string | null;
    reason?: string;
    warnings: string[];
}

/** Install (or refresh) the shim. Refuses to overwrite a foreign `gh`. */
export function installGhShim(deps: ShimDeps = {}): InstallResult {
    const file = defaultGhShimPath(deps);
    const realGh = findRealGh(deps);
    const warnings: string[] = [];
    if (!realGh) {
        return { ok: false, path: file, realGh: null, reason: 'no real gh on PATH (only the xtrm shim, if any)', warnings };
    }
    const exists = deps.exists ?? ((f: string) => existsSync(f));
    if (exists(file) && !isShimFile(deps, file)) {
        return { ok: false, path: file, realGh, reason: `${file} exists and is not the xtrm shim; move it aside first`, warnings };
    }
    const ordered = pathOrder(deps, file, realGh);
    if (!ordered) warnings.push(`${path.dirname(file)} comes after ${path.dirname(realGh)} on PATH; the shim will not be used`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, ghShimSource(realGh), { mode: 0o755 });
    chmodSync(file, 0o755);
    return { ok: true, path: file, realGh, warnings };
}

function pathOrder(deps: ShimDeps, shim: string, realGh: string): boolean {
    const env = deps.env ?? process.env;
    const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const shimDir = path.dirname(shim);
    const realDir = path.dirname(realGh);
    const shimIndex = dirs.indexOf(shimDir);
    const realIndex = dirs.indexOf(realDir);
    if (shimIndex < 0) return false;
    return realIndex < 0 || shimIndex < realIndex;
}

export interface ShimStatus {
    path: string;
    installed: boolean;
    current: boolean;
    realGh: string | null;
    /** Real gh recorded in the installed shim. */
    recordedRealGh: string | null;
    pathOrderOk: boolean;
}

export function ghShimStatus(deps: ShimDeps = {}): ShimStatus {
    const file = defaultGhShimPath(deps);
    const exists = deps.exists ?? ((f: string) => existsSync(f));
    const read = deps.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
    if (!exists(file) || !isShimFile(deps, file)) {
        return { path: file, installed: false, current: false, realGh: null, recordedRealGh: null, pathOrderOk: false };
    }
    const installed = read(file);
    const recorded = /const REAL_GH = "([^"]*)";/.exec(installed)?.[1] ?? null;
    const realGh = recorded && exists(recorded) ? recorded : findRealGh(deps);
    return {
        path: file,
        installed: true,
        current: installed === ghShimSource(realGh),
        realGh,
        recordedRealGh: recorded,
        pathOrderOk: realGh ? pathOrder(deps, file, realGh) : false,
    };
}
