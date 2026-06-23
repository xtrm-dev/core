import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  updateKind, classifyFromManifest, cooldownStatus, isSecurityForced,
  epssBucketFromCvss, cvssFromVector, cvssFromQualitative, cvssFromEntry, preliminaryVerdict, buildCase, caseId,
} from './dep-inspect.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../.xtrm/skills/default/updating-dependencies/schemas/dependency_update_case.schema.json', import.meta.url), 'utf8'));

test('updateKind classifies semver delta + github-actions sha', () => {
  assert.equal(updateKind('1.2.2', '1.2.3', 'npm'), 'patch');
  assert.equal(updateKind('1.2.2', '1.3.0', 'npm'), 'minor');
  assert.equal(updateKind('1.2.2', '2.0.0', 'npm'), 'major');
  assert.equal(updateKind('a', 'b', 'npm'), 'unknown');
  assert.equal(updateKind('v3', '34e114876b0b11c390a56381ad16ebd13914f8d5', 'github-actions'), 'sha');
});

test('classifyFromManifest: direct runtime, dev test/build, transitive', () => {
  const manifest = { dependencies: { hono: '1.0' }, devDependencies: { vitest: '1.0', vite: '8.0.16' } };
  assert.deepEqual(classifyFromManifest('hono', manifest), { dependency_kind: 'direct', scope: 'runtime' });
  assert.deepEqual(classifyFromManifest('vitest', manifest), { dependency_kind: 'direct', scope: 'test' });
  assert.deepEqual(classifyFromManifest('vite', manifest), { dependency_kind: 'direct', scope: 'build' });
  assert.deepEqual(classifyFromManifest('not-listed', manifest), { dependency_kind: 'transitive', scope: 'unknown' });
});

test('cooldownStatus: cleared/active/blocked/bypass/unknown', () => {
  assert.equal(cooldownStatus(200, 'normal', false), 'cleared');
  assert.equal(cooldownStatus(10, 'normal', false), 'active');
  assert.equal(cooldownStatus(10, 'normal', true), 'bypass_security'); // security overrides cooldown
  assert.equal(cooldownStatus(10, 'yanked', true), 'blocked');          // yanked wins
  assert.equal(cooldownStatus(null, 'normal', false), 'unknown');
});

test('isSecurityForced: CVSS9 + reachable, explicit flags, KEV', () => {
  const adv = { id: 'GHSA-x', severity_cvss: 9.1 };
  assert.equal(isSecurityForced(adv, { runtime_reachable: 'yes' }), true);
  assert.equal(isSecurityForced(adv, { runtime_reachable: 'no' }), false);  // CVSS9 but not reachable
  assert.equal(isSecurityForced(adv, { runtime_reachable: 'yes' }, ), true);
  assert.equal(isSecurityForced({ id: 'KEV-1', severity_cvss: 5 }, { cisaKev: ['KEV-1'] }), true);
  assert.equal(isSecurityForced({ id: 'X', severity_cvss: 5 }, { known_exploited: true }), true);
  assert.equal(isSecurityForced({ id: 'X', severity_cvss: 5 }, { public_exploit_available: true }), true);
  assert.equal(isSecurityForced({ id: 'X', severity_cvss: 5 }, {}), false);
});

