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


// The real gh flag tables (CORE-2528 delta review #2). A value flag consumes the
// next argument; a boolean flag does not. Short forms differ per verb: -r is
// --request-changes for pr review and --rebase for pr merge.
const MERGE_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '-R', '--repo', '--match-head-commit']);
const REVIEW_VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-R', '--repo']);
const EDIT_VALUE_FLAGS = new Set(['-b', '--body', '-t', '--title', '-B', '--base', '-R', '--repo', '--add-label', '--remove-label', '--add-assignee', '--add-reviewer', '--milestone']);

function valueFlags(verb) {
  if (verb === 'review') return REVIEW_VALUE_FLAGS;
  if (verb === 'edit') return EDIT_VALUE_FLAGS;
  return MERGE_VALUE_FLAGS;
}

/**
 * Split a gh argument list into its repository, its positional target and the
 * remaining arguments. The target is a number, a PR URL or a branch name; the
 * repository comes from --repo/-R (separate, =value or attached -Rvalue).
 */
function parseTarget(rest, verb) {
  const values = valueFlags(verb);
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
    if (arg.indexOf('-R') === 0 && arg.length > 2) { repo = arg.slice(2); continue; }
    kept.push(arg);
  }
  let target = '';
  const forwarded = [];
  for (let i = 0; i < kept.length; i += 1) {
    const arg = kept[i];
    if (arg === '--') { forwarded.push(...kept.slice(i + 1)); break; }
    if (arg.charAt(0) === '-') {
      forwarded.push(arg);
      if (values.has(arg) && i + 1 < kept.length) { forwarded.push(kept[i + 1]); i += 1; }
      continue;
    }
    // The first bare word is the target: a number, a URL or a branch name.
    if (!target) {
      target = arg;
    } else {
      forwarded.push(arg);
    }
  }
  return { repo, target, forwarded };
}

/** gh's review short flags, translated to the long options xt defines. */
function translateReviewFlags(args) {
  const map = { '-a': '--approve', '-c': '--comment', '-r': '--request-changes', '-b': '--body', '-F': '--body-file' };
  const takesValue = new Set(['-b', '-F', '--body', '--body-file']);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (takesValue.has(arg)) {
      // The next token is a VALUE: never rewrite it, even when it looks like a
      // flag (gh pr review 5 --body -c means the body is "-c").
      out.push(map[arg] || arg);
      if (i + 1 < args.length) { out.push(args[i + 1]); i += 1; }
      continue;
    }
    if (arg.indexOf('--body=') === 0 || arg.indexOf('--body-file=') === 0) { out.push(arg); continue; }
    out.push(map[arg] || arg);
  }
  return out;
}

const RESTRICTED_WHEN_UNRESOLVED = '__role_lookup_failed__';

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
    } catch (error) { /* fall through to the fail-closed branch */ }
  }
  // A failed lookup with a role set fails closed: restricted, not operator.
  return raw ? RESTRICTED_WHEN_UNRESOLVED : null;
}

/** Restricted means "may not merge, close, edit, reopen or ready". */
function isRestricted(role) {
  return role === 'reviewer' || role === RESTRICTED_WHEN_UNRESOLVED;
}

function targetPr(target) {
  if (!target) return 0;
  const url = /^https?:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/pull\\/(\\d+)/.exec(target);
  if (url) return Number(url[1]);
  return /^\\d+$/.test(target) ? Number(target) : 0;
}

/**
 * The reviewer role may read GitHub, not write it. Allow only a plain GET: no
 * method other than GET, no field or input flags, no graphql, no issues endpoint
 * (closing a PR through /issues is the same write).
 */
