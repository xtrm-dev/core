import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-registry-pack-parity.mjs');

// Retired Beads hooks (xtrm-6qu.8 allowlist): exact paths only — the count
// and membership are pinned so a glob or broad exemption cannot sneak in.
const RETIRED_BEADS_PATHS = [
  '.xtrm/hooks/beads-claim-sync.mjs',
  '.xtrm/hooks/beads-commit-gate.mjs',
  '.xtrm/hooks/beads-compact-restore.mjs',
  '.xtrm/hooks/beads-compact-save.mjs',
  '.xtrm/hooks/beads-edit-gate.mjs',
  '.xtrm/hooks/beads-gate-core.mjs',
  '.xtrm/hooks/beads-gate-messages.mjs',
  '.xtrm/hooks/beads-gate-utils.mjs',
  '.xtrm/hooks/beads-status-cache.mjs',
  '.xtrm/hooks/beads-status-cache.test.mjs',
  '.xtrm/hooks/beads-stop-gate.mjs',
];

// NOTE: the script resolves the repo from its own import.meta.url, so the
// sandbox case must execute the sandbox COPY, not the original path.
function runParity(cwd: string, script: string = SCRIPT) {
  return spawnSync('node', [script], { encoding: 'utf8', cwd });
}

describe('registry-pack parity (retired Beads hooks)', () => {
  it('passes on the real tree with exactly the retired set allowlisted', () => {
    const result = runParity(REPO_ROOT);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Allowlisted pack-only managed paths: 11');
    for (const retired of RETIRED_BEADS_PATHS) {
      expect(fs.pathExistsSync(path.join(REPO_ROOT, retired))).toBe(true);
    }
  });

  it('allowlist keys are exact paths, never globs', async () => {
    const script = await fs.readFile(SCRIPT, 'utf8');
    const allowlistBlock = script.slice(script.indexOf('const allowlist = new Map('));
    expect(allowlistBlock).not.toContain('*');
    for (const retired of RETIRED_BEADS_PATHS) {
      expect(allowlistBlock).toContain(`'${retired}'`);
    }
  });

  it('an unlisted managed file still fails parity (sandbox clone)', async () => {
    // Sandbox, not the real tree: no interference with parallel suites.
    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-parity-'));
    try {
      await fs.copy(path.join(REPO_ROOT, 'package.json'), path.join(sandbox, 'package.json'));
      await fs.ensureDir(path.join(sandbox, 'scripts'));
      await fs.copy(SCRIPT, path.join(sandbox, 'scripts', 'check-registry-pack-parity.mjs'));
      await fs.ensureDir(path.join(sandbox, '.xtrm'));
      await fs.copy(path.join(REPO_ROOT, '.xtrm', 'registry.json'), path.join(sandbox, '.xtrm', 'registry.json'));
      await fs.ensureDir(path.join(sandbox, '.xtrm', 'hooks'));
      const probe = path.join(sandbox, '.xtrm', 'hooks', '__parity_probe.mjs');
      await fs.writeFile(probe, 'export default 1;\n');

      const result = runParity(sandbox, path.join(sandbox, 'scripts', 'check-registry-pack-parity.mjs'));
      expect(result.status).not.toBe(0);
      // Discriminating assertion: the probe must appear as a Missing-from-
      // registry entry specifically — not merely mentioned (e.g. in the
      // allowlisted branch, which would indicate an over-broad exemption).
      // In this sandbox the probe is the ONLY pack file missing from the
      // registry, so the section must contain exactly it.
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const section = output.split('Missing from registry:')[1]?.split('Allowlisted')[0] ?? '';
      expect(section.trim().split('\n').map(line => line.trim()).filter(Boolean))
        .toEqual(['- .xtrm/hooks/__parity_probe.mjs']);
    } finally {
      await fs.remove(sandbox);
    }
  });
});
