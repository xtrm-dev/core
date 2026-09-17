import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// xtrm-tzzud: the installer must stop writing global state from project-scoped
// paths. Two deletions from the installer-writes matrix
// (docs/installer-settings-writes.md), one test each.
//
// xtrm-wiy5n.4.37: same file also holds the four survival proofs — the
// bootstrap must never delete a file it cannot prove it wrote. See the
// bottom two `describe` blocks.

vi.mock('../core/global-hooks-flag.js', () => ({ shouldUseGlobalHooks: () => false }));

const PKG = 'npm:@jaggerxtrm/pi-extensions';

let repoRoot = '';
let homeDir = '';
let originalHome: string | undefined;
let originalAgentDir: string | undefined;

beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-tzzud-repo-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-tzzud-home-'));
    fs.ensureDirSync(path.join(repoRoot, '.xtrm', 'hooks'));
    fs.ensureDirSync(path.join(homeDir, '.claude'));
    fs.ensureDirSync(path.join(homeDir, '.xtrm', 'hooks'));
    fs.ensureDirSync(path.join(homeDir, '.pi', 'agent'));
    originalHome = process.env.HOME;
    originalAgentDir = process.env.PI_AGENT_DIR;
    process.env.HOME = homeDir;
    process.env.PI_AGENT_DIR = path.join(homeDir, '.pi', 'agent');
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    vi.resetModules();
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = originalAgentDir;
    vi.restoreAllMocks();
    fs.removeSync(repoRoot);
    fs.removeSync(homeDir);
});

// Matrix finding 2: runClaudeRuntimeSyncPhase called ensureGlobalStatusLine on
// every exit path regardless of isGlobal, so `xt claude sync` inside one
// project flipped a setting in ~/.claude/settings.json.
describe('runClaudeRuntimeSyncPhase isGlobal=false', () => {
    async function syncProject() {
        const { runClaudeRuntimeSyncPhase } = await import('../core/claude-runtime-sync.js');
        return runClaudeRuntimeSyncPhase({ repoRoot, dryRun: false, isGlobal: false });
    }

    it('does not write statusLine into ~/.claude/settings.json', async () => {
        // The statusline hook exists, so the write is armed — only the isGlobal
        // gate stops it.
        fs.writeFileSync(path.join(homeDir, '.xtrm', 'hooks', 'statusline.mjs'), '// statusline');
        const globalSettings = path.join(homeDir, '.claude', 'settings.json');
        fs.writeJsonSync(globalSettings, { model: 'claude-opus-4-8' });

        await syncProject();

        expect(fs.readJsonSync(globalSettings)).toEqual({ model: 'claude-opus-4-8' });
    });

    it('still writes the project settings.json it owns', async () => {
        fs.writeFileSync(path.join(homeDir, '.xtrm', 'hooks', 'statusline.mjs'), '// statusline');

        const result = await syncProject();

        expect(result.settingsPath).toBe(path.join(repoRoot, '.claude', 'settings.json'));
        expect(fs.existsSync(result.settingsPath)).toBe(true);
    });
});

