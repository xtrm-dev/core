import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

const mocked = vi.hoisted(() => {
    const runMachineBootstrap = vi.fn(async () => undefined);
    const runClaudeRuntimeSync = vi.fn(async () => ({
        installedOfficial: 0,
        alreadyInstalledOfficial: 4,
        failedOfficial: [],
        verificationPassed: true,
    }));
    const runInitVerification = vi.fn(async () => ({
        machineBootstrap: { allRequiredPresent: true, missingRequired: [] },
        claudeRuntime: { xtrmToolsPlugin: true, officialPlugins: ['serena'], missingPlugins: [] },
        piRuntime: { allRequiredPresent: true, missingExtensions: [], missingPackages: [] },
        projectBootstrap: { beadsInitialized: true, gitnexusIndexed: true, instructionHeaders: true },
        allPassed: true,
    }));
    const renderVerificationSummary = vi.fn();
    const getContext = vi.fn(async () => ({ targets: ['/tmp/.agents/skills'], syncMode: 'sync' }));
    const calculateDiff = vi.fn(async () => ({
        skills: { missing: ['a'], outdated: ['b'], drifted: [] },
    }));
    const findRepoRoot = vi.fn(async () => '/tmp/repo-root');
    const prompts = vi.fn(async () => ({ confirm: true }));
    const spawnSync = vi.fn();
    const installFromRegistry = vi.fn(async () => ({
        installed: 1,
        upToDate: 0,
        driftedSkipped: 0,
        forced: 0,
        expectedInstalls: 1,
        missingSourceSkipped: 0,
    }));
    const scaffoldSkillsDefaultFromPackage = vi.fn(async () => 'noop');
    const runPiInstall = vi.fn(async () => undefined);
    const runPluginEraCleanup = vi.fn(async () => undefined);
    const ensureAgentsSkillsSymlink = vi.fn(async () => ({
        activatedClaudeSkills: 0,
        activatedPiSkills: 0,
    }));
    const assertRuntimeSkillsViews = vi.fn(async () => undefined);
    const syncProjectMcpConfig = vi.fn(async () => ({
        addedServers: ['serena'],
        missingEnvWarnings: [],
        wroteFile: true,
        createdFile: true,
        mcpPath: '/tmp/project/.mcp.json',
    }));
    const syncPiMcpConfig = vi.fn(async () => ({
        addedServers: ['specialists'],
        missingEnvWarnings: [],
        wroteFile: true,
        createdFile: true,
        mcpPath: '/tmp/project/.pi/mcp.json',
    }));

    return {
        runMachineBootstrap,
        runClaudeRuntimeSync,
        runInitVerification,
        renderVerificationSummary,
        getContext,
        calculateDiff,
        findRepoRoot,
        prompts,
        spawnSync,
        installFromRegistry,
        scaffoldSkillsDefaultFromPackage,
        runPiInstall,
        runPluginEraCleanup,
        ensureAgentsSkillsSymlink,
        assertRuntimeSkillsViews,
        syncProjectMcpConfig,
        syncPiMcpConfig,
    };
});

vi.mock('../src/core/machine-bootstrap.js', () => ({
    inventoryDeps: vi.fn(() => ({
        deps: [],
        missingRequired: [],
        missingRecommended: [],
        allRequiredPresent: true,
        allPresent: true,
    })),
    renderBootstrapPlan: vi.fn(),
    runMachineBootstrapPhase: mocked.runMachineBootstrap,
}));

vi.mock('../src/core/claude-runtime-sync.js', () => ({
    runClaudeRuntimeSyncPhase: mocked.runClaudeRuntimeSync,
    renderClaudeRuntimePlanSummary: vi.fn(),
}));

vi.mock('../src/core/init-verification.js', () => ({
    runInitVerification: mocked.runInitVerification,
    renderVerificationSummary: mocked.renderVerificationSummary,
}));

vi.mock('../src/core/context.js', () => ({
    getContext: mocked.getContext,
}));

vi.mock('../src/core/diff.js', () => ({
    calculateDiff: mocked.calculateDiff,
}));

