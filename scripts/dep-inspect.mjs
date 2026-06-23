#!/usr/bin/env node
// dependency_update_case.json inspector — deterministic layer (spec §6, §7).
// No LLM. Computes everything a parser/scanner/registry can: direct/transitive,
// prod/dev scope, release age + cooldown, OSV advisory match, SECURITY_FORCED,
// usage hints, preliminary verdict. Emits schema xtrm.dependency_update_case.v0.
//
// v0.1 approximations (documented, not hidden):
//   - EPSS not available offline -> epss_bucket derived from CVSS (>=9 high, >=7 med, else low).
//   - KEV/public-exploit feeds not wired -> known_exploited/public_exploit default false
//     unless passed via input. SECURITY_FORCED thus rests on CVSS>=9 AND runtime_reachable,
//     OR explicit input flags. (PR #152 lesson: we query the TO version only, so a stale
//     transitive FROM-version entry that's already remediated at root no longer blocks.)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCHEMA_VERSION = 'xtrm.dependency_update_case.v0';
const COOLDOWN_HOURS = 7 * 24; // policy D2

// ---------- pure helpers ----------

export function semverParts(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function updateKind(from, to, ecosystem) {
  if (ecosystem === 'github-actions') {
    return /^[0-9a-f]{40}$/i.test(String(to)) ? 'sha' : 'unknown';
  }
  const a = semverParts(from), b = semverParts(to);
  if (!a || !b) return 'unknown';
  if (b[0] !== a[0]) return 'major';
  if (b[1] !== a[1]) return 'minor';
  return 'patch';
}

// dependency_kind + scope from a parsed manifest (package.json shape).
export function classifyFromManifest(name, manifest) {
  const dep = manifest?.dependencies || {};
  const dev = manifest?.devDependencies || {};
  const peer = manifest?.peerDependencies || {};
  const optional = manifest?.optionalDependencies || {};
  const isDirect = Object.prototype.hasOwnProperty.call(dep, name)
    || Object.prototype.hasOwnProperty.call(dev, name)
    || Object.prototype.hasOwnProperty.call(peer, name)
    || Object.prototype.hasOwnProperty.call(optional, name);
  const dependency_kind = isDirect ? 'direct' : 'transitive';
  let scope = 'unknown';
  if (Object.prototype.hasOwnProperty.call(dep, name)) scope = 'runtime';
  else if (Object.prototype.hasOwnProperty.call(dev, name)) scope = guessDevScope(name);
  else if (Object.prototype.hasOwnProperty.call(peer, name)) scope = 'runtime';
  else if (isDirect) scope = guessDevScope(name);
  return { dependency_kind, scope };
}

// dev-dep build-vs-test heuristic from the package name.
const TEST_TOOLS = ['vitest', 'jest', 'mocha', 'ava', 'playwright', '@playwright', 'cypress'];
const BUILD_TOOLS = ['vite', 'webpack', 'rollup', 'esbuild', 'turbo', 'swc', 'tsc', 'typescript'];
function guessDevScope(name) {
  if (TEST_TOOLS.some((t) => name === t || name.startsWith(t + '/') || name.startsWith(t + '-'))) return 'test';
  if (BUILD_TOOLS.some((t) => name === t || name.startsWith(t + '/') || name.startsWith(t + '-'))) return 'build';
  return 'dev';
}

export function cooldownStatus(releaseAgeHours, registryStatus, hasSecurityForced) {
  if (registryStatus === 'yanked' || registryStatus === 'suspicious') return 'blocked';
  if (hasSecurityForced) return 'bypass_security';
  if (releaseAgeHours == null) return 'unknown';
  return releaseAgeHours >= COOLDOWN_HOURS ? 'cleared' : 'active';
}

// SECURITY_FORCED — policy §4.1. v0.1: CVSS>=9 AND runtime_reachable, OR explicit flags.
export function isSecurityForced(advisory, ctx) {
  if (ctx?.known_exploited) return true;
  if (ctx?.public_exploit_available) return true;
  if (ctx?.cisaKev?.includes(advisory.id)) return true;
  const cvss = advisory.severity_cvss;
  if (cvss != null && cvss >= 9.0 && ctx?.runtime_reachable === 'yes') return true;
  return false;
}

export function epssBucketFromCvss(cvss) {
  if (cvss == null) return 'unknown';
  if (cvss >= 9) return 'high';
  if (cvss >= 7) return 'medium';
  return 'low';
}

// Extract a numeric base score from OSV CVSS values. Some sources append a
// numeric score, but standard CVSS_V3 vectors are pure metric strings such as
// `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`; compute those directly.
export function cvssFromVector(scoreStr) {
  if (scoreStr == null) return null;
  const raw = String(scoreStr).trim();
  const numeric = raw.match(/^(?:score:)?\s*(\d+(?:\.\d+)?)$/i) || raw.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*$/);
  if (numeric && !raw.startsWith('CVSS:')) {
    const n = Number(numeric[1]);
    return n >= 0 && n <= 10 ? n : null;
  }
  if (raw.startsWith('CVSS:3.')) return cvss3BaseScore(raw);
  return null;
}

