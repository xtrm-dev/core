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

// A JavaScript line comment: the shim is a .js file, so a `#` line here would be
// a SyntaxError on every agent `gh` call. The detection substring stays stable
// for files written by earlier versions.
export const GH_SHIM_MARKER = '// xtrm-gh-agent-shim v1';
export const GH_SHIM_FINGERPRINT = 'xtrm-gh-agent-shim v1';
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
        return read(file).slice(0, 512).includes(GH_SHIM_FINGERPRINT);
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

const MARKER = '${GH_SHIM_FINGERPRINT}';
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


// Flags whose NEXT argument is a value: a bare number after one of these is a
// value, not the PR ("gh pr review 12 --body 42" must not look like PR 42).
const VALUE_FLAGS = new Set([
  '--body', '-b', '--body-file', '-F', '--title', '-t', '--subject', '-s',
  '--match-head-commit', '--branch', '-B', '--base', '--head', '-H', '--label',
  '--assignee', '-a', '--reviewer', '-r', '--milestone', '-m', '--repo', '-R',
]);

/**
 * Split a gh argument list into its repository, its positional target and the
 * remaining arguments. The target is a number, a PR URL or a branch name; the
 * repository comes from --repo/-R (separate or --repo=value).
 */
function parseTarget(rest) {
  let repo = '';
  const kept = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--repo' || arg === '-R') {
      repo = rest[i + 1] || repo;
      i += 1;
      continue;
    }
    if (arg.indexOf('--repo=') === 0) { repo = arg.slice('--repo='.length); continue; }
    if (arg.indexOf('-R=') === 0) { repo = arg.slice('-R='.length); continue; }
    kept.push(arg);
  }
  let target = '';
  const forwarded = [];
  for (let i = 0; i < kept.length; i += 1) {
    const arg = kept[i];
    if (arg === '--') { forwarded.push(...kept.slice(i + 1)); break; }
    if (arg.charAt(0) === '-') {
      forwarded.push(arg);
      if (VALUE_FLAGS.has(arg) && i + 1 < kept.length) { forwarded.push(kept[i + 1]); i += 1; }
      continue;
    }
    if (!target && (/^\\d+$/.test(arg) || /^https?:\\/\\//.test(arg))) {
      target = arg;
    } else {
      forwarded.push(arg);
    }
  }
  return { repo, target, forwarded };
}

/**
 * The role this process acts as, through the xt role map: a raw XTRM_ROLE of
 * "pr-reviewer" or "seconder" resolves to reviewer, and the shim honours that,
 * not the string.
 */
function resolvedRole() {
  const raw = (process.env.XTRM_ROLE || '').trim();
  const answer = xtQuiet(['identity', 'role', '--json']);
  if (answer.status === 0) {
    try {
      const parsed = JSON.parse(answer.stdout);
      if (parsed && (parsed.role === null || typeof parsed.role === 'string')) return parsed.role;
    } catch (error) { /* fall back to the raw value */ }
  }
  return raw || null;
}

function targetPr(target) {
  if (!target) return 0;
  const url = /^https?:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/pull\\/(\\d+)/.exec(target);
  if (url) return Number(url[1]);
  return /^\\d+$/.test(target) ? Number(target) : 0;
}

function viewInfo(view) {
  if (view.status !== 0) return { repo: '', pr: 0, head: '' };
  let info;
  try { info = JSON.parse(view.stdout); } catch (error) { return { repo: '', pr: 0, head: '' }; }
  const match = /^https?:\\/\\/github\\.com\\/([^/]+\\/[^/]+)\\/pull\\/(\\d+)$/.exec(info.url || '');
  return { repo: match ? match[1] : '', pr: match ? Number(match[2]) : 0, head: info.headRefOid || '' };
}

function lookupPr(real, target) {
  if (targetPr(target)) return { repo: '', pr: targetPr(target), head: '' };
  return viewInfo(capture(real, ['pr', 'view', target, '--json', 'number,url,headRefOid']));
}