vi.mock('../src/utils/repo-root.js', () => ({
    findRepoRoot: mocked.findRepoRoot,
}));

vi.mock('../src/core/registry-scaffold.js', () => ({
    resolvePackageRoot: vi.fn(() => '/tmp/xtrm-pkg-root'),
    installFromRegistry: mocked.installFromRegistry,
    scaffoldSkillsDefaultFromPackage: mocked.scaffoldSkillsDefaultFromPackage,
}));

vi.mock('../src/commands/pi-install.js', () => ({
    runPiInstall: mocked.runPiInstall,
}));

vi.mock('../src/core/plugin-era-cleanup.js', () => ({
    runPluginEraCleanup: mocked.runPluginEraCleanup,
}));

vi.mock('../src/core/skills-scaffold.js', () => ({
    ensureAgentsSkillsSymlink: mocked.ensureAgentsSkillsSymlink,
}));

vi.mock('../src/core/skills-runtime-views.js', () => ({
    assertRuntimeSkillsViews: mocked.assertRuntimeSkillsViews,
}));

vi.mock('../src/core/project-mcp-sync.js', () => ({
    syncProjectMcpConfig: mocked.syncProjectMcpConfig,
    syncPiMcpConfig: mocked.syncPiMcpConfig,
}));

vi.mock('prompts', () => ({
    default: mocked.prompts,
}));

vi.mock('child_process', () => ({
    spawnSync: mocked.spawnSync,
}));

function setupSpawnSync(projectRoot: string, calls: string[]): void {
    // Tracks whether `gitnexus analyze` has already run. The gitnexus init phase
    // analyzes first; the later dependency-maintenance phase (Phase 8) re-checks the
    // index — once analyzed it must report fresh, otherwise the mock would trigger a
    // spurious second analyze that the real (stateful) index never would.
    let gitnexusAnalyzed = false;
    mocked.spawnSync.mockImplementation((command: string, args: string[] = [], options: any = {}) => {
        const key = `${command} ${args.join(' ')}`.trim();

        if (key === 'git rev-parse --show-toplevel') {
            return { status: 0, stdout: `${projectRoot}\n`, stderr: '' };
        }

        if (key === 'gitnexus status') {
            return gitnexusAnalyzed
                ? { status: 0, stdout: 'indexed', stderr: '' }
                : { status: 1, stdout: 'not indexed', stderr: '' };
        }

        if (key === 'gitnexus --version') {
            return { status: 0, stdout: 'gitnexus 1.0.0', stderr: '' };
        }

        if (key === 'git rev-parse HEAD') {
            return { status: 0, stdout: 'abc123\n', stderr: '' };
        }

        if (key === 'gitnexus analyze') {
            calls.push('gitnexus analyze');
            gitnexusAnalyzed = true;
            return { status: 0, stdout: 'indexed', stderr: '' };
        }

        if (key === 'bd init') {
            calls.push('bd init');
            return { status: 0, stdout: 'initialized', stderr: '' };
        }

        // Dependency-maintenance probes (machine-bootstrap inventoryDeps + Phase 8
        // dependency-maintenance). Generic so adding/removing a managed dep never
        // re-breaks this mock. installed === latest === 1.0.0 keeps every tool in the
        // 'current' state, so no npm-install update path is triggered.
        if (args.length === 1 && (args[0] === '--version' || args[0] === 'version')) {
            return { status: 0, stdout: '1.0.0\n', stderr: '' };
        }
        if (command === 'npm' && args[0] === 'view' && args[args.length - 1] === 'version') {
            return { status: 0, stdout: '1.0.0\n', stderr: '' };
        }

        throw new Error(`Unexpected spawnSync call: ${key} cwd=${options?.cwd ?? ''}`);
    });
}

