import { DISPATCHER_ENV_KEYS } from '../core/dispatcher-identity.js';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { readlinkSync, realpathSync } from 'node:fs';
import { needsTmpGitGuard } from './tmp-git-guard.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Launch-level tests (reviewer 751b/830 + seconder 516 + reviewer d5c): run the REAL
// launchWorktreeSession / launchCodexWorktreeSession with a mocked spawnSync
// surface, a HERMETIC HOME (zero host-path references), and inspect the final
// runtime payload/args plus materialized links.

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawnSync: mocked.spawnSync };
});

const roots: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalCodexHome = process.env.CODEX_HOME;

function exitByThrow(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
    }) as never);
}

const PACK_NAME = 'service-knowledge';
const RUNTIME_NAME_LONG = 'infra-xt-claude-sk-reconcile-infra-service-knowledge';

function canonicalSpec(paths: string[], model = 'claude-opus-5'): string {
    return JSON.stringify({
        specialist: {
            metadata: { name: 'sync-role', version: '1.0.0', category: 'testing', description: 'd' },
            execution: {
                mode: 'tool', model, timeout_ms: 0, stall_timeout_ms: 600000,
                max_retries: 0, interactive: false, response_format: 'markdown', output_type: 'workflow',
                permission_required: 'MEDIUM', requires_worktree: true, bare: false, auto_commit: 'never',
            },
            prompt: { system: 'You are the sync librarian.', task_template: 'Do the sync.' },
            skills: { paths },
        },
    });
}

// Role declaration paths resolved against the HERMETIC home for global skills.
function rolePathsFor(home: string): string[] {
    return [
        '.xtrm/skills/infra/service-knowledge',
        path.join(home, '.xtrm', 'skills', 'default', 'gitnexus-impact-analysis'),
        path.join(home, '.xtrm', 'skills', 'default', 'gitnexus-exploring'),
    ];
}
const ROLE_SP_NAMES = ['service-knowledge', 'gitnexus-impact-analysis', 'gitnexus-exploring'];

interface LaunchHarness {
    repoRoot: string;
    homeRoot: string;
    worktreePath: string;
    branchName: string;
    capturedPayload: { runtimeCmd?: string; runtimeArgs?: string[] } | null;
    newSessionArgs: string[] | null;
    calls: { branchDeleteCalls: number; worktreeRemoveCalls: number; worktreeCreateArgs: string; piSpawn: number; updateIndex: number; spCwdsHeartbeat: number };
    spCwds: string[];
    profileBefore: string[];
    callLog: Array<{ command: string; argv: string[]; cwd: string; env?: Record<string, string | undefined> }>;
    spViewCalls: Array<{ argv: string[]; cwd: string }>;
    envBefore: Record<string, string | undefined>;
    cwdBeforeOriginal: string;
    immediateEnv: Record<string, string | undefined>;
    immediateListeners: Record<string, number>;
    envAfterCleanup: Record<string, string | undefined>;
    listenersBefore: Record<string, number>;
    listenersAfter: Record<string, number>;
    seededWorktreeCopy: boolean;
    branchPreExists: boolean;
    /** Plant <worktree>/.xtrm/hooks/statusline.mjs at creation so the launch
     * runs with a worktree-local hook script present (global-statusline regression). */
    seedStatusline: boolean;
    /** CORE-2760: leave the hermetic install with no resolvable claude model, so the
     * launch refuses. The seat has no --model, no ANTHROPIC_MODEL and no settings file. */
    unresolvableModel: boolean;
    oldSp: boolean;
    extraSkills: string[];
    roleSpecPaths?: string[];
    roleSpNames?: string[];
    role?: string;
    /** The model the role spec declares. '' leaves the role with none, so the launch must refuse. */
    roleModel?: string;
    runtime: 'claude' | 'pi';
    codex: boolean;
    fromSubdir: boolean;
    seedWorktreeCopy: boolean;
    /** Shape the repo pack fixture: 'valid' (default), 'missing' (no SKILL.md), 'unsafe-name'. */
    malformedPack?: 'missing' | 'unsafe-name';
    /**
     * CORE-2728: what the launch-time `sb provenance dispatch` answers. Default is
     * a success; a variant models a failed, missing or hung sb.
     */
    sbResult?: { status?: number | null; stdout?: string; stderr?: string; error?: { code: string; message?: string } };
    error: string;
}

interface LaunchResult {
    payload: string | null;
    error: string;
    calls: { branchDeleteCalls: number; worktreeRemoveCalls: number; worktreeCreateArgs: string; piSpawn: number; updateIndex: number; spCwdsHeartbeat: number };
    newSessionArgs: string[] | null;
    spCwds: string[];
    profileBefore: string[];
    callLog: Array<{ command: string; argv: string[]; cwd: string; env?: Record<string, string | undefined> }>;
    spViewCalls: Array<{ argv: string[]; cwd: string }>;
    envBefore: Record<string, string | undefined>;
    cwdBeforeOriginal: string;
    immediateEnv: Record<string, string | undefined>;
    immediateListeners: Record<string, number>;
    envAfterCleanup: Record<string, string | undefined>;
    listenersBefore: Record<string, number>;
    listenersAfter: Record<string, number>;
}

