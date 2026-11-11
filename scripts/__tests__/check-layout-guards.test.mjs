import test from 'node:test';
import assert from 'node:assert/strict';
import { staleActiveTierHits } from '../check-layout-guards.mjs';

// CORE-2601: the global runtime view (`~/.xtrm/skills/active/<runtime>`) is live —
// resolveGlobalRuntimeViewRoot still builds it — so only the retired per-REPO
// form is stale. The guard used to flag both and failed on correct documentation.

test('flags a repo-relative active tier reference', () => {
  assert.deepEqual(staleActiveTierHits('see .xtrm/skills/active/pi/planning'), ['.xtrm/skills/active/pi']);
});

test('accepts the live global runtime view', () => {
  assert.deepEqual(staleActiveTierHits('`~/.xtrm/skills/active/pi/` is the global view'), []);
  assert.deepEqual(staleActiveTierHits('$HOME/.xtrm/skills/active/claude'), []);
  assert.deepEqual(staleActiveTierHits('${HOME}/.xtrm/skills/active/claude'), []);
});

test('flags every unanchored occurrence, not only the first', () => {
  assert.equal(
    staleActiveTierHits('.xtrm/skills/active/pi plus .xtrm/skills/active/claude').length,
    2,
  );
});
