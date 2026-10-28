#!/usr/bin/env node
// Claude Code statusLine for xt sessions. Rendering only reads a bounded
// git-status cache; a detached, lease-protected refresh performs slow git work.
// Lane 1 (hook cleanup): beads counts were severed — no beads-status-cache
// import, no bd subprocess, git-only line. The retired beads-status-cache.mjs
// payload stays on disk until lane 2 but nothing live imports it.
//
// Layout and figures match the pi footer (packages/pi-extensions/extensions/
// custom-footer/hud.ts); change them together:
//   <worktree>  ⎇ <branch><flags> · <used>%/<window> · (<provider>) <model> <effort> · <N>% cache [(last M%)]
// The cache figure is the median hit rate of the last CACHE_WINDOW responses, with
// "(last M%)" when the latest response is CACHE_MISS_GAP points below it. Claude's
// statusline input only carries the latest response (context_window.current_usage),
// so this script keeps a small per-session window in the cache dir. Session token
// totals (pi's ↑ ↓) are not in the input and are not printed here.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
         statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { join, basename, dirname, resolve, sep } from 'node:path';
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

const CACHE_WINDOW = 10;
const CACHE_MISS_GAP = 20;
const MAX_NAME = 24, MAX_BRANCH = 32, MAX_MODEL = 28;
const SEPARATOR = ' · ';

// Grayscale ladder like the pi footer: weight and brightness carry emphasis, no accent colour.
const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m', M = '\x1b[90m';

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

// Same formatting as the pi footer's formatTokens.
function formatTokens(count) {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 1000) return count.toString();
  if (count < 10000) return count % 1000 === 0 ? `${count / 1000}k` : `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function truncateLabel(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function getProvider(modelId) {
  return modelId?.includes('/') ? modelId.split('/')[0] : null;
}

function getModelName(modelId) {
  return modelId?.includes('/') ? modelId.split('/')[1] : modelId ?? null;
}

function fallbackGit(cwd) {
  return {
    displayDir: basename(cwd) || cwd, branch: null, gitFlags: '',
  };
}

function computeGit(cwd, mainRoot) {
  const repoRoot = runFast(cwd, 'git rev-parse --show-toplevel');
  // The worktree name is the identifier, as in the pi footer: `core` for the main
  // checkout, `core-xt-claude-foo` for a linked worktree.
  const displayDir = basename(repoRoot || cwd) || cwd;

  let branch = null, gitFlags = '';
  if (repoRoot) {
    branch = runFast(cwd, 'git -c core.useBuiltinFSMonitor=false branch --show-current');
    if (!branch) {
      const head = runFast(cwd, 'git rev-parse --short HEAD');
      branch = head ? `detached@${head}` : 'detached';
    }
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const side = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function cacheStateFile(sessionId) {
  return join(CACHE_DIR, `xtrm-sl-cache-${createHash('md5').update(String(sessionId)).digest('hex').slice(0, 8)}.json`);
}

// Per-session window of response hit rates. The input only carries the latest
// response, so each new response (a changed usage signature) adds one rate.
function readCacheWindow(ctx) {
  const usage = ctx?.context_window?.current_usage;
  const sessionId = ctx?.session_id;
  let state = { sig: '', reported: false, rates: [] };
  const file = sessionId ? cacheStateFile(sessionId) : null;
  if (file) {
    try {
      if (statSync(file).size <= 4096) {
        const stored = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(stored?.rates)) state = { sig: String(stored.sig ?? ''), reported: !!stored.reported, rates: stored.rates.filter(Number.isFinite).slice(-CACHE_WINDOW) };
      }
    } catch {}
  }
  if (usage && typeof usage === 'object') {
    const input = side(usage.input_tokens), written = side(usage.cache_creation_input_tokens), read = side(usage.cache_read_input_tokens);
    const prompt = input + written + read;
    const sig = `${input}:${side(usage.output_tokens)}:${written}:${read}`;
    if (prompt > 0 && sig !== state.sig) {
      state = { sig, reported: state.reported || written + read > 0, rates: [...state.rates, Math.round((read / prompt) * 1000) / 10].slice(-CACHE_WINDOW) };
      if (file) {
        try {
          mkdirSync(CACHE_DIR, { recursive: true });
          const temp = `${file}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
          renameSync(temp, file);
        } catch {}
      }
    }
  }
  // A provider that reports no cache fields at all must not surface a rate.
  return state.reported && state.rates.length > 0 ? state.rates : null;
}

function cacheLabel(rates) {
  if (!rates) return null;
  const rate = Math.max(0, Math.min(100, median(rates)));
  const text = `${Math.round(rate)}% cache`;
  const last = Math.max(0, Math.min(100, rates[rates.length - 1]));
  return rate - last >= CACHE_MISS_GAP ? `${text} (last ${Math.round(last)}%)` : text;
}

function render(ctx, git) {
  const pct = ctx?.context_window?.used_percentage;
  const windowSize = ctx?.context_window?.context_window_size;
  const modelId = ctx?.model?.id ?? null;
  const provider = getProvider(modelId);
  const modelName = ctx?.model?.display_name ?? getModelName(modelId) ?? 'no-model';
  const { displayDir, branch, gitFlags } = git;
  const segments = [];

  // Git group: worktree name upright, branch muted, same as the pi footer.
  const name = truncateLabel(displayDir, MAX_NAME);
  segments.push(branch ? `${name}  ${M}⎇ ${truncateLabel(branch, MAX_BRANCH)}${gitFlags}${R}` : name);

  // Context group: omitted when neither the percentage nor the window is known.
  const knownPct = typeof pct === 'number' && Number.isFinite(pct);
  const windowText = windowSize > 0 ? formatTokens(windowSize) : null;
  if (knownPct || windowText) {
    const label = `${knownPct ? `${pct.toFixed(1)}%` : '?'}${windowText ? `/${windowText}` : ''}`;
    const style = knownPct && pct > 90 ? B : knownPct && pct > 70 ? B + M : D;
    segments.push(`${style}${label}${R}`);
  }

  let modelStr = truncateLabel(modelName, MAX_MODEL);
  if (provider) modelStr = `(${provider}) ${modelStr}`;
  const effort = ctx?.effort?.level ?? ctx?.effort_level ?? ctx?.thinking_level ?? readEffortSetting();
  segments.push(`${M}${modelStr}${R}${effort ? ` ${D}${effort}${R}` : ''}`);

  const cache = cacheLabel(readCacheWindow(ctx));
  if (cache) segments.push(`${D}${cache}${R}`);

  process.stdout.write(`${segments.join(SEPARATOR)}\n`);
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
