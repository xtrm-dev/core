#!/usr/bin/env node
// Composite-action orchestrator for updating-dependencies dep-review.
// Dependency-free: uses node fetch + dynamic import of scripts/dep-inspect.mjs.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const outDir = path.resolve(env.RUNNER_TEMP || process.cwd(), 'dep-review');
mkdirSync(outDir, { recursive: true });

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePrTitle(title) {
  if (!title) return {};
  // Dependabot common forms: "Bump vite from 8.0.13 to 8.0.16", "Bumps hono from 4.0.0 to 4.1.0".
  const m = title.match(/\bBumps?\s+([^\s]+)\s+from\s+([^\s]+)\s+to\s+([^\s]+)/i);
  return m ? { name: m[1], from: m[2], to: m[3] } : {};
}

function splitCsv(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function actionVerdict(prelim) {
  switch (prelim?.status) {
    case 'security_forced': return 'SECURITY_FORCED';
    case 'blocked': return 'BLOCKED';
    case 'cooldown': return 'COOLDOWN';
    case 'safe_candidate': return 'PASS';
    case 'research_required': return 'PASS_WITH_NOTES';
    default: return 'UNKNOWN';
  }
}

function labelFor(verdict) {
  return {
    PASS: 'dependency-review/pass',
    PASS_WITH_NOTES: 'dependency-review/notes',
    COOLDOWN: 'dependency-review/cooldown',
    SECURITY_FORCED: 'dependency-review/security-forced',
    BLOCKED: 'dependency-review/blocked',
    UNKNOWN: 'dependency-review/incomplete',
  }[verdict] || 'dependency-review/incomplete';
}

function shouldFail(verdict) {
  return verdict === 'SECURITY_FORCED' || verdict === 'BLOCKED';
}

function renderTemplate(template, c, verdict, label) {
  const forced = c.security.advisories.filter((a) => a.security_forced).length;
  const replacements = {
    verdict,
    'package.name': c.package.name,
    'package.from_version': c.package.from_version,
    'package.to_version': c.package.to_version,
    'package.ecosystem': c.package.ecosystem,
    'package.dependency_kind': c.package.dependency_kind,
    'package.scope': c.package.scope,
    case_id: c.case_id,
    summary: `${c.package.name} ${c.package.from_version} -> ${c.package.to_version}; preliminary verdict ${verdict}.`,
    verdict_reason: c.preliminary_verdict.reason,
    advisory_count: String(c.security.advisories.length),
    security_forced_count: String(forced),
    known_exploited: String(c.security.known_exploited),
    public_exploit_available: String(c.security.public_exploit_available),
    epss_bucket: c.security.epss_bucket,
    malicious_package_signal: c.security.malicious_package_signal,
    release_age_hours: String(c.supply_chain.release_age_hours ?? 'unknown'),
    cooldown_status: c.supply_chain.cooldown_status,
    registry_status: c.supply_chain.registry_status,
    required_gate: shouldFail(verdict)
      ? `This check FAILS the PR until remediated. Label: ${label}`
      : `No merge block from this check. Label: ${label}`,
    follow_ups: c.security.advisories.length
      ? c.security.advisories.map((a) => `- ${a.id}: cvss=${a.severity_cvss ?? 'unknown'}, SECURITY_FORCED=${a.security_forced}`).join('\n')
      : '- none',
  };
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, key) => replacements[key] ?? 'unknown');
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'xtrm-dep-review',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

async function ensureLabel(repo, label, token, color) {
  const [owner, name] = repo.split('/');
  try {
    await postJson(`https://api.github.com/repos/${owner}/${name}/labels`, token, {
      name: label,
      color,
      description: 'xtrm dependency review verdict',
    });
  } catch (e) {
    if (!String(e.message).startsWith('422 ')) throw e; // already exists is ok
  }
}

async function commentAndLabel(repo, pr, comment, label, token) {
  const [owner, name] = repo.split('/');
  await postJson(`https://api.github.com/repos/${owner}/${name}/issues/${pr}/comments`, token, { body: comment });
  try {
    const color = label.endsWith('/blocked') || label.endsWith('/security-forced') ? 'b60205'
      : label.endsWith('/cooldown') ? 'fbca04'
      : label.endsWith('/incomplete') ? 'd4c5f9'
      : '0e8a16';
    await ensureLabel(repo, label, token, color);
    await postJson(`https://api.github.com/repos/${owner}/${name}/issues/${pr}/labels`, token, { labels: [label] });
  } catch (e) {
    console.warn(`warning: failed to apply label ${label}: ${e.message}`);
  }
}

