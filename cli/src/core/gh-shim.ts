/**
 * The `gh` shim for agent processes (CORE-2528).
 *
 * Agents keep typing plain `gh`. For an agent process (SUBSTRATE_HOLDER or
 * XTRM_ROLE set) the shim intercepts four things and passes everything else to
 * the real binary unchanged:
 *
 *   gh pr create ...   -> the real gh, its output teed byte for byte, then a
 *                         best-effort `sb provenance attach` link to the Issue
 *                         the PR body marker (or the title and branch) names.
 *                         Refused before the create runs when the marker's
 *                         run= is a tmux session id ($N), quoted or not, which
 *                         some other worker shares (CORE-2619, CORE-2622)
 *   gh pr edit ...     -> the same marker refusal (an edit sets the same body),
 *                         then the real gh; refused for the reviewer role
 *   gh pr review ...   -> `xt identity review-post` (formal review, commit_id
 *                         pinned to the reviewed head, reviewer App token)
 *   gh pr merge ...    -> `xt identity merge-check` first, then the real gh with
 *                         --match-head-commit, then a github-merge Journal ref
 *   gh pr close        -> refused for the reviewer role
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

function xtJson(args, timeoutMs) {
  const answer = xtQuiet(args, timeoutMs);
  let data = null;
  try { data = JSON.parse(answer.stdout || 'null'); } catch (error) { data = null; }
  return { status: answer.status, data, stderr: (answer.stderr || '').trim() };
}

function xtQuiet(args, timeoutMs) {
  const options = { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' };
  if (timeoutMs) { options.timeout = timeoutMs; options.killSignal = 'SIGKILL'; }
  return spawnSync('xt', args, options);
}


// CORE-2607: the Issue-to-PR link after a create. The budget bounds the whole
// post-create step, so a slow or absent sb can never hold gh pr create open.
const LINK_TIMEOUT_MS = 6000;

// CORE-2619: a marker's run= must be the worker's own runtime session id. A tmux
// session id ($N — what XTRM_SESSION_ID carries) is shared by every window in
// that tmux session, so it attributes nothing. xt owns marker parsing (fences,
// the last marker wins), so ask it and refuse BEFORE the pull request exists.
// Fail-open by design: only a refusal blocks, never a slow or absent xt.
const MARKER_CHECK_TIMEOUT_MS = 4000;

/**
 * The budget actually used. XTRM_MARKER_CHECK_TIMEOUT_MS exists so a test can
 * exercise the timeout branch without sleeping through the production budget;
 * it is clamped, so a stray value cannot turn the check into a slow blocker.
 */
