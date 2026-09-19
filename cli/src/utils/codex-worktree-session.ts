import kleur from 'kleur';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
    buildCodexDetachedOutcome,
    buildCodexRuntimeArgs,
    checkCodexPassthrough,
} from '../core/codex-runtime.js';
import {
    codexTrustProfile,
    ensureCodexTrustProfile,
    findCodexSession,
    removeCodexTrustProfile,
    writeCodexWorktreeSession,
    type CodexTrustProfile,
} from '../core/codex-session.js';
import {
    checkStructuredLaunchOptions,
    checkStructuredLaunchPaths,
    parseLiveTmuxSessionListing,
    sanitizeRuntimeVersion,
} from '../core/launch-outcome.js';
import {
    buildAgentEnv,
    chooseAttachCommand,
    isProjectPackSkillPath,
    parseSpecialistJson,
    projectPackSkillName,
    resolveRequestedSkills,
} from './worktree-session.js';
import { ensureAgentsSkillsSymlink } from '../core/skills-scaffold.js';

export interface CodexWorktreeSessionOptions {
    name?: string;
    role?: string;
    bead?: string;
    prompt?: string;
    model?: string;
    skills?: string[];
    attach?: boolean;
    json?: boolean;
    yolo: boolean;
    passthrough?: string[];
}

const SESSION_DISCOVERY_TIMEOUT_MS = 15_000;
const SESSION_DISCOVERY_POLL_MS = 100;

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function slugify(value: string): string {
    const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug.slice(0, 64) || 'codex';
}

function gitRoot(cwd: string): string | null {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: 'pipe', encoding: 'utf8' });
    return result.status === 0 ? (result.stdout ?? '').trim() || null : null;
}

function mainGitRoot(cwd: string): string | null {
    const result = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, stdio: 'pipe', encoding: 'utf8' });
    if (result.status !== 0) return null;
    const raw = (result.stdout ?? '').trim();
    if (!raw) return null;
    const common = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    return common.endsWith(`${path.sep}.git`) ? path.dirname(common) : common;
}

function resolveCodexExecutable(): string | null {
    const result = spawnSync('sh', ['-c', 'command -v "$1"', 'xtrm', 'codex'], {
        stdio: 'pipe',
        encoding: 'utf8',
    });
    const executable = (result.stdout ?? '').trim();
    const absolute = executable ? path.resolve(process.cwd(), executable) : '';
    return result.status === 0 && path.basename(absolute) === 'codex'
        ? absolute
        : null;
}

function codexBufferCommand(buffer: string): string {
    const script = [
        "const { execFileSync, spawnSync } = require('node:child_process')",
        "const path = require('node:path')",
        'const buffer = process.argv[1]',
        "const cleanup = () => spawnSync('tmux', ['delete-buffer', '-b', buffer], { stdio: 'ignore' })",
        "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { cleanup(); process.exit(1) })",
        "execFileSync('tmux', ['wait-for', '-S', `${buffer}-consumer-ready`])",
        "execFileSync('tmux', ['wait-for', `${buffer}-ready`], { timeout: 5000, killSignal: 'SIGTERM', stdio: 'ignore' })",
        "const raw = execFileSync('tmux', ['show-buffer', '-b', buffer], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })",
        'cleanup()',
        'const payload = JSON.parse(raw)',
        "if (typeof payload.runtimeCmd !== 'string' || path.basename(payload.runtimeCmd) !== 'codex' || !path.isAbsolute(payload.runtimeCmd) || !Array.isArray(payload.runtimeArgs) || payload.runtimeArgs.some((arg) => typeof arg !== 'string')) process.exit(2)",
        "const result = spawnSync(payload.runtimeCmd, payload.runtimeArgs, { stdio: 'inherit' })",
        'if (result.error) throw result.error',
        'process.exit(result.status ?? 1)',
    ].join(';');
    return [process.execPath, '-e', script, buffer].map(shellQuote).join(' ');
}

