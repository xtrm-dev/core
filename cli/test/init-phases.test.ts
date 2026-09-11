import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

// Real spawn for the fixture setup.ts: the child_process mock below throws
// on unknown calls, but enrollment must execute the real fixture script.
const realSpawnSync = createRequire(import.meta.url)('node:child_process').spawnSync as typeof import('node:child_process').spawnSync;
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const mocked = vi.hoisted(() => {
    const runMachineBootstrap = vi.fn(async () => undefined);
    const runClaudeRuntimeSync = vi.fn(async () => ({
        installedOfficial: 0,
        alreadyInstalledOfficial: 4,
        failedOfficial: [],
        verificationPassed: true,
    }));
    const reconcileGlobalClaudeHooks = vi.fn(async () => undefined);
    const reconcileGlobalPiHooks = vi.fn(async () => undefined);
    const runInitVerification = vi.fn(async () => ({
        machineBootstrap: { allRequiredPresent: true, missingRequired: [] },
        claudeRuntime: { xtrmToolsPlugin: true, officialPlugins: ['context7'], missingPlugins: [] },
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
    const ensureUserAgentsSkillsSymlink = vi.fn(async () => undefined);
    const ensureAgentsSkillsSymlink = vi.fn(async () => ({
        activatedClaudeSkills: 0,
        activatedPiSkills: 0,
        activatedCodexSkills: 0,
    }));
    const assertRuntimeSkillsViews = vi.fn(async () => undefined);
    const syncProjectMcpConfig = vi.fn(async () => ({
        addedServers: ['github-grep'],
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
        reconcileGlobalClaudeHooks,
        reconcileGlobalPiHooks,
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
        ensureUserAgentsSkillsSymlink,
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
    reconcileGlobalClaudeHooks: mocked.reconcileGlobalClaudeHooks,
    renderClaudeRuntimePlanSummary: vi.fn(),
}));

vi.mock('../src/core/pi-runtime-hooks.js', () => ({
    reconcileGlobalPiHooks: mocked.reconcileGlobalPiHooks,
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
    ensureUserAgentsSkillsSymlink: mocked.ensureUserAgentsSkillsSymlink,
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

function writeOctal(buf: Buffer, offset: number, value: number, digits: number): void {
    buf.write(value.toString(8).padStart(digits, '0'), offset, digits, 'ascii');
    buf[offset + digits] = 0;
}

function buildMinimalSkillsBackup(): Buffer {
    const entries = ['skills/', 'skills/default/', 'skills/optional/'];
    const chunks: Buffer[] = [];
    for (const name of entries) {
        const header = Buffer.alloc(512);
        header.write(name.slice(0, 100), 0, 'utf8');
        writeOctal(header, 100, 0o755, 7);
        writeOctal(header, 108, 1000, 7);
        writeOctal(header, 116, 1000, 7);
        writeOctal(header, 124, 0, 11);
        writeOctal(header, 136, 1700000000, 11);
        header[156] = '5'.charCodeAt(0);
        header.write('ustar', 257, 'ascii');
        header.write('00', 263, 'ascii');
        header.fill(0x20, 148, 156);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += header[i];
        header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
        header[154] = 0;
        header[155] = 0x20;
        chunks.push(header);
    }
    chunks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(chunks));
}

function setupSpawnSync(projectRoot: string, calls: string[], opts: { linked?: boolean } = {}): void {
    const initiallyLinked = opts.linked ?? true;
    // Stateful link: a successful link/create flips later doctor probes to
    // linked, mirroring the real sb store. Without this, Phase 7
    // re-verification would see a stale unlinked state.
    let linkSucceeded = false;
    // Tracks whether `gitnexus analyze` has already run. The gitnexus init phase
    // analyzes first; the later dependency-maintenance phase (Phase 8) re-checks the
    // index — once analyzed it must report fresh, otherwise the mock would trigger a
    // spurious second analyze that the real (stateful) index never would.
    let gitnexusAnalyzed = false;
    mocked.spawnSync.mockImplementation((command: string, args: string[] = [], options: any = {}) => {
        // Enrollment fixture: real execution, hermetic script, no network.
        if (command === 'node' && typeof args[0] === 'string' && args[0].endsWith(path.join('integrations', 'setup.ts'))) {
            calls.push(`setup.ts ${args[1] ?? ''}`);
            return realSpawnSync(command, args, options);
        }
        const key = `${command} ${args.join(' ')}`.trim();
        // Fixture plan noop command (real, side-effect-free).
        if (key === 'true') {
            calls.push('true');
            return { status: 0, stdout: '', stderr: '' };
        }

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

        // Substrate-first project init: link state comes from doctor
        // data.link (no `project list` verb exists); healthy envelope here.
        if (key === 'sb doctor --json') {
            calls.push('sb doctor --json');
            const isLinked = initiallyLinked || linkSucceeded;
            const link = isLinked ? ',"link":{"projectId":"XTRM-1","source":"link"}' : ',"link":null,"linkError":"none"';
            return { status: 0, stdout: `{"schema":"substrate-cli/v1","command":"doctor","ok":true,"data":{"dbPath":"x","schemaHealthy":true${link}}}`, stderr: '' };
        }

        if (key === 'sb project link' || key.startsWith('sb project link --project ')) {
            calls.push(key);
            if (key.endsWith('NOPE')) return { status: 1, stdout: '', stderr: 'unknown project' };
            linkSucceeded = true;
            return { status: 0, stdout: 'linked', stderr: '' };
        }

        if (key.startsWith('sb project create ')) {
            calls.push(key);
            linkSucceeded = true;
            return { status: 0, stdout: '{"id":"prj_fixture"}', stderr: '' };
        }

        // Internal verified global-skills backup creation during init bootstrap.
        if (command === 'tar' && args[0] === '-czf') {
            fs.ensureDirSync(path.dirname(args[1]));
            fs.writeFileSync(args[1], buildMinimalSkillsBackup());
            return { status: 0, stdout: '', stderr: '' };
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
    let sandboxHome: string;
    let previousHome: string | undefined;
    let substrateDir: string;
    let previousSubstrateDir: string | undefined;
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

        // xtrm-8zsi1: init.ts triggers ensureGlobalHooksBootstrapped and
        // ensureGlobalSkillsBootstrapped, both of which resolve os.homedir().
        // Without sandboxing HOME here, those functions write to the real
        // user's ~/.xtrm/{hooks,skills}/state.json and wipe the operator's
        // global install. Sandbox HOME to a per-test tmp dir; the test-setup
        // guard also throws if this ever regresses.
        sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-init-home-'));
        previousHome = process.env.HOME;
        process.env.HOME = sandboxHome;
        // Hermetic substrate source: plan carries one noop command, check
        // reports the full six-item enrollment healthy. Exercises the real
        // enrollment flow without network.
        substrateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-init-substrate-'));
        previousSubstrateDir = process.env.XTRM_SUBSTRATE_DIR;
        process.env.XTRM_SUBSTRATE_DIR = substrateDir;
        await fs.ensureDir(path.join(substrateDir, 'integrations'));
        await fs.writeJson(path.join(substrateDir, 'package.json'), { name: '@xtrm/substrate', version: '0.0.0-test' });
        await fs.writeFile(
            path.join(substrateDir, 'integrations', 'setup.ts'),
            '#!/usr/bin/env node\n' +
            'const args = process.argv.slice(2);\n' +
            'const verb = args[0];\n' +
            'const ENROLL = [{name:\'sb-enrolled\',ok:true},{name:\'pi-enrolled\',ok:true},{name:\'claude-marketplace-enrolled\',ok:true},{name:\'claude-plugin-enrolled\',ok:true},{name:\'claude-strict-live\',ok:true},{name:\'beads-absent\',ok:true}];\n' +
            'if (verb === \'plan\') { process.stdout.write(JSON.stringify({ surfaces: [], dir: process.env.XTRM_SUBSTRATE_DIR, commands: [{label:\'noop\',cmd:\'true\',args:[]}] })); }\n' +
            'else if (verb === \'check\') { process.stdout.write(JSON.stringify({ ok: true, claude: [], pi: [], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false }, enrollment: ENROLL })); }\n' +
            'else { process.stderr.write(\'bad verb\'); process.exit(1); }\n',
        );

        const packageRoot = '/tmp/xtrm-pkg-root';
        await fs.ensureDir(path.join(packageRoot, '.xtrm'));
        await fs.writeJson(path.join(packageRoot, '.xtrm', 'registry.json'), { version: '1.0.0', assets: {} });
        // Batch B/J bootstrap logging reads pkgJson.version — mock package.json.
        await fs.writeJson(path.join(packageRoot, 'package.json'), { name: 'xtrm-tools', version: '0.0.0-test' });
        // Batch A global-skills bootstrap copies from packageRoot/.xtrm/skills/{default,optional,user};
        // mock empty tiers so ensureGlobalSkillsBootstrapped has something to walk.
        await fs.ensureDir(path.join(packageRoot, '.xtrm', 'skills', 'default'));
        await fs.ensureDir(path.join(packageRoot, '.xtrm', 'skills', 'optional'));
        // Batch J global-hooks bootstrap copies packageRoot/.xtrm/hooks and packageRoot/.xtrm/config/hooks.json.
        await fs.ensureDir(path.join(packageRoot, '.xtrm', 'hooks'));
        await fs.ensureDir(path.join(packageRoot, '.xtrm', 'config'));
        await fs.writeJson(path.join(packageRoot, '.xtrm', 'config', 'hooks.json'), { hooks: {} });

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
        await fs.remove(sandboxHome);
        await fs.remove(substrateDir);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousSubstrateDir === undefined) delete process.env.XTRM_SUBSTRATE_DIR;
        else process.env.XTRM_SUBSTRATE_DIR = previousSubstrateDir;
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
        expect(calls).toEqual(['sb doctor --json']);
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
        expect(calls).toEqual(['sb doctor --json']);
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
                activatedCodexSkills: 1,
            };
        });
        mocked.runInitVerification.mockImplementation(async () => {
            calls.push('runInitVerification');
            return {
                machineBootstrap: { allRequiredPresent: true, missingRequired: [] },
                claudeRuntime: { xtrmToolsPlugin: true, officialPlugins: ['context7'], missingPlugins: [] },
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
            'sb doctor --json',
            'sb doctor --json',
            'setup.ts plan',
            'true',
            'setup.ts check',
            'sb doctor --json',
            'runMachineBootstrap',
            'runClaudeRuntimeSync',
            'installFromRegistry',
            'scaffoldSkillsDefaultFromPackage',
            'runPiInstall',
            'ensureAgentsSkillsSymlink',
            'sb doctor --json',
            'gitnexus analyze',
            'sb doctor --json',
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

        // Phase 9 verifies the exact source this run enrolled (threaded through).
        expect(mocked.runInitVerification).toHaveBeenCalledWith(
            projectRoot,
            expect.stringContaining(path.join('integrations', 'setup.ts')),
            process.env.XTRM_SUBSTRATE_DIR,
        );
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

    it('links an existing project with --sb-project when unlinked', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });

        const { runProjectInit } = await import('../src/commands/init.js?t=sb-link-' + Date.now());
        await runProjectInit({ yes: true, sbProject: 'XTRM-9' });

        expect(calls).toContain('sb project link --project XTRM-9');
        expect(logs.join('\n')).toContain('linked to Substrate project XTRM-9');
        expect(process.exitCode ?? 0).toBe(0);
    });

    it('creates and links with --sb-create-project when unlinked', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });

        const { runProjectInit } = await import('../src/commands/init.js?t=sb-create-' + Date.now());
        await runProjectInit({ yes: true, sbCreateProject: 'X:Demo' });

        expect(calls).toContain('sb project create --prefix X --name Demo');
        // created id links explicitly: unambiguous in a non-empty store.
        expect(calls).toContain('sb project link --project prj_fixture');
        expect(logs.join('\n')).toContain('created and linked');
        expect(process.exitCode ?? 0).toBe(0);
    });

    it('fails closed when unlinked, non-interactive, and no project flags', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-nolink-' + Date.now());
            await runProjectInit({ yes: true });

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('--sb-project');
            expect(logs.join('\n')).toContain('--sb-create-project');
            // pre-confirm gate: no phase runs, not even machine bootstrap.
            expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
            expect(mocked.runClaudeRuntimeSync).not.toHaveBeenCalled();
            // and enrollment never shells its commands.
            expect(calls.filter(c => c.startsWith('setup.ts'))).toHaveLength(0);
        } finally {
            process.exitCode = previousExitCode;
        }
    });

    it('rejects malformed --sb-create-project values', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-badflag-' + Date.now());
            await runProjectInit({ yes: true, sbCreateProject: 'no-colon-here' });

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('PREFIX:Name');
            expect(calls.filter(c => c.startsWith('sb project create'))).toHaveLength(0);
        } finally {
            process.exitCode = previousExitCode;
        }
    });

    it('fails before mutations on malformed --sb-create-project', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-badflag35-' + Date.now());
            await runProjectInit({ yes: true, sbCreateProject: 'no-colon-here' });

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('PREFIX:Name');
            expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
            expect(mocked.runClaudeRuntimeSync).not.toHaveBeenCalled();
            expect(calls.filter(c => c.startsWith('sb project create'))).toHaveLength(0);
            // Phase 3.4 pure validation precedes enrollment: zero setup calls.
            expect(calls.filter(c => c.startsWith('setup.ts'))).toHaveLength(0);
        } finally {
            process.exitCode = previousExitCode;
        }
    });

    it('rejects conflicting --sb-project and --sb-create-project', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-both-' + Date.now());
            await runProjectInit({ yes: true, sbProject: 'XTRM-9', sbCreateProject: 'X:Demo' });

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('only one of');
            expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
            expect(calls.filter(c => c.startsWith('sb project'))).toHaveLength(0);
            // Phase 3.4 conflict check precedes enrollment: zero setup calls.
            expect(calls.filter(c => c.startsWith('setup.ts'))).toHaveLength(0);
        } finally {
            process.exitCode = previousExitCode;
        }
    });

    it('fails closed on a legacy .beads board before any enrollment mutation', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;
        await fs.ensureDir(path.join(projectRoot, '.beads'));

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-legacy-' + Date.now());
            await runProjectInit({ yes: true, sbCreateProject: 'X:Demo' });

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('migration');
            expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
            expect(mocked.runClaudeRuntimeSync).not.toHaveBeenCalled();
            // migration detection precedes enrollment: zero setup + sb calls.
            expect(calls.filter(c => c.startsWith('setup.ts'))).toHaveLength(0);
            expect(calls.filter(c => c.startsWith('sb project'))).toHaveLength(0);
        } finally {
            process.exitCode = previousExitCode;
            await fs.remove(path.join(projectRoot, '.beads'));
        }
    });

    it('collects interactive identity intent before enrollment; skip cancels with zero setup calls', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;
        mocked.prompts.mockResolvedValueOnce({ confirm: true }).mockResolvedValueOnce({ action: 'skip' });
        for (const stream of [process.stdin, process.stdout] as const) {
            Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
        }

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-interactive-skip-' + Date.now());
            await runProjectInit({});

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('link later');
            // cancellation precedes enrollment: zero setup + sb calls.
            expect(calls.filter(c => c.startsWith('setup.ts'))).toHaveLength(0);
            expect(calls.filter(c => c.startsWith('sb project'))).toHaveLength(0);
            expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
        } finally {
            process.exitCode = previousExitCode;
            for (const stream of [process.stdin, process.stdout] as const) {
                Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
            }
        }
    });

    it('fails closed when create returns no project id (never a bare link)', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;
        const prevImpl = mocked.spawnSync.getMockImplementation();
        mocked.spawnSync.mockImplementation((command: string, args: string[] = [], options: any = {}) => {
            const key = `${command} ${args.join(' ')}`.trim();
            if (key.startsWith('sb project create ')) {
                calls.push(`${key} [no-id]`);
                return { status: 0, stdout: 'created', stderr: '' };
            }
            return prevImpl!(command, args, options);
        });

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-noid-' + Date.now());
            await runProjectInit({ yes: true, sbCreateProject: 'X:Demo' });

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('no project id');
            // created but never linked: zero link calls of any form.
            expect(calls.filter(c => c.startsWith('sb project link'))).toHaveLength(0);
        } finally {
            process.exitCode = previousExitCode;
        }
    });

    it('fails before mutations on nonexistent --sb-project', async () => {
        const calls: string[] = [];
        setupSpawnSync(projectRoot, calls, { linked: false });
        const previousExitCode = process.exitCode;

        try {
            const { runProjectInit } = await import('../src/commands/init.js?t=sb-nolink35-' + Date.now());
            await runProjectInit({ yes: true, sbProject: 'NOPE' });

            expect(process.exitCode).toBe(1);
            expect(logs.join('\n')).toContain('failed');
            expect(mocked.runMachineBootstrap).not.toHaveBeenCalled();
            expect(mocked.runClaudeRuntimeSync).not.toHaveBeenCalled();
        } finally {
            process.exitCode = previousExitCode;
        }
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
