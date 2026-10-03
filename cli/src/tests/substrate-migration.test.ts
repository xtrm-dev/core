import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  migrationBlockedReason,
  MIGRATION_MARKER,
  planSubstrateMigration,
  readMigrationMarker,
  substrateMigrationTransition,
  SUBSTRATE_TRANSITION_DOC,
  SUBSTRATE_TRANSITION_STATUS,
} from '../core/substrate-migration.js';
import type { SbRunner } from '../core/substrate.js';

// Amended A8/A9 contract: detection + planning + fail-closed remediation
// only. No backup/export/import/verify/receipt/cleanup/marker writes exist.

function stubSb(versionAvailable = true): SbRunner {
  return (args) => {
    if (args[0] === '--version') {
      return versionAvailable
        ? { status: 0, stdout: 'sb 0.1.0', stderr: '' }
        : { status: 127, stdout: '', stderr: 'not found', error: 'not found' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
}

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-migration-test-'));
});

afterEach(() => {
  fs.removeSync(tmpDir);
});

async function writeBeadsRepo(root: string): Promise<string> {
  const repo = path.join(root, 'repo');
  await fs.ensureDir(path.join(repo, '.beads'));
  await fs.writeFile(path.join(repo, '.beads', 'issues.jsonl'), '{"id":"a"}\n');
  return repo;
}

describe('planSubstrateMigration (detect stage)', () => {
  it('needs nothing without .beads', async () => {
    const repo = path.join(tmpDir, 'repo');
    await fs.ensureDir(repo);
    const plan = await planSubstrateMigration(repo, stubSb());
    expect(plan.needed).toBe(false);
    expect(plan.hasBeads).toBe(false);
    expect(migrationBlockedReason(plan)).toBeNull();
  });

  it('marker without a board reads as already migrated', async () => {
    const repo = path.join(tmpDir, 'repo');
    await fs.ensureDir(path.join(repo, '.xtrm'));
    await fs.writeJson(path.join(repo, '.xtrm', MIGRATION_MARKER), { status: 'migrated', receipt: 'r' });
    const plan = await planSubstrateMigration(repo, stubSb());
    expect(plan.needed).toBe(false);
    expect(plan.hasBeads).toBe(false);
    expect(plan.alreadyMigrated).toBe(true);
    expect(migrationBlockedReason(plan)).toBeNull();
    expect(await readMigrationMarker(repo)).toMatchObject({ status: 'migrated' });
  });

  it('forged/stale marker never bypasses a present board', async () => {
    for (const marker of [{}, { status: 'migrated', receipt: 'r' }, { status: 'migrated', receipt: 'r', verified: true }]) {
      const repo = await writeBeadsRepo(tmpDir);
      await fs.ensureDir(path.join(repo, '.xtrm'));
      await fs.writeJson(path.join(repo, '.xtrm', MIGRATION_MARKER), marker);
      const plan = await planSubstrateMigration(repo, stubSb());
      expect(plan.needed).toBe(true);
      expect(plan.hasBeads).toBe(true);
      expect(plan.alreadyMigrated).toBe(false);
      expect(plan.reason).toMatch(/unverified migration marker/);
      expect(migrationBlockedReason(plan)).toMatch(/Do NOT delete/);
    }
  });

  it('detects pending work with and without sb', async () => {
    const repo = await writeBeadsRepo(tmpDir);
    const withSb = await planSubstrateMigration(repo, stubSb(true));
    expect(withSb.needed).toBe(true);
    expect(withSb.sbAvailable).toBe(true);
    const withoutSb = await planSubstrateMigration(repo, stubSb(false));
    expect(withoutSb.needed).toBe(true);
    expect(withoutSb.sbAvailable).toBe(false);
  });

  it('reads no marker as null without throwing', async () => {
    const repo = await writeBeadsRepo(tmpDir);
    expect(await readMigrationMarker(repo)).toBeNull();
  });
});

describe('migrationBlockedReason (fail-closed gate)', () => {
  it('always remediates without manual-migration posture', async () => {
    const repo = await writeBeadsRepo(tmpDir);
    for (const available of [true, false]) {
      const plan = await planSubstrateMigration(repo, stubSb(available));
      const reason = migrationBlockedReason(plan);
      expect(reason).not.toBeNull();
      expect(reason as string).toContain('transition pending');
      expect(reason as string).toContain('Do NOT delete');
      expect(reason as string).toContain('No released xt version clears this gate');
      expect(reason as string).not.toContain('bd export');
    }
    const withSb = await planSubstrateMigration(repo, stubSb(true));
    expect(migrationBlockedReason(withSb)).not.toContain('xt init');
    const withoutSb = await planSubstrateMigration(repo, stubSb(false));
    expect(migrationBlockedReason(withoutSb)).toContain('xt init');
  });

  it('never sends the operator down the upgrade dead end (CORE-2343)', async () => {
    const repo = await writeBeadsRepo(tmpDir);
    const reason = migrationBlockedReason(await planSubstrateMigration(repo, stubSb(true))) as string;
    expect(reason).not.toContain('Upgrade xt, then re-run');
  });

  it('points at a remediation doc that exists in the repo', async () => {
    // A pointer that 404s is worse than no pointer: the substrate package
    // ships no repository URL, so the doc must live in-repo.
    const docPath = path.resolve(__dirname, '..', '..', '..', SUBSTRATE_TRANSITION_DOC);
    expect(await fs.pathExists(docPath)).toBe(true);
  });
});

describe('substrateMigrationTransition (machine-readable transition)', () => {
  it('is null when nothing is needed', async () => {
    const repo = await writeBeadsRepo(tmpDir);
    await fs.remove(path.join(repo, '.beads'));
    expect(substrateMigrationTransition(await planSubstrateMigration(repo, stubSb(true)))).toBeNull();
  });

  it('describes the pending state without claiming an upgrade clears it', async () => {
    const repo = await writeBeadsRepo(tmpDir);
    const transition = substrateMigrationTransition(await planSubstrateMigration(repo, stubSb(true)));
    expect(transition).toEqual({
      needed: true,
      status: SUBSTRATE_TRANSITION_STATUS,
      reason: expect.stringContaining('.beads'),
      inspectCommand: 'xt doctor',
      docPath: SUBSTRATE_TRANSITION_DOC,
      clearsWithUpgrade: false,
    });
  });
});
