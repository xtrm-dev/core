import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(__dirname, '../dist/index.cjs');

// xtrm-8zsi1: `xt init --yes` (spawned as a subprocess below) runs the real
// installer which resolves os.homedir() and writes ~/.xtrm/skills/state.json
// + ~/.xtrm/hooks/state.json. Without a per-suite sandbox HOME, that wipes
// the operator's real global install. The subprocess inherits our env, so
// setting HOME here propagates automatically.
let __sandboxHome = '';
let __sandboxBin = '';
let __sandboxSubstrate = '';
let __prevHome: string | undefined;
let __prevPath: string | undefined;
let __prevSubstrateDir: string | undefined;
beforeAll(() => {
    __sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-init-cli-home-'));
    __sandboxBin = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-init-cli-bin-'));
    __sandboxSubstrate = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-init-cli-substrate-'));
    __prevHome = process.env.HOME;
    __prevPath = process.env.PATH;
    __prevSubstrateDir = process.env.XTRM_SUBSTRATE_DIR;
    process.env.HOME = __sandboxHome;
    process.env.XTRM_SUBSTRATE_DIR = __sandboxSubstrate;
    // Fixture substrate source: plan validates with one noop command, check
    // reports the full six-item enrollment healthy. Exercises the real
    // enrollment flow hermetically.
    fs.mkdirSync(path.join(__sandboxSubstrate, 'integrations'), { recursive: true });
    fs.writeFileSync(path.join(__sandboxSubstrate, 'package.json'), JSON.stringify({ name: '@xtrm/substrate', version: '0.0.0-test' }));
    fs.writeFileSync(
        path.join(__sandboxSubstrate, 'integrations', 'setup.ts'),
        '#!/usr/bin/env node\n' +
        'const args = process.argv.slice(2);\n' +
        'const verb = args[0];\n' +
        'const dirIdx = args.indexOf(\'--dir\');\n' +
        'const dir = dirIdx >= 0 ? args[dirIdx + 1] : null;\n' +
        'if (!dir) { process.stderr.write(\'--dir required\'); process.exit(2); }\n' +
        'const ENROLL = [{name:\'sb-enrolled\',ok:true},{name:\'pi-enrolled\',ok:true},{name:\'claude-marketplace-enrolled\',ok:true},{name:\'claude-plugin-enrolled\',ok:true},{name:\'claude-strict-live\',ok:true},{name:\'beads-absent\',ok:true}];\n' +
        'if (verb === \'plan\') { process.stdout.write(JSON.stringify({ surfaces: [], dir, commands: [{label:\'noop\',cmd:\'true\',args:[]}] })); }\n' +
        'else if (verb === \'check\') { process.stdout.write(JSON.stringify({ ok: true, claude: [], pi: [], naming: { substratePlugins: [], beadsRemnants: [], duplicates: false }, enrollment: ENROLL })); }\n' +
        'else { process.stderr.write(\'bad verb\'); process.exit(1); }\n',
    );
    // Keep init integration hermetic. The host may expose an incompatible
    // legacy `sb`, which makes the installer attempt a network package install
    // and turns this no-prompt test into a 120s timeout. A tiny executable
    // satisfies the confirmed version/list probes without real subprocess
    // contention; Substrate behavior is covered by the mocked unit tests.
    const fakeCommands: Record<string, string> = {
        sb: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "sb 0.0.0-init-test"; elif [ "$1" = "doctor" ]; then if [ -f "${SB_STATE_FILE:-/nonexistent}" ]; then echo \'{"schema":"substrate-cli/v1","command":"doctor","ok":true,"data":{"dbPath":"x","schemaHealthy":true,"link":{"projectId":"XTRM-1","source":"link"}}}\'; else echo \'{"schema":"substrate-cli/v1","command":"doctor","ok":true,"data":{"dbPath":"x","schemaHealthy":true,"link":null,"linkError":"none"}}\'; fi; elif [ "$1" = "project" ]; then touch "${SB_STATE_FILE:-/nonexistent}"; if [ "$2" = "create" ]; then echo \'{"id":"prj_initcli"}\'; else echo ok; fi; else echo "{}"; fi\n',
        pi: '#!/bin/sh\necho "pi 0.0.0-init-test"\n',
        pnpm: '#!/bin/sh\necho "pnpm 0.0.0-init-test"\n',
        deepwiki: '#!/bin/sh\necho "deepwiki 0.0.0-init-test"\n',
        ctx7: '#!/bin/sh\necho "ctx7 0.0.0-init-test"\n',
        // A ready status avoids invoking a real 120s GitNexus analyze during
        // the --yes integration test. Other init behavior remains real.
        gitnexus: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gitnexus 0.0.0-init-test"; elif [ "$1" = "status" ]; then echo "ready"; fi\n',
    };
    for (const [name, script] of Object.entries(fakeCommands)) {
        const file = path.join(__sandboxBin, name);
        fs.writeFileSync(file, script);
        fs.chmodSync(file, 0o755);
    }
    process.env.PATH = `${__sandboxBin}${path.delimiter}${__prevPath ?? ''}`;
});
afterAll(() => {
    try { fs.rmSync(__sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(__sandboxBin, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(__sandboxSubstrate, { recursive: true, force: true }); } catch { /* ignore */ }
    if (__prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = __prevHome;
    if (__prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = __prevPath;
    if (__prevSubstrateDir === undefined) delete process.env.XTRM_SUBSTRATE_DIR;
    else process.env.XTRM_SUBSTRATE_DIR = __prevSubstrateDir;
});

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): { stdout: string; stderr: string; status: number; duration: number } {
    const start = Date.now();
    const r = spawnSync('node', [CLI_BIN, ...args], {
        encoding: 'utf8',
        timeout: opts.timeout ?? 30000,
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
    });
    const duration = Date.now() - start;
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1, duration };
}

function git(args: string[], cwd: string): void {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function createTempGitRepo(): string {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-init-cli-'));
    git(['init'], repoDir);
    git(['config', 'user.email', 'test@test.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test project');
    fs.writeFileSync(path.join(repoDir, 'tsconfig.json'), '{}');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'init'], repoDir);
    return repoDir;
}

function cleanupTempRepo(repoDir: string): void {
    try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('xt init CLI surface', () => {
    it('xt init --help exits 0 and describes phased installer', () => {
        const r = run(['init', '--help']);
        expect(r.status).toBe(0);
        // Help description mentions setup/bootstrap functionality
        expect(r.stdout).toMatch(/Set up xtrm|Bootstrap|plugin.*Pi.*skills/i);
    });

    it('xt init --help shows dry-run and yes options', () => {
        const r = run(['init', '--help']);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/--dry-run/);
        expect(r.stdout).toMatch(/-y.*--yes/);
    });

    it('xt init --help shows global option', () => {
        const r = run(['init', '--help']);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/--global/);
    });
});

describe('xt init dry-run mode', () => {
    let repoDir: string;

    beforeEach(() => {
        repoDir = createTempGitRepo();
    });

    afterEach(() => {
        cleanupTempRepo(repoDir);
    });

    it('xt init --dry-run renders plan without making changes', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir });
        const combined = r.stdout + r.stderr;

        // Should not crash
        expect(combined).not.toMatch(/TypeError|ReferenceError|Cannot read properties/i);

        // Should show the plan header
        expect(combined).toMatch(/Installation Plan/i);

        // Should show dry-run indicator
        expect(combined).toMatch(/Dry run.*no changes/i);
    });

    it('xt init --dry-run does not create .beads directory', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir });
        const beadsPath = path.join(repoDir, '.beads');
        expect(fs.existsSync(beadsPath)).toBe(false);
    });

    it('xt init --dry-run does not prompt for confirmation', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir, timeout: 20000 });
        // A prompt would leave stdin waiting until the subprocess timeout.
        // Assert successful completion instead of a brittle wall-clock bound;
        // the runner's 20s timeout is intentionally below the CLI's 120s
        // production timeout and preserves the no-prompt guarantee.
        expect(r.status).toBe(0);
    });
});