function reviewerApiVerdict(args) {
  // ALLOWLIST, not a denylist (CORE-2528 batch 4): one endpoint argument plus a
  // closed set of read-only flags. Any other argument, in any spelling
  // (-fevent=..., -XPOST, --field=..., --input=..., glued or =), is refused.
  const booleanFlags = new Set(['--paginate', '--slurp', '-i', '--include', '--silent']);
  const valueFlags = new Set(['-q', '--jq', '--cache']);
  // CHOICE: a small allowlist for headers, not a denylist of dangerous ones. A
  // denylist lets -H X-HTTP-Method-Override:DELETE (or any future override)
  // through; an allowlist keeps the reviewer to representation headers only.
  const allowedHeaders = ['accept:', 'x-github-api-version:'];
  let endpoint = '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (booleanFlags.has(arg)) continue;
    if (valueFlags.has(arg)) {
      if (i + 1 >= args.length) return 'gh api ' + arg + ' needs a value';
      i += 1;
      continue;
    }
    if (arg === '-H' || arg === '--header') {
      const header = (args[i + 1] || '').trim().toLowerCase();
      if (!header) return 'gh api ' + arg + ' needs a value';
      if (!allowedHeaders.some((allowed) => header.indexOf(allowed) === 0)) {
        return 'the reviewer role may only send Accept or X-GitHub-Api-Version headers';
      }
      i += 1;
      continue;
    }
    if (arg.indexOf('--header=') === 0) {
      const header = arg.slice('--header='.length).trim().toLowerCase();
      if (!allowedHeaders.some((allowed) => header.indexOf(allowed) === 0)) {
        return 'the reviewer role may only send Accept or X-GitHub-Api-Version headers';
      }
      continue;
    }
    if (arg.indexOf('--jq=') === 0 || arg.indexOf('--cache=') === 0) continue;
    if (arg.charAt(0) === '-') return 'the reviewer role may only GET through gh api (refused flag ' + arg + ')';
    if (endpoint) return 'the reviewer role may only call one endpoint through gh api';
    endpoint = arg;
  }
  if (!endpoint) return 'the reviewer role needs an endpoint';
  if (/graphql/i.test(endpoint)) return 'the reviewer role may not run gh api graphql';
  if (/\\/issues(\\/|$)/i.test(endpoint)) return 'the reviewer role may not write through the issues endpoint';
  if (/\\/merge(\\/|$)/i.test(endpoint)) return 'the reviewer role may not merge (gh api .../merge)';
  return null;
}

function viewInfo(view) {
  if (view.status !== 0) return { repo: '', pr: 0, head: '' };
  let info;
  try { info = JSON.parse(view.stdout); } catch (error) { return { repo: '', pr: 0, head: '' }; }
  const match = /^https?:\\/\\/github\\.com\\/([^/]+\\/[^/]+)\\/pull\\/(\\d+)$/.exec(info.url || '');
  return { repo: match ? match[1] : '', pr: match ? Number(match[2]) : 0, head: info.headRefOid || '' };
}

function repoFromUrl(target) {
  const match = /^https?:\\/\\/github\\.com\\/([^/]+)\\/([^/]+)\\/pull\\/(\\d+)/.exec(target || '');
  return match ? { repo: match[1] + '/' + match[2], pr: Number(match[3]) } : null;
}

/** The current repository, for a bare PR number. */
function currentRepo(real) {
  const view = capture(real, ['repo', 'view', '--json', 'nameWithOwner']);
  if (view.status !== 0) return '';
  try {
    const parsed = JSON.parse(view.stdout);
    return typeof parsed.nameWithOwner === 'string' ? parsed.nameWithOwner : '';
  } catch (error) {
    return '';
  }
}

/**
 * Resolve the repository and PR the user means. A URL carries both; a number
 * needs --repo or the current repository; a branch needs --repo and is looked up
 * as a PR. Nothing here falls back to the cwd PR when a target was named.
 */
function resolveTarget(real, parsed) {
  const fromUrl = repoFromUrl(parsed.target);
  if (fromUrl) return { repo: parsed.repo || fromUrl.repo, pr: fromUrl.pr, head: '' };
  const number = targetPr(parsed.target);
  if (number) {
    return { repo: parsed.repo || currentRepo(real), pr: number, head: '' };
  }
  if (parsed.target) {
    const repo = parsed.repo || currentRepo(real);
    if (!repo) return { repo: '', pr: 0, head: '' };
    const view = capture(real, ['pr', 'view', parsed.target, '--repo', repo, '--json', 'number,headRefOid']);
    if (view.status !== 0) return { repo: '', pr: 0, head: '' };
    try {
      const info = JSON.parse(view.stdout);
      return { repo, pr: Number(info.number) || 0, head: info.headRefOid || '' };
    } catch (error) {
      return { repo: '', pr: 0, head: '' };
    }
  }
  const here = currentPr(real);
  return { repo: parsed.repo || here.repo, pr: here.pr, head: here.head };
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


/**
 * The verb of a pr command, skipping global flags that may precede it
 * (CORE-2528 batch 4). gh pr -R o/r merge 5 must reach the merge route, not
 * the real gh.
 */
function findVerb(args) {
  // Root-level global flags may precede pr (gh accepts gh -R o/r pr merge 5),
  // and more may follow it. Skip global flags and their values in both places.
  let repo = '';
  let i = 0;
  let sawPr = false;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-R' || arg === '--repo') { repo = args[i + 1] || repo; i += 2; continue; }
    if (arg.indexOf('--repo=') === 0) { repo = arg.slice('--repo='.length); i += 1; continue; }
    if (arg.indexOf('-R=') === 0) { repo = arg.slice('-R='.length); i += 1; continue; }
    if (arg.indexOf('-R') === 0 && arg.length > 2) { repo = arg.slice(2); i += 1; continue; }
    if (arg === 'pr') { sawPr = true; i += 1; break; }
    if (arg.charAt(0) === '-') { i += 1; continue; }
    return { verb: undefined, index: -1, repo };
  }
  if (!sawPr) return { verb: undefined, index: -1, repo };
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-R' || arg === '--repo') { repo = args[i + 1] || repo; i += 2; continue; }
    if (arg.indexOf('--repo=') === 0) { repo = arg.slice('--repo='.length); i += 1; continue; }
    if (arg.indexOf('-R=') === 0) { repo = arg.slice('-R='.length); i += 1; continue; }
    if (arg.indexOf('-R') === 0 && arg.length > 2) { repo = arg.slice(2); i += 1; continue; }
    if (arg.charAt(0) === '-') { i += 1; continue; }
    return { verb: arg, index: i, repo };
  }
  return { verb: undefined, index: -1, repo };
}