async function runLaunch(h: LaunchHarness, opts: Record<string, unknown>): Promise<LaunchResult> {
    const { repoRoot, homeRoot } = h;
    // Hermetic HOME with the two global skills the canonical role references.
    fs.ensureDirSync(path.join(homeRoot, '.xtrm', 'skills', 'default', 'gitnexus-impact-analysis'));
    fs.ensureDirSync(path.join(homeRoot, '.xtrm', 'skills', 'default', 'gitnexus-exploring'));
    fs.writeFileSync(path.join(homeRoot, '.xtrm', 'skills', 'default', 'gitnexus-impact-analysis', 'SKILL.md'), '# gn1');
    fs.writeFileSync(path.join(homeRoot, '.xtrm', 'skills', 'default', 'gitnexus-exploring', 'SKILL.md'), '# gn2');
    // Matching HOME pack content so relative repo-missing tests can prove the
    // pinned request never home-falls-back.
    fs.ensureDirSync(path.join(homeRoot, '.xtrm', 'skills', 'infra', 'catalog'));
    fs.writeFileSync(path.join(homeRoot, '.xtrm', 'skills', 'infra', 'catalog', 'SKILL.md'), '# home catalog');
    fs.writeFileSync(path.join(homeRoot, '.xtrm', 'skills', 'infra', 'SKILL.md'), '# home root');
    // Claude runtime pointer, mirroring the real install (ensureUserAgentsSkillsSymlink).
    fs.ensureDirSync(path.join(homeRoot, '.claude'));
    fs.symlinkSync(path.join(homeRoot, '.xtrm', 'skills', 'default'), path.join(homeRoot, '.claude', 'skills'), 'dir');
    // Nonempty CODEX_HOME fixture: a profile file + a symlink, so profile
    // snapshots compare real bytes and link targets.
    fs.ensureDirSync(path.join(homeRoot, '.codex', 'profiles'));
    fs.writeFileSync(path.join(homeRoot, '.codex', 'profiles', 'xtrm.json'), JSON.stringify({ trust: 'baseline', n: 1 }));
    fs.symlinkSync(path.join(homeRoot, '.codex', 'profiles'), path.join(homeRoot, '.codex', 'profiles-link'), 'dir');
    process.env.HOME = homeRoot;
    // XTRM-970: a claude seat's model must be resolvable at launch. The hermetic
    // install declares one where a real install keeps it — CLAUDE_CONFIG_DIR when
    // the harness sandboxes it, otherwise the sandboxed HOME.
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME!, '.claude');
    fs.ensureDirSync(configDir);
    if (h.unresolvableModel) {
        // CORE-2760: no settings model at all, and the caller unsets ANTHROPIC_MODEL.
        fs.removeSync(path.join(configDir, 'settings.json'));
        delete process.env.ANTHROPIC_MODEL;
    } else {
        fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'claude-opus-5' }));
    }

    const packSkillDir = path.join(repoRoot, '.xtrm', 'skills', 'infra', PACK_NAME);
    fs.ensureDirSync(packSkillDir);
    const packSkillFile = path.join(packSkillDir, 'SKILL.md');
    const rootSkillFile = path.join(repoRoot, '.xtrm', 'skills', 'infra', 'SKILL.md');
    if (h.malformedPack === 'unsafe-name') {
        fs.writeFileSync(packSkillFile, '---\nname: ../evil\n---\n# bad');
        fs.writeFileSync(rootSkillFile, '---\nname: ../evil-root\n---\n# bad');
    } else if (h.malformedPack === 'missing') {
        fs.removeSync(rootSkillFile); // no root skill; infra exists only for the child dir marker below
    } else {
        fs.writeFileSync(packSkillFile, `---\nname: ${RUNTIME_NAME_LONG}\n---\n# real`);
        fs.writeFileSync(rootSkillFile, '---\nname: infra-root\n---\n# root');
    }

    mocked.spawnSync.mockReset();
    const branchDeleteCalls: number[] = [];
    const worktreeRemoveCalls: number[] = [];
    const piSpawnCalls: number[] = [];
    const updateIndexCalls: number[] = [];
    const worktreeCreateArgs: string[][] = [];
    let capturedPayload: { runtimeCmd?: string; runtimeArgs?: string[] } | null = null;
    let newSessionArgs: string[] | null = null;
    const spCwds: string[] = [];
    const allCalls: Array<{ command: string; argv: string[]; cwd: string; env?: Record<string, string | undefined> }> = [];
    const spViewCalls: Array<{ argv: string[]; cwd: string }> = [];

    const specPaths = h.roleSpecPaths ?? rolePathsFor(homeRoot);
    mocked.spawnSync.mockImplementation((command: string, args: string[] = [], mo: Record<string, unknown> = {}) => {
        // CORE-2802: the launcher binds tmux to the caller's socket; the verb is args[0] again.
                // CORE-2802 review (finding 5): the binding is asserted, never merely stripped.
        if (command === 'tmux' && args[0] === '-S') { expect(args[1]).toMatch(/^(?:\/|tmux-)/); args = args.slice(2); }
        const joined = (args ?? []).join(' ');
        allCalls.push({ command, argv: args ?? [], cwd: (mo.cwd as string | undefined) ?? process.cwd(), env: mo.env as Record<string, string | undefined> | undefined });
        if (command === 'sp' && args[0] === 'view') {
            spCwds.push((mo.cwd as string | undefined) ?? '');
            if (h.oldSp && args.includes('--surface')) {
                // old-sp: surfaced view must FAIL so the legacy --raw retry runs.
                spViewCalls.push({ argv: args, cwd: (mo.cwd as string | undefined) ?? '' });
                return { status: 1, stdout: '', stderr: "unknown option '--surface'" };
            }
            spViewCalls.push({ argv: args, cwd: (mo.cwd as string | undefined) ?? '' });
            // CORE-2760: a role that declares no model leaves the launch with nothing to resolve.
            return { status: 0, stdout: canonicalSpec(specPaths, h.roleModel ?? 'claude-opus-5'), stderr: '' };
        }
        if (command === 'sp' && args[0] === 'render-skill-prefix' && args[1] === '--help') {
            return h.oldSp ? { status: 1, stdout: '', stderr: "unknown option '--help'" } : { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'sp' && args[0] === 'render-task') {
            // CORE-2728: a role + --issue launch renders the task body.
            // render-task must carry the exact trusted prefix the launch verifies.
            const skillPrefix = `${ROLE_SP_NAMES.map((n) => `/${n}`).join('\n')}\n\n`;
            return { status: 0, stdout: JSON.stringify({ ok: true, initial_prompt: `${skillPrefix}smoke body`, prompt_hash: 'h', components: [] }), stderr: '' };
        }
        if (command === 'sp' && args[0] === 'render-skill-prefix') {
            return h.oldSp
                ? { status: 1, stdout: '', stderr: 'unknown option --surface' }
                : { status: 0, stdout: JSON.stringify({ ok: true, skill_prefix: `${(h.roleSpNames ?? ROLE_SP_NAMES).map((n) => `/${n}`).join('\n')}\n\n` }), stderr: '' };
        }
        if (command === 'git' && joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
        if (command === 'git' && joined === 'rev-parse --git-common-dir') {
            const cwd = (mo.cwd as string | undefined) ?? process.cwd();
            return { status: 0, stdout: cwd.includes('subdir') ? '../.git\n' : '.git\n', stderr: '' };
        }
        if (command === 'git' && args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
        if (command === 'git' && args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n', stderr: '' };
        if (command === 'git' && joined.startsWith('rev-parse --verify --quiet origin/')) return { status: 0, stdout: '', stderr: '' };
        if (command === 'git' && joined.startsWith('rev-parse --verify')) {
            return h.branchPreExists ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'check-ref-format') return { status: 0, stdout: '', stderr: '' };
        if (command === 'git' && args[0] === 'show-ref') {
            return h.branchPreExists ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'config') return { status: 1, stdout: '', stderr: '' };
        if (command === 'git' && args[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' };
        if (command === 'git' && args[0] === 'update-index') { updateIndexCalls.push(1); return { status: 0, stdout: '', stderr: '' }; }
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
            worktreeRemoveCalls.push(1);
            fs.removeSync(args[3] ?? args[2]);
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'branch' && args[1] === '-D') {
            branchDeleteCalls.push(1);
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
            // Git-first path (CORE-2307): `git worktree add` creates the
            // worktree directly. bd remains a recorded fallback only.
            worktreeCreateArgs.push(['git', ...args]);
            fs.ensureDirSync(h.worktreePath);
            if (h.seedWorktreeCopy) {
                const wtPackDir = path.join(h.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME);
                fs.ensureDirSync(wtPackDir);
                fs.copyFileSync(packSkillFile, path.join(wtPackDir, 'SKILL.md'));
            }
            if (h.seedStatusline) {
                const hookFile = path.join(h.worktreePath, '.xtrm', 'hooks', 'statusline.mjs');
                fs.ensureDirSync(path.dirname(hookFile));
                fs.writeFileSync(hookFile, '// statusline');
            }
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'bd' && args[0] === 'worktree') {
            // bd fallback: legacy primary, now only a fallback. Recorded
            // separately so tests can assert git-first ordering.
            worktreeCreateArgs.push(args);
            fs.ensureDirSync(h.worktreePath);
            if (h.seedWorktreeCopy) {
                const wtPackDir = path.join(h.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME);
                fs.ensureDirSync(wtPackDir);
                fs.copyFileSync(packSkillFile, path.join(wtPackDir, 'SKILL.md'));
            }
            if (h.seedStatusline) {
                const hookFile = path.join(h.worktreePath, '.xtrm', 'hooks', 'statusline.mjs');
                fs.ensureDirSync(path.dirname(hookFile));
                fs.writeFileSync(hookFile, '// statusline');
            }
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
        if (command === 'tmux' && args[0] === 'list-panes') return { status: 0, stdout: '%17\n', stderr: '' };
        if (command === 'tmux' && args[0] === 'display-message') return { status: 0, stdout: '$42\n', stderr: '' };
        if (command === 'tmux' && args[0] === 'list-sessions') return { status: 0, stdout: '', stderr: '' };
        if (command === 'tmux' && args[0] === 'new-session') {
            newSessionArgs = args;
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'tmux' && args[0] === 'load-buffer') {
            const input = mo.input as string | undefined;
            if (input) {
                try { capturedPayload = JSON.parse(input); } catch { capturedPayload = null; }
            }
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'tmux' && (args[0] === 'wait-for' || args[0] === 'delete-buffer' || args[0] === 'kill-session')) {
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'sb') {
            // CORE-2728: a issue launch records who dispatched it. Never a real store.
            return h.sbResult ?? { status: 0, stdout: '{"schema":"substrate-cli/v1","command":"provenance.dispatch","ok":true,"data":{}}', stderr: '' };
        }
        if (command === 'sh') return { status: 0, stdout: 'bin/codex\n', stderr: '' };
        if (command === 'pi') { piSpawnCalls.push(1); return { status: 0, stdout: '', stderr: '' }; }
        // Hermetic fail-closed fallback (reviewer 3be): an unexpected command
        // — especially a mutating one — never silently succeeds.
        return { status: 128, stdout: '', stderr: 'unexpected command (hermetic harness)' };
    });

    const profileBefore = treeSnapshot(process.env.CODEX_HOME ?? path.join(homeRoot, '.codex'));
    const cwdBefore = process.cwd();
    const homeBefore = process.env.HOME;
    const codexBefore = process.env.CODEX_HOME;
    const listenersBeforeSets: Record<string, unknown[]> = {
        SIGINT: process.listeners('SIGINT') as unknown[],
        SIGTERM: process.listeners('SIGTERM') as unknown[],
        SIGHUP: process.listeners('SIGHUP') as unknown[],
        exit: process.listeners('exit') as unknown[],
    };
    const listenersBefore: Record<string, number> = {};
    for (const k of Object.keys(listenersBeforeSets)) {
        listenersBefore[k] = listenersBeforeSets[k].length;
    }
    let error = '';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...msg: string[]) => {
        error += ` ${msg.flat().join(' ')}`;
    });
    const exitSpy = exitByThrow();
    const cwd = h.fromSubdir ? path.join(repoRoot, 'subdir') : repoRoot;
    fs.ensureDirSync(cwd);
    process.chdir(cwd);
    // envBefore captured AFTER the harness's own cwd/HOME setup, immediately
    // before the launch: the LAUNCHER must not change cwd/HOME/CODEX_HOME.
    const envBefore = { cwd: process.cwd(), HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    const cwdBeforeOriginal = cwdBefore;
    try {
        if (h.codex) {
            const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
            await launchCodexWorktreeSession({ ...opts } as never);
        } else {
            const { launchWorktreeSession } = await import('../utils/worktree-session.js');
            await launchWorktreeSession({ ...opts } as never);
        }
    } catch (e) {
        error += ` ${e instanceof Error ? e.message : String(e)}`;
    }
    // (3) Launcher IMMEDIATE-after state, captured BEFORE any harness cleanup:
    // the launcher must not alter cwd/HOME/CODEX_HOME and must leave a fixed,
    // bounded listener delta (its once-handlers) that cleanup then removes.
    const immediateEnv = { cwd: process.cwd(), HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    const immediateListeners: Record<string, number> = { SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const) {
        immediateListeners[signal] = process.listenerCount(signal);
    }
    const result: LaunchResult = {
        payload: capturedPayload ? JSON.stringify(capturedPayload) : null,
        error: error.trim(),
        calls: {
            branchDeleteCalls: branchDeleteCalls.length,
            worktreeRemoveCalls: worktreeRemoveCalls.length,
            worktreeCreateArgs: JSON.stringify(worktreeCreateArgs),
            piSpawn: piSpawnCalls.length,
            updateIndex: updateIndexCalls.length,
            spCwdsHeartbeat: spCwds.length,
        },
        spCwds,
        profileBefore,
        newSessionArgs,
        callLog: allCalls,
        spViewCalls,
        envBefore,
        cwdBeforeOriginal,
        immediateEnv,
        immediateListeners,
        envAfterCleanup: { cwd: '', HOME: undefined, CODEX_HOME: undefined },
        listenersBefore,
        listenersAfter: { SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 },
    };
    // Per-launch hygiene: remove any signal/exit listeners the launcher
    // registered so before == after for every launch (no accumulation), and
    // restore cwd + HOME + CODEX_HOME to their exact pre-launch values.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const) {
        const beforeSet = new Set(listenersBeforeSets[signal]);
        for (const fn of process.listeners(signal)) {
            if (!beforeSet.has(fn)) process.removeListener(signal, fn);
        }
    }
    process.chdir(cwdBefore);
    process.env.HOME = homeBefore;
    if (codexBefore === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = codexBefore;
    result.envAfterCleanup = { cwd: process.cwd(), HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'] as const) {
        result.listenersAfter[signal] = process.listenerCount(signal);
    }
    vi.restoreAllMocks();
    return result;
}

beforeEach(() => mocked.spawnSync.mockReset());
afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    process.env.HOME = originalHome;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    for (const root of roots.splice(0)) fs.removeSync(root);
});

function makeRepo(): { repoRoot: string; homeRoot: string; worktreePath: string; branchName: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-launch-'));
    roots.push(repoRoot);
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-home-'));
    roots.push(homeRoot);
    return {
        repoRoot,
        homeRoot,
        worktreePath: path.join(repoRoot, '.xtrm', 'worktrees', `${path.basename(repoRoot)}-xt-claude-demo`),
        branchName: 'xt/demo',
    };
}

function harnessOpts(over: Partial<LaunchHarness> = {}): LaunchHarness {
    const { repoRoot, homeRoot, worktreePath, branchName } = makeRepo();
    const full: LaunchHarness = {
        repoRoot,
        homeRoot,
        worktreePath,
        branchName,
        capturedPayload: null,
        newSessionArgs: null,
        calls: { branchDeleteCalls: 0, worktreeRemoveCalls: 0, worktreeCreateArgs: '', piSpawn: 0, updateIndex: 0, spCwdsHeartbeat: 0 },
        spCwds: [],
        profileBefore: [],
        callLog: [],
        spViewCalls: [],
        envBefore: { cwd: '', HOME: undefined, CODEX_HOME: undefined },
        cwdBeforeOriginal: '',
        immediateEnv: { cwd: '', HOME: undefined, CODEX_HOME: undefined },
        immediateListeners: { SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 },
        envAfterCleanup: { cwd: '', HOME: undefined, CODEX_HOME: undefined },
        listenersBefore: { SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 },
        listenersAfter: { SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 },
        seededWorktreeCopy: true,
        branchPreExists: false,
        seedStatusline: false,
        unresolvableModel: false,
        oldSp: false,
        extraSkills: [],
        role: 'sync-role',
        roleModel: 'claude-opus-5',
        runtime: 'claude',
        codex: false,
        fromSubdir: false,
        seedWorktreeCopy: true,
        error: '',
        ...over,
    };
    return full;
}

async function claudeLaunch(over: Partial<LaunchHarness> = {}): Promise<LaunchHarness & LaunchResult> {
    const h = harnessOpts(over);
    const result = await runLaunch(h, {
        name: 'demo',
        runtime: h.runtime,
        role: h.role === 'NONE' ? undefined : h.role,
        newSession: true,
        attach: false,
        skills: h.extraSkills,
        prompt: 'smoke body',
        model: h.oldSp ? 'claude-opus-5' : undefined, // legacy sp needs explicit model for the claude retry
        passthrough: undefined,
        json: false,
    });
    return { ...h, ...result };
}

async function codexLaunch(over: Partial<LaunchHarness> = {}): Promise<LaunchHarness & LaunchResult> {
    const h = harnessOpts({ codex: true, ...over });
    process.env.CODEX_HOME = path.join(h.homeRoot, '.codex');
    const result = await runLaunch(h, {
        name: 'demo',
        attach: false,
        json: true,
        yolo: false,
        skills: h.extraSkills,
    } as never);
    return { ...h, ...result };
}

function existsSync(p: string): boolean {
    return fs.pathExistsSync(p);
}

/** Byte-hashed tree snapshot (files + content sha256) for trust-profile
 * comparison: identical listing AND identical file bytes prove zero writes. */
function treeSnapshot(root: string): string[] {
    if (!fs.pathExistsSync(root)) return [];
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            out.push(path.join(rel, entry.name));
            if (entry.isSymbolicLink()) {
                out.push(`${path.join(rel, entry.name)} -> ${readlinkSync(p)}`);
            } else if (entry.isDirectory()) {
                walk(p, path.join(rel, entry.name));
            } else if (entry.isFile()) {
                out.push(`${path.join(rel, entry.name)} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
            }
        }
    };
    walk(root, '.');
    return out.sort();
}

/**
 * Proof-grade zero-mutation assertion (reviewer d5c): NOTHING may touch bd
 * worktree create, git worktree add/remove, branch delete, or the codex trust
 * profile, and the worktree path must not exist on disk.
 */
/** STRICT READ-ONLY allowlist (reviewer 6749 + exact-c2 seconder): on a
 * rejected launch the ONLY permitted spawns are EXACT read-only argv shapes:
 * sp view/prefix inspection, git read commands (config only in --get-style
 * forms), tmux inspection, and the exact `sh -c 'command -v "$1"'` executable
 * resolver. ANY write-capable argv — `sh -c touch`, a mutating sp subcommand,
 * `git config key value` — is rejected. */
function isReadOnlyCall(c: { command: string; argv: string[] }): boolean {
    const argv = c.argv;
    if (c.command === 'sp') {
        // EXACT inspection shapes only:
        //   view <name> --raw                    (legacy retry)
        //   view <name> --raw --surface pi|claude
        //   render-skill-prefix --help
        //   render-skill-prefix <name> --surface pi|claude
        if (argv[0] === 'view') {
            // view <name> --raw                          (legacy retry)
            // view <name> --raw --surface pi|claude      (surfaced)
            const name = argv[1];
            if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
            if (argv.length === 3 && argv[2] === '--raw') return true;
            if (argv.length === 5 && argv[2] === '--raw' && argv[3] === '--surface'
                && ['pi', 'claude'].includes(argv[4])) return true;
            return false;
        }
        if (argv[0] === 'render-skill-prefix') {
            // EXACT: --help alone, or <name> --surface pi|claude (4 tokens),
            // with the name nonempty and NOT option-like ('-...').
            if (argv.length === 2 && argv[1] === '--help') return true;
            const name = argv[1];
            if (argv.length === 4 && argv[2] === '--surface' && ['pi', 'claude'].includes(argv[3])) {
                return typeof name === 'string' && name.length > 0 && !name.startsWith('-');
            }
            return false;
        }
        return false;
    }
    if (c.command === 'git') {
        if (argv[0] === 'config' || (argv[0] === '-C' && argv[2] === 'config')) {
            // EXACT read-only config tuple positions: `config <read-flag>
            // <key>` or `config --list`; the config token must be argv[0] (or
            // argv[2] under a `-C <root>` prefix). Anything else — a config
            // token at any other position, a value pair, extra positionals —
            // is a write/counterexample and rejected.
            const tail = argv.slice(argv[0] === 'config' ? 1 : 3);
            const read = ['--get', '--get-all', '--show-origin'];
            if (read.includes(tail[0] ?? '')) return tail.length === 2;
            if (tail[0] === '--list') return tail.length === 1;
            return false;
        }
        if (argv[0] === 'rev-parse') {
            // EXACT observed: --show-toplevel | --git-common-dir | --verify <ref>
            if (argv.length === 2 && (argv[1] === '--show-toplevel' || argv[1] === '--git-common-dir')) return true;
            if (argv.length === 3 && argv[1] === '--verify') return true;
            return false;
        }
        if (argv[0] === 'check-ref-format') {
            // EXACT observed: --branch <name>
            return argv.length === 3 && argv[1] === '--branch';
        }
        if (argv[0] === 'show-ref') {
            // EXACT observed: --verify --quiet <ref>
            return argv.length === 4 && argv[1] === '--verify' && argv[2] === '--quiet';
        }
        if (argv[0] === 'ls-files') {
            // EXACT observed: -- <pathspec>  (ls-files -- <path>)
            return argv.length === 3 && argv[1] === '--';
        }
        return false;
    }
    if (c.command === 'tmux') {
        // EXACT observed tmux inspection shapes (cardinality + flags exact);
        // anything else — including any '-I' input/mutation flag or arbitrary
        // formats — is forbidden.
        if (argv[0] === 'has-session') {
            return argv.length === 3 && argv[1] === '-t' && argv[2].startsWith('=');
        }
        if (argv[0] === 'display-message') {
            // EXACTLY two observed shapes, nothing else:
            //   ['display-message', '-p', ALLOWED_FORMAT]
            //   ['display-message', '-p', '-t', <target>, ALLOWED_FORMAT]
            // Duplicate -p, duplicate/absent formats, missing targets, and
            // misplaced flags are all rejected. Formats are from an exact
            // finite literal set (no nested '#(...)' expansion possible).
            const ALLOWED_FORMATS = new Set(['#{pane_id}', '#{session_id}']);
            if (argv.length === 3 && argv[1] === '-p') {
                return ALLOWED_FORMATS.has(argv[2]);
            }
            if (argv.length === 5 && argv[1] === '-p' && argv[2] === '-t') {
                const target = argv[3];
                return typeof target === 'string' && target.length > 0 && !target.startsWith('-') && ALLOWED_FORMATS.has(argv[4]);
            }
            return false;
        }
        if (argv[0] === 'list-panes') {
            // observed: -t <name> -F #{pane_id}  (pane query, exact 5 tokens)
            return argv.length === 5 && argv[1] === '-t' && argv[3] === '-F' && argv[4] === '#{pane_id}';
        }
        if (argv[0] === 'list-sessions') {
            return argv.length === 1;
        }
        return false;
    }
    if (c.command === 'sh') {
        // EXACT known read-only resolver: sh -c 'command -v "$1"' xtrm codex
        // — complete literal shape, no other sh invocation is read-only.
        return argv.length === 4 && argv[0] === '-c' && argv[1] === 'command -v "$1"'
            && argv[2] === 'xtrm' && argv[3] === 'codex';
    }
    return false;
}

function assertReadOnlyCallsOnly(r: LaunchHarness & LaunchResult): void {
    const forbidden = r.callLog.filter((c) => !isReadOnlyCall(c));
    expect(forbidden).toEqual([]);
}

function expectZeroMutation(r: LaunchHarness & LaunchResult, codexHomeSnapshot?: string[]): void {
    expect(r.calls.worktreeCreateArgs).toBe('[]');
    expect(r.calls.worktreeRemoveCalls).toBe(0);
    expect(r.calls.branchDeleteCalls).toBe(0);
    expect(r.calls.piSpawn).toBe(0);
    expect(r.calls.updateIndex).toBe(0);          // no index/worktree mutation
    expect(r.newSessionArgs).toBeNull();          // no tmux session created
    expect(fs.pathExistsSync(r.worktreePath)).toBe(false);
    // Strict READ-ONLY allowlist (reviewer 6749): on rejection, only sp/git/tmux
    // inspection may have been invoked — bd/pi/codex or any mutator is forbidden.
    assertReadOnlyCallsOnly(r);
    // Codex trust profile: the CODEX_HOME tree must be byte-for-byte listed
    // identical to the pre-rejection snapshot (no new path, no writes).
    if (codexHomeSnapshot !== undefined) {
        expect(treeSnapshot(path.join(r.homeRoot, '.codex'))).toEqual(codexHomeSnapshot);
    }
}

/**
 * Proof-grade link identity (seconder 516): the materialized entry under
 * <worktree>/.claude/skills/<name> must be a SYMLINK whose readlink target
 * resolves to the WORKTREE-LOCAL pack copy (not the main checkout, not an
 * exists check).
 */
/** Exact single-link .claude/skills dir assertion (complete set, alternate absent). */
function expectSingleLinkDir(worktreePath: string, name: string, wtCopyDir: string): void {
    expect(fs.readdirSync(path.join(worktreePath, '.claude', 'skills')).sort()).toEqual([name]);
    expectClaudeLinkToWorktreeCopy(worktreePath, name, wtCopyDir);
}

function expectClaudeLinkToWorktreeCopy(worktreePath: string, name: string, wtCopyDir: string): void {
    const link = path.join(worktreePath, '.claude', 'skills', name);
    const stat = fs.lstatSync(link);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(path.relative(path.dirname(link), wtCopyDir));
    expect(realpathSync(link)).toBe(realpathSync(wtCopyDir));
    expect(realpathSync(path.join(link, 'SKILL.md'))).toBe(realpathSync(path.join(wtCopyDir, 'SKILL.md')));
}

/** Minimal POSIX-ish shell tokenizer for the launcher's shellQuote output. */
/**
 * CORE-2727 (D7): the pane command may start with `env -u '<KEY>' ...` unsets.
 * Splits them off and returns the keys, so a caller asserts the runtime argv
 * EXACTLY as before and additionally pins that only dispatcher keys are cleared.
 */
function splitUnsetPrefix(tokens: string[]): { keys: string[]; argv: string[] } {
    if (tokens[0] !== 'env') return { keys: [], argv: tokens };
    const keys: string[] = [];
    let i = 1;
    while (tokens[i] === '-u' && i + 1 < tokens.length) {
        keys.push(tokens[i + 1]);
        i += 2;
    }
    return { keys, argv: tokens.slice(i) };
}

function shellTokens(cmd: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    let cur = '';
    let inTok = false;
    let quote: string | null = null;
    while (i < cmd.length) {
        const ch = cmd[i];
        if (quote) {
            if (ch === quote) { quote = null; } else if (ch === '\\' && quote === '\'') { cur += cmd[i + 1]; i += 1; } else { cur += ch; }
        } else if (ch === '\'' || ch === '"') {
            quote = ch; inTok = true;
        } else if (ch === ' ') {
            if (inTok) { tokens.push(cur); cur = ''; inTok = false; }
        } else {
            cur += ch; inTok = true;
        }
        i += 1;
    }
    if (inTok) tokens.push(cur);
    return tokens;
}

describe('launchWorktreeSession claude role (launch-level, 751b/830)', () => {
    it('materializes the alias link and emits the EXACT final claude body (canonical 3-skill role, normal sp)', async () => {
        const r = await claudeLaunch();
        expect(r.error).toMatch(/^exit:0/);
        expect(r.calls.worktreeCreateArgs).not.toHaveLength(0);
        expectSingleLinkDir(r.worktreePath, PACK_NAME, path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME));
        const args = JSON.parse(r.payload as string).runtimeArgs as string[];
        const body = args.at(-1) as string;
        // Exact final turn-1 body: one bound command + the two non-pack
        // commands in declaration order + the literal prompt.
        expect(body).toBe('/service-knowledge\n/gitnexus-impact-analysis\n/gitnexus-exploring\n\nsmoke body');
        expect(body).not.toContain(`/${RUNTIME_NAME_LONG}`);
    });

    it('role + explicit same identity emits one command in BOTH orders (normal sp)', async () => {
        const a = await claudeLaunch({ extraSkills: [PACK_NAME] });
        const b = await claudeLaunch({ extraSkills: [`.xtrm/skills/infra/${PACK_NAME}`] });
        for (const r of [a, b]) {
            expect(r.error).toMatch(/^exit:0/);
            const args = JSON.parse(r.payload as string).runtimeArgs as string[];
            expect(args.at(-1) as string).toBe('/service-knowledge\n/gitnexus-impact-analysis\n/gitnexus-exploring\n\nsmoke body');
            expectSingleLinkDir(r.worktreePath, PACK_NAME, path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME));
        }
        // Launcher must not change cwd/HOME/CODEX_HOME (immediate-after == before)
        // and must leave a FIXED, bounded listener delta; cleanup restores both.
        let _i = 0;
        for (const r of [a, b]) {
            _i += 1;
            expect(r.immediateEnv).toEqual(r.envBefore);
            // Permitted EXACT listener delta: the launcher registers its three
            // SIGINT/SIGTERM/SIGHUP cleanup once-handlers and REMOVES them
            // itself (process.off) before returning — so the net delta must be
            // exactly 0 on every signal and exit, per launch, with nothing
            // accumulating across launches.
            const delta = {
                SIGINT: r.immediateListeners.SIGINT - r.listenersBefore.SIGINT,
                SIGTERM: r.immediateListeners.SIGTERM - r.listenersBefore.SIGTERM,
                SIGHUP: r.immediateListeners.SIGHUP - r.listenersBefore.SIGHUP,
                exit: r.immediateListeners.exit - r.listenersBefore.exit,
            };
            expect(delta).toEqual({ SIGINT: 0, SIGTERM: 0, SIGHUP: 0, exit: 0 });
            expect(r.listenersAfter).toEqual(r.listenersBefore);
            // Cleanup measured: HOME/CODEX_HOME unchanged; cwd restored to the
            // ORIGINAL pre-launch cwd (the harness chdirs into the repoRoot and
            // back out; the launcher itself never changes cwd).
            expect(r.envAfterCleanup.HOME).toEqual(r.envBefore.HOME);
            expect(r.envAfterCleanup.CODEX_HOME).toEqual(r.envBefore.CODEX_HOME);
            expect(path.normalize(r.envAfterCleanup.cwd ?? "")).toBe(path.normalize(r.cwdBeforeOriginal));
        }
    });

    it('old-sp fallback binds runtimeName for path-only role and agrees prefix/link', async () => {
        const r = await claudeLaunch({ oldSp: true });
        expect(r.error).toMatch(/^exit:0/);
        const args = JSON.parse(r.payload as string).runtimeArgs as string[];
        const body = args.at(-1) as string;
        expect(body).toBe(`/${RUNTIME_NAME_LONG}\n/gitnexus-impact-analysis\n/gitnexus-exploring\n\nsmoke body`);
        expectSingleLinkDir(r.worktreePath, RUNTIME_NAME_LONG, path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME));
        // (2) the old-sp SURFACED view must have failed and the legacy retry
        // must have run WITHOUT --surface, with the main-root cwd.

        // Old-sp: EXACT ordered spViewCalls array — surfaced (failed) then
        // legacy --raw retry, cardinality exactly 2, each argv/cwd exact.
        expect(path.normalize(r.cwdBeforeOriginal)).toBe(path.normalize(process.cwd()));
        expect(r.spViewCalls.map((c) => c.argv)).toEqual([
            ['view', 'sync-role', '--raw', '--surface', 'claude'],
            ['view', 'sync-role', '--raw'],
        ]);
        for (const c of r.spViewCalls) {
            expect(path.normalize(c.cwd)).toBe(path.normalize(r.repoRoot));
        }
    });

    it('old-sp + explicit alias binds the alias and emits one command (permutation)', async () => {
        const r = await claudeLaunch({ oldSp: true, extraSkills: [PACK_NAME] });
        expect(r.error).toMatch(/^exit:0/);
        const args = JSON.parse(r.payload as string).runtimeArgs as string[];
        const body = args.at(-1) as string;
        expect(body).toBe('/service-knowledge\n/gitnexus-impact-analysis\n/gitnexus-exploring\n\nsmoke body');
        expect((body.match(/\/service-knowledge/g) ?? []).length).toBe(1);
        expectSingleLinkDir(r.worktreePath, PACK_NAME, path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME));
    });

    it('duplicate role alias declarations emit exactly one command/link (SEC-02, normal sp)', async () => {
        const r = await claudeLaunch({
            roleSpecPaths: [`.xtrm/skills/infra/${PACK_NAME}`, `.xtrm/skills/infra/${PACK_NAME}`],
            roleSpNames: [PACK_NAME, PACK_NAME],
        });
        expect(r.error).toMatch(/^exit:0/);
        const args = JSON.parse(r.payload as string).runtimeArgs as string[];
        expect(args.at(-1) as string).toBe('/service-knowledge\n\nsmoke body');
        expect((args.at(-1) as string).match(/\/service-knowledge/g) ?? []).toHaveLength(1);
        expectSingleLinkDir(r.worktreePath, PACK_NAME, path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME));
    });

    it('old-sp duplicate role declarations emit exactly one command/link (SEC-02)', async () => {
        const r = await claudeLaunch({
            oldSp: true,
            roleSpecPaths: [`.xtrm/skills/infra/${PACK_NAME}`, `.xtrm/skills/infra/${PACK_NAME}`],
            roleSpNames: [PACK_NAME, PACK_NAME],
        });
        expect(r.error).toMatch(/^exit:0/);
        const args = JSON.parse(r.payload as string).runtimeArgs as string[];
        expect(args.at(-1) as string).toBe(`/${RUNTIME_NAME_LONG}\n\nsmoke body`);
        expectSingleLinkDir(r.worktreePath, RUNTIME_NAME_LONG, path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME));
    });

    it('rejects a role declaration naming a skill outside its slot/runtime names (reviewer 78, launch-level)', async () => {
        const r = await claudeLaunch({ roleSpecPaths: [`.xtrm/skills/infra/${PACK_NAME}`], roleSpNames: ['other-alias'] });
        expect(r.error).toMatch(/neither its slot name/);
        expectZeroMutation(r);
    });

    it('provisioning failure rolls back worktree only and preserves a pre-existing reused branch (SEC-FINAL-01)', async () => {
        const r = await claudeLaunch({ seedWorktreeCopy: false, branchPreExists: true });
        expect(r.error).toMatch(/must be tracked|absent from the worktree|does not contain/);
        expect(r.calls.worktreeRemoveCalls).toBeGreaterThan(0);
        expect(r.calls.branchDeleteCalls).toBe(0);
    });

    it('provisioning failure deletes a launcher-created branch (SEC-FINAL-01)', async () => {
        const r = await claudeLaunch({ seedWorktreeCopy: false, branchPreExists: false });
        expect(r.error).toMatch(/must be tracked|absent from the worktree|does not contain/);
        expect(r.calls.worktreeRemoveCalls).toBeGreaterThan(0);
        expect(r.calls.branchDeleteCalls).toBeGreaterThan(0);
    });

    it('never writes worktree-local .claude/settings.local.json (global statusline owns UI)', async () => {
        // seedStatusline plants a worktree-local hook script: pre-fix
        // provisioning bound settings.local.json to it.
        const r = await claudeLaunch({ role: 'NONE', seedStatusline: true });
        expect(r.error).toMatch(/^exit:0/);
        expect(fs.pathExistsSync(path.join(r.worktreePath, '.xtrm', 'hooks', 'statusline.mjs'))).toBe(true);
        expect(fs.pathExistsSync(path.join(r.worktreePath, '.claude', 'settings.local.json'))).toBe(false);
    });

    describe('bare claude explicit permutations (SEC-03, exact)', () => {
        const P = [`.xtrm/skills/infra/${PACK_NAME}` as string, PACK_NAME as string];
        const PERMUTATIONS = [...new Set([
            [P[0], P[1]],
            [P[1], P[0]],
            [P[0]],
            [P[1]],
            [P[0], P[1], P[0]],
        ].map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x) as string[]);

        it('every bare permutation yields exactly one command/link per the bound policy (SEC-03)', async () => {
            for (const skills of PERMUTATIONS) {
                const r = await claudeLaunch({ role: 'NONE', extraSkills: skills });
                expect(r.error).toMatch(/^exit:0/);
                const commandLine = (r.newSessionArgs ?? []).join(' ');
                const aliasCount = (commandLine.match(/\/service-knowledge/g) ?? []).length;
                const canonicalCount = (commandLine.match(/\/infra-xt-claude-sk-reconcile-infra-service-knowledge/g) ?? []).length;
                // Path-only requests bind the canonical runtimeName (approved
                // explicit-path contract); when the bare slot alias is
                // requested it wins and no canonical command remains.
                if (skills.includes(PACK_NAME)) {
                    expect(aliasCount).toBe(1);
                    expect(canonicalCount).toBe(0);
                } else {
                    expect(aliasCount).toBe(0);
                    expect(canonicalCount).toBe(1);
                }
                expectSingleLinkDir(
                    r.worktreePath,
                    skills.includes(PACK_NAME) ? PACK_NAME : RUNTIME_NAME_LONG,
                    path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME),
                );
            }
        });
    });
});