test('epss + cvss vector parsing', () => {
  assert.equal(epssBucketFromCvss(9.5), 'high');
  assert.equal(epssBucketFromCvss(7.2), 'medium');
  assert.equal(epssBucketFromCvss(4.0), 'low');
  assert.equal(epssBucketFromCvss(null), 'unknown');
  assert.equal(cvssFromVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.equal(cvssFromVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
  assert.equal(cvssFromVector('9.1'), 9.1);
});

test('cvssFromQualitative maps GHSA labels; cvssFromEntry prefers V3 then qualitative', () => {
  assert.equal(cvssFromQualitative('CRITICAL'), 9.5);
  assert.equal(cvssFromQualitative('HIGH'), 8.5);
  assert.equal(cvssFromQualitative('MODERATE'), 5.5);
  assert.equal(cvssFromQualitative('LOW'), 2.5);
  assert.equal(cvssFromQualitative(null), null);
  // V3 computed score preferred over qualitative
  assert.equal(cvssFromEntry({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }], database_specific: { severity: 'LOW' } }), 9.8);
  // CVSS_V4 pure vector has no trailing score -> falls back to qualitative
  assert.equal(cvssFromEntry({ severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/SA:N' }], database_specific: { severity: 'HIGH' } }), 8.5);
  assert.equal(cvssFromEntry({}), null);
});

test('preliminaryVerdict walks taxonomy top-down', () => {
  const base = { security: { advisories: [], malicious_package_signal: 'none' }, usage: { github_actions_blast_radius: 'n/a' }, supply_chain: { registry_status: 'normal', cooldown_status: 'cleared' } };
  assert.equal(preliminaryVerdict({ ...base, security: { advisories: [], malicious_package_signal: 'strong' }, usage: { github_actions_blast_radius: 'n/a' }, supply_chain: { registry_status: 'normal', cooldown_status: 'cleared' } }).status, 'blocked');
  assert.equal(preliminaryVerdict({ ...base, supply_chain: { registry_status: 'yanked', cooldown_status: 'cleared' } }).status, 'blocked');
  assert.equal(preliminaryVerdict({ ...base, security: { advisories: [{ security_forced: true }], malicious_package_signal: 'none' } }).status, 'security_forced');
  assert.equal(preliminaryVerdict({ ...base, security: { advisories: [{ security_forced: false }], malicious_package_signal: 'none' } }).status, 'research_required');
  assert.equal(preliminaryVerdict({ ...base, supply_chain: { registry_status: 'normal', cooldown_status: 'active' } }).status, 'cooldown');
  assert.equal(preliminaryVerdict({ ...base, supply_chain: { registry_status: 'normal', cooldown_status: 'cleared' } }).status, 'safe_candidate');
});

test('caseId is stable + opaque', () => {
  assert.equal(caseId('a|b'), caseId('a|b'));
  assert.notEqual(caseId('a|b'), caseId('a|c'));
  assert.match(caseId('x'), /^dep-[0-9a-f]{12}$/);
});

test('buildCase (offline): SECURITY_FORCED advisory -> correct verdict + schema shape', async () => {
  const input = {
    trigger: { kind: 'dependabot_pr', repo: 'xtrm-dev/specialists', pr: 999 },
    package: { name: 'hono', ecosystem: 'other', from_version: '1.0.0', to_version: '1.1.0' },
    advisories: [{ id: 'GHSA-x', source: 'ghsa', severity_cvss: 9.4 }],
    runtime_reachable_hint: 'yes',
    affected_services: ['specialists'],
  };
  const c = await buildCase(input);
  // schema required keys
  for (const k of SCHEMA.required) assert.ok(k in c, `missing ${k}`);
  assert.equal(c.schema, 'xtrm.dependency_update_case.v0');
  assert.equal(c.package.update_kind, 'minor');
  assert.equal(c.security.advisories[0].security_forced, true);
  assert.equal(c.supply_chain.cooldown_status, 'bypass_security');
  assert.equal(c.security.epss_bucket, 'high');
  assert.equal(c.preliminary_verdict.status, 'security_forced');
});

test('buildCase (offline): no advisories + non-npm -> safe/unknown cooldown, not forced', async () => {
  const c = await buildCase({
    trigger: { kind: 'manual_bump' },
    package: { name: 'foo', ecosystem: 'other', from_version: '1.0.0', to_version: '1.0.1' },
  });
  assert.equal(c.security.advisories.length, 0);
  assert.equal(c.security.advisories.every((a) => !a.security_forced), true);
  assert.equal(c.supply_chain.cooldown_status, 'unknown'); // no registry data for 'other'
  assert.notEqual(c.preliminary_verdict.status, 'security_forced');
});

test('buildCase queries OSV for every advertised ecosystem', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, async json() { return { vulns: [] }; } };
  };
  try {
    await buildCase({ package: { name: 'requests', ecosystem: 'pypi', from_version: '2.0.0', to_version: '2.32.0' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { package: { name: 'requests', ecosystem: 'PyPI' }, version: '2.32.0' });
});
