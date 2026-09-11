import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
const getPiDoctorReportMock = vi.hoisted(() => vi.fn());
const checkUpdatesMock = vi.hoisted(() => vi.fn(() => []));
const substrateVersionMock = vi.hoisted(() => vi.fn(() => ({ available: true, version: '0.0.0-doctor-stub', raw: 'sb 0.0.0-doctor-stub' })));
const substrateDoctorMock = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  payload: { schema: 'substrate-cli/v1', command: 'doctor', ok: true },
  data: { dbPath: 'state.db', schemaHealthy: true, schemaError: null, projects: 1, link: { projectId: 'XTRM-1', source: 'env', gitRoot: '/repo' }, linkError: null, gitRoot: '/repo' },
  raw: '{}',
})));
const setupCheckMock = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  report: { ok: true, claude: [{ name: 'plugin-manifest', ok: true }], pi: [{ name: 'pi-extension', ok: true }], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false }, enrollment: [{ name: 'sb-enrolled', ok: true }, { name: 'pi-enrolled', ok: true }, { name: 'claude-marketplace-enrolled', ok: true }, { name: 'claude-plugin-enrolled', ok: true }, { name: 'claude-strict-live', ok: true }, { name: 'beads-absent', ok: true }] },
  raw: '{}',
})));

// This integration fixture is intentionally hermetic. The real doctor command
// otherwise launches npm and sb subprocesses, which contend with the full
// Vitest worker pool and make the existing 30s test budget load-sensitive.
vi.mock('../src/core/pi-runtime.js', () => ({
  getXtManagedPiPackageDoctorReport: getPiDoctorReportMock,
}));
vi.mock('../src/utils/npm-latest.js', () => ({
  checkXtrmUpdates: checkUpdatesMock,
  defaultCacheFile: vi.fn(() => '/tmp/xtrm-doctor-cache.json'),
  formatUpdateRows: vi.fn(() => []),
  updatesSummary: vi.fn(() => ''),
}));
vi.mock('../src/core/substrate.js', async () => {
  const actual = await vi.importActual<typeof import('../src/core/substrate.js')>('../src/core/substrate.js');
  return {
    ...actual,
    getSbVersion: substrateVersionMock,
    getSbDoctorJson: substrateDoctorMock,
    runSetupCheck: setupCheckMock,
  };
});

import { createDoctorCommand } from '../src/commands/doctor.js';

let tmpDir: string;
let previousHome: string | undefined;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function writeFile(relativePath: string, content: string): Promise<void> {
  await fs.outputFile(path.join(tmpDir, relativePath), content);
}

async function setupCleanRepo(): Promise<void> {
  const homeDir = process.env.HOME as string;
  await fs.ensureDir(path.join(homeDir, '.xtrm', 'skills', 'default'));
  await fs.ensureDir(path.join(homeDir, '.claude'));
  await fs.ensureDir(path.join(homeDir, '.pi', 'agent'));
  await fs.symlink(path.join(homeDir, '.xtrm', 'skills', 'default'), path.join(homeDir, '.claude', 'skills'));
  await fs.symlink(path.join(homeDir, '.xtrm', 'skills', 'default'), path.join(homeDir, '.pi', 'agent', 'skills'));
  await fs.ensureDir(path.join(tmpDir, '.xtrm', 'skills', 'default', 'clean-code'));
  await fs.writeFile(path.join(tmpDir, '.xtrm', 'skills', 'default', 'clean-code', 'SKILL.md'), '# clean\n');
  await fs.ensureDir(path.join(tmpDir, '.xtrm', 'skills', 'default', 'fresh-skill'));
  await fs.writeFile(path.join(tmpDir, '.xtrm', 'skills', 'default', 'fresh-skill', 'SKILL.md'), '# fresh\n');
  await fs.ensureDir(path.join(tmpDir, '.xtrm', 'hooks'));
  await fs.writeFile(path.join(tmpDir, '.xtrm', 'hooks', 'hook-a.mjs'), 'export default 1;\n');
  await fs.writeFile(path.join(tmpDir, '.xtrm', 'hooks', 'hook-b.mjs'), 'export default 2;\n');
  await fs.ensureDir(path.join(tmpDir, '.claude', 'skills'));
  await fs.ensureDir(path.join(tmpDir, '.pi', 'skills'));
  await fs.ensureDir(path.join(tmpDir, '.agents', 'skills'));
  await fs.writeJson(path.join(tmpDir, '.xtrm', 'skills', 'state.json'), {
    schemaVersion: '2',
    enabledPacks: { claude: [], pi: [], codex: [] },
    managedLinks: { claude: {}, pi: {}, codex: {} },
  });
  await fs.writeJson(path.join(tmpDir, '.xtrm', 'registry.json'), {
    version: '1',
    assets: {
      skills: {
        source_dir: '.xtrm/skills/default',
        install_mode: 'copy',
        files: {
          'clean-code/SKILL.md': { hash: sha256('# clean\n'), version: '1' },
          'fresh-skill/SKILL.md': { hash: sha256('# fresh\n'), version: '1' },
        },
      },
      hooks: {
        source_dir: '.xtrm/hooks',
        install_mode: 'copy',
        files: {
          'hook-a.mjs': { hash: sha256('export default 1;\n'), version: '1' },
          'hook-b.mjs': { hash: sha256('export default 2;\n'), version: '1' },
        },
      },
    },
  });
  expect(await fs.pathExists(path.join(tmpDir, '.xtrm', 'skills', 'active'))).toBe(false);
}