function skillNames(paths: string[]): string[] {
    return paths.map((skillPath) => {
        const name = path.basename(skillPath) === 'SKILL.md'
            ? path.basename(path.dirname(skillPath))
            : path.basename(skillPath);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
            throw new Error(`invalid Codex skill name '${name}'`);
        }
        return name;
    });
}

function renderCodexTask(role: string, bead: string, cwd: string): string {
    const result = spawnSync('sp', [
        'render-task', role,
        '--bead', bead,
        '--cwd', cwd,
        '--context-depth', '3',
        '--surface', 'codex',
    ], { cwd, stdio: 'pipe', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout ?? ''); } catch { /* handled below */ }
    const output = parsed as { ok?: unknown; initial_prompt?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
    if (result.status !== 0 || output?.ok !== true || typeof output.initial_prompt !== 'string') {
        const code = typeof output?.error?.code === 'string' ? output.error.code : 'render_failed';
        const message = typeof output?.error?.message === 'string' ? output.error.message : 'invalid Specialists response';
        throw new Error(`role '${role}': ${code}: ${message}`);
    }
    return output.initial_prompt;
}

function cleanupCreatedLaunch(
    mainRoot: string,
    worktreePath: string,
    branchName: string,
    sessionName: string,
    buffer?: string,
    profile?: CodexTrustProfile,
): void {
    if (buffer) spawnSync('tmux', ['delete-buffer', '-b', buffer], { stdio: 'ignore' });
    spawnSync('tmux', ['kill-session', '-t', `=${sessionName}`], { stdio: 'ignore' });
    spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: mainRoot, stdio: 'pipe' });
    spawnSync('git', ['branch', '-D', branchName], { cwd: mainRoot, stdio: 'pipe' });
    if (profile) removeCodexTrustProfile(profile, worktreePath);
}

function fail(message: string): never {
    console.error(kleur.red(`\n  ✗ ${message}\n`));
    process.exit(1);
}

async function waitForCodexSession(sessionsRoot: string, cwd: string, launchedAfterMs: number) {
    const deadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS;
    while (Date.now() <= deadline) {
        const session = findCodexSession({ sessionsRoot, cwd, launchedAfterMs });
        if (session) return session;
        await new Promise((resolve) => setTimeout(resolve, SESSION_DISCOVERY_POLL_MS));
    }
    return null;
}

