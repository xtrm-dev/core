#!/usr/bin/env node
// Claude Code statusLine for xt sessions. Rendering only reads a bounded
// git-status cache; a detached, lease-protected refresh performs slow git work.
// Lane 1 (hook cleanup): beads counts were severed — no beads-status-cache
// import, no bd subprocess, git-only line. The retired beads-status-cache.mjs
// payload stays on disk until lane 2 but nothing live imports it.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
         statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join, basename, relative, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
// Lane 1: zero beads-status-cache.mjs imports. runFast + resolveMainRoot are
// inlined below (pure git/fs helpers, no bd dependency).

// Inlined lane-1 replacements for the retired beads-status-cache.mjs helpers.
// Pure git/fs only — no bd subprocess, no beads cache paths.
const GIT_TIMEOUT_MS = 250;
function runFast(cwd, cmd, timeout = GIT_TIMEOUT_MS) {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout }).trim();
  } catch {
    return null;
  }
}

function resolveMainRoot(cwd) {
  const override = process.env.XTRM_BEADS_CACHE_ROOT;
  if (override) return override;
  let current = resolve(cwd);
  while (true) {
    const dotGit = join(current, '.git');
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return current;
      if (stat.isFile()) {
        const match = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const gitDir = resolve(current, match[1].trim());
          const marker = `${sep}.git${sep}worktrees${sep}`;
          const markerIndex = gitDir.indexOf(marker);
          return markerIndex >= 0 ? gitDir.slice(0, markerIndex) : current;
        }
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

const CACHE_DIR = process.env.XTRM_STATUSLINE_CACHE_DIR ?? tmpdir();
const GIT_CACHE_TTL = 5000;
const REFRESH_LEASE_MS = 5000;
const RENDER_BUDGET_MS = 50;
const MAX_CACHE_BYTES = 16 * 1024;
const REFRESH_LOCK = join(CACHE_DIR, 'xtrm-sl-refresh.lock');

const R = '\x1b[0m', B = '\x1b[1m', B_ = '\x1b[22m', D = '\x1b[2m';
// XTRM accent for the model name (#9a8bff) — mirrors the pi custom-footer.
const EXT = '\x1b[38;2;154;139;255m';

function cacheFile(cwd) {
  const key = createHash('md5').update(cwd).digest('hex').slice(0, 8);
  return join(CACHE_DIR, `xtrm-sl-git-${key}.json`);
}

function readGitCache(file) {
  try {
    if (statSync(file).size > MAX_CACHE_BYTES) return null;
    const cache = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(cache?.ts) || !cache?.data || typeof cache.data !== 'object') return null;
    return { data: cache.data, fresh: Date.now() - cache.ts < GIT_CACHE_TTL };
  } catch {
    return null;
  }
}

function writeGitCache(file, data) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ts: Date.now(), data }), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    try { unlinkSync(temp); } catch {}
  }
}

function takeRefreshLease() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const fd = openSync(REFRESH_LOCK, 'wx', 0o600);
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(REFRESH_LOCK).mtimeMs > REFRESH_LEASE_MS) {
        unlinkSync(REFRESH_LOCK);
        return takeRefreshLease();
      }
    } catch {}
    return false;
  }
}