function setOutput(name, value) {
  if (env.GITHUB_OUTPUT) {
    writeFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`, { flag: 'a' });
  }
}

async function main() {
  const detected = parsePrTitle(env.PR_TITLE || '');
  const pkgName = env.PACKAGE_NAME || detected.name;
  const fromVersion = env.FROM_VERSION || detected.from;
  const toVersion = env.TO_VERSION || detected.to;
  if (!pkgName || !fromVersion || !toVersion) {
    throw new Error('package-name/from-version/to-version are required (or use a Dependabot-style PR title: "Bump pkg from X to Y")');
  }

  const inspectorPath = required('INSPECTOR_PATH', env.INSPECTOR_PATH);
  const templatePath = required('TEMPLATE_PATH', env.TEMPLATE_PATH);
  const repo = env.PR_REPO || env.GITHUB_REPOSITORY || '';
  const manifestPath = env.MANIFEST_PATH || 'package.json';
  const input = {
    trigger: { kind: 'dependabot_pr', repo, pr: env.PR_NUMBER ? Number(env.PR_NUMBER) : null, branch: env.GITHUB_HEAD_REF || null },
    package: { name: pkgName, ecosystem: env.ECOSYSTEM || 'npm', from_version: fromVersion, to_version: toVersion },
    runtime_reachable_hint: env.RUNTIME_REACHABLE || 'unknown',
    affected_services: splitCsv(env.AFFECTED_SERVICES),
  };
  if (env.ADVISORIES_JSON) input.advisories = JSON.parse(env.ADVISORIES_JSON);
  if (existsSync(manifestPath)) input.manifest_path = manifestPath;

  const { buildCase } = await import(pathToFileURL(path.resolve(inspectorPath)).href);
  let c;
  try {
    c = await buildCase(input);
  } catch (e) {
    c = {
      schema: 'xtrm.dependency_update_case.v0',
      case_id: 'dep-review-incomplete',
      trigger: input.trigger,
      package: { ...input.package, update_kind: 'unknown', dependency_kind: 'transitive', scope: 'unknown' },
      supply_chain: { release_age_hours: null, cooldown_status: 'unknown', registry_status: 'unknown', maintainer_change_detected: false, install_script_changed: false, artifact_repo_mismatch: 'unknown' },
      security: { advisories: [], known_exploited: false, public_exploit_available: false, epss_bucket: 'unknown', malicious_package_signal: 'unknown' },
      usage: { affected_services: input.affected_services, affected_files: [], runtime_reachable: input.runtime_reachable_hint, publicly_exposed_path: 'unknown', github_actions_blast_radius: 'n/a' },
      preliminary_verdict: { status: 'unknown', reason: `inspector failed: ${e.message}` },
    };
  }

  const verdict = actionVerdict(c.preliminary_verdict);
  const label = labelFor(verdict);
  const template = readFileSync(templatePath, 'utf8');
  const comment = renderTemplate(template, c, verdict, label);
  const casePath = path.join(outDir, 'dependency_update_case.json');
  const commentPath = path.join(outDir, 'pr-comment.md');
  writeFileSync(casePath, JSON.stringify(c, null, 2) + '\n');
  writeFileSync(commentPath, comment + '\n');

  const token = env.GH_TOKEN || env.GITHUB_TOKEN || '';
  const pr = env.PR_NUMBER;
  if (token && repo && pr) {
    await commentAndLabel(repo, pr, comment, label, token);
  } else {
    console.log('dep-review dry-run: no token/repo/pr; skipping GitHub comment+label');
    console.log(comment);
  }

  setOutput('verdict', verdict);
  setOutput('label', label);
  setOutput('case-path', casePath);
  setOutput('comment-path', commentPath);
  console.log(`dep-review verdict=${verdict} label=${label} case=${casePath}`);
  if (shouldFail(verdict)) process.exit(1);
}

main().catch((e) => { console.error(`dep-review failed: ${e.message}`); process.exit(1); });