async function runDoctor(args: string[] = []): Promise<{ stdout: string; stderr: string; status: number | null }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...input: unknown[]) => { logs.push(input.join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...input: unknown[]) => { errors.push(input.join(' ')); });
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    const command = createDoctorCommand();
    await command.parseAsync(['--cwd', tmpDir, ...args], { from: 'user' });
    return { stdout: logs.join('\n'), stderr: errors.join('\n'), status: process.exitCode };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = originalExitCode;
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-doctor-'));
  previousHome = process.env.HOME;
  process.env.HOME = path.join(tmpDir, 'home');
  getPiDoctorReportMock.mockResolvedValue({ issues: [], missing: [], outdated: [], ok: [], hasIssues: false });
  checkUpdatesMock.mockReturnValue([]);
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  await fs.remove(tmpDir);
});

describe('doctor command', () => {
  it('prints Cat B section and JSON', async () => {
    await setupCleanRepo();
    const result = await runDoctor(['--json']);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.catB.skills.every((row: { status: string }) => row.status === 'in-sync')).toBe(true);
    expect(parsed.catB.hooks.every((row: { status: string }) => row.status === 'in-sync')).toBe(true);
    expect(parsed.catB.runtimeView).toMatchObject({ activeReady: true, globalClaudePointerReady: true, globalPiPointerReady: true, projectClaudePointerState: 'ready', projectPiPointerState: 'ready', projectCodexPointerState: 'ready' });
    expect(parsed.catB.duplicates).toEqual([]);
    // Substrate section (§41): version + doctor payload come from the stub.
    expect(parsed.substrate).toMatchObject({ available: true, version: '0.0.0-doctor-stub', doctorOk: true });
    expect(parsed.legacyMigration).toMatchObject({ beadsDirPresent: false, beadsHookRegistrations: 0, status: 'clean' });
  });

  it('doctor clean repo with no .beads passes', async () => {
    await setupCleanRepo();
    await fs.remove(path.join(tmpDir, '.beads'));
    const result = await runDoctor(['--json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.catB.sharedBeadsServerState).toBe('not-applicable');
  });

  it('reports drifted, missing, extra, and non-zero exit with --check-drift', async () => {
    await setupCleanRepo();
    await writeFile('.xtrm/skills/default/clean-code/SKILL.md', '# changed\n');
    await fs.remove(path.join(tmpDir, '.xtrm', 'skills', 'default', 'fresh-skill'));
    await fs.ensureDir(path.join(tmpDir, '.xtrm', 'skills', 'default', 'fake-skill'));
    await fs.writeFile(path.join(tmpDir, '.xtrm', 'skills', 'default', 'fake-skill', 'SKILL.md'), '# fake\n');

    const result = await runDoctor(['--check-drift']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('drifted');
    expect(result.stdout).toContain('missing-from-snapshot');
    expect(result.stdout).toContain('extra-not-canonical');
  });
});