function cvssMetric(vector, key) {
  const found = vector.split('/').find((part) => part.startsWith(`${key}:`));
  return found ? found.slice(key.length + 1) : null;
}

function cvssRoundUp(n) {
  return Math.ceil((n - 1e-10) * 10) / 10;
}

function cvss3BaseScore(vector) {
  const scope = cvssMetric(vector, 'S');
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[cvssMetric(vector, 'AV')];
  const ac = { L: 0.77, H: 0.44 }[cvssMetric(vector, 'AC')];
  const prValue = cvssMetric(vector, 'PR');
  const pr = scope === 'C'
    ? { N: 0.85, L: 0.68, H: 0.5 }[prValue]
    : { N: 0.85, L: 0.62, H: 0.27 }[prValue];
  const ui = { N: 0.85, R: 0.62 }[cvssMetric(vector, 'UI')];
  const c = { H: 0.56, L: 0.22, N: 0 }[cvssMetric(vector, 'C')];
  const i = { H: 0.56, L: 0.22, N: 0 }[cvssMetric(vector, 'I')];
  const a = { H: 0.56, L: 0.22, N: 0 }[cvssMetric(vector, 'A')];
  if ([av, ac, pr, ui, c, i, a].some((value) => value == null) || !['U', 'C'].includes(scope)) return null;

  const iscBase = 1 - ((1 - c) * (1 - i) * (1 - a));
  const impact = scope === 'U'
    ? 6.42 * iscBase
    : 7.52 * (iscBase - 0.029) - 3.25 * ((iscBase - 0.02) ** 15);
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const score = scope === 'U'
    ? Math.min(impact + exploitability, 10)
    : Math.min(1.08 * (impact + exploitability), 10);
  return cvssRoundUp(score);
}

// GHSA qualitative severity -> approximate numeric (v0.1). OSV now serves CVSS_V4
// pure vectors with no trailing base score, so the qualitative label is the
// pragmatic signal. CRITICAL maps >=9 (SECURITY_FORCED if runtime-reachable);
// HIGH/MODERATE/LOW stay advisory under policy §4.1.
const QUALITATIVE_CVSS = { CRITICAL: 9.5, HIGH: 8.5, MODERATE: 5.5, LOW: 2.5 };
export function cvssFromQualitative(label) {
  if (!label) return null;
  return QUALITATIVE_CVSS[String(label).toUpperCase()] ?? null;
}

// resolve a CVSS base score from an OSV vuln entry: prefer a CVSS_V3 vector's
// trailing base score, then fall back to the GHSA qualitative label.
export function cvssFromEntry(v) {
  const v3 = (v.severity || []).find((s) => s.type === 'CVSS_V3' || s.type === 'CVSS_V2');
  if (v3) {
    const n = cvssFromVector(v3.score);
    if (n != null) return n;
  }
  return cvssFromQualitative(v?.database_specific?.severity);
}

// walk verdict rules (policy §5 / skill taxonomy). returns preliminary_verdict.status.
export function preliminaryVerdict(caseFields) {
  const { security, usage, supply_chain } = caseFields;
  if (security.malicious_package_signal === 'strong'
    || supply_chain.registry_status === 'yanked'
    || supply_chain.registry_status === 'suspicious'
    || usage.github_actions_blast_radius === 'high') {
    return { status: 'blocked', reason: 'supply-chain / blast-radius signal' };
  }
  const forced = security.advisories.some((a) => a.security_forced);
  if (forced) return { status: 'security_forced', reason: 'SECURITY_FORCED advisory present' };
  if (security.advisories.length > 0) {
    return { status: 'research_required', reason: `${security.advisories.length} non-forced advisory(ies) need triage` };
  }
  if (supply_chain.cooldown_status === 'active') {
    return { status: 'cooldown', reason: `release < ${COOLDOWN_HOURS}h old, no security urgency` };
  }
  if (supply_chain.cooldown_status === 'cleared') {
    return { status: 'safe_candidate', reason: 'cooldown cleared, no advisories' };
  }
  return { status: 'unknown', reason: 'insufficient deterministic signal' };
}

