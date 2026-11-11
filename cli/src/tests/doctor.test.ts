import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getXtManagedPiPackageDoctorReportMock = vi.hoisted(() => vi.fn());
const checkDriftMock = vi.hoisted(() => vi.fn());
const checkRuntimeSkillsViewsMock = vi.hoisted(() => vi.fn());
const discoverDefaultSkillsMock = vi.hoisted(() => vi.fn());
const getSbVersionMock = vi.hoisted(() => vi.fn(() => ({ available: true, version: '0.1.0-stub', raw: 'sb 0.1.0-stub' })));
const getSbDoctorJsonMock = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  payload: { schema: 'substrate-cli/v1', command: 'doctor', ok: true },
  data: { dbPath: 'state.db', schemaHealthy: true, schemaError: null, projects: 1, link: { projectId: 'XTRM-1', source: 'link' }, linkError: null, gitRoot: '/repo' },
  raw: '{}',
})));
const runSetupCheckMock = vi.hoisted(() => vi.fn(() => ({
  ok: true,
  report: { ok: true, claude: [], pi: [], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false }, enrollment: [{ name: 'sb-enrolled', ok: true }, { name: 'pi-enrolled', ok: true }, { name: 'claude-marketplace-enrolled', ok: true }, { name: 'claude-plugin-enrolled', ok: true }, { name: 'claude-strict-live', ok: true }, { name: 'beads-absent', ok: true }] },
  raw: '{}',
})));

vi.mock('../core/pi-runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/pi-runtime.js')>();
  return {
    ...actual,
    getXtManagedPiPackageDoctorReport: getXtManagedPiPackageDoctorReportMock,
  };
});

// Hermetic substrate boundary: the real doctor action otherwise spawns sb,
// npm, and node subprocesses, which contend with the full Vitest worker pool
// and make the 30s test budget load-sensitive.
vi.mock('../core/substrate.js', async () => {
  const actual = await vi.importActual<typeof import('../core/substrate.js')>('../core/substrate.js');
  return {
    ...actual,
    getSbVersion: getSbVersionMock,
    getSbDoctorJson: getSbDoctorJsonMock,
    runSetupCheck: runSetupCheckMock,
  };
});

vi.mock('../core/drift.js', () => ({
  checkDrift: checkDriftMock,
}));

vi.mock('../core/skills-runtime-views.js', () => ({
  checkRuntimeSkillsViews: checkRuntimeSkillsViewsMock,
}));

vi.mock('../core/skill-discovery.js', () => ({
  discoverDefaultSkills: discoverDefaultSkillsMock,
}));

// checkXtrmUpdates shells `npm view` per package (5s timeouts); hermetic.
vi.mock('../utils/npm-latest.js', () => ({
  checkXtrmUpdates: () => [],
  defaultCacheFile: () => '/tmp/xtrm-doctor-cache.json',
  formatUpdateRows: () => [],
  updatesSummary: () => '',
}));

// CORE-2591: force the `claude` probe to miss so the doctor wording is deterministic;
// every other binary still runs for real.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: (bin: Parameters<typeof actual.spawnSync>[0], args?: Parameters<typeof actual.spawnSync>[1], options?: Parameters<typeof actual.spawnSync>[2]) => (
      bin === 'claude' ? { status: 1, stdout: '', stderr: '' } : actual.spawnSync(bin, args, options)
    ),
  };
});

import { createDoctorCommand } from '../commands/doctor.js';

let tmpDir = '';
let previousCwd = '';

beforeEach(() => {
  previousCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-doctor-test-'));
  process.chdir(tmpDir);
  fs.ensureDirSync(path.join(tmpDir, '.xtrm'));
  fs.writeJsonSync(path.join(tmpDir, '.xtrm', 'registry.json'), { version: '1', assets: {} }, { spaces: 2 });
  checkDriftMock.mockResolvedValue({ missing: [], upToDate: [], drifted: [] });
  checkRuntimeSkillsViewsMock.mockResolvedValue({ activeReady: true, globalClaudePointerReady: true, globalPiPointerReady: true, globalActivationReady: true, projectClaudePointerState: 'ready', projectPiPointerState: 'ready', projectCodexPointerState: 'ready', hasDeprecatedAgentsSkillsPath: false });
  discoverDefaultSkillsMock.mockResolvedValue([]);
  getXtManagedPiPackageDoctorReportMock.mockReset();
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.removeSync(tmpDir);
  vi.restoreAllMocks();
});

async function runDoctorCli(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  });

  try {
    const command = createDoctorCommand();
    await command.parseAsync(['node', 'xtrm-doctor-test', ...args]);
    return logs;
  } finally {
    spy.mockRestore();
  }
}

function buildReport(overrides: Partial<Awaited<ReturnType<typeof getXtManagedPiPackageDoctorReportMock>>> = {}) {
  return {
    issues: [],
    missing: [],
    outdated: [],
    ok: [],
    hasIssues: false,
    ...overrides,
  };
}

