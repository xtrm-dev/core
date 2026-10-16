// CORE-2407: the specialists-source manifest claims a pin, so the ref it
// exposes to consumers (release workflows read .source.ref) must BE that pin.
// It used to carry `master`, a moving branch that can resolve to a different
// tree than the one vendored. Runs under `npm run test:scripts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (relative) => JSON.parse(readFileSync(path.join(repo, relative), 'utf8'));

test('specialists-source pins source.ref to the resolved sha', () => {
  const manifest = readJson('.xtrm/specialists-source.json');
  const { ref, resolved_sha: sha } = manifest.source;
  assert.match(sha, /^[0-9a-f]{40}$/, `resolved_sha is not a commit sha: ${sha}`);
  assert.equal(ref, sha, `source.ref must be the pinned sha, not a moving ref: ${ref}`);
  assert.notEqual(ref, 'master', 'source.ref must never be a branch name');
});

test('registry.json carries the same pinned ref as the manifest', () => {
  const manifest = readJson('.xtrm/specialists-source.json');
  const registry = readJson('.xtrm/registry.json');
  const source = registry.specialists_source?.source;
  assert.ok(source, 'registry.json is missing specialists_source.source');
  assert.equal(source.ref, manifest.source.resolved_sha, 'registry ref drifted from the manifest pin');
  assert.equal(source.resolved_sha, manifest.source.resolved_sha, 'registry sha drifted from the manifest pin');
});

test('the vendor script records the resolved sha as ref, never a branch', () => {
  const script = readFileSync(path.join(repo, 'scripts/vendor-specialists-skills.mjs'), 'utf8');
  assert.match(script, /ref: resolvedSha/, 'vendor script must write the pinned sha as source.ref');
  assert.doesNotMatch(script, /--abbrev-ref/, 'vendor script must not derive ref from a branch name');
});