export function caseId(seed) {
  return 'dep-' + createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

// ---------- I/O (network + filesystem) ----------

async function fetchJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} -> ${res.status}`);
  return res.json();
}

// Query OSV for advisories affecting `version` of (name, ecosystem).
export async function queryOsv(name, ecosystem, version) {
  const body = JSON.stringify({ package: { name, ecosystem: osvEcosystem(ecosystem) }, version });
  const data = await fetchJson('https://api.osv.dev/v1/query', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  return (data.vulns || []).map((v) => mapOsvVuln(v, name, ecosystem));
}

function osvEcosystem(ecosystem) {
  return ({ npm: 'npm', pypi: 'PyPI', maven: 'Maven', cargo: 'crates.io', go: 'Go' }[ecosystem]) || ecosystem;
}

function supportsOsvEcosystem(ecosystem) {
  return ['npm', 'pypi', 'maven', 'cargo', 'go'].includes(ecosystem);
}

function mapOsvVuln(v, name, ecosystem) {
  const cvss = cvssFromEntry(v);
  const fixedIn = (v.affected || [])
    .find((a) => a?.package?.name === name && a?.package?.ecosystem === osvEcosystem(ecosystem))
    ?.ranges?.[0]?.events?.find((e) => e.fixed)?.fixed || null;
  const source = v.id.startsWith('GHSA') ? 'ghsa'
    : v.id.startsWith('CVE') ? 'cve_nvd' : 'osv';
  return { id: v.id, source, severity_cvss: cvss, fixed_in: fixedIn };
}

// npm registry: publish time + deprecation/yank signal for `version`.
export async function queryNpmRegistry(name, version) {
  const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  const published = meta?.time?.[version] || null;
  const deprecated = Boolean(meta?.versions?.[version]?.deprecated);
  return { published, deprecated };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------- orchestration ----------

export async function buildCase(input) {
  const pkg = input.package;
  if (!pkg?.name || !pkg?.ecosystem || !pkg?.from_version || !pkg?.to_version) {
    throw new Error('input.package requires name, ecosystem, from_version, to_version');
  }
  const manifest = input.manifest_path ? readJson(input.manifest_path) : (input.manifest || null);
  const cls = classifyFromManifest(pkg.name, manifest);

  // advisories for the TO version (deterministic; stale FROM entries excluded).
  let advisories = [];
  if (Array.isArray(input.advisories)) advisories = input.advisories;
  else if (supportsOsvEcosystem(pkg.ecosystem)) advisories = await queryOsv(pkg.name, pkg.ecosystem, pkg.to_version);

  const ctx = {
    runtime_reachable: input.runtime_reachable_hint ?? 'unknown',
    known_exploited: Boolean(input.known_exploited),
    public_exploit_available: Boolean(input.public_exploit_available),
    cisaKev: input.cisa_kev || [],
  };
  advisories = advisories.map((a) => ({ ...a, security_forced: isSecurityForced(a, ctx) }));

  // release age + registry status
  let releaseAgeHours = null, registryStatus = 'unknown';
  if (pkg.ecosystem === 'npm') {
    try {
      const reg = await queryNpmRegistry(pkg.name, pkg.to_version);
      if (reg.published) releaseAgeHours = Math.max(0, (Date.now() - Date.parse(reg.published)) / 3.6e6);
      registryStatus = reg.deprecated ? 'deprecated' : 'normal';
    } catch { registryStatus = 'unknown'; }
  }

  const hasForced = advisories.some((a) => a.security_forced);
  const cooldown = cooldownStatus(releaseAgeHours, registryStatus, hasForced);
  const maxCvss = advisories.reduce((m, a) => (a.severity_cvss != null ? Math.max(m, a.severity_cvss) : m), null);

  const fields = {
    trigger: { kind: input.trigger?.kind || 'manual_bump', repo: input.trigger?.repo || null, pr: input.trigger?.pr ?? null, branch: input.trigger?.branch || null },
    package: { name: pkg.name, ecosystem: pkg.ecosystem, from_version: pkg.from_version, to_version: pkg.to_version, update_kind: updateKind(pkg.from_version, pkg.to_version, pkg.ecosystem), dependency_kind: cls.dependency_kind, scope: cls.scope },
    supply_chain: { release_age_hours: releaseAgeHours != null ? Math.round(releaseAgeHours) : null, cooldown_status: cooldown, registry_status: registryStatus, maintainer_change_detected: Boolean(input.maintainer_change), install_script_changed: Boolean(input.install_script_changed), artifact_repo_mismatch: input.artifact_repo_mismatch || 'unknown' },
    security: { advisories, known_exploited: ctx.known_exploited, public_exploit_available: ctx.public_exploit_available, epss_bucket: epssBucketFromCvss(maxCvss), malicious_package_signal: input.malicious_package_signal || 'none' },
    usage: { affected_services: input.affected_services || [], affected_files: input.affected_files || [], runtime_reachable: ctx.runtime_reachable, publicly_exposed_path: input.publicly_exposed_path || 'unknown', github_actions_blast_radius: input.github_actions_blast_radius || 'n/a' },
  };
  const preliminary_verdict = preliminaryVerdict({ security: fields.security, usage: fields.usage, supply_chain: fields.supply_chain });

  return {
    schema: SCHEMA_VERSION,
    case_id: caseId([input.trigger?.repo || '', pkg.name, pkg.from_version, pkg.to_version, fields.trigger.kind].join('|')),
    ...fields,
    preliminary_verdict,
  };
}

async function main() {
  let raw;
  if (process.argv.includes('--input')) {
    const i = process.argv.indexOf('--input');
    raw = readFileSync(process.argv[i + 1], 'utf8');
  } else {
    raw = await readStdin();
  }
  if (!raw.trim()) {
    process.stderr.write('usage: dep-inspect.mjs --input case-input.json   (or pipe JSON on stdin)\n');
    process.exit(2);
  }
  const input = JSON.parse(raw);
  const result = await buildCase(input);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { process.stderr.write(`dep-inspect failed: ${e.message}\n`); process.exit(1); });