describe('bare direct launch argv (CORE-2283)', () => {
    // The DIRECT path is the one launch shape with no tmux plan: `xt claude
    // <name>` carrying NONE of prompt/issue/model/thinking/skills/passthrough,
    // attached, no --new-session. That is the exact condition set the launcher
    // routes to spawnSync-in-terminal, so it needs its own argv assertion —
    // the plan-builder tests cannot reach it.
    async function directLaunch(home: { pluginInstalled: boolean }): Promise<LaunchHarness & LaunchResult> {
        const h = harnessOpts({ runtime: 'claude' });
        if (home.pluginInstalled) {
            fs.ensureDirSync(path.join(h.homeRoot, '.claude', 'plugins'));
            fs.writeFileSync(
                path.join(h.homeRoot, '.claude', 'plugins', 'installed_plugins.json'),
                JSON.stringify({ plugins: { 'specialists@xtrm': [{ version: '1.0.0' }] } }),
            );
        }
        const result = await runLaunch(h, { name: 'demo', runtime: 'claude', attach: true, json: false });
        return { ...h, ...result };
    }

    function directClaudeArgv(r: LaunchHarness & LaunchResult): string[] {
        const call = r.callLog.find((c) => c.command === 'claude');
        // Proves the run actually took the direct path: the harness records
        // every spawnSync, and only this path spawns `claude`.
        expect(call).toBeDefined();
        expect(r.newSessionArgs).toBeNull();
        return call?.argv ?? [];
    }

    it('passes --channels plugin:specialists@xtrm when the manifest lists specialists@xtrm', async () => {
        const r = await directLaunch({ pluginInstalled: true });
        const argv = directClaudeArgv(r);
        expect(argv[0]).toBe('--name');
        expect(argv).toContain('--dangerously-skip-permissions');
        const at = argv.indexOf('--channels');
        expect(at).toBeGreaterThan(-1);
        expect(argv[at + 1]).toBe('plugin:specialists@xtrm');
    });

    it('omits --channels when no plugin manifest is installed (fail-soft)', async () => {
        const r = await directLaunch({ pluginInstalled: false });
        const argv = directClaudeArgv(r);
        expect(argv).toContain('--dangerously-skip-permissions');
        expect(argv).not.toContain('--channels');
    });
});