function main() {
  const args = process.argv.slice(2);
  const real = findRealGh();
  if (!isAgent()) { if (!real) die('real gh not found on PATH'); pass(real, args); }
  if (!real) die('real gh not found on PATH (the xtrm shim excludes itself)');
  const found = findVerb(args);
  const verb = found.verb;
  // Resolved lazily: gh issue list must not pay for a role lookup (0.17 s).
  let roleCache;
  const roleOf = () => {
    if (roleCache === undefined) roleCache = resolvedRole();
    return roleCache;
  };

  if (verb === 'review') {
    // A real parser: the target may be a number, a URL or a branch; --repo may be
    // --repo=o/r; a number after a boolean flag is the target, not a value.
    const parsed = parseTarget(args.slice(found.index + 1), 'review');
    const looked = resolveTarget(real, { repo: parsed.repo || found.repo, target: parsed.target });
    const repo = looked.repo;
    const pr = looked.pr;
    if (!repo || !pr) die('cannot tell which pull request to review: pass a number, a URL or --repo');
    // gh's short flags (-a, -c, -r, -b, -F) are gh's own; map them to xt's options.
    const forwarded = translateReviewFlags(parsed.forwarded);
    process.exit(xtPassthrough(['identity', 'review-post', '--repo', repo, '--pr', String(pr), ...forwarded]));
  }

  if (verb === 'merge') {
    if (isRestricted(roleOf())) die('the reviewer role may not merge; ask the worker or coordinator');
    // Flag-gated and OFF by default (CORE-2528 rev 4 R3): with the guard off the
    // command passes through untouched, before any resolution can fail.
    if (!mergeGuardOn()) {
      process.stderr.write('gh (xtrm): merge guard is off (XTRM_MERGE_GUARD is not set); the merge is not checked\\n');
      pass(real, args);
    }
    const parsed = parseTarget(args.slice(found.index + 1), 'merge');
    const looked = resolveTarget(real, { repo: parsed.repo || found.repo, target: parsed.target });
    let repo = looked.repo;
    let pr = looked.pr;
    let head = looked.head;
    if (pr && !head) {
      const view = capture(real, ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid']);
      if (view.status === 0) { try { head = JSON.parse(view.stdout).headRefOid || ''; } catch (error) { head = ''; } }
    }
    if (!repo || !pr) die('cannot tell which pull request to merge: pass a number, a URL or --repo');
    const checked = xtPassthrough(['identity', 'merge-check', '--repo', repo, '--pr', String(pr)]);
    if (checked !== 0) process.exit(checked);
    const pinned = args.some((arg) => arg === '--match-head-commit' || arg.indexOf('--match-head-commit=') === 0);
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

  // The verb test comes FIRST: gh pr view and gh issue list must not pay a
  // role lookup (CORE-2528 batch 5).
  if ((verb === 'close' || verb === 'edit' || verb === 'ready' || verb === 'reopen') && isRestricted(roleOf())) {
    die('the reviewer role may not change PR state (gh pr ' + verb + ')');
  }

  if (args[0] === 'api' && isRestricted(roleOf())) {
    const verdict = reviewerApiVerdict(args.slice(1));
    if (verdict) die(verdict);
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
