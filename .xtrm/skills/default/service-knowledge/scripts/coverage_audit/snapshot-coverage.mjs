import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = join(HERE, 'results-coverage');
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

const GROUPS = [
  { id: 'session-authority', theme: 'Session-window authority: generated YAML/JSON authority + materialized profiles + golden fixtures + verifier scripts + session/holiday test family. No service owns the generator or artifact files.',
    prefixes: ['config/session_authority.yaml', 'config/session_authority.gen.json', 'config/session_map.yaml', 'config/cme_holiday_trade_dates.yaml', 'config/session_profiles.json', 'analytics/shared/session_authority.py', 'scripts/data/generate_session_authority_golden.py', 'scripts/data/generate_session_authority_json.py', 'scripts/data/generate_session_profiles.py', 'scripts/data/generate_session_profiles_golden.py', 'scripts/data/verify_session_authority_empirical.py', 'tests/test_session_authority.py', 'tests/test_session_authority_4dox1.py', 'tests/test_session_profile_contract.py', 'tests/test_session_profiles.py', 'tests/test_session_map_v8i92.py', 'tests/test_holiday_session_kind_mmd2398.py', 'tests/test_cme_holiday_trade_dates_mmd2448.py', 'tests/fixtures/session_authority_golden.json', 'tests/fixtures/session_profiles_golden.json'] },
  { id: 'linnsoft-rollover', theme: 'LinnSoft rollover subsystem: fetch job + schedule feed module + shadow report + host timer units + Rithmic/continuous research data + cutover/runbook/audit docs + linnsoft test family. Tables owned by migrating-schema, env by infrastructure-platform, read path by computing-snapshots; the fetch cadence and timer have no owner.',
    prefixes: ['analytics/feeds/linnsoft_rollover.py', 'scripts/data/fetch_linnsoft_rollover.py', 'scripts/data/linnsoft_shadow_report.py', 'analytics/shared/linnsoft_continuous/', 'analytics/shared/linnsoft_rithmic/', 'docs/audits/mmd-2466-linnsoft-shadow-report.md', 'docs/operations/linnsoft-roll-authority-cutover.md', 'docs/operations/linnsoft-roll-authority-runbook.md', 'docs/ops/jira-roll-tickets-audit-2026-10-18.md', 'docs/ops/roll-lane-report-2026-10-18.html', 'tests/test_linnsoft_roll_authority.py', 'tests/test_linnsoft_rollover.py', 'tests/test_linnsoft_rollover_calendar.py', 'tests/test_linnsoft_shadow_report.py', 'tests/test_mmd2576_linnsoft_interim_resolver.py', 'tests/test_fetch_linnsoft_rollover.py', 'tests/fixtures/linnsoft/'] },
  { id: 'mcp-v2-impl', theme: 'Five core MCP serving implementation modules. serving-mcp-tools documents their behavior in detail but its registry territory lists only the server entrypoint, docstrings and helpers.',
    prefixes: ['api/mcp_v2/candles.py', 'api/mcp_v2/correlations.py', 'api/mcp_v2/discovery.py', 'api/mcp_v2/market.py', 'api/mcp_v2/volatility.py'] },
  { id: 'shared-libs', theme: 'Pure analytics shared libraries consumed by the snapshot feed and API (rollover, calendars, sanitizer, STIR resolver). computing-snapshots owns sibling files from the same directory (session.py, config.py, data.py) but not these.',
    prefixes: ['analytics/shared/rollover.py', 'analytics/shared/rollover_predictor.py', 'analytics/shared/rollover_rule_sources.py', 'analytics/shared/trade_calendar.py', 'analytics/shared/exchange_calendar.py', 'analytics/shared/ohlcv_sanitize.py', 'analytics/shared/candle_series.py', 'analytics/shared/cme_holidays.py', 'analytics/spreads/stir_resolver.py'] },
  { id: 'bars-reference', theme: 'Bar-builder reference implementation + golden vectors + research script supporting the MMD-2369 shadow bar pipeline documented in ingesting-tick-data.',
    prefixes: ['analytics/bars/', 'data/golden/bar_builder_es_slice_2026-10-07.json', 'data/golden/bar_builder_es_zn_2026-10-07.json', 'scripts/research/bar_builder_golden_vectors.py', 'tests/test_bar_builder_golden.py', 'tests/test_bar_builder_reference.py', 'tests/test_bar_builder_slice.py'] },
  { id: 'toolchoice-eval', theme: 'MCP tool-choice eval harness (runner, scorer, tasks, baseline, README) plus its unit test. The manual workflow file and Makefile target are referenced from repository-ci-cd prose but no territory covers the harness files.',
    prefixes: ['evals/mcp_tool_choice/', 'tests/unit/test_mcp_tool_choice_scorer.py'] },
  { id: 'doc-gates', theme: 'MCP doc-gates check run by the LIGHT lane (scripts/ci/light.sh, owned by repository-ci-cd) plus its contract test.',
    prefixes: ['scripts/mcp_doc_gates.py', 'tests/test_mcp_doc_gates.py'] },
  { id: 'accumulator-config', theme: 'Generated accumulator config artifact plus its generator. ingesting-tick-data documents both (schema v4 volume caps) but its territory lists neither path.',
    prefixes: ['config/accumulator_config.json', 'scripts/data/generate_accumulator_config.py'] },
  { id: 'ops-linnsoft-timer', theme: 'LinnSoft rollover host timer: fetch wrapper, timer installer, systemd service+timer. Part of the fetch-to-cutover LinnSoft chain.',
    prefixes: ['scripts/ops/linnsoft-rollover.sh', 'scripts/ops/install-mmd-linnsoft-rollover-timer.sh', 'scripts/ops/systemd/mmd-linnsoft-rollover.service', 'scripts/ops/systemd/mmd-linnsoft-rollover.timer'] },
  { id: 'ops-swap', theme: 'Ingestor swap/guardian operator scripts (swap scheduler, swap CLI, guardian daemon + units). The swap procedure is documented in ingesting-tick-data.',
    prefixes: ['scripts/ops/schedule_ingestor_swap.sh', 'scripts/ops/ingestor_swap.py', 'scripts/ops/ingestor_guardian.py', 'scripts/ops/systemd/mmd-ingestor-guardian.service', 'scripts/ops/systemd/mmd-ingestor-guardian.timer'] },
  { id: 'ops-scripts', theme: 'Operator-run job scripts (mmd_ops/mmd_deploy CLIs, backfill and audit jobs, observability rejection helper, entrypoint, healthcheck, retention, title audit, byte-offset). Each has its own docs or runbook; no single runtime-service owner.',
    prefixes: ['scripts/'] },
  { id: 'tests-rest', theme: 'Contract and regression tests for behaviors owned by existing services. Tests are evidence, not service territory, except the CI-contract tests repository-ci-cd already lists.',
    prefixes: ['tests/'] },
  { id: 'docs-rest', theme: 'Audit reports, proposals and operational notes. Point-in-time evidence, not living service surface.',
    prefixes: ['docs/'] },
  { id: 'root-misc', theme: 'Repo-root config, dependency pins, deploy notes, TUI lockfile, Rust README/fixtures, SCID golden fixture, Eurex source bundle. No runtime-service owner.',
    prefixes: [] },
];