describe('xt init phase ordering', () => {
    let repoDir: string;

    beforeEach(() => {
        repoDir = createTempGitRepo();
    });

    afterEach(() => {
        cleanupTempRepo(repoDir);
    });

    it('xt init --dry-run shows all phase sections in correct order', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir });
        const combined = r.stdout + r.stderr;

        // Phase order: Machine Bootstrap → Claude Runtime → Pi Runtime → Skills → Project Bootstrap → Verification
        const machineIdx = combined.indexOf('Machine Bootstrap') !== -1 ? combined.indexOf('Machine Bootstrap') : combined.indexOf('System Tools');
        const claudeIdx = combined.indexOf('Claude Runtime');
        const piIdx = combined.indexOf('Pi Runtime');
        const skillsIdx = combined.indexOf('Skills');
        const projectIdx = combined.indexOf('Project Bootstrap');
        const verificationIdx = combined.indexOf('Verification');

        // All sections should appear
        expect(combined).toMatch(/Machine Bootstrap|System Tools/i);
        expect(combined).toMatch(/Claude Runtime/i);
        expect(combined).toMatch(/Pi Runtime/i);
        expect(combined).toMatch(/Skills/i);
        expect(combined).toMatch(/Project Bootstrap/i);
        expect(combined).toMatch(/Verification/i);

        // Verify ordering (each section should appear after the previous)
        if (machineIdx !== -1 && claudeIdx !== -1) {
            expect(claudeIdx).toBeGreaterThan(machineIdx);
        }
        if (claudeIdx !== -1 && piIdx !== -1) {
            expect(piIdx).toBeGreaterThan(claudeIdx);
        }
        if (piIdx !== -1 && projectIdx !== -1) {
            expect(projectIdx).toBeGreaterThan(piIdx);
        }
        if (projectIdx !== -1 && verificationIdx !== -1) {
            expect(verificationIdx).toBeGreaterThan(projectIdx);
        }
    });
});