function markerCheckTimeoutMs() {
  const raw = Number(process.env.XTRM_MARKER_CHECK_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return MARKER_CHECK_TIMEOUT_MS;
  return Math.min(Math.max(Math.round(raw), 50), 60_000);
}

/** The refusal for this create's marker, or '' when the create may proceed. */
function markerRefusal(args) {
  const checked = xtJson(
    ['identity', 'marker-check', '--argv', JSON.stringify(args), '--cwd', process.cwd()],
    markerCheckTimeoutMs(),
  );
  if (checked.status !== 0 || !checked.data) return '';
  return typeof checked.data.refusal === 'string' ? checked.data.refusal : '';
}

/**
 * Refuse a write verb whose effective marker carries a tmux session id in run=.
 * One message for create and edit (CORE-2622): the create refusal is pointless
 * if a pr edit can set the same marker a command later. Fail-open on an absent,
 * slow or broken xt, like the link step: only a refusal blocks.
 */
function refuseBadRun(args, action) {
  const refused = markerRefusal(args);
  if (refused) die('refusing to ' + action + ': ' + refused);
}

/**
 * Ask xt to attach the created PR to its Issue. At most one warning line on
 * stderr, and never a change to the create's own output or exit code: an
 * attached link with a caveat (its commits could not be linked) still prints
 * that caveat.
 */
function linkCreatedPr(stdout, args) {
  const linked = xtJson(
    ['identity', 'pr-link', '--argv', JSON.stringify(args), '--stdout', stdout, '--cwd', process.cwd()],
    LINK_TIMEOUT_MS,
  );
  const warning = linked.data && typeof linked.data.warning === 'string' ? linked.data.warning : '';
  if (linked.status === 0 && linked.data && linked.data.attached === true) {
    if (warning) process.stderr.write('gh (xtrm): ' + warning + '\\n');
    return;
  }
  process.stderr.write('gh (xtrm): ' + (warning || 'the new pull request was not linked to its Substrate Issue') + '\\n');
}

/**
 * gh pr create, teed. The real gh owns stdout, stderr and the exit code; the link
 * runs only after exit 0 and its failure is one warning line. The help verb
 * creates nothing and prints no URL, so it takes the plain pass-through.
 */
function createAndLink(real, args) {
  if (args.indexOf('--help') >= 0 || args.indexOf('-h') >= 0) { pass(real, args); return; }
  refuseBadRun(args, 'create the pull request');
  const run = spawnSync(real, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (run.error) die('cannot run ' + real + ': ' + run.error.message);
  const out = typeof run.stdout === 'string' ? run.stdout : '';
  const err = typeof run.stderr === 'string' ? run.stderr : '';
  // Byte-identical: each stream goes out unchanged, before any warning of ours.
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  const status = run.status === null ? 1 : run.status;
  if (status === 0) {
    try {
      linkCreatedPr(out, args);
    } catch (error) {
      process.stderr.write('gh (xtrm): the new pull request was not linked to its Substrate Issue: '
        + ((error && error.message) || String(error)) + '\\n');
    }
  }
  process.exit(status);
}


// The real gh flag tables (CORE-2528 delta review #2). A value flag consumes the
// next argument; a boolean flag does not. Short forms differ per verb: -r is
// --request-changes for pr review and --rebase for pr merge.


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

  // CORE-2607: a create happens for any agent role; the link is not a permission.
  if (verb === 'create') createAndLink(real, args);

  // CORE-2622: a pr edit sets the same body, so it gets the same refusal.
  // An edit that carries no body never reaches the marker parser's work.
  // The role gate must run HERE: pass() exits the process, so an edit that
  // reached the shared gate below would never come back (review 6pgu, #921).
  if (verb === 'edit') {
    if (isRestricted(roleOf())) die('the reviewer role may not change PR state (gh pr edit)');
    refuseBadRun(args, 'edit the pull request');
    pass(real, args);
  }


  if (verb === 'review') {
    // One parser for the target (CORE-2530 review): the CLI resolves the same gh
    // argv the shim received, so a hook and a shim can never pick different PRs.
    const resolved = xtJson(['identity', 'resolve-gh', '--argv', JSON.stringify(args), '--cwd', process.cwd()]);
    if (!resolved.data || !resolved.data.repo || !resolved.data.pr) {
      die('cannot tell which pull request to review: ' + (resolved.stderr || 'pass a number, a URL or --repo'));
    }
    const forwarded = Array.isArray(resolved.data.forwarded) ? resolved.data.forwarded : [];
    process.exit(xtPassthrough(['identity', 'review-post', '--repo', resolved.data.repo, '--pr', String(resolved.data.pr), ...forwarded]));
  }

  if (verb === 'merge') {
    if (isRestricted(roleOf())) die('the reviewer role may not merge; ask the worker or coordinator');
    // Flag-gated and OFF by default (CORE-2528 rev 4 R3): with the guard off the
    // command passes through untouched, before any resolution can fail.
    if (!mergeGuardOn()) {
      process.stderr.write('gh (xtrm): merge guard is off (XTRM_MERGE_GUARD is not set); the merge is not checked\\n');
      pass(real, args);
    }
    const checked = xtJson(['identity', 'merge-check', '--gh-args', JSON.stringify(args), '--cwd', process.cwd(), '--json']);
    if (checked.status !== 0 || !checked.data || checked.data.allow !== true) {
      const message = (checked.data && checked.data.message) || checked.stderr || 'the merge guard refused this merge';
      process.stderr.write(message + '\\n');
      process.exit(1);
    }
    // CORE-2590 review finding 1: an unknown Issue state allows the merge, and
    // this shim is the path agents use, so the one-line warning must be written
    // here; the JSON decision alone is discarded by the caller.
    if (checked.data.issueLookup === 'unknown') {
      const ref = checked.data.issueRef || 'this pull request';
      const why = checked.data.issueLookupDetail || 'reason not reported';
      process.stderr.write('gh (xtrm): the Issue was not verified for ' + ref + ': ' + why + '; merging anyway\\n');
    }
    const repo = checked.data.repo;
    const pr = checked.data.pr;
    // The pin must survive the override path: a decision without a head (the
    // coordinator override, App absent) still needs the resolved head, and
    // resolve-gh is the same resolver that produced the repo and PR above.
    let head = checked.data.head || '';
    if (!head) {
      const resolved = xtJson(['identity', 'resolve-gh', '--argv', JSON.stringify(args), '--cwd', process.cwd()]);
      head = (resolved.data && resolved.data.head) || '';
    }
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

  // The verb test comes FIRST: gh pr view and gh issue list must not pay a role
  // lookup (CORE-2528 batch 5).
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