function groupOf(f) {
  for (const g of GROUPS) {
    if (g.prefixes.some(p => p.endsWith('/') ? f.startsWith(p) : f === p)) return g.id;
  }
  if (f.startsWith('tests/')) return 'tests-rest';
  if (f.startsWith('docs/')) return 'docs-rest';
  if (f.startsWith('scripts/')) return 'ops-scripts';
  if (!f.includes('/')) return 'root-misc';
  return 'root-misc';
}

async function main() {
  await mkdir(OUTDIR, { recursive: true });
  const headRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const changed = execFileSync('git', ['diff', '--name-only', BASE_REF, headRef], { cwd: REPO, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  const reg = JSON.parse(await readFile(join(REPO, '.xtrm/skills/market-data/service-knowledge/service-registry.json'), 'utf8'));
  const byId = {};
  let routedCount = 0;
  for (const f of changed) {
    const owners = Object.entries(reg.services).filter(([, s]) => (s.territory || []).some(t => projMatch(f, t))).map(([sid]) => sid);
    if (owners.length) { routedCount += 1; continue; }
    const gid = groupOf(f);
    (byId[gid] ||= { id: gid, files: [], ownedFiles: 0 });
    byId[gid].files.push(f);
    if (owners.length) { byId[gid].ownedFiles += 1; (byId[gid].ownerHits ||= {})[f] = owners; }
  }
  const themeById = Object.fromEntries(GROUPS.map(g => [g.id, g.theme]));
  const groups = Object.values(byId).map(g => ({ ...g, count: g.files.length, theme: themeById[g.id] || '' })).sort((a, b) => a.id < b.id ? -1 : 1);
  const snap = { ranAt: new Date().toISOString(), repo: REPO, baseRef: BASE_REF, headRef, changedCount: changed.length, routedCount, unroutedCount: changed.length - routedCount, groups };
  await writeFile(join(OUTDIR, 'coverage-files.json'), JSON.stringify(snap, null, 2));
  console.log(`SNAPSHOT groups=${groups.length} changed=${changed.length} head=${headRef.slice(0, 12)}`);
  for (const g of groups) console.log(`  ${g.id}: files=${g.count} owned=${g.ownedFiles || 0}`);
}

await main();
