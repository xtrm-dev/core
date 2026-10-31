import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = join(HERE, 'results-prs');
const REPO = process.env.SK_REPO || process.cwd();
const BASE_REF = '780d4afb8f5c1bbb18e29b1c6f664eece61a1762';

function globToRegExp(pat) {
  let i = 0; const n = pat.length; let out = '';
  while (i < n) {
    const c = pat[i];
    if (c === '*' && pat[i + 1] === '*') {
      if (pat[i + 2] === '/') { out += '(.*/)?'; i += 3; }
      else { out += '.*'; i += 2; }
    } else if (c === '*') { out += '[^/]*'; i += 1; }
    else if ('.+()|^$\\{}[]'.includes(c)) { out += '\\' + c; i += 1; }
    else if (c === '?') { out += '[^/]'; i += 1; }
    else { out += c; i += 1; }
  }
  return new RegExp(out + '$');
}

function baseOf(pat) {
  const m = pat.search(/[*?[]/);
  return (m === -1 ? pat : pat.slice(0, m)).replace(/\/$/, '');
}

function projMatch(path, pattern) {
  if (globToRegExp(pattern).test(path)) return true;
  const base = baseOf(pattern);
  return !!base && (path === base || path.startsWith(base + '/'));
}

function sh(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

async function main() {
  await mkdir(OUTDIR, { recursive: true });
  const headRef = sh(['rev-parse', 'HEAD']);
  const reg = JSON.parse(await readFile(join(REPO, '.xtrm/skills/market-data/service-knowledge/service-registry.json'), 'utf8'));
  const ownersOf = (f) => Object.entries(reg.services).filter(([, s]) => (s.territory || []).some(t => projMatch(f, t))).map(([sid]) => sid);
  const merges = sh(['log', '--merges', '--format=%H%x01%s', BASE_REF + '..' + headRef]).split('\n').filter(Boolean);
  const prs = [];
  const covered = new Set();
  for (const line of merges) {
    const tab = line.indexOf('\x01');
    const h = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const m = subject.match(/^Merge pull request #(\d+) from \S+/);
    if (!m) continue;
    const files = sh(['diff', '--name-only', h + '^1', h]).split('\n').map(s => s.trim()).filter(Boolean);
    files.forEach(f => covered.add(f));
    const ownerCounts = {};
    for (const f of files) for (const o of ownersOf(f)) ownerCounts[o] = (ownerCounts[o] || 0) + 1;
    const isTestDoc = (f) => f.startsWith('tests/') || f.startsWith('docs/') || f.startsWith('data/') || f.startsWith('.xtrm/') || f.indexOf('/') === -1;
    const core = files.filter(f => !isTestDoc(f));
    const coreOwners = {};
    for (const f of core) for (const o of ownersOf(f)) coreOwners[o] = (coreOwners[o] || 0) + 1;
    const TITLE_VOTE = [
      [/hmm|volatility|correlation|stir|amt|outright|snapshot.feed|naked.level|eod|continuous|rollover.calendar/i, 'computing-snapshots'],
      [/mcp|api|serving|u\.s\.dollar|switch.risk|correlation.matrix/i, 'serving-market-api'],
      [/mcp.tool|tool.choice|doc.gate|contract|ci |ci-|semgrep|bandit|workflow/i, 'repository-ci-cd'],
      [/allowlist|candidate|release|promot/i, 'releasing-mcp-candidate'],
      [/migrat|alembic|schema/i, 'migrating-schema'],
      [/rust|ingestor|bar|scid|questdb|swap|guardian/i, 'ingesting-tick-data'],
      [/data.feed|ohlcv|yfinance|instrument/i, 'ingesting-ohlcv'],
      [/derived.state|derived.publisher|accumulator/i, 'publishing-derived-state'],
      [/linnsoft/i, ''],
      [/session.authority|session.profile|holiday/i, ''],
    ];
    let titleVote = '';
    for (const [re, svc] of TITLE_VOTE) {
      if (re.test(subject) && svc && coreOwners[svc]) { titleVote = svc; break; }
    }
    prs.push({ pr: '#' + m[1], merge: h.slice(0, 12), title: subject, files, fileCount: files.length, ownerCounts, coreFiles: core, coreOwners, titleVote });
  }
  const rangeFiles = sh(['diff', '--name-only', BASE_REF, headRef]).split('\n').map(s => s.trim()).filter(Boolean);
  const direct = rangeFiles.filter(f => !covered.has(f));
  const dOwner = {};
  for (const f of direct) for (const o of ownersOf(f)) dOwner[o] = (dOwner[o] || 0) + 1;
  if (direct.length) prs.push({ pr: 'direct', merge: '', title: 'Non-PR direct commits on master in range', files: direct, fileCount: direct.length, ownerCounts: dOwner });
  const snap = { ranAt: new Date().toISOString(), repo: REPO, baseRef: BASE_REF, headRef, prCount: prs.length, rangeFiles: rangeFiles.length, prs };
  await writeFile(join(OUTDIR, 'pr-files.json'), JSON.stringify(snap, null, 2));
  console.log(`SNAPSHOT prs=${prs.length} rangeFiles=${rangeFiles.length} head=${headRef.slice(0, 12)}`);
  for (const p of prs) {
    const top = Object.entries(p.ownerCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(',');
    console.log(`  ${p.pr} files=${p.fileCount} owners={${top}} :: ${p.title.slice(0, 80)}`);
  }
}

await main();
