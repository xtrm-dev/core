import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getXtManagedPiPackageDoctorReportMock = vi.hoisted(() => vi.fn());
const checkDriftMock = vi.hoisted(() => vi.fn());
const checkRuntimeSkillsViewsMock = vi.hoisted(() => vi.fn());
const discoverDefaultSkillsMock = vi.hoisted(() => vi.fn());

vi.mock('../core/pi-runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/pi-runtime.js')>();
    return { ...actual, getXtManagedPiPackageDoctorReport: getXtManagedPiPackageDoctorReportMock };
});

// Hermetic substrate boundary: the doctor action otherwise spawns sb, npm, and node.
vi.mock('../core/substrate.js', async () => {
    const actual = await vi.importActual<typeof import('../core/substrate.js')>('../core/substrate.js');
    return {
        ...actual,
        getSbVersion: () => ({ available: true, version: '0.1.0-stub', raw: 'sb 0.1.0-stub' }),
        getSbDoctorJson: () => ({
            ok: true,
            payload: { schema: 'substrate-cli/v1', command: 'doctor', ok: true },
            data: { dbPath: 'state.db', schemaHealthy: true, schemaError: null, projects: 1, link: { projectId: 'XTRM-1', source: 'link' }, linkError: null, gitRoot: '/repo' },
            raw: '{}',
        }),
        runSetupCheck: () => ({
            ok: true,
            report: { ok: true, claude: [], pi: [], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false }, enrollment: [{ name: 'sb-enrolled', ok: true }] },
            raw: '{}',
        }),
    };
});

vi.mock('../core/drift.js', () => ({ checkDrift: checkDriftMock }));
vi.mock('../core/skills-runtime-views.js', () => ({ checkRuntimeSkillsViews: checkRuntimeSkillsViewsMock }));
vi.mock('../core/skill-discovery.js', () => ({ discoverDefaultSkills: discoverDefaultSkillsMock }));
vi.mock('../utils/npm-latest.js', () => ({
    checkXtrmUpdates: () => [],
    defaultCacheFile: () => '/tmp/xtrm-doctor-cache.json',
    formatUpdateRows: () => [],
    updatesSummary: () => '',
}));

import { createDoctorCommand } from '../commands/doctor.js';

let tmpRoot = '';
let previousCwd = '';
const savedEnv: Record<string, string | undefined> = {};
let savedExitCode: typeof process.exitCode;

function userConfigPath(): string {
    return path.join(tmpRoot, '.config', 'specialists', 'user.json');
}

function writeUserConfig(value: unknown): void {
    fs.ensureDirSync(path.dirname(userConfigPath()));
    fs.writeFileSync(userConfigPath(), JSON.stringify(value));
}

async function runDoctor(args: string[]): Promise<string[]> {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
        logs.push(values.map(String).join(' '));
    });
    try {
        await createDoctorCommand().parseAsync(['node', 'xtrm-doctor-test', ...args]);
        return logs;
    } finally {
        spy.mockRestore();
    }
}

beforeEach(() => {
    previousCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-claude-route-doctor-'));
    process.chdir(tmpRoot);
    fs.ensureDirSync(path.join(tmpRoot, '.xtrm'));
    fs.writeJsonSync(path.join(tmpRoot, '.xtrm', 'registry.json'), { version: '1', assets: {} }, { spaces: 2 });
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    for (const key of ['HOME', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
    process.env.HOME = tmpRoot;
    delete process.env.XDG_CONFIG_HOME;
    checkDriftMock.mockResolvedValue({ missing: [], upToDate: [], drifted: [] });
    checkRuntimeSkillsViewsMock.mockResolvedValue({ activeReady: true, globalClaudePointerReady: true, globalPiPointerReady: true, globalActivationReady: true, projectClaudePointerState: 'ready', projectPiPointerState: 'ready', projectCodexPointerState: 'ready', hasDeprecatedAgentsSkillsPath: false });
    discoverDefaultSkillsMock.mockResolvedValue([]);
    getXtManagedPiPackageDoctorReportMock.mockReset();
    getXtManagedPiPackageDoctorReportMock.mockResolvedValue({ issues: [], missing: [], outdated: [], ok: [], hasIssues: false, bridge: null });
});

afterEach(() => {
    process.exitCode = savedExitCode;
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    process.chdir(previousCwd);
    fs.removeSync(tmpRoot);
    vi.restoreAllMocks();
});

describe('xt doctor — Claude route section', () => {
    it('reports an unconfigured route as fine', async () => {
        const logs = await runDoctor([]);
        const text = logs.join('\n');
        expect(text).toContain('Claude route');
        expect(text).toMatch(/route not configured/);
    });

    it('reports the configured allow list and the bridge package', async () => {
        writeUserConfig({
            claude_bridge: {
                enabled: true,
                default_model: 'claude-bridge/claude-sonnet-4-5',
                specialists: ['worker', 'reviewer'],
            },
        });
        getXtManagedPiPackageDoctorReportMock.mockResolvedValue({
            issues: [], missing: [], outdated: [], ok: [], hasIssues: false,
            bridge: { installedVersion: '0.12.0' },
        });
        const logs = await runDoctor([]);
        const text = logs.join('\n');
        expect(text).toMatch(/route enabled for 2 listed Specialist\(s\): worker, reviewer/);
        expect(text).toMatch(/pi-claude-bridge installed \(0\.12\.0\)/);
    });

    it('warns when the route is enabled but the bridge package is absent', async () => {
        writeUserConfig({
            claude_bridge: {
                enabled: true,
                default_model: 'claude-bridge/claude-sonnet-4-5',
                specialists: ['worker'],
            },
        });
        const logs = await runDoctor([]);
        expect(logs.join('\n')).toMatch(/pi-claude-bridge is not installed/);
    });

    it('reports an invalid block without failing doctor, and names a remedy that clears it', async () => {
        writeUserConfig({ claude_bridge: { enabled: true, specialists: ['*'] } });
        const logs = await runDoctor([]);
        const text = logs.join('\n');
        expect(text).toMatch(/invalid claude_bridge block/);
        expect(text).toMatch(/xt claude-route disable --purge/);
        expect(process.exitCode).toBe(0);
    });

    it('tells the operator to repair an unparseable file by hand, not to run a command that refuses', async () => {
        fs.ensureDirSync(path.dirname(userConfigPath()));
        fs.writeFileSync(userConfigPath(), '{ "worker": ');
        const logs = await runDoctor([]);
        const text = logs.join('\n');
        expect(text).toMatch(/repair .*user\.json by hand/);
        expect(text).not.toMatch(/run: xt claude-route disable/);
        expect(process.exitCode).toBe(0);
    });

    it('exposes the route state in the JSON payload', async () => {
        writeUserConfig({
            claude_bridge: {
                enabled: true,
                default_model: 'claude-bridge/claude-sonnet-4-5',
                specialists: ['worker'],
            },
        });
        const logs = await runDoctor(['--json']);
        const payload = JSON.parse(logs.join('\n')) as Record<string, any>;
        expect(payload.claudeRoute).toMatchObject({
            present: true,
            enabled: true,
            listedSpecialists: ['worker'],
            bridge_package_version: null,
        });
        expect(payload.claudeRoute.path).toBe(userConfigPath());
    });
});
