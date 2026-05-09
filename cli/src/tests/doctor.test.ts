import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getXtManagedPiPackageDoctorReportMock = vi.hoisted(() => vi.fn());
const checkDriftMock = vi.hoisted(() => vi.fn());
const checkRuntimeSkillsViewsMock = vi.hoisted(() => vi.fn());
const discoverDefaultSkillsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/pi-runtime.js', () => ({
  getXtManagedPiPackageDoctorReport: getXtManagedPiPackageDoctorReportMock,
}));

vi.mock('../core/drift.js', () => ({
  checkDrift: checkDriftMock,
}));

vi.mock('../core/skills-runtime-views.js', () => ({
  checkRuntimeSkillsViews: checkRuntimeSkillsViewsMock,
}));

vi.mock('../core/skill-discovery.js', () => ({
  discoverDefaultSkills: discoverDefaultSkillsMock,
}));

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
  checkRuntimeSkillsViewsMock.mockResolvedValue({ activeReady: true, claudePointerReady: true, piPointerReady: true, hasDeprecatedAgentsSkillsPath: false });
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

  it('reports missing pi-serena-tools in text and json without installing anything', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport({
      issues: [{ pkg: { id: 'npm:pi-serena-tools', displayName: 'pi-serena-tools', required: true }, npmPackageName: 'pi-serena-tools', installedVersion: null, expectedVersion: '1.1.0', state: 'missing', remediation: 'pi install npm:pi-serena-tools' }],
      missing: [{ pkg: { id: 'npm:pi-serena-tools', displayName: 'pi-serena-tools', required: true }, npmPackageName: 'pi-serena-tools', installedVersion: null, expectedVersion: '1.1.0', state: 'missing', remediation: 'pi install npm:pi-serena-tools' }],
      hasIssues: true,
    }));

    const textLogs = await runDoctorCli([]);
    expect(textLogs.join('\n')).toContain('missing');
    expect(textLogs.join('\n')).toContain('pi install npm:pi-serena-tools');
    expect(getXtManagedPiPackageDoctorReportMock).toHaveBeenCalled();

    const jsonLogs = await runDoctorCli(['--json']);
    const parsed = JSON.parse(jsonLogs[0]);
    expect(parsed.piPackages.hasIssues).toBe(true);
    expect(parsed.piPackages.missing[0].pkg.id).toBe('npm:pi-serena-tools');
  });

  it('reports outdated and version-unknown packages with visible warnings', async () => {
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue(buildReport({
      issues: [
        { pkg: { id: 'npm:pi-gitnexus', displayName: 'pi-gitnexus', required: true }, npmPackageName: 'pi-gitnexus', installedVersion: '1.0.0', expectedVersion: '1.1.0', state: 'outdated', remediation: 'pi install npm:pi-gitnexus' },
        { pkg: { id: 'npm:@aliou/pi-processes', displayName: 'pi-processes', required: true }, npmPackageName: 'pi-processes', installedVersion: '1.0.0', expectedVersion: null, state: 'version-unknown', remediation: 'check network/npm registry, then rerun xt doctor' },
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
});