function currentPr(real) {
  return viewInfo(capture(real, ['pr', 'view', '--json', 'number,url,headRefOid']));
}

function mergeGuardOn() {
  const value = (process.env.XTRM_MERGE_GUARD || '').trim().toLowerCase();
  return value === 'on' || value === '1' || value === 'true' || value === 'yes';
}

function isMergeApi(args) {
  return /\\/merge(\\s|$)/.test(args.join(' '));
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
  // Resolved through the xt role map, so pr-reviewer/seconder are reviewers too.
  const role = resolvedRole();

  if (verb === 'review') {
    // A real parser: the target may be a number, a URL or a branch; --repo may be
    // --repo=o/r; and "42" after --body is a value, not the PR.
    const parsed = parseTarget(args.slice(2));
    let repo = parsed.repo;
    let pr = targetPr(parsed.target);
    if (!repo || !pr) {
      const looked = parsed.target ? lookupPr(real, parsed.target) : currentPr(real);
      repo = repo || looked.repo;
      pr = pr || looked.pr;
    }
    if (!repo || !pr) die('cannot tell which pull request to review: pass a number, a URL or --repo');
    process.exit(xtPassthrough(['identity', 'review-post', '--repo', repo, '--pr', String(pr), ...parsed.forwarded]));
  }

  if (verb === 'merge') {
    if (role === 'reviewer') die('the reviewer role may not merge; ask the worker or coordinator');
    const parsed = parseTarget(args.slice(2));
    let repo = parsed.repo;
    let pr = targetPr(parsed.target);
    let head = '';
    if (!repo || !pr || !head) {
      const looked = parsed.target ? lookupPr(real, parsed.target) : currentPr(real);
      repo = repo || looked.repo;
      pr = pr || looked.pr;
      head = looked.head;
      if (pr && !head) {
        const view = capture(real, ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid']);
        if (view.status === 0) { try { head = JSON.parse(view.stdout).headRefOid || ''; } catch (error) { head = ''; } }
      }
    }
    if (!repo || !pr) die('cannot tell which pull request to merge: pass a number, a URL or --repo');
    // Flag-gated and OFF by default (CORE-2528 rev 4 R3): installing the shim must
    // not refuse every agent merge on a machine whose Apps are not set up.
    if (!mergeGuardOn()) {
      process.stderr.write('gh (xtrm): merge guard is off (XTRM_MERGE_GUARD is not set); ' + repo + '#' + pr + ' is not checked\\n');
      pass(real, args);
    }
    const checked = xtPassthrough(['identity', 'merge-check', '--repo', repo, '--pr', String(pr)]);
    if (checked !== 0) process.exit(checked);
    const pinned = args.some((arg) => arg === '--match-head-commit');
    const mergeArgs = pinned || !head ? args : [...args, '--match-head-commit', head];
    const merged = spawnSync(real, mergeArgs, { stdio: 'inherit' });
    if (merged.error) die('cannot run ' + real + ': ' + merged.error.message);
    const status = merged.status === null ? 1 : merged.status;
    if (status === 0) {
      const recorded = xtQuiet(['identity', 'merge-record', '--repo', repo, '--pr', String(pr), '--head', head]);
      if (recorded.status !== 0) {
        process.stderr.write('gh (xtrm): merged, but the Journal receipt failed: ' + ((recorded.stderr || '').trim() || 'unknown error') + '\\n');
      }
    }
    process.exit(status);
  }

  if (role === 'reviewer' && (verb === 'close' || verb === 'edit' || verb === 'ready' || verb === 'reopen')) {
    die('the reviewer role may not change PR state (gh pr ' + verb + ')');
  }

  // A merge through the API is the same merge: refuse it for the reviewer too.
  if (role === 'reviewer' && args[0] === 'api' && isMergeApi(args.slice(1))) {
    die('the reviewer role may not merge (gh api .../merge)');
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