export async function launchCodexWorktreeSession(opts: CodexWorktreeSessionOptions): Promise<void> {
    const attach = opts.attach ?? true;
    const structured = Boolean(opts.json);
    const optionCheck = checkStructuredLaunchOptions({
        json: structured,
        attach,
        reuse: false,
        sessionSlug: opts.name,
    });
    if (!optionCheck.ok) fail(optionCheck.error);
    if (opts.role && opts.bead && opts.prompt) fail('--bead and --prompt are mutually exclusive with --role');

    const passthrough = checkCodexPassthrough(opts.passthrough ?? []);
    if (!passthrough.ok) fail(passthrough.error);
    const executable = resolveCodexExecutable();
    if (!executable) fail('Could not resolve an absolute Codex executable');

    const cwd = process.cwd();
    const currentRoot = gitRoot(cwd);
    const mainRoot = mainGitRoot(cwd);
    if (!currentRoot || !mainRoot) fail('Not inside a git repository');
    if (currentRoot !== mainRoot) fail('Refusing to create a nested worktree from an existing worktree');

    const slug = opts.name ?? randomBytes(2).toString('hex');
    const branchName = `xt/${slug}`;
    const worktreePath = path.join(mainRoot, '.xtrm', 'worktrees', `${path.basename(mainRoot)}-xt-codex-${slugify(slug)}`);
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const trustProfile = codexTrustProfile(codexHome, worktreePath);
    const pathCheck = checkStructuredLaunchPaths({ json: structured, worktreePath, branchName });
    if (!pathCheck.ok) fail(pathCheck.error);
    const refCheck = spawnSync('git', ['check-ref-format', '--branch', branchName], { cwd: mainRoot, stdio: 'pipe' });
    if (refCheck.status !== 0) fail(`invalid worktree branch '${branchName}'`);
    const existingBranch = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: mainRoot,
        stdio: 'pipe',
    });
    if (existingBranch.status === 0) fail(`Worktree branch already exists: ${branchName}`);
    if (existingBranch.status !== 1) fail(`Could not verify worktree branch ownership: ${branchName}`);
    if (existsSync(worktreePath)) fail(`Worktree path already exists: ${worktreePath}`);

    let roleName: string | undefined;
    let developerInstructions: string | undefined;
    let selectedModel = opts.model;
    let requestedSkills: string[] = [];
    let roleSkillPaths: string[] = [];
    let prompt = opts.prompt;
    try {
        // SEC-03: initial --skill resolution lives inside the normalized
        // catch so ambiguity/not-found never escapes with a stack.
        requestedSkills = resolveRequestedSkills(mainRoot, opts.skills ?? [], 'codex');
        if (opts.role) {
            roleName = opts.role;
            const view = spawnSync('sp', ['view', opts.role, '--raw', '--surface', 'codex'], {
                cwd: mainRoot, stdio: 'pipe', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
            });
            if (view.status !== 0) throw new Error((view.stderr ?? '').trim() || `role '${opts.role}' not found`);
            const role = parseSpecialistJson(opts.role, view.stdout ?? '', mainRoot);
            developerInstructions = role.systemPrompt;
            selectedModel ??= role.model;
            roleSkillPaths = role.skillPaths;
            if (opts.bead) {
                prompt = renderCodexTask(opts.role, opts.bead, mainRoot);
            } else {
                requestedSkills = [...roleSkillPaths, ...requestedSkills];
            }
        }
        // Role skillPaths are declared verbatim by parseSpecialistJson; resolve
        // the merged set once here (bare pack names, relatives, absolutes).
        // ResolveRequestedSkills dedupes by realpath internally.
        requestedSkills = resolveRequestedSkills(mainRoot, requestedSkills, 'codex');
        // SEC-03: the validation set covers role skill paths in EVERY role
        // launch — including --bead, where the compose set deliberately leaves
        // them out — so a project-pack reference can never slip through with a
        // dead/wrong skill. Project-pack skills are outside this bead's codex
        // scope and codex does not materialize them; fail closed before any
        // worktree state exists. A path into the same project pack is still
        // unsupported, so only a global enablement/global path is remediated.
        const validationSet = resolveRequestedSkills(mainRoot, [...roleSkillPaths, ...requestedSkills], 'codex');
        const unsupported = validationSet.find((p) => isProjectPackSkillPath(mainRoot, p));
        if (unsupported) {
            const name = projectPackSkillName(mainRoot, unsupported) ?? path.basename(unsupported);
            fail(
                `skill '${name}' resolves to a project pack under .xtrm/skills, which codex launches do not support. `
                + 'Enable it as a global skill or pass a global skill path.',
            );
        }
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }

    const runtimePlan = buildCodexRuntimeArgs({
        yolo: opts.yolo,
        profileName: trustProfile.name,
        model: selectedModel,
        developerInstructions,
        prompt,
        skillNames: skillNames(requestedSkills),
        passthrough: passthrough.argv,
    });
    const sessionName = roleName
        ? `role-codex-${slugify(roleName)}${opts.bead ? `-${slugify(opts.bead)}` : ''}`
        : `codex-${slugify(slug)}`;
    if (spawnSync('tmux', ['has-session', '-t', `=${sessionName}`], { stdio: 'pipe' }).status === 0) {
        fail(`tmux session already exists: ${sessionName}`);
    }

    if (!structured) {
        console.log(kleur.bold('\n  Launching experimental Codex session'));
        console.log(kleur.dim(`  worktree: ${worktreePath}`));
        console.log(kleur.dim(`  branch:   ${branchName}\n`));
    }

    const buffer = `xtrm-codex-${randomBytes(16).toString('hex')}`;
    let created = false;
    // Git-first worktree create (CORE-2307): `git worktree add` is the
    // primary path — codex launches must not require bd. bd is attempted
    // as a FALLBACK only if git itself failed; observable behavior is
    // identical. Flag surface untouched in this lane (XTRM-93 owns --bead).
    const codexGit = spawnSync('git', ['worktree', 'add', '-b', branchName, worktreePath], {
        cwd: mainRoot, stdio: structured ? 'pipe' : 'inherit',
    });
    if (!codexGit.error && codexGit.status === 0) {
        created = true;
    } else {
        const partialBranch = spawnSync(
            'git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
            { cwd: mainRoot, stdio: 'pipe' },
        ).status === 0;
        if (existsSync(worktreePath) || partialBranch) {
            cleanupCreatedLaunch(mainRoot, worktreePath, branchName, sessionName, buffer);
            fail(`git worktree creation left partial state at ${worktreePath}`);
        }
        const bdFallback = spawnSync('bd', ['worktree', 'create', worktreePath, '--branch', branchName], {
            cwd: mainRoot, stdio: structured ? 'pipe' : 'inherit',
        });
        created = !bdFallback.error && bdFallback.status === 0;
        if (!created) {
            cleanupCreatedLaunch(mainRoot, worktreePath, branchName, sessionName, buffer);
        }
    }
    if (!created) fail(`Failed to create worktree at ${worktreePath}`);

    try {
        ensureCodexTrustProfile(codexHome, worktreePath);
    } catch (error) {
        cleanupCreatedLaunch(mainRoot, worktreePath, branchName, sessionName, buffer, trustProfile);
        fail(error instanceof Error ? error.message : String(error));
    }

    try {
        rmSync(path.join(worktreePath, '.beads'), { recursive: true, force: true });
        const tracked = spawnSync('git', ['-C', worktreePath, 'ls-files', '--', '.beads'], {
            cwd: worktreePath, stdio: 'pipe', encoding: 'utf8',
        });
        const paths = (tracked.stdout ?? '').split(/\r?\n/).filter(Boolean);
        if (paths.length > 0) {
            spawnSync('git', ['-C', worktreePath, 'update-index', '--skip-worktree', '--', ...paths], {
                cwd: worktreePath, stdio: 'pipe', encoding: 'utf8',
            });
        }
    } catch { /* bd resolves through the common git directory */ }

    const launchedAfterMs = Date.now() - 1_000;
    const parentSession = process.env.TMUX
        ? (spawnSync('tmux', ['display-message', '-p', '-F', '#{session_id}'], {
            stdio: 'pipe', encoding: 'utf8',
        }).stdout ?? '').trim()
        : '';
    const paneOptions: Array<{ key: string; value: string }> = [
        { key: '@agent_parent_session', value: parentSession },
        { key: '@agent_task', value: roleName ? `role:${roleName}` : `session:${slug}` },
        { key: '@agent_state', value: 'idle' },
        { key: '@agent_worktree', value: worktreePath },
        { key: '@agent_branch', value: branchName },
        ...(opts.bead ? [{ key: '@agent_bead', value: opts.bead }] : []),
        ...(roleName ? [{ key: '@agent_role', value: roleName }] : []),
    ];
    const agentEnv = { ...buildAgentEnv(paneOptions), XTMUX_AGENT_RUNTIME: 'codex' };
    const envArgs = Object.entries(agentEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    const cleanupOnSignal = (): void => {
        cleanupCreatedLaunch(mainRoot, worktreePath, branchName, sessionName, buffer, trustProfile);
        process.exit(1);
    };
    const removeSignalCleanup = (): void => {
        process.off('SIGINT', cleanupOnSignal);
        process.off('SIGTERM', cleanupOnSignal);
        process.off('SIGHUP', cleanupOnSignal);
    };
    const cleanupAndFail = (message: string): never => {
        removeSignalCleanup();
        cleanupCreatedLaunch(mainRoot, worktreePath, branchName, sessionName, buffer, trustProfile);
        return fail(message);
    };
    process.once('SIGINT', cleanupOnSignal);
    process.once('SIGTERM', cleanupOnSignal);
    process.once('SIGHUP', cleanupOnSignal);
    try {
        await ensureAgentsSkillsSymlink(worktreePath);
    } catch (error) {
        cleanupAndFail(error instanceof Error ? error.message : String(error));
    }
    const launched = spawnSync('tmux', [
        'new-session', '-d', '-s', sessionName, '-c', worktreePath,
        ...envArgs,
        codexBufferCommand(buffer),
    ], { stdio: 'pipe', encoding: 'utf8' });
    if (launched.status !== 0) cleanupAndFail((launched.stderr ?? '').trim() || 'tmux new-session failed');

    const consumer = spawnSync('tmux', ['wait-for', `${buffer}-consumer-ready`], {
        stdio: 'pipe', encoding: 'utf8', timeout: 5_000, killSignal: 'SIGTERM',
    });
    if (consumer.status !== 0) cleanupAndFail('Codex prompt consumer did not become ready');
    const loaded = spawnSync('tmux', ['load-buffer', '-b', buffer, '-'], {
        input: JSON.stringify({ runtimeCmd: executable, runtimeArgs: runtimePlan.argv }),
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
    });
    const signaled = loaded.status === 0
        ? spawnSync('tmux', ['wait-for', '-S', `${buffer}-ready`], { stdio: 'pipe', encoding: 'utf8' })
        : null;
    if (loaded.status !== 0 || signaled?.status !== 0) cleanupAndFail('Codex prompt transport failed');

    const pane = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_id}'], {
        stdio: 'pipe', encoding: 'utf8',
    });
    const paneId = (pane.stdout ?? '').trim().split(/\r?\n/, 1)[0] ?? '';
    if (!/^%[0-9]+$/.test(paneId)) cleanupAndFail('Could not resolve Codex pane id');
    for (const { key, value } of paneOptions) {
        spawnSync('tmux', ['set-option', '-p', '-t', paneId, key, value], { stdio: 'pipe' });
    }

    // Codex only writes a rollout record once a thread opens, which does not
    // happen until the first turn. A bare launch therefore has nothing to
    // discover, and tearing the session down here destroyed a session that had
    // started correctly. Absent metadata degrades the outcome; it is not a
    // launch failure. Only a metadata WRITE failure is still fatal, because
    // that means the on-disk state would disagree with what we report.
    const session = await waitForCodexSession(path.join(codexHome, 'sessions'), worktreePath, launchedAfterMs);
    const launchedAt = new Date(launchedAfterMs).toISOString();
    if (session && !writeCodexWorktreeSession(worktreePath, {
        runtime: 'codex',
        launchedAt,
        threadId: session.threadId,
        safetyProfile: runtimePlan.safetyProfile.name,
        profileName: trustProfile.name,
        profilePath: trustProfile.path,
    })) cleanupAndFail('Could not persist Codex worktree session metadata');

    const sessionQuery = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_id}'], {
        stdio: 'pipe', encoding: 'utf8',
    });
    const tmuxIdentity = parseLiveTmuxSessionListing(sessionQuery.status, sessionQuery.stdout ?? '', sessionName);
    if (!tmuxIdentity.ok) return cleanupAndFail(tmuxIdentity.error);
    removeSignalCleanup();

    if (!attach) {
        if (structured) {
            const version = spawnSync(executable, ['--version'], {
                cwd: worktreePath, stdio: 'pipe', encoding: 'utf8', timeout: 5_000,
            });
            const outcome = buildCodexDetachedOutcome({
                runtimeVersion: version.status === 0 ? sanitizeRuntimeVersion((version.stdout ?? '').trim()) : null,
                threadId: session?.threadId ?? null,
                sessionSlug: slug,
                sessionName,
                tmuxSessionId: tmuxIdentity.sessionId,
                paneId,
                worktreePath,
                branchName,
                safetyProfile: runtimePlan.safetyProfile,
                profileName: trustProfile.name,
                insideTmux: Boolean(process.env.TMUX),
            });
            process.stdout.write(`${JSON.stringify(outcome)}\n`);
        } else {
            process.stdout.write(`${sessionName}:${paneId}\n`);
        }
        process.exit(0);
    }

    const attached = spawnSync('tmux', chooseAttachCommand(sessionName, Boolean(process.env.TMUX)), { stdio: 'inherit' });
    process.exit(attached.status ?? 0);
}