describe('xtrm init phased orchestrator', () => {
    let projectRoot: string;
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;
    let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
    let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    let logs: string[];

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        logs = [];
        projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-init-project-'));
        await fs.writeFile(path.join(projectRoot, 'tsconfig.json'), '{}');

        const packageRoot = '/tmp/xtrm-pkg-root';
        await fs.ensureDir(path.join(packageRoot, '.xtrm'));
        await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), { version: '1.0.0', assets: {} });

        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
            logs.push(args.join(' '));
        });
        stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
        stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true as any);
        cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    });

    afterEach(async () => {
        consoleLogSpy.mockRestore();
        stdoutWriteSpy.mockRestore();
        stderrWriteSpy.mockRestore();
        cwdSpy.mockRestore();
        await fs.remove(projectRoot);
        await fs.remove('/tmp/xtrm-pkg-root');
    });

    it('renders the plan and stops before mutation in dry-run mode', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls);
        mocked.prompts.mockResolvedValue({ confirm: true });

        const { runProjectInit } = await import('../src/commands/init.js?t=dryrun-' + Date.now());
        await runProjectInit({ dryRun: true });

        expect(logs.join('\n')).toContain('xtrm init — Installation Plan');
        expect(logs.join('\n')).toContain('Dry run — no changes written');
        expect(mocked.prompts).not.toHaveBeenCalled();
        expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
        expect(mocked.installFromRegistry).not.toHaveBeenCalled();
        expect(mocked.scaffoldSkillsDefaultFromPackage).not.toHaveBeenCalled();
        expect(mocked.ensureAgentsSkillsSymlink).not.toHaveBeenCalled();
        expect(mocked.runPiInstall).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });

    it('respects the single confirmation gate before running mutating phases', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls);
        mocked.prompts.mockResolvedValue({ confirm: false });

        const { runProjectInit } = await import('../src/commands/init.js?t=cancel-' + Date.now());
        await runProjectInit();

        expect(mocked.prompts).toHaveBeenCalledTimes(1);
        expect(logs.join('\n')).toContain('Init cancelled.');
        expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
        expect(mocked.installFromRegistry).not.toHaveBeenCalled();
        expect(mocked.scaffoldSkillsDefaultFromPackage).not.toHaveBeenCalled();
        expect(mocked.ensureAgentsSkillsSymlink).not.toHaveBeenCalled();
        expect(mocked.runPiInstall).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });

    it('runs machine bootstrap before runtime sync and project bootstrap', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls);
        mocked.runMachineBootstrap.mockImplementation(async () => {
            calls.push('runMachineBootstrap');
        });
        mocked.runClaudeRuntimeSync.mockImplementation(async () => {
            calls.push('runClaudeRuntimeSync');
            return {
                installedOfficial: 0,
                alreadyInstalledOfficial: 4,
                failedOfficial: [],
                verificationPassed: true,
            };
        });
        mocked.installFromRegistry.mockImplementation(async () => {
            calls.push('installFromRegistry');
            return {
                installed: 1,
                upToDate: 0,
                driftedSkipped: 0,
                forced: 0,
                expectedInstalls: 1,
                missingSourceSkipped: 0,
            };
        });
        mocked.scaffoldSkillsDefaultFromPackage.mockImplementation(async () => {
            calls.push('scaffoldSkillsDefaultFromPackage');
            return 'noop';
        });
        mocked.runPiInstall.mockImplementation(async () => {
            calls.push('runPiInstall');
        });
        mocked.ensureAgentsSkillsSymlink.mockImplementation(async () => {
            calls.push('ensureAgentsSkillsSymlink');
            return {
                activatedClaudeSkills: 1,
                activatedPiSkills: 1,
            };
        });
        mocked.runInitVerification.mockImplementation(async () => {
            calls.push('runInitVerification');
            return {
                machineBootstrap: { allRequiredPresent: true, missingRequired: [] },
                claudeRuntime: { xtrmToolsPlugin: true, officialPlugins: ['serena'], missingPlugins: [] },
                piRuntime: { allRequiredPresent: true, missingExtensions: [], missingPackages: [] },
                projectBootstrap: { beadsInitialized: true, gitnexusIndexed: true, instructionHeaders: true },
                allPassed: true,
            };
        });

        const installModule = await import('../src/commands/install.js');
        const runInstallSpy = vi.spyOn(installModule, 'runInstall');

        const { runProjectInit } = await import('../src/commands/init.js?t=ordered-' + Date.now());
        await runProjectInit({ yes: true });

        expect(mocked.prompts).not.toHaveBeenCalled();
        expect(mocked.runMachineBootstrap).toHaveBeenCalledWith({ dryRun: false });
        expect(mocked.runClaudeRuntimeSync).toHaveBeenCalledWith(expect.objectContaining({
            repoRoot: projectRoot,
            dryRun: false,
            isGlobal: false,
        }));
        expect(mocked.installFromRegistry).toHaveBeenCalledTimes(1);
        expect(mocked.scaffoldSkillsDefaultFromPackage).toHaveBeenCalledTimes(1);
        expect(mocked.runPiInstall).toHaveBeenCalledWith(false, false, projectRoot);
        expect(mocked.syncProjectMcpConfig).toHaveBeenCalledWith(projectRoot, { preserveExistingFile: true });
        expect(mocked.syncPiMcpConfig).toHaveBeenCalledWith(projectRoot);
        expect(mocked.ensureAgentsSkillsSymlink).toHaveBeenCalledWith(projectRoot);
        expect(runInstallSpy).not.toHaveBeenCalled();
        expect(calls).toEqual([
            'runMachineBootstrap',
            'runClaudeRuntimeSync',
            'installFromRegistry',
            'scaffoldSkillsDefaultFromPackage',
            'runPiInstall',
            'ensureAgentsSkillsSymlink',
            'bd init',
            'gitnexus analyze',
            'runInitVerification',
        ]);

        const machineOrder = mocked.runMachineBootstrap.mock.invocationCallOrder[0];
        const runtimeOrder = mocked.runClaudeRuntimeSync.mock.invocationCallOrder[0];
        const registryOrder = mocked.installFromRegistry.mock.invocationCallOrder[0];
        const piMcpOrder = mocked.syncPiMcpConfig.mock.invocationCallOrder[0];
        const piInstallOrder = mocked.runPiInstall.mock.invocationCallOrder[0];
        const symlinkOrder = mocked.ensureAgentsSkillsSymlink.mock.invocationCallOrder[0];
        const verificationOrder = mocked.runInitVerification.mock.invocationCallOrder[0];

        expect(machineOrder).toBeLessThan(runtimeOrder);
        expect(runtimeOrder).toBeLessThan(registryOrder);
        expect(registryOrder).toBeLessThan(piMcpOrder);
        expect(piMcpOrder).toBeLessThan(piInstallOrder);
        expect(piInstallOrder).toBeLessThan(symlinkOrder);
        expect(symlinkOrder).toBeLessThan(verificationOrder);

        expect(mocked.runInitVerification).toHaveBeenCalledWith(projectRoot);
        expect(mocked.renderVerificationSummary).toHaveBeenCalled();
        expect(logs.join('\n')).toContain('Next steps:');
    });

    it('uses git root without prompting when --yes is supplied from a subdirectory', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls);
        cwdSpy.mockReturnValue(path.join(projectRoot, 'nested'));

        const { runProjectInit } = await import('../src/commands/init.js?t=subdir-yes-' + Date.now());
        await runProjectInit({ yes: true });

        expect(mocked.prompts).not.toHaveBeenCalled();
        expect(logs.join('\n')).toContain('CWD is not the git root.');
        expect(logs.join('\n')).toContain('--yes supplied; proceeding with the git root.');
        expect(mocked.runMachineBootstrap).toHaveBeenCalledWith({ dryRun: false });
    });

    it('surfaces actionable error when source repo root cannot be resolved', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls);
        mocked.findRepoRoot.mockRejectedValueOnce(new Error('Could not locate xtrm-tools source repo root from current runtime.'));

        const { runProjectInit } = await import('../src/commands/init.js?t=missing-root-' + Date.now());
        await expect(runProjectInit({ yes: true })).rejects.toThrow('Could not locate xtrm-tools source repo root from current runtime.');

        expect(mocked.ensureAgentsSkillsSymlink).not.toHaveBeenCalled();
    });
});