function startRefresh(cwd, started) {
  if (Date.now() - started >= RENDER_BUDGET_MS || !takeRefreshLease()) return;
  try {
    const child = spawn(process.execPath, [process.argv[1], '--refresh', cwd], {
      cwd, detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
  } catch {
    try { unlinkSync(REFRESH_LOCK); } catch {}
  }
}

function formatTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function getProvider(modelId) {
  return modelId?.includes('/') ? modelId.split('/')[0] : null;
}

function getModelName(modelId) {
  return modelId?.includes('/') ? modelId.split('/')[1] : modelId ?? null;
}

function fallbackGit(cwd) {
  return {
    displayDir: cwd.replace(process.env.HOME ?? '', '~'), branch: null, gitFlags: '',
  };
}

function computeGit(cwd, mainRoot) {
  const repoRoot = runFast(cwd, 'git rev-parse --show-toplevel');
  // Linked worktrees (.xtrm/worktrees/*): full paths are unreadably long —
  // collapse to <mainrepo>@<worktree-basename>.
  const wtRel = repoRoot && mainRoot ? relative(mainRoot, repoRoot) : '';
  const displayDir = wtRel && !wtRel.startsWith('..') && wtRel.includes('.xtrm/worktrees')
    ? `${basename(mainRoot)}@${basename(repoRoot)}`
    : repoRoot
      ? (() => { const rel = relative(repoRoot, cwd) || '.'; return rel === '.' ? basename(repoRoot) : `${basename(repoRoot)}/${rel}`; })()
      : cwd.replace(process.env.HOME ?? '', '~');

  let branch = null, gitFlags = '';
  if (repoRoot) {
    branch = runFast(cwd, 'git -c core.useBuiltinFSMonitor=false branch --show-current')
      || runFast(cwd, 'git rev-parse --short HEAD');
    const porcelain = runFast(cwd, 'git -c core.useBuiltinFSMonitor=false --no-optional-locks status --porcelain') ?? '';
    let modified = false, staged = false, deleted = false;
    for (const line of porcelain.split('\n').filter(Boolean)) {
      if (/^ M|^AM|^MM/.test(line)) modified = true;
      if (/^A |^M /.test(line)) staged = true;
      if (/^ D|^D /.test(line)) deleted = true;
    }
    gitFlags = (modified ? '*' : '') + (staged ? '+' : '') + (deleted ? '-' : '');
    const aheadBehind = runFast(cwd, 'git -c core.useBuiltinFSMonitor=false --no-optional-locks rev-list --left-right --count @{upstream}...HEAD');
    if (aheadBehind) {
      const [behind, ahead] = aheadBehind.split(/\s+/).map(Number);
      if (ahead > 0 && behind > 0) gitFlags += '↕';
      else if (ahead > 0) gitFlags += '↑';
      else if (behind > 0) gitFlags += '↓';
    }
  }
  return { displayDir, branch, gitFlags, mainRoot };
}

function refresh(cwd) {
  try {
    const mainRoot = resolveMainRoot(cwd);
    writeGitCache(cacheFile(cwd), computeGit(cwd, mainRoot));
    // Lane 1: no beads refresh — fetchCompact/writeBeadsCache severed.
  } finally {
    try { unlinkSync(REFRESH_LOCK); } catch {}
  }
}

function readEffortSetting() {
  try {
    return JSON.parse(readFileSync(join(process.env.HOME ?? '', '.claude', 'settings.json'), 'utf8'))?.effortLevel ?? null;
  } catch {
    return null;
  }
}

function render(ctx, git) {
  const pct = ctx?.context_window?.used_percentage;
  const windowSize = ctx?.context_window?.context_window_size ?? 200000;
  const modelId = ctx?.model?.id ?? null;
  const provider = getProvider(modelId);
  const modelName = ctx?.model?.display_name ?? getModelName(modelId) ?? 'no-model';
  const { displayDir, branch, gitFlags } = git;

  // Bold + default fg (not dim) so the path/branch reads first.
  let head = B + displayDir + B_;
  if (branch) head += B + `(${gitFlags ? `${branch} ${gitFlags}` : branch})` + B_;
  const pctStr = pct != null ? `${pct.toFixed(1)}%` : '?';
  let modelStr = modelName;
  if (provider) modelStr = `(${provider}) ${modelStr}`;
  const effort = ctx?.effort_level ?? ctx?.thinking_level ?? readEffortSetting();
  if (effort) modelStr += ` ${B}${effort}${B_}`;

  // Lane 1: git-only line — no beads segment.
  process.stdout.write(`${head} ${D}${pctStr}/${formatTokens(windowSize)}${R} ${EXT}${modelStr}${R}\n`);
}

if (process.argv[2] === '--refresh') {
  refresh(process.argv[3] || process.cwd());
} else {
  const started = Date.now();
  let ctx = {};
  try { ctx = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const cwd = ctx?.workspace?.current_dir ?? process.cwd();
  const gitCached = readGitCache(cacheFile(cwd));
  const git = gitCached?.data ?? fallbackGit(cwd);

  render(ctx, git);

  if (!gitCached?.fresh) startRefresh(cwd, started);
}