describe('xt doctor command', () => {
  it('names the Claude Code consequence when the claude CLI is missing (CORE-2591)', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport());

    const textLogs = await runDoctorCli([]);
    expect(textLogs.join('\n')).toContain('claude CLI not found; the Claude Code route will refuse at dispatch');
  });

  it('reports the Node floor for the Claude Code bridge (CORE-2591)', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport());

    const textLogs = await runDoctorCli([]);
    expect(textLogs.join('\n')).toContain('meets the Claude Code bridge floor (>= 20)');
  });

  it('reports the resolved bridge version and src entry in the Pi packages section (CORE-2591)', async () => {
    const packageDir = '/tmp/bridge-agent/npm/node_modules/pi-claude-bridge';
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport({
      bridge: {
        npmPackageName: 'pi-claude-bridge',
        installedVersion: '0.12.0',
        packageDir,
        entryPath: `${packageDir}/src/index.ts`,
        entryPresent: true,
      },
    }));

    const textLogs = await runDoctorCli([]);
    expect(textLogs.join('\n')).toContain(`pi-claude-bridge 0.12.0 → ${packageDir}/src/index.ts`);
  });

  it('warns when the installed bridge has no src entry (CORE-2591)', async () => {
    const packageDir = '/tmp/bridge-agent/npm/node_modules/pi-claude-bridge';
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport({
      bridge: {
        npmPackageName: 'pi-claude-bridge',
        installedVersion: '0.12.0',
        packageDir,
        entryPath: `${packageDir}/src/index.ts`,
        entryPresent: false,
      },
    }));

    const textLogs = await runDoctorCli([]);
    expect(textLogs.join('\n')).toContain('missing src/index.ts; the specialists resolver cannot load it');
  });

  it('prints clean text and json when all xt pi packages are current', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport());

    const textLogs = await runDoctorCli([]);
    expect(textLogs.join('\n')).toContain('all xt-shipped Pi packages present and current');

    const jsonLogs = await runDoctorCli(['--json']);
    const parsed = JSON.parse(jsonLogs[0]);
    expect(parsed.piPackages.hasIssues).toBe(false);
    expect(parsed.catB.runtimeView.hasDeprecatedAgentsSkillsPath).toBe(false);
    expect(parsed.piPackages.issues).toEqual([]);
  });

  it('reports a missing managed Pi package in text and json without installing anything', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport({
      issues: [{ pkg: { id: 'npm:pi-ast-grep', displayName: 'pi-ast-grep', required: true }, npmPackageName: 'pi-ast-grep', installedVersion: null, expectedVersion: '1.1.0', state: 'missing', remediation: 'pi install npm:pi-ast-grep' }],
      missing: [{ pkg: { id: 'npm:pi-ast-grep', displayName: 'pi-ast-grep', required: true }, npmPackageName: 'pi-ast-grep', installedVersion: null, expectedVersion: '1.1.0', state: 'missing', remediation: 'pi install npm:pi-ast-grep' }],
      hasIssues: true,
    }));

    const textLogs = await runDoctorCli([]);
    expect(textLogs.join('\n')).toContain('missing');
    expect(textLogs.join('\n')).toContain('pi install npm:pi-ast-grep');
    expect(getXtManagedPiPackageDoctorReportMock).toHaveBeenCalled();

    const jsonLogs = await runDoctorCli(['--json']);
    const parsed = JSON.parse(jsonLogs[0]);
    expect(parsed.piPackages.hasIssues).toBe(true);
    expect(parsed.piPackages.missing[0].pkg.id).toBe('npm:pi-ast-grep');
  });

  it('reports outdated and version-unknown packages with visible warnings', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport({
      issues: [
        { pkg: { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true }, npmPackageName: 'pi-gitnexus', installedVersion: '1.0.0', expectedVersion: '1.1.0', state: 'outdated', remediation: 'pi install npm:pi-gitnexus' },
        { pkg: { id: 'npm:pi-ast-grep', displayName: 'pi-ast-grep', required: true }, npmPackageName: 'pi-ast-grep', installedVersion: '1.0.0', expectedVersion: null, state: 'version-unknown', remediation: 'check network/npm registry, then rerun xt doctor' },
      ],
      outdated: [{ pkg: { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true }, npmPackageName: 'pi-gitnexus', installedVersion: '1.0.0', expectedVersion: '1.1.0', state: 'outdated', remediation: 'pi install npm:pi-gitnexus' }],
      hasIssues: true,
    }));

    const textLogs = await runDoctorCli([]);
    const joined = textLogs.join('\n');
    expect(joined).toContain('outdated');
    expect(joined).toContain('version unknown');
    expect(joined).toContain('outbound: npm view <pkg> version');

    const jsonLogs = await runDoctorCli(['--json']);
    const parsed = JSON.parse(jsonLogs[0]);
    expect(parsed.piPackages.issues.some((issue: { state: string }) => issue.state === 'version-unknown')).toBe(true);
    expect(parsed.piPackages.hasIssues).toBe(true);
  });

  it('resolves project root from subdirectories', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport());
    const nestedDir = path.join(tmpDir, 'cli', 'nested');
    fs.ensureDirSync(nestedDir);
    process.chdir(nestedDir);

    const jsonLogs = await runDoctorCli(['--json']);
    const parsed = JSON.parse(jsonLogs[0]);

    expect(parsed.catB.runtimeView).toBeDefined();
    expect(parsed.piPackages.hasIssues).toBe(false);
  });
});