// xtrm-xnymw: after any sync the package is registered EXACTLY ONCE, and
// that once is global. Both "registered twice" and "registered nowhere" are
// failures. The reconciler follows an ENSURE-THEN-REMOVE contract:
//   1. make sure ~/.pi/agent/settings.json declares the package;
//   2. THEN strip it from the per-repo packages array.
// If step 1 fails (unreadable, disk error), the per-repo entry is left in
// place and a diagnostic is emitted — a working per-repo entry is strictly
// better than no registration at all.
describe('updatePiSettings — exactly-once global invariant (xtrm-xnymw)', () => {
    async function update() {
        const { updatePiSettings } = await import('../core/pi-runtime.js');
        return updatePiSettings(repoRoot, false);
    }

    const projectPi = () => path.join(repoRoot, '.pi', 'settings.json');
    const globalPi = () => path.join(homeDir, '.pi', 'agent', 'settings.json');

    function readPackages(file: string): string[] {
        try {
            const j = fs.readJsonSync(file) as { packages?: unknown };
            return Array.isArray(j.packages) ? j.packages.filter((e): e is string => typeof e === 'string') : [];
        } catch { return []; }
    }

    it('adds the global entry when it is missing and package files are present, then removes the project entry', async () => {
        // Setup: global settings exist without the entry, project has the entry.
        fs.writeJsonSync(globalPi(), { packages: ['npm:something-else'] });
        fs.ensureDirSync(path.join(repoRoot, '.pi'));
        fs.writeJsonSync(projectPi(), { packages: [PKG, 'npm:other'] });

        await update();

        expect(readPackages(globalPi())).toContain(PKG);       // step 1: ensure global
        expect(readPackages(projectPi())).not.toContain(PKG);  // step 2: remove per-repo
    });

    it('creates the global settings file when absent, adds the entry, then removes the project entry', async () => {
        fs.removeSync(globalPi());
        fs.ensureDirSync(path.join(repoRoot, '.pi'));
        fs.writeJsonSync(projectPi(), { packages: [PKG] });

        await update();

        expect(fs.existsSync(globalPi())).toBe(true);
        expect(readPackages(globalPi())).toContain(PKG);
        expect(readPackages(projectPi())).not.toContain(PKG);
    });

    it('does not add the entry twice when the global settings already declare it', async () => {
        fs.writeJsonSync(globalPi(), { packages: [PKG, 'npm:other'] });
        fs.ensureDirSync(path.join(repoRoot, '.pi'));
        fs.writeJsonSync(projectPi(), { packages: [PKG] });

        await update();

        // Global entry appears exactly once
        expect(readPackages(globalPi()).filter((p) => p === PKG)).toHaveLength(1);
        expect(readPackages(projectPi())).not.toContain(PKG);
    });

    it('leaves the per-repo entry in place when the global settings file is unreadable, and emits a diagnostic on stderr', async () => {
        fs.writeJsonSync(globalPi(), { packages: [] });
        fs.chmodSync(globalPi(), 0o000);
        const stderrCalls: string[] = [];
        const origError = console.error;
        console.error = (msg: unknown) => { stderrCalls.push(String(msg)); };

        fs.ensureDirSync(path.join(repoRoot, '.pi'));
        fs.writeJsonSync(projectPi(), { packages: [PKG] });

        try {
            await update();
            expect(readPackages(projectPi())).toContain(PKG);   // safety net stays
            expect(stderrCalls.some((m) => m.includes(PKG) && /unreadable|EACCES|EPERM/i.test(m))).toBe(true);
        } finally {
            console.error = origError;
            fs.chmodSync(globalPi(), 0o644);
        }
    });

    it('registers the package exactly once after a sync — never zero, never twice', async () => {
        // Starting state: global with the entry, project also carrying it.
        // Invariant: after the sync, the count across (global, project) is 1.
        fs.writeJsonSync(globalPi(), { packages: [PKG] });
        fs.ensureDirSync(path.join(repoRoot, '.pi'));
        fs.writeJsonSync(projectPi(), { packages: [PKG] });

        await update();

        const total = readPackages(globalPi()).filter((p) => p === PKG).length
            + readPackages(projectPi()).filter((p) => p === PKG).length;
        expect(total).toBe(1);
        expect(readPackages(globalPi())).toContain(PKG);
        expect(readPackages(projectPi())).not.toContain(PKG);
    });

    it('starts from clean global (missing entry) and per-repo entry: ends with exactly-once, globally', async () => {
        fs.removeSync(globalPi());
        fs.ensureDirSync(path.join(repoRoot, '.pi'));
        fs.writeJsonSync(projectPi(), { packages: [PKG] });

        await update();

        const total = readPackages(globalPi()).filter((p) => p === PKG).length
            + readPackages(projectPi()).filter((p) => p === PKG).length;
        expect(total).toBe(1);
        expect(readPackages(globalPi())).toContain(PKG);
    });
});

