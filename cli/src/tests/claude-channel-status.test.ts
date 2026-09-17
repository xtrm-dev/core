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
  report: { ok: true, claude: [], pi: [], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false }, enrollment: [{ name: 'sb-enrolled', ok: true }] },
  raw: '{}',
})));

vi.mock('../core/pi-runtime.js', () => ({
  getXtManagedPiPackageDoctorReport: getXtManagedPiPackageDoctorReportMock,
}));

// Hermetic substrate boundary: the real doctor action otherwise spawns sb,
// npm, and node subprocesses.
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

import {
  CLAUDE_CHANNEL_POLICY_JSON,
  defaultManagedSettingsPath,
  getClaudeChannelStatus,
  type ClaudeChannelPaths,
} from '../core/claude-channel-status.js';
import { createDoctorCommand } from '../commands/doctor.js';

let tmpRoot = '';
let previousCwd = '';
const savedEnv: Record<string, string | undefined> = {};

function writeManifest(home: string, withPlugin: boolean): string {
  const dir = path.join(home, '.claude', 'plugins');
  fs.ensureDirSync(dir);
  const manifestPath = path.join(dir, 'installed_plugins.json');
  const plugins: Record<string, unknown[]> = withPlugin
    ? { 'specialists@xtrm': [{ scope: 'user', installPath: '/tmp/fixture', version: '1.0.0' }] }
    : { 'other@place': [{ scope: 'user', installPath: '/tmp/fixture', version: '1.0.0' }] };
  fs.writeJsonSync(manifestPath, { version: 2, plugins });
  return manifestPath;
}

function pathsFor(name: string, withPlugin: boolean): ClaudeChannelPaths {
  const home = path.join(tmpRoot, name);
  return {
    managedSettingsPath: path.join(tmpRoot, `${name}-managed-settings.json`),
    installedPluginsPath: writeManifest(home, withPlugin),
  };
}

function writePolicy(paths: ClaudeChannelPaths, value: unknown): void {
  fs.writeFileSync(paths.managedSettingsPath, typeof value === 'string' ? value : JSON.stringify(value));
}

beforeEach(() => {
  previousCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-channel-status-'));
  process.chdir(tmpRoot);
  fs.ensureDirSync(path.join(tmpRoot, '.xtrm'));
  fs.writeJsonSync(path.join(tmpRoot, '.xtrm', 'registry.json'), { version: '1', assets: {} }, { spaces: 2 });
  for (const key of ['XT_CLAUDE_MANAGED_SETTINGS_PATH', 'XT_CLAUDE_INSTALLED_PLUGINS_PATH']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  checkDriftMock.mockResolvedValue({ missing: [], upToDate: [], drifted: [] });
  checkRuntimeSkillsViewsMock.mockResolvedValue({ activeReady: true, globalClaudePointerReady: true, globalPiPointerReady: true, globalActivationReady: true, projectClaudePointerState: 'ready', projectPiPointerState: 'ready', projectCodexPointerState: 'ready', hasDeprecatedAgentsSkillsPath: false });
  discoverDefaultSkillsMock.mockResolvedValue([]);
  getXtManagedPiPackageDoctorReportMock.mockReset();
  getXtManagedPiPackageDoctorReportMock.mockResolvedValue({ issues: [], missing: [], outdated: [], ok: [], hasIssues: false });
});

afterEach(() => {
  for (const key of ['XT_CLAUDE_MANAGED_SETTINGS_PATH', 'XT_CLAUDE_INSTALLED_PLUGINS_PATH']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  process.chdir(previousCwd);
  fs.removeSync(tmpRoot);
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

describe('getClaudeChannelStatus', () => {
  it('not_applicable when the plugin manifest has no specialists entry', () => {
    const paths = pathsFor('absent', false);
    const result = getClaudeChannelStatus(paths);
    expect(result.state).toBe('not_applicable');
    expect(result.pluginInstalled).toBe(false);
    expect(result.managedSettingsPath).toBe(paths.managedSettingsPath);
    expect(result.installedPluginsPath).toBe(paths.installedPluginsPath);
  });

  it('allowlist_missing when the plugin is installed but no policy file exists', () => {
    const paths = pathsFor('no-policy', true);
    const result = getClaudeChannelStatus(paths);
    expect(result.state).toBe('allowlist_missing');
    expect(result.pluginInstalled).toBe(true);
  });

  it('gate_armed_without_channels_enabled when the file exists but channelsEnabled !== true', () => {
    const paths = pathsFor('no-gate', true);
    // The exact trap from docs/xt-claude-channels.md: allowlist present,
    // channelsEnabled omitted — writing the file armed the gate.
    writePolicy(paths, { allowedChannelPlugins: [{ plugin: 'specialists', marketplace: 'xtrm' }] });
    const result = getClaudeChannelStatus(paths);
    expect(result.state).toBe('gate_armed_without_channels_enabled');
    expect(result.pluginInstalled).toBe(true);
  });

  it('allowlist_entry_missing for a string-shaped allowlist entry', () => {
    const paths = pathsFor('string-entry', true);
    writePolicy(paths, { channelsEnabled: true, allowedChannelPlugins: ['specialists@xtrm'] });
    const result = getClaudeChannelStatus(paths);
    expect(result.state).toBe('allowlist_entry_missing');
    expect(result.pluginInstalled).toBe(true);
  });

  it('configured for the correct object entry', () => {
    const paths = pathsFor('ok', true);
    writePolicy(paths, { channelsEnabled: true, allowedChannelPlugins: [{ plugin: 'specialists', marketplace: 'xtrm' }] });
    const result = getClaudeChannelStatus(paths);
    expect(result.state).toBe('configured');
    expect(result.pluginInstalled).toBe(true);
  });

  it('malformed for invalid JSON', () => {
    const paths = pathsFor('broken', true);
    writePolicy(paths, 'not json{{{');
    const result = getClaudeChannelStatus(paths);
    expect(result.state).toBe('malformed');
    expect(result.pluginInstalled).toBe(true);
  });

  it('resolves the platform policy path', () => {
    expect(defaultManagedSettingsPath('darwin')).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(defaultManagedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json');
  });

  it('remediation JSON carries both required keys', () => {
    const parsed = JSON.parse(CLAUDE_CHANNEL_POLICY_JSON) as Record<string, unknown>;
    expect(parsed.channelsEnabled).toBe(true);
    expect(parsed.allowedChannelPlugins).toEqual([{ plugin: 'specialists', marketplace: 'xtrm' }]);
  });
});

describe('xt doctor claude-channels section', () => {
  it('renders the section and leaves the exit code unchanged on a misconfigured fixture', async () => {
    const paths = pathsFor('doctor', true);
    process.env.XT_CLAUDE_INSTALLED_PLUGINS_PATH = paths.installedPluginsPath;
    process.env.XT_CLAUDE_MANAGED_SETTINGS_PATH = paths.managedSettingsPath;
    const previousExitCode = process.exitCode;

    const textLogs = await runDoctorCli([]);
    const text = textLogs.join('\n');
    expect(text).toContain('Claude channels');
    expect(text).toContain('specialists doctor --channels');
    expect(text).toContain('docs/xt-claude-channels.md');
    expect(process.exitCode).toBe(previousExitCode);

    const jsonLogs = await runDoctorCli(['--json']);
    const parsed = JSON.parse(jsonLogs[0]) as { claudeChannels: { state: string } };
    expect(parsed.claudeChannels.state).toBe('allowlist_missing');
    expect(process.exitCode).toBe(previousExitCode);
  });
});