describe('xt init banner non-blocking', () => {
    let repoDir: string;

    beforeEach(() => {
        repoDir = createTempGitRepo();
    });

    afterEach(() => {
        cleanupTempRepo(repoDir);
    });

    it('xt init --dry-run completes without blocking on banner', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir, timeout: 20000 });
        // Banner rendering should not wait on keypress. The subprocess timeout
        // is the no-prompt guard; do not impose a host-load-sensitive duration.
        expect(r.status).toBe(0);
    });

    it('xt init --yes bypasses confirmation and completes quickly', () => {
        // This test may fail if external tools (bd, gitnexus) aren't available
        // but should not hang waiting for confirmation.
        // Wall-clock can reach ~30s on slow CI runners because spawnSync's
        // timeout cleanup waits for the child after SIGTERM; the assertion
        // we care about is "no interactive prompt", not "init was fast".
        // Bump vitest test timeout to 120s so we don't flake on CI. HOME is
        // sandboxed for this suite (xtrm-8zsi1) so xt init --yes does real
        // bootstrap work into an empty tmp HOME, which is slower than against
        // a warm real HOME. 60s occasionally flaked; 120s covers observed
        // ~70s worst-case runs. Assertion is still "no interactive prompt".
        // (xtrm-qdsx / xtrm-x12p3)
        // --sb-create-project exercises the explicit project flow: the fake
        // sb answers create/link, so init links without prompting or failing.
        const r = run(['init', '--yes', '--sb-create-project', 'T:InitCli'], { cwd: repoDir, timeout: 45000, env: { SB_STATE_FILE: path.join(repoDir, '.sb-state') } });
        // Should not hang on confirmation prompt
        const combined = r.stdout + r.stderr;
        expect(combined).not.toMatch(/press any key|continue\?/i);
        expect(r.status).toBe(0);
        expect(combined).toContain('created and linked');
    }, 120000);

    it('xt init --yes fails closed without project flags when unlinked', () => {
        const r = run(['init', '--yes'], { cwd: repoDir, timeout: 20000 });
        expect(r.status).not.toBe(0);
        const combined = r.stdout + r.stderr;
        expect(combined).toMatch(/--sb-create-project/);
    });
});

describe('xt init confirmation gate', () => {
    let repoDir: string;

    beforeEach(() => {
        repoDir = createTempGitRepo();
    });

    afterEach(() => {
        cleanupTempRepo(repoDir);
    });

    it('xt init --dry-run skips confirmation entirely', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir });
        const combined = r.stdout + r.stderr;
        // No confirmation prompt in dry-run mode
        expect(combined).not.toMatch(/Proceed with xtrm init\?/i);
    });

    it('xt init shows single confirmation gate before mutations', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir });
        const combined = r.stdout + r.stderr;
        // Plan shows confirmation phase exists
        expect(combined).toMatch(/Installation Plan/i);
        // Dry-run explicitly states no changes
        expect(combined).toMatch(/no changes/i);
    });
});

describe('xt init error handling', () => {
    it('xt init fails gracefully outside git repository', () => {
        const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-nongit-'));
        const r = run(['init', '--dry-run'], { cwd: nonGitDir, timeout: 5000 });
        const combined = r.stdout + r.stderr;

        // Should not crash with TypeError
        expect(combined).not.toMatch(/TypeError|ReferenceError|Cannot read properties/i);

        // Should warn about git requirement
        expect(combined).toMatch(/git repository|Not inside a git/i);

        try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('xt init handles missing external tools gracefully', () => {
        const repoDir = createTempGitRepo();

        // Run with PATH that excludes external tools (bd, gitnexus, etc.)
        const minimalPath = '/usr/bin:/bin';
        const r = run(['init', '--dry-run'], {
            cwd: repoDir,
            env: { ...process.env, PATH: minimalPath },
            timeout: 10000,
        });

        const combined = r.stdout + r.stderr;

        // Should not crash
        expect(combined).not.toMatch(/TypeError|ReferenceError|Cannot read properties/i);

        cleanupTempRepo(repoDir);
    });
});

describe('xt init phase summaries', () => {
    let repoDir: string;

    beforeEach(() => {
        repoDir = createTempGitRepo();
    });

    afterEach(() => {
        cleanupTempRepo(repoDir);
    });

    it('xt init --dry-run shows verification phase summary placeholder', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir });
        const combined = r.stdout + r.stderr;

        // Verification phase should be mentioned
        expect(combined).toMatch(/Verification/i);
        expect(combined).toMatch(/unified summary/i);
    });

    it('xt init --dry-run shows detection output', () => {
        const r = run(['init', '--dry-run'], { cwd: repoDir });
        const combined = r.stdout + r.stderr;

        // Should show project type detection (tsconfig.json present)
        expect(combined).toMatch(/Detected:.*TypeScript/i);
    });
});

describe('xt update alias', () => {
    it('xt update --help shows init alias description', () => {
        const r = run(['update', '--help']);
        expect(r.status).toBe(0);
        expect(r.stdout).toMatch(/alias|init/i);
    });
});