// xtrm-wiy5n.4.37 — the installer must never delete a file it cannot prove it
// wrote. Before this fix, ensureGlobalSkillsBootstrapped/copyTier issued an
// unconditional `fs.remove` on ~/.xtrm/skills/default and .../optional
// whenever the guarded version changed — which is exactly every release day.
// The proofs below anchor the fix: a user file present at first install
// survives that install, survives a re-run at the same version, survives a
// version bump that changes the payload, and a shipped file that goes away
// between versions is still cleaned up (the manifest is doing its job, not
// just "delete nothing").
describe('ensureGlobalSkillsBootstrapped safe-delete (xtrm-wiy5n.4.37)', () => {
    async function snapshotTree(root: string): Promise<Record<string, string>> {
        const out: Record<string, string> = {};
        async function walk(dir: string): Promise<void> {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
                const full = path.join(dir, entry.name);
                const rel = path.relative(root, full).split(path.sep).join('/');
                if (entry.isSymbolicLink()) {
                    // Generated runtime views under active/ are symlinks; record the
                    // link target instead of following it (xtrm-e7jzt.2).
                    out[rel] = `symlink:${await fs.readlink(full)}`;
                } else if (entry.isDirectory()) {
                    out[`${rel}/`] = 'dir';
                    await walk(full);
                } else {
                    out[rel] = await fs.readFile(full, 'utf8');
                }
            }
        }
        if (await fs.pathExists(root)) {
            await walk(root);
        }
        return out;
    }

    function seedPkg(version: string, tiers: { default?: Record<string, string>; optional?: Record<string, string> }): void {
        fs.writeJsonSync(path.join(repoRoot, 'package.json'), { name: 'xtrm-tools', version });
        fs.emptyDirSync(path.join(repoRoot, '.xtrm', 'skills', 'default'));
        fs.emptyDirSync(path.join(repoRoot, '.xtrm', 'skills', 'optional'));
        for (const [rel, content] of Object.entries(tiers.default ?? {})) {
            const dest = path.join(repoRoot, '.xtrm', 'skills', 'default', rel);
            fs.ensureDirSync(path.dirname(dest));
            fs.writeFileSync(dest, content);
        }
        for (const [rel, content] of Object.entries(tiers.optional ?? {})) {
            const dest = path.join(repoRoot, '.xtrm', 'skills', 'optional', rel);
            fs.ensureDirSync(path.dirname(dest));
            fs.writeFileSync(dest, content);
        }
    }

    async function bootstrap(): Promise<void> {
        const { ensureGlobalSkillsBootstrapped } = await import('../core/global-skills-bootstrap.js');
        await ensureGlobalSkillsBootstrapped(repoRoot);
    }

    const userDefault = (): string => path.join(homeDir, '.xtrm', 'skills', 'default', 'my-user-skill', 'SKILL.md');
    const userOptional = (): string => path.join(homeDir, '.xtrm', 'skills', 'optional', 'user-optional', 'SKILL.md');

    it('proof 1: a user-authored file present before the first install survives it', async () => {
        fs.ensureDirSync(path.dirname(userDefault()));
        fs.writeFileSync(userDefault(), '# user-authored, must survive');
        seedPkg('1.0.0', { default: { 'shipped-a/SKILL.md': '# shipped-a v1' } });

        await bootstrap();

        expect(fs.readFileSync(userDefault(), 'utf8')).toBe('# user-authored, must survive');
        expect(fs.existsSync(path.join(homeDir, '.xtrm', 'skills', 'default', 'shipped-a', 'SKILL.md'))).toBe(true);
    });

    it('proof 2: a user file added after the first install survives an update at the same version', async () => {
        seedPkg('1.0.0', { default: { 'shipped-a/SKILL.md': '# shipped-a v1' } });
        await bootstrap();

        fs.ensureDirSync(path.dirname(userDefault()));
        fs.writeFileSync(userDefault(), '# added after first install');

        await bootstrap();

        expect(fs.readFileSync(userDefault(), 'utf8')).toBe('# added after first install');
    });

    it('proof 3: a user file survives a version bump AND a payload change', async () => {
        seedPkg('1.0.0', {
            default: { 'shipped-a/SKILL.md': '# shipped-a v1' },
            optional: { 'shipped-opt/SKILL.md': '# opt v1' },
        });
        await bootstrap();

        fs.ensureDirSync(path.dirname(userDefault()));
        fs.writeFileSync(userDefault(), '# user default, must survive bump');
        fs.ensureDirSync(path.dirname(userOptional()));
        fs.writeFileSync(userOptional(), '# user optional, must survive bump');

        seedPkg('2.0.0', {
            default: { 'shipped-b/SKILL.md': '# shipped-b v2' },
            optional: { 'shipped-opt/SKILL.md': '# opt v2' },
        });
        await bootstrap();

        expect(fs.readFileSync(userDefault(), 'utf8')).toBe('# user default, must survive bump');
        expect(fs.readFileSync(userOptional(), 'utf8')).toBe('# user optional, must survive bump');
        // The manifest tracked shipped-a — so it IS removed on the bump. This
        // proves the fix is not the trivial "delete nothing".
        expect(fs.existsSync(path.join(homeDir, '.xtrm', 'skills', 'default', 'shipped-a', 'SKILL.md'))).toBe(false);
        expect(fs.existsSync(path.join(homeDir, '.xtrm', 'skills', 'default', 'shipped-b', 'SKILL.md'))).toBe(true);
    });

    it('restores the complete skills tree when bootstrap fails after mutation', async () => {
        seedPkg('1.0.0', {
            default: { 'shipped-a/SKILL.md': '# shipped-a v1' },
            optional: { 'shipped-opt/SKILL.md': '# opt v1' },
        });
        await bootstrap();

        fs.ensureDirSync(path.dirname(userDefault()));
        fs.writeFileSync(userDefault(), '# user default, must survive rollback');
        fs.ensureDirSync(path.join(homeDir, '.xtrm', 'skills', 'custom-pack', 'custom-skill'));
        fs.writeFileSync(path.join(homeDir, '.xtrm', 'skills', 'custom-pack', 'custom-skill', 'SKILL.md'), '# custom');

        seedPkg('2.0.0', {
            default: { 'shipped-b/SKILL.md': '# shipped-b v2' },
            optional: { 'shipped-opt/SKILL.md': '# opt v2' },
        });
        const skillsRoot = path.join(homeDir, '.xtrm', 'skills');
        const statePath = path.join(skillsRoot, 'state.json');
        const before = await snapshotTree(skillsRoot);
        const originalAppendFile = fs.appendFile.bind(fs);
        const appendSpy = vi.spyOn(fs, 'appendFile');
        appendSpy.mockImplementation(async (file, data, options) => {
            if (String(file) === statePath && String(data) === '\n') {
                throw new Error('simulated state write failure');
            }
            return originalAppendFile(file as never, data as never, options as never);
        });

        await expect(bootstrap()).rejects.toThrow(/simulated state write failure/);
        appendSpy.mockRestore();

        expect(await snapshotTree(skillsRoot)).toEqual(before);
        const backups = await fs.readdir(path.join(homeDir, '.xtrm', 'migration-backups'));
        expect(backups.some((name) => name.endsWith('.tgz'))).toBe(true);
        expect(backups.some((name) => name.endsWith('.sha256.json'))).toBe(true);
    });

    it('fails closed before mutation when the backup archive cannot be verified', async () => {
        seedPkg('1.0.0', {
            default: { 'shipped-a/SKILL.md': '# shipped-a v1' },
            optional: { 'shipped-opt/SKILL.md': '# opt v1' },
        });
        await bootstrap();

        const before = await snapshotTree(path.join(homeDir, '.xtrm', 'skills'));
        seedPkg('2.0.0', {
            default: { 'shipped-b/SKILL.md': '# shipped-b v2' },
            optional: { 'shipped-opt/SKILL.md': '# opt v2' },
        });
        const originalWriteJson = fs.writeJson.bind(fs);
        const writeJsonSpy = vi.spyOn(fs, 'writeJson');
        writeJsonSpy.mockImplementation(async (file, data, options) => {
            if (String(file).endsWith('.sha256.json')) {
                throw new Error('simulated backup sidecar failure');
            }
            return originalWriteJson(file as never, data as never, options as never);
        });

        await expect(bootstrap()).rejects.toThrow(/simulated backup sidecar failure/);
        writeJsonSpy.mockRestore();

        expect(await snapshotTree(path.join(homeDir, '.xtrm', 'skills'))).toEqual(before);
    });

    it('keeps the current root intact when final rollback placement fails once', async () => {
        seedPkg('1.0.0', {
            default: { 'shipped-a/SKILL.md': '# shipped-a v1' },
            optional: { 'shipped-opt/SKILL.md': '# opt v1' },
        });
        await bootstrap();

        fs.ensureDirSync(path.dirname(userDefault()));
        fs.writeFileSync(userDefault(), '# user default, must survive failed final placement');
        seedPkg('2.0.0', {
            default: { 'shipped-b/SKILL.md': '# shipped-b v2' },
            optional: { 'shipped-opt/SKILL.md': '# opt v2' },
        });
        const skillsRoot = path.join(homeDir, '.xtrm', 'skills');
        const statePath = path.join(skillsRoot, 'state.json');
        const originalAppendFile = fs.appendFile.bind(fs);
        const appendSpy = vi.spyOn(fs, 'appendFile');
        appendSpy.mockImplementation(async (file, data, options) => {
            if (String(file) === statePath && String(data) === '\n') {
                throw new Error('simulated state write failure');
            }
            return originalAppendFile(file as never, data as never, options as never);
        });
        const originalRename = fs.rename.bind(fs);
        const renameSpy = vi.spyOn(fs, 'rename')
            .mockImplementationOnce(originalRename as typeof fs.rename)
            .mockRejectedValueOnce(new Error('simulated final placement failure'))
            .mockImplementationOnce(originalRename as typeof fs.rename);

        await expect(bootstrap()).rejects.toThrow(/Global skills rollback failed: simulated final placement failure; original error: simulated state write failure/);
        renameSpy.mockRestore();
        appendSpy.mockRestore();

        expect(await fs.pathExists(path.join(skillsRoot, 'default', 'shipped-b', 'SKILL.md'))).toBe(true);
        expect(await fs.pathExists(path.join(skillsRoot, 'default', 'shipped-a', 'SKILL.md'))).toBe(false);
        expect(await fs.readFile(userDefault(), 'utf8')).toBe('# user default, must survive failed final placement');
        const state = await fs.readJson(statePath) as { installedVersion: string };
        expect(state.installedVersion).toBe('2.0.0');
    });

    it('proof 6: if a tracked directory is replaced with a symlink between installs, bootstrap fails closed and the external target survives (Codex P1)', async () => {
        // Adversarial: after install v1, the user (or attacker) replaces
        // default/skill-x with a symlink to a working copy outside the managed
        // root. removeTrackedEntries would previously follow the parent-dir
        // symlink and delete `<external>/SKILL.md` because the lexical
        // startsWith check on `default/skill-x/SKILL.md` still passes.
        seedPkg('1.0.0', { default: { 'skill-x/SKILL.md': '# shipped v1', 'skill-x/lib/helper.md': '# helper' } });
        await bootstrap();

        const skillDir = path.join(homeDir, '.xtrm', 'skills', 'default', 'skill-x');
        const external = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-w437-external-'));
        try {
            fs.writeFileSync(path.join(external, 'SKILL.md'), '# external — must NOT be touched');
            fs.writeFileSync(path.join(external, 'lib.md'), '# external lib');
            fs.removeSync(skillDir);
            fs.symlinkSync(external, skillDir, 'dir');

            seedPkg('2.0.0', { default: { 'shipped-b/SKILL.md': '# shipped v2' } });
            await expect(bootstrap()).rejects.toThrow(/absolute symlink target|symbolic link/);

            expect(fs.readFileSync(path.join(external, 'SKILL.md'), 'utf8')).toBe('# external — must NOT be touched');
            expect(fs.readFileSync(path.join(external, 'lib.md'), 'utf8')).toBe('# external lib');
        } finally {
            fs.removeSync(external);
        }
    });

    it('proof 5: a user file present BEFORE the first install survives the SECOND install (manifest must not adopt files it did not copy)', async () => {
        // Every existing user upgrading to this version is in exactly this
        // position: they have files under ~/.xtrm/skills/default before any
        // manifest-aware bootstrap has ever run. Proof 1 catches the first
        // install; this proof catches the second, where the earlier bug was
        // that listFilesUnder(targetRoot) had adopted the user file into the
        // manifest and the version-bump install then deleted it.
        fs.ensureDirSync(path.dirname(userDefault()));
        fs.writeFileSync(userDefault(), '# pre-existing user file, must survive TWO installs');

        seedPkg('1.0.0', { default: { 'shipped-a/SKILL.md': '# shipped-a v1' } });
        await bootstrap();

        seedPkg('2.0.0', { default: { 'shipped-b/SKILL.md': '# shipped-b v2' } });
        await bootstrap();

        expect(fs.readFileSync(userDefault(), 'utf8')).toBe('# pre-existing user file, must survive TWO installs');
    });

    it('proof 4: a user file dropped INSIDE a shipped skill dir survives that skill being removed', async () => {
        // Adversarial: user drops a file inside a directory that used to house
        // a shipped skill. Tracked-file removal must not sweep the user file
        // with it; dir-pruning must stop at the first non-empty directory.
        seedPkg('1.0.0', { default: { 'skill-x/SKILL.md': '# skill-x v1', 'skill-x/lib/helper.md': '# helper' } });
        await bootstrap();

        const userDropIn = path.join(homeDir, '.xtrm', 'skills', 'default', 'skill-x', 'user-notes.md');
        fs.writeFileSync(userDropIn, '# I wrote this into a shipped dir');

        seedPkg('2.0.0', { default: {} });
        await bootstrap();

        expect(fs.readFileSync(userDropIn, 'utf8')).toBe('# I wrote this into a shipped dir');
        expect(fs.existsSync(path.join(homeDir, '.xtrm', 'skills', 'default', 'skill-x', 'SKILL.md'))).toBe(false);
        expect(fs.existsSync(path.join(homeDir, '.xtrm', 'skills', 'default', 'skill-x', 'lib', 'helper.md'))).toBe(false);
    });
});