describe('Substrate MCP env on claude launches (CORE-2290)', () => {
    const KEYS = ['MCP_SDK_GENERATION', 'MCP_PROTOCOL_NEGOTIATION'] as const;
    const saved = KEYS.map((k) => process.env[k]);
    afterEach(() => {
        KEYS.forEach((k, i) => {
            if (saved[i] === undefined) delete process.env[k];
            else process.env[k] = saved[i];
        });
    });

    it('claudeMcpEnv defaults for claude, keeps explicit values, and is empty for other runtimes', async () => {
        const { claudeMcpEnv } = await import('../utils/worktree-session.js');
        expect(claudeMcpEnv('claude', {})).toEqual({ MCP_SDK_GENERATION: 'v2', MCP_PROTOCOL_NEGOTIATION: 'auto' });
        expect(claudeMcpEnv('claude', { MCP_SDK_GENERATION: 'v3', MCP_PROTOCOL_NEGOTIATION: '  ' }))
            .toEqual({ MCP_SDK_GENERATION: 'v3', MCP_PROTOCOL_NEGOTIATION: 'auto' });
        expect(claudeMcpEnv('pi', {})).toEqual({});
    });

    it('direct launch spawns claude with both variables', async () => {
        KEYS.forEach((k) => delete process.env[k]);
        const h = harnessOpts({ runtime: 'claude' });
        const r = await runLaunch(h, { name: 'demo', runtime: 'claude', attach: true, json: false });
        const call = r.callLog.find((c) => c.command === 'claude');
        expect(call).toBeDefined();
        expect(call?.env).toMatchObject({ MCP_SDK_GENERATION: 'v2', MCP_PROTOCOL_NEGOTIATION: 'auto' });
    });

    it('tmux launch passes both variables to new-session with -e, preserving an exported value', async () => {
        process.env.MCP_SDK_GENERATION = 'v9';
        delete process.env.MCP_PROTOCOL_NEGOTIATION;
        const h = harnessOpts({ runtime: 'claude' });
        const r = await runLaunch(h, { name: 'demo', runtime: 'claude', attach: false, json: false });
        const args = r.newSessionArgs ?? [];
        expect(args).toContain('MCP_SDK_GENERATION=v9');
        expect(args).toContain('MCP_PROTOCOL_NEGOTIATION=auto');
        expect(args[args.indexOf('MCP_PROTOCOL_NEGOTIATION=auto') - 1]).toBe('-e');
    });
});