describe('ensureGlobalHooksBootstrapped safe-delete (xtrm-wiy5n.4.37)', () => {
    function seedHooksPkg(version: string, files: Record<string, string>, configBody = '{"hooks":{}}'): void {
        fs.writeJsonSync(path.join(repoRoot, 'package.json'), { name: 'xtrm-tools', version });
        fs.emptyDirSync(path.join(repoRoot, '.xtrm', 'hooks'));
        fs.ensureDirSync(path.join(repoRoot, '.xtrm', 'config'));
        fs.writeFileSync(path.join(repoRoot, '.xtrm', 'config', 'hooks.json'), configBody);
        for (const [rel, content] of Object.entries(files)) {
            const dest = path.join(repoRoot, '.xtrm', 'hooks', rel);
            fs.ensureDirSync(path.dirname(dest));
            fs.writeFileSync(dest, content);
        }
    }

    async function bootstrap(): Promise<void> {
        const { ensureGlobalHooksBootstrapped } = await import('../core/global-hooks-bootstrap.js');
        await ensureGlobalHooksBootstrapped(repoRoot);
    }

    const userHook = (): string => path.join(homeDir, '.xtrm', 'hooks', 'user-authored-hook.mjs');

    it('proof: a user-authored hook survives a version bump AND a source-fingerprint change', async () => {
        seedHooksPkg('1.0.0', { 'shipped-hook.mjs': '// shipped v1' });
        await bootstrap();

        fs.writeFileSync(userHook(), '// user-authored hook, must survive');

        // Change BOTH version and content — the old fingerprint-match guard
        // would have let the pre-fix `fs.remove(targetHooksRoot)` blow through.
        seedHooksPkg('2.0.0', { 'shipped-hook.mjs': '// shipped v2 CHANGED' }, '{"hooks":{"v":2}}');
        await bootstrap();

        expect(fs.readFileSync(userHook(), 'utf8')).toBe('// user-authored hook, must survive');
        expect(fs.readFileSync(path.join(homeDir, '.xtrm', 'hooks', 'shipped-hook.mjs'), 'utf8')).toBe('// shipped v2 CHANGED');
    });

    it('proof 5 (hooks): a user hook present BEFORE the first bootstrap survives the SECOND bootstrap after a fingerprint change', async () => {
        // Hooks equivalent of skills proof 5. The user hook exists before any
        // bootstrap has ever run; the earlier bug adopted it into the manifest
        // on install 1 and deleted it on install 2.
        fs.writeFileSync(userHook(), '// pre-existing user hook, must survive TWO installs');

        seedHooksPkg('1.0.0', { 'shipped-hook.mjs': '// shipped v1' });
        await bootstrap();

        seedHooksPkg('2.0.0', { 'shipped-hook.mjs': '// shipped v2 CHANGED' }, '{"hooks":{"v":2}}');
        await bootstrap();

        expect(fs.readFileSync(userHook(), 'utf8')).toBe('// pre-existing user hook, must survive TWO installs');
    });

    it('proof: dropping a shipped hook between versions cleans it without touching the user hook', async () => {
        seedHooksPkg('1.0.0', { 'shipped-hook.mjs': '// shipped v1', 'another.mjs': '// another' });
        await bootstrap();

        fs.writeFileSync(userHook(), '// still mine');

        seedHooksPkg('2.0.0', { 'shipped-hook.mjs': '// shipped v2' });
        await bootstrap();

        expect(fs.existsSync(path.join(homeDir, '.xtrm', 'hooks', 'another.mjs'))).toBe(false);
        expect(fs.readFileSync(userHook(), 'utf8')).toBe('// still mine');
    });
});