describe('tmp-git guard predicate (fae security SEC-02)', () => {
    it('exempts only the EXACT temp root cwd; any other /tmp project fails closed', () => {
        const tmp = path.join(os.tmpdir(), 'TMPROOT');
        expect(needsTmpGitGuard(tmp, tmp)).toBe(false);                              // cwd === tempRoot: exempt
        expect(needsTmpGitGuard(path.join(tmp, 'project'), tmp)).toBe(true);          // /tmp/project: guarded
        expect(needsTmpGitGuard(path.join(tmp, 'a', 'b'), tmp)).toBe(true);           // deeper /tmp cwd: guarded
        expect(needsTmpGitGuard('/home/u/dev/repo', tmp)).toBe(true);                 // non-tmp: guarded
        expect(needsTmpGitGuard(tmp + path.sep, tmp)).toBe(true);                     // trailing-slash variant != exact root
    });
});

describe('read-only classifier self-tests (exact-c2 seconder)', () => {
    it('accepts the exact observed read-only argv shapes', () => {
        // sp inspection
        expect(isReadOnlyCall({ command: 'sp', argv: ['view', 'sync-role', '--raw'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'sp', argv: ['view', 'sync-role', '--raw', '--surface', 'claude'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', '--help'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', 'sync-role', '--surface', 'pi'] })).toBe(true);
        // git reads
        expect(isReadOnlyCall({ command: 'git', argv: ['rev-parse', '--show-toplevel'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'git', argv: ['-C', '/x', 'config', '--get', 'core.hooksPath'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'git', argv: ['config', '--get', 'core.hooksPath'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'git', argv: ['config', '--list'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'git', argv: ['show-ref', '--verify', '--quiet', 'xt/demo'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'git', argv: ['check-ref-format', '--branch', 'xt/demo'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'git', argv: ['ls-files', '--', '.beads'] })).toBe(true);
        // tmux inspection
        expect(isReadOnlyCall({ command: 'tmux', argv: ['has-session', '-t', '=x'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '#{pane_id}'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '-t', '$42', '#{session_id}'] })).toBe(true);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['list-panes', '-t', 'x', '-F', '#{pane_id}'] })).toBe(true);
        // exact sh resolver
        expect(isReadOnlyCall({ command: 'sh', argv: ['-c', 'command -v "$1"', 'xtrm', 'codex'] })).toBe(true);
    });

    it('rejects write-capable and non-observed argv shapes', () => {
        // sh mutator + shape counterexamples
        expect(isReadOnlyCall({ command: 'sh', argv: ['-c', 'touch /tmp/x'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sh', argv: ['-c', 'command -v "$1"', 'xtrm', 'codex', 'extra'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sh', argv: ['not-c', 'command -v "$1"', 'wrong', 'anything'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sh', argv: ['-c', 'command -v "$1"', 'wrong', 'anything'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sh', argv: ['-c', 'command -v "$1"', 'xtrm', 'other'] })).toBe(false);
        // sp mutator / bad shapes
        expect(isReadOnlyCall({ command: 'sp', argv: ['enable', 'pack'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sp', argv: ['view', 'x'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sp', argv: ['view', 'x', '--raw', '--surface', 'other'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', 'role', 'extra', '--surface', 'pi'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', 'role', '--surface', 'pi', 'extra'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', '--help', 'extra'] })).toBe(false);
        // git config WRITE forms + misplaced-config counterexample
        expect(isReadOnlyCall({ command: 'git', argv: ['config', 'user.name', 'bob'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['config', '--global', 'user.name', 'bob'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['-C', '/x', 'config', 'core.hooksPath', '/y'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['worktree', 'config', '--get', 'key'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['config', '--get', 'a', 'b'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['-C', '/x', 'config', '--list', 'extra'] })).toBe(false);
        // git mutators
        expect(isReadOnlyCall({ command: 'git', argv: ['worktree', 'add', '/w', 'xt/x'] })).toBe(false);
        // extra/trailing args on read commands
        expect(isReadOnlyCall({ command: 'git', argv: ['rev-parse', '--show-toplevel', 'extra'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['rev-parse', '--abbrev-ref', 'HEAD'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['rev-parse', '--git-common-dir', '--show-prefix'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['check-ref-format', '--branch', 'a', 'b'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['show-ref', '--verify', 'a', 'b', 'c'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['show-ref', '--verify', '--quiet'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['ls-files', '--all'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['ls-files', '-z', '--', 'x'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['rev-parse', '--verify'] })).toBe(false);
        // render-skill-prefix 4-token name validation
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', '-x', '--surface', 'pi'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', '', '--surface', 'pi'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'sp', argv: ['render-skill-prefix', 'r', '--surface', 'pi', 'extra'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['branch', '-D', 'xt/x'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['update-index', '--skip-worktree', '--', 'p'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'git', argv: ['config', '--get', 'a', 'b'] })).toBe(false);
        // tmux creators/transport
        expect(isReadOnlyCall({ command: 'tmux', argv: ['new-session', '-d', '-s', 'x'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['load-buffer', '-b', 'x'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['kill-session', '-t', 'x'] })).toBe(false);
        // tmux input/mutation flags and arbitrary formats
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-I'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '-I', '#{pane_id}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', 'arbitrary-format'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '#{pane_id}#(touch /tmp/x)'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '-p', '#{pane_id}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '-t', '#{pane_id}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '-t', '$x', '#{pane_id}', '#{session_id}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '-t', '-$x', '#{pane_id}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '-t'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '#{pane_id:--width}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '#(touch /tmp/x)'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['display-message', '-p', '#{unknown}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['has-session', '-I', '-t', '=x'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['list-panes', '-I', '-t', 'x', '-F', '#{pane_id}'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'tmux', argv: ['list-sessions', '-I'] })).toBe(false);
        // bd / pi / codex forbidden
        expect(isReadOnlyCall({ command: 'bd', argv: ['worktree', 'create', '/w'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'pi', argv: ['--version'] })).toBe(false);
        expect(isReadOnlyCall({ command: 'codex', argv: ['--version'] })).toBe(false);
    });
});

describe('launcher-level pack tables (830)', () => {
    const FORMS = ['root-dir', 'root-skill', 'child-dir', 'child-skill'] as const;
    const formPath = (form: string): string => {
        switch (form) {
            case 'root-dir': return '.xtrm/skills/infra';
            case 'root-skill': return '.xtrm/skills/infra/SKILL.md';
            case 'child-dir': return `.xtrm/skills/infra/${PACK_NAME}`;
            default: return `.xtrm/skills/infra/${PACK_NAME}/SKILL.md`;
        }
    };
    const packSkillPathFor = (repoRoot: string, form: string): string =>
        form === 'root-dir' || form === 'root-skill'
            ? path.join(repoRoot, '.xtrm', 'skills', 'infra', 'SKILL.md')
            : path.join(repoRoot, '.xtrm', 'skills', 'infra', PACK_NAME, 'SKILL.md');

    it.each(FORMS)('pi valid %s forwards the pack SKILL path via --skill', async (form) => {
        const r = await claudeLaunch({ role: 'NONE', runtime: 'pi', extraSkills: [formPath(form)] });
        expect(r.error).toMatch(/^exit:0/);
        // COMPLETE argv equality (reviewer 3be): exact command, option order,
        // exactly one --skill pointing at the absolute pack SKILL path, and
        // the positional boundary.
        const { keys, argv: tokens } = splitUnsetPrefix(shellTokens((r.newSessionArgs ?? []).at(-1) ?? ''));
        const displayName = `${path.basename(r.repoRoot)}-xt-pi-demo`;
        expect(tokens).toEqual(['pi', '--name', displayName, '--skill', packSkillPathFor(r.repoRoot, form), 'smoke body']);
        // D7: whatever the launch clears is dispatcher env, never the runtime argv.
        expect(keys.every((key) => (DISPATCHER_ENV_KEYS as readonly string[]).includes(key))).toBe(true);
    });

    it.each(FORMS)('pi malformed/missing %s rejects before worktree mutation', async (form) => {
        const r = await claudeLaunch({
            role: 'NONE',
            runtime: 'pi',
            extraSkills: [formPath(form)],
            malformedPack: 'missing',
        });
        expect(r.error).not.toMatch(/^exit:0/);
        expectZeroMutation(r);
    });

    it('pi multi-skill ordering preserves request order with one --skill each', async () => {
        const r = await claudeLaunch({
            role: 'NONE',
            runtime: 'pi',
            extraSkills: [`.xtrm/skills/infra/${PACK_NAME}/SKILL.md`, '.xtrm/skills/infra/SKILL.md'],
        });
        expect(r.error).toMatch(/^exit:0/);
        const { keys, argv: tokens } = splitUnsetPrefix(shellTokens((r.newSessionArgs ?? []).at(-1) ?? ''));
        const displayName = `${path.basename(r.repoRoot)}-xt-pi-demo`;
        expect(keys.every((key) => (DISPATCHER_ENV_KEYS as readonly string[]).includes(key))).toBe(true);
        expect(tokens).toEqual([
            'pi',
            '--name', displayName,
            '--skill', path.join(r.repoRoot, '.xtrm', 'skills', 'infra', PACK_NAME, 'SKILL.md'),
            '--skill', path.join(r.repoRoot, '.xtrm', 'skills', 'infra', 'SKILL.md'),
            'smoke body',
        ]);
    });

    it.each(FORMS)('pi unsafe-name %s rejects before worktree mutation', async (form) => {
        const r = await claudeLaunch({
            role: 'NONE',
            runtime: 'pi',
            extraSkills: [formPath(form)],
            malformedPack: 'unsafe-name',
        });
        expect(r.error).not.toMatch(/^exit:0/);
        expectZeroMutation(r);
    });

    it.each(FORMS)('codex pack-shaped %s rejects as unsupported before worktree mutation', async (form) => {
        const r = await codexLaunch({ extraSkills: [formPath(form)] });
        expect(r.error).toContain('do not support');
        expectZeroMutation(r, r.profileBefore);
    });

    it.each(FORMS)('codex malformed/missing %s rejects with a bounded probe error before worktree mutation', async (form) => {
        const r = await codexLaunch({ extraSkills: [formPath(form)], malformedPack: 'missing' });
        expect(r.error).not.toMatch(/^exit:0/);
        expectZeroMutation(r, r.profileBefore);
    });

    it.each(FORMS)('codex unsafe-name %s rejects before worktree mutation', async (form) => {
        const r = await codexLaunch({ extraSkills: [formPath(form)], malformedPack: 'unsafe-name' });
        expect(r.error).toMatch(/unsafe runtime name/);
        expectZeroMutation(r, r.profileBefore);
    });

    it.each(['pi', 'claude', 'codex'] as const)('relative pack request with matching HOME never selects HOME (%s)', async (runtime) => {
        // A temp HOME contains .xtrm/skills/infra content; the REPO lacks the
        // pack. Any relative pack-shaped request must fail prelaunch with ZERO
        // worktree mutation.
        const r = runtime === 'codex'
            ? await codexLaunch({ extraSkills: ['.xtrm/skills/infra/catalog'], malformedPack: 'missing' })
            : await claudeLaunch({ role: 'NONE', runtime, extraSkills: ['.xtrm/skills/infra/catalog'], malformedPack: 'missing' });
        expect(r.error).not.toMatch(/^exit:0/);
        expectZeroMutation(r, r.profileBefore);
        // HOME content must NOT have been selected: no forward, no link, no
        // payload success.
        expect(JSON.stringify(r.payload)).not.toContain('home');
    });

    it('subdirectory launch: legacy sp cwd is the main repo root (751b)', async () => {
        const r = await claudeLaunch({ fromSubdir: true, oldSp: true });
        expect(r.error).toMatch(/^exit:0/);
        const args = JSON.parse(r.payload as string).runtimeArgs as string[];
        expect(args.at(-1) as string).toBe(`/${RUNTIME_NAME_LONG}\n/gitnexus-impact-analysis\n/gitnexus-exploring\n\nsmoke body`);
        // The subdirectory launch succeeded, which REQUIRES sp (legacy) to have
        // resolved repo-local specs from the MAIN root. The mocked spawnSync
        // captures the actual cwd of every `sp view` call: it must equal the
        // main repo root, not the launch subdirectory.
        expect(r.spCwds ?? []).not.toHaveLength(0);
        for (const cwd of r.spCwds ?? []) {
            expect(path.normalize(cwd)).toBe(path.normalize(r.repoRoot));
        }
        expect(r.newSessionArgs).not.toBeNull();
        const ns = r.newSessionArgs as string[];
        const cIdx = ns.indexOf('-c');
        expect(cIdx).toBeGreaterThan(0);
        expect(path.normalize(ns[cIdx + 1])).toBe(path.normalize(r.worktreePath)); // pane runs in the worktree
        expectSingleLinkDir(r.worktreePath, RUNTIME_NAME_LONG, path.join(r.worktreePath, '.xtrm', 'skills', 'infra', PACK_NAME));
        expect(r.calls.worktreeCreateArgs).not.toHaveLength(0);
    });
});

// CORE-2728 (D8): a launch with --issue persists WHO dispatched it on the
// Substrate ExecutionBinding, from the same resolution the pane env exports.
describe('launch records the dispatcher on the Substrate binding (CORE-2728)', () => {
    const SESSION_UUID = '01a1ec56-3da4-77fb-aed5-c6dee5eb40ce';

    function dispatcherDeps(h: LaunchHarness, over: Record<string, unknown> = {}) {
        const sessionsDir = path.join(h.homeRoot, '.claude', 'sessions');
        fs.ensureDirSync(sessionsDir);
        fs.writeJsonSync(path.join(sessionsDir, '100.json'), {
            pid: 100,
            name: 'g04z-lead',
            messagingSocketPath: '/run/cc/100.sock',
            sessionId: SESSION_UUID,
        });
        // worker xt (pid 300) <- shell 200 <- claude dispatcher 100
        const table: Record<number, { ppid: number }> = { 300: { ppid: 200 }, 200: { ppid: 100 }, 100: { ppid: 1 } };
        return {
            sessionsDir,
            startPid: 300,
            readProcess: (pid: number) => table[pid] ?? null,
            readEnviron: (pid: number) => (pid === 100 ? { SUBSTRATE_HOLDER: 'g04z' } : null),
            env: {},
            tmux: () => ({ status: 1, stdout: '' }),
            ...over,
        };
    }

    it('a claude role launch with --issue writes one binding with the dispatcher flags, before tmux starts', async () => {
        const h = harnessOpts();
        const r = await runLaunch(h, {
            name: 'demo',
            runtime: 'claude',
            role: 'sync-role',
            issue: 'CORE-2728',
            newSession: true,
            attach: false,
            skills: [],
            dispatcherDeps: dispatcherDeps(h),
        });
        // The issue assignee probe fails in this hermetic harness; the launch itself succeeds.
        expect(r.error).toMatch(/exit:0/);
        const sbCalls = r.callLog.filter((c) => c.command === 'sb');
        // CORE-2740: dispatch, then one trace read-back that finds which binding
        // this launch wrote, so the session record can name it.
        expect(sbCalls).toHaveLength(2);
        expect(sbCalls[0].argv).toEqual([
            'provenance', 'dispatch', 'CORE-2728',
            '--dispatcher-participant', 'g04z',
            '--dispatcher-session', SESSION_UUID,
            '--workspace', h.worktreePath,
        ]);
        expect(sbCalls[1].argv).toEqual(['provenance', 'trace', 'CORE-2728', '--json']);
        // The binding precedes the work: recorded before the pane is created.
        const sbIndex = r.callLog.findIndex((c) => c.command === 'sb');
        const tmuxIndex = r.callLog.findIndex((c) => c.command === 'tmux' && c.argv[0] === 'new-session');
        expect(sbIndex).toBeGreaterThanOrEqual(0);
        expect(tmuxIndex).toBeGreaterThan(sbIndex);
        // CORE-2728 F3: the issue is persisted with the session record, so attach can
        // find this launch's binding after the pane is gone.
        expect(fs.readJsonSync(path.join(h.worktreePath, '.xtrm', 'session-meta.json'))).toMatchObject({
            runtime: 'claude',
            issue: 'CORE-2728',
        });
    });

    it('CORE-2740 F2: the launch records the binding id it just wrote in the session record', async () => {
        // The hermetic sb answers the same envelope to dispatch and to the trace
        // read-back; a binding in the launch's own worktree, created at launch time,
        // is the one the record must name.
        const h = harnessOpts();
        h.sbResult = {
            status: 0,
            stderr: '',
            stdout: JSON.stringify({
                schema: 'substrate-cli/v1',
                command: 'provenance.trace',
                ok: true,
                data: {
                    bindings: [
                        { id: 'exb_older', dispatcherParticipantId: 'old-lead', workspace: h.worktreePath, createdAt: 1 },
                        { id: 'exb_own', dispatcherParticipantId: 'g04z', workspace: h.worktreePath, createdAt: Date.now() + 60_000 },
                    ],
                },
            }),
        };
        const r = await runLaunch(h, {
            name: 'demo',
            runtime: 'claude',
            role: 'sync-role',
            issue: 'CORE-2728',
            newSession: true,
            attach: false,
            skills: [],
            dispatcherDeps: dispatcherDeps(h),
        });
        expect(r.error).toMatch(/exit:0/);
        expect(fs.readJsonSync(path.join(h.worktreePath, '.xtrm', 'session-meta.json'))).toMatchObject({
            runtime: 'claude',
            issue: 'CORE-2728',
            bindingId: 'exb_own',
        });
    });

    it.each([
        ['a failed sb', { status: 1, stdout: '', stderr: 'boom' }, 'sb (sb) exited 1: boom'],
        ['a missing sb', { status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawn sb ENOENT' } }, 'sb: spawn sb ENOENT'],
        ['a hung sb', { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }, 'sb: no answer in 5000 ms'],
    ])('CORE-2728 F4: %s is one warning and the launch still succeeds', async (_label, sbResult, reason) => {
        const h = harnessOpts({ sbResult: sbResult as never });
        const lines: string[] = [];
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            lines.push(String(chunk));
            return true;
        }) as never);
        let r: LaunchResult;
        try {
            r = await runLaunch(h, {
                name: 'demo',
                runtime: 'claude',
                role: 'sync-role',
                issue: 'CORE-2728',
                newSession: true,
                attach: false,
                skills: [],
                dispatcherDeps: dispatcherDeps(h),
            });
        } finally {
            stderrSpy.mockRestore();
        }
        expect(r.error).toMatch(/exit:0/);
        expect(r.callLog.filter((c) => c.command === 'sb')).toHaveLength(1);
        // EXACTLY one line about the dispatcher, no stack and no second report.
        const dispatcherLines = lines.filter((line) => line.includes('could not record the dispatcher'));
        expect(dispatcherLines).toEqual([`xt: could not record the dispatcher on CORE-2728 (launch continues): ${reason}\n`]);
    });

    it('an unknown dispatcher passes no dispatcher flag and never invents one', async () => {
        const h = harnessOpts();
        const r = await runLaunch(h, {
            name: 'demo',
            runtime: 'claude',
            role: 'sync-role',
            issue: 'CORE-2728',
            newSession: true,
            attach: false,
            skills: [],
            dispatcherDeps: dispatcherDeps(h, {
                readProcess: () => null,
                readEnviron: () => null,
                env: {},
            }),
        });
        // The issue assignee probe fails in this hermetic harness; the launch itself succeeds.
        expect(r.error).toMatch(/exit:0/);
        const sbCalls = r.callLog.filter((c) => c.command === 'sb');
        // CORE-2740: the dispatch and its read-back; the trace fixture names no
        // binding, so the record keeps no binding id and attach falls back to the
        // worktree match instead.
        expect(sbCalls).toHaveLength(2);
        expect(sbCalls[0].argv).toEqual(['provenance', 'dispatch', 'CORE-2728', '--workspace', h.worktreePath]);
        expect(sbCalls[0].argv).not.toContain('--dispatcher-participant');
        expect(sbCalls[0].argv).not.toContain('--dispatcher-session');
    });

    it('a launch without --issue writes no binding', async () => {
        const h = harnessOpts();
        const r = await runLaunch(h, {
            name: 'demo',
            runtime: 'claude',
            role: 'sync-role',
            newSession: true,
            attach: false,
            skills: [],
            dispatcherDeps: dispatcherDeps(h),
        });
        // The issue assignee probe fails in this hermetic harness; the launch itself succeeds.
        expect(r.error).toMatch(/exit:0/);
        expect(r.callLog.filter((c) => c.command === 'sb')).toHaveLength(0);
        // CORE-2728 F3: no issue means no issue key — never an empty placeholder.
        const meta = fs.readJsonSync(path.join(h.worktreePath, '.xtrm', 'session-meta.json')) as Record<string, unknown>;
        expect(meta.runtime).toBe('claude');
        expect(meta).not.toHaveProperty('issue');
    });
});

/**
 * CORE-2760. The model refusal (XTRM-970) sits on a path that runs *after* the worktree exists, so
 * before this fix every misconfigured `xt claude` printed `✓ Worktree ready`, refused, and left a
 * worktree directory and an `xt/<name>` branch behind — the next launch of that window then collided
 * with the branch. The comment above the resolution claimed the refusal preceded all worktree work.
 *
 * These drive the REAL launch path with no resolvable model and assert the composition, not the
 * pieces: exit 1, the three remedies the refusal names, no child process carrying `PI_MODEL`, and no
 * worktree or launcher-created branch left registered.
 */
describe('CORE-2760: a model refusal leaves no worktree, no branch and no PI_MODEL', () => {
    function captureStderr(): string[] {
        const chunks: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
            chunks.push(String(chunk));
            return true;
        }) as never);
        return chunks;
    }

    function expectRefusalShape(chunks: string[]): void {
        const text = chunks.join('');
        // The three lines a reviewer verified stay three lines, and each remedy is still named.
        expect(text).toContain('cannot resolve the model this claude seat would run');
        // CORE-2761 amended the middle remedy to the directory the seat runs in.
        expect(text).toContain('Pass --model <id>, set ANTHROPIC_MODEL, copy the settings file into the worktree,');
        expect(text).toContain('or declare specialist.execution.model on the role.');
        expect(text).toContain('.claude/settings.json or ~/.claude/settings.json');
    }

    function expectNothingSpawnedWithAModel(r: LaunchResult): void {
        // (c) no child process environment contains PI_MODEL — and here, no child at all.
        expect(r.callLog.filter((call) => call.env && 'PI_MODEL' in call.env)).toEqual([]);
        expect(r.callLog.some((call) => call.command === 'claude' || call.command === 'pi')).toBe(false);
    }

    it('a pre-existing worktree path is refused and left standing, not removed', async () => {
        // The `existsSync(worktreePath)` guard before `git worktree add` is what makes the
        // rollback's `worktree remove --force` safe: it stops the launcher from adopting a
        // directory it did not create. Nothing pinned that guard, so replacing it with
        // `if (false)` left every test green while a stale tree became removable by a launch.
        const h = harnessOpts({ role: 'NONE', unresolvableModel: true });
        fs.ensureDirSync(h.worktreePath);
        fs.writeFileSync(path.join(h.worktreePath, 'left-behind.txt'), 'not mine');
        const chunks = captureStderr();
        const launched = await runLaunch(h, {
            name: 'demo',
            runtime: 'claude',
            role: undefined,
            newSession: true,
            attach: false,
            skills: [],
            prompt: 'smoke body',
            model: undefined,
            passthrough: undefined,
            json: false,
        });
        const r = { ...h, ...launched };
        // The refusal is written with console.error before the exit, so it lands in `error`, not
        // in the stderr spy: assert on the text the operator would see, and the status at its end.
        expect(r.error).toContain('Worktree path already exists');
        expect(r.error).toMatch(/exit:1$/);
        // The pre-existing directory survives with its contents: no remove, no branch deletion,
        // and no runtime spawn took the seat into a tree this launch did not create.
        expect(r.calls.worktreeRemoveCalls).toBe(0);
        expect(r.calls.branchDeleteCalls).toBe(0);
        expectNothingSpawnedWithAModel(r);
        expect(fs.pathExistsSync(r.worktreePath)).toBe(true);
        expect(fs.readFileSync(path.join(r.worktreePath, 'left-behind.txt'), 'utf8')).toBe('not mine');
    });

    it('the plain runtime path refuses the same way, without a tmux plan', async () => {
        // Every case above takes the tmux path. The direct spawn carries its own
        // `refuse: refuseModelAfterRollback(...)`, and unwiring it left every test green because
        // no test reached spawnSync-in-terminal. `attach: true` with none of
        // prompt/issue/model/thinking/skills/passthrough/new-session is that exact route.
        const h = harnessOpts({ runtime: 'claude', role: 'NONE', unresolvableModel: true });
        const chunks = captureStderr();
        const r = { ...h, ...(await runLaunch(h, { name: 'demo', runtime: 'claude', attach: true, json: false })) };
        expect(r.error).toMatch(/^exit:1/);
        expectRefusalShape(chunks);
        // The route really was the plain one: no tmux session was planned.
        expect(r.newSessionArgs).toBeNull();
        expectNothingSpawnedWithAModel(r);
        expect(r.calls.worktreeRemoveCalls).toBeGreaterThan(0);
        expect(r.calls.branchDeleteCalls).toBeGreaterThan(0);
        expect(fs.pathExistsSync(r.worktreePath)).toBe(false);
    });

    it('bare launch refuses with exit 1 and removes the worktree it had already created', async () => {
        const chunks = captureStderr();
        const r = await claudeLaunch({ role: 'NONE', unresolvableModel: true });
        expect(r.error).toMatch(/^exit:1/);
        expectRefusalShape(chunks);
        expectNothingSpawnedWithAModel(r);
        // (d) the worktree and the branch this invocation created are both gone.
        expect(r.calls.worktreeRemoveCalls).toBeGreaterThan(0);
        expect(r.calls.branchDeleteCalls).toBeGreaterThan(0);
        expect(fs.pathExistsSync(r.worktreePath)).toBe(false);
    });

    it('role launch on the tmux path ends the same way', async () => {
        const chunks = captureStderr();
        // The role declares no model, so nothing resolves it: settings and ANTHROPIC_MODEL are absent too.
        const r = await claudeLaunch({ unresolvableModel: true, roleModel: '' });
        expect(r.error).toMatch(/^exit:1/);
        expectRefusalShape(chunks);
        expectNothingSpawnedWithAModel(r);
        expect(r.calls.worktreeRemoveCalls).toBeGreaterThan(0);
        expect(r.calls.branchDeleteCalls).toBeGreaterThan(0);
        expect(fs.pathExistsSync(r.worktreePath)).toBe(false);
    });

    it('a pre-existing reused branch survives the refusal (SEC-FINAL-01 still holds)', async () => {
        const chunks = captureStderr();
        const r = await claudeLaunch({ role: 'NONE', unresolvableModel: true, branchPreExists: true });
        expect(r.error).toMatch(/^exit:1/);
        expectRefusalShape(chunks);
        expect(r.calls.worktreeRemoveCalls).toBeGreaterThan(0);
        expect(r.calls.branchDeleteCalls).toBe(0);
    });

    it('a second refusing launch in the same fixture gives the same refusal, not an exists collision', async () => {
        const first = await claudeLaunch({ role: 'NONE', unresolvableModel: true });
        expect(first.error).toMatch(/^exit:1/);
        // Same repo, same worktree path and same branch: the state a second launch would collide with.
        // The home is fresh because the harness seeds a hermetic install per run, and the collision
        // surface this issue is about is the worktree and its branch in the repo, not the home.
        const chunks = captureStderr();
        const secondHarness = harnessOpts({
            repoRoot: first.repoRoot,
            worktreePath: first.worktreePath,
            branchName: first.branchName,
            role: 'NONE',
            unresolvableModel: true,
        });
        const second = {
            ...secondHarness,
            ...(await runLaunch(secondHarness, { name: 'demo', runtime: 'claude', role: undefined, newSession: true, attach: false, skills: [], prompt: 'smoke body', model: undefined, passthrough: undefined, json: false })),
        };
        expect(second.error, "the second launch refuses for the same reason, not for a collision").toMatch(/^exit:1/);
        expect(second.error).not.toMatch(/already exists/i);
        expect(second.error).not.toMatch(/Failed to create worktree/);
        // The same three-line refusal, from a worktree this second launch created again.
        expect(second.calls.worktreeRemoveCalls).toBeGreaterThan(0);
        expect(fs.pathExistsSync(second.worktreePath)).toBe(false);
        expectRefusalShape(chunks);
    });
});
