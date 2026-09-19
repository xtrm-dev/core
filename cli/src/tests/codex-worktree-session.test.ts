import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawnSync: mocked.spawnSync };
});

const roots: string[] = [];
const originalCwd = process.cwd();

function exitByThrow(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
    }) as never);
}

beforeEach(() => mocked.spawnSync.mockReset());
afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEX_HOME;
    process.chdir(originalCwd);
    for (const root of roots.splice(0)) fs.removeSync(root);
});

describe('Codex worktree launcher', () => {
    it('rejects a role-declared project-pack skill even with --bead (SEC-03)', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-bead-pack-'));
        roots.push(repoRoot);
        process.chdir(repoRoot);
        fs.ensureDirSync(path.join(repoRoot, '.xtrm', 'skills', 'infra', 'service-knowledge'));
        fs.writeFileSync(path.join(repoRoot, '.xtrm', 'skills', 'infra', 'service-knowledge', 'SKILL.md'), '# pack');

        mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
            const joined = args.join(' ');
            if (command === 'sh') return { status: 0, stdout: 'bin/codex\n', stderr: '' };
            if (command === 'git' && joined === 'rev-parse --show-toplevel') {
                return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
            }
            if (command === 'git' && joined === 'rev-parse --git-common-dir') {
                return { status: 0, stdout: '.git\n', stderr: '' };
            }
            if (command === 'git' && joined.startsWith('show-ref --verify')) {
                return { status: 1, stdout: '', stderr: '' };
            }
            if (command === 'sp' && args[0] === 'view') {
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        specialist: {
                            metadata: { name: 'roller', version: '1.0.0', category: 'testing', description: 'd' },
                            execution: {
                                mode: 'tool', model: 'openai-codex/gpt-5.6-codex', timeout_ms: 0, stall_timeout_ms: 600000,
                                max_retries: 0, interactive: false, response_format: 'markdown', output_type: 'workflow',
                                permission_required: 'LOW', requires_worktree: true, bare: false, auto_commit: 'never',
                            },
                            prompt: { system: 'sys', task_template: 'task' },
                            skills: { paths: ['service-knowledge'] },
                        },
                    }),
                    stderr: '',
                };
            }
            if (command === 'sp' && args[0] === 'render-task') {
                return { status: 0, stdout: JSON.stringify({ ok: true, initial_prompt: 'body', prompt_hash: 'h', components: [] }), stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        });

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const exitSpy = exitByThrow();
        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
        await expect(launchCodexWorktreeSession({
            name: 'bead-pack',
            role: 'roller',
            attach: false,
            json: true,
            yolo: false,
            bead: 'xtrm-lk07w.14',
        })).rejects.toThrow('exit:1');

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('do not support');
        // Rejection happens before any worktree state exists.
        expect(mocked.spawnSync).not.toHaveBeenCalledWith('bd', expect.anything(), expect.anything());
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('rejects hook-trust bypass before any worktree mutation', async () => {
        const exitSpy = exitByThrow();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');

        await expect(launchCodexWorktreeSession({
            name: 'unsafe',
            attach: false,
            json: true,
            yolo: true,
            passthrough: ['--dangerously-bypass-hook-trust'],
        })).rejects.toThrow('exit:1');

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('persisted hook trust is required');
        expect(mocked.spawnSync).not.toHaveBeenCalledWith('bd', expect.anything(), expect.anything());
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('persists an explicit thread and emits one structured outcome', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-launch-'));
        roots.push(repoRoot);
        const codexHome = path.join(repoRoot, 'codex-home');
        const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', `${path.basename(repoRoot)}-xt-codex-demo`);
        process.env.CODEX_HOME = codexHome;
        process.chdir(repoRoot);
        fs.ensureDirSync(path.join(repoRoot, '.beads'));

        mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
            const joined = args.join(' ');
            if (command === 'sh') return { status: 0, stdout: 'bin/codex\n', stderr: '' };
            if (command === 'git' && joined === 'rev-parse --show-toplevel') {
                return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
            }
            if (command === 'git' && joined === 'rev-parse --git-common-dir') {
                return { status: 0, stdout: '.git\n', stderr: '' };
            }
            if (command === 'git' && joined === 'show-ref --verify --quiet refs/heads/xt/demo') {
                return { status: 1, stdout: '', stderr: '' };
            }
            if (command === 'bd' && args[0] === 'worktree') {
                fs.ensureDirSync(worktreePath);
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
            if (command === 'tmux' && args[0] === 'wait-for' && args[1] === '-S') {
                const sessions = path.join(codexHome, 'sessions', '2026', '08', '02');
                fs.ensureDirSync(sessions);
                fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), `${JSON.stringify({
                    type: 'session_meta',
                    payload: {
                        session_id: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
                        id: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
                        timestamp: new Date().toISOString(),
                        cwd: worktreePath,
                        cli_version: '0.146.0',
                    },
                })}\n`);
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'tmux' && args[0] === 'list-panes') return { status: 0, stdout: '%17\n', stderr: '' };
            if (command === 'tmux' && args[0] === 'list-sessions') return { status: 0, stdout: 'codex-demo\t$42\n', stderr: '' };
            if (command === 'tmux' && args[0] === 'display-message') return { status: 0, stdout: '$42\n', stderr: '' };
            if (command === path.join(repoRoot, 'bin', 'codex') && args[0] === '--version') {
                return { status: 0, stdout: 'codex-cli 0.146.0\n', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        });

        const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const exitSpy = exitByThrow();
        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
        await expect(launchCodexWorktreeSession({
            name: 'demo',
            prompt: 'inspect the launcher',
            attach: false,
            json: true,
            yolo: false,
        })).rejects.toThrow('exit:0');

        expect(stdoutSpy).toHaveBeenCalledTimes(1);
        const outcome = JSON.parse(String(stdoutSpy.mock.calls[0][0]));
        expect(outcome).toMatchObject({
            runtime: { name: 'codex', version: 'codex-cli 0.146.0' },
            identity: { thread_id: '019fc3bc-fb7a-7ae0-9536-125624bf726b' },
            safety_profile: { name: 'codex-workspace-write' },
        });
        expect(fs.readJsonSync(path.join(worktreePath, '.xtrm', 'session-meta.json'))).toMatchObject({
            runtime: 'codex',
            threadId: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            profileName: expect.stringMatching(/^xtrm-[0-9a-f]{16}$/),
            profilePath: expect.stringMatching(/\.config\.toml$/),
        });
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'tmux',
            expect.arrayContaining(['-e', 'XTMUX_AGENT_RUNTIME=codex']),
            expect.objectContaining({ stdio: 'pipe' }),
        );
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            path.join(repoRoot, 'bin', 'codex'),
            ['--version'],
            expect.objectContaining({ cwd: worktreePath, stdio: 'pipe' }),
        );
        const payloadCall = mocked.spawnSync.mock.calls.find(([, args]) => args[0] === 'load-buffer');
        expect(JSON.parse(payloadCall?.[2]?.input as string)).toMatchObject({
            runtimeCmd: path.join(repoRoot, 'bin', 'codex'),
            runtimeArgs: expect.arrayContaining(['--profile']),
        });
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('removes the worktree and branch after a post-creation tmux failure', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-cleanup-'));
        roots.push(repoRoot);
        const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', `${path.basename(repoRoot)}-xt-codex-fail`);
        const codexHome = path.join(repoRoot, 'codex-home');
        process.env.CODEX_HOME = codexHome;
        process.chdir(repoRoot);

        mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
            const joined = args.join(' ');
            if (command === 'sh') return { status: 0, stdout: '/opt/xtrm/bin/codex\n', stderr: '' };
            if (command === 'git' && joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
            if (command === 'git' && joined === 'rev-parse --git-common-dir') return { status: 0, stdout: '.git\n', stderr: '' };
            if (command === 'git' && joined === 'show-ref --verify --quiet refs/heads/xt/fail') {
                return { status: 1, stdout: '', stderr: '' };
            }
            if (command === 'bd' && args[0] === 'worktree') {
                fs.ensureDirSync(worktreePath);
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
            if (command === 'tmux' && args[0] === 'new-session') return { status: 1, stdout: '', stderr: 'launch failed' };
            return { status: 0, stdout: '', stderr: '' };
        });

        exitByThrow();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
        await expect(launchCodexWorktreeSession({
            name: 'fail',
            attach: false,
            json: true,
            yolo: true,
        })).rejects.toThrow('exit:1');

        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'git', ['worktree', 'remove', '--force', worktreePath], expect.objectContaining({ cwd: repoRoot }),
        );
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'git', ['branch', '-D', 'xt/fail'], expect.objectContaining({ cwd: repoRoot }),
        );
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'tmux', ['delete-buffer', '-b', expect.stringMatching(/^xtrm-codex-[0-9a-f]{32}$/)],
            expect.objectContaining({ stdio: 'ignore' }),
        );
        expect(fs.existsSync(codexHome)
            ? fs.readdirSync(codexHome).filter((name) => name.startsWith('xtrm-'))
            : []).toEqual([]);
    });

    it('rejects a pre-existing branch before any worktree mutation', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-existing-'));
        roots.push(repoRoot);
        process.chdir(repoRoot);

        mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
            const joined = args.join(' ');
            if (command === 'sh') return { status: 0, stdout: '/opt/xtrm/bin/codex\n', stderr: '' };
            if (command === 'git' && joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
            if (command === 'git' && joined === 'rev-parse --git-common-dir') return { status: 0, stdout: '.git\n', stderr: '' };
            if (command === 'git' && joined === 'check-ref-format --branch xt/existing') {
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'git' && joined === 'show-ref --verify --quiet refs/heads/xt/existing') {
                return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 1, stdout: '', stderr: '' };
        });

        exitByThrow();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
        await expect(launchCodexWorktreeSession({
            name: 'existing',
            attach: false,
            json: true,
            yolo: true,
        })).rejects.toThrow('exit:1');

        expect(errorSpy.mock.calls.flat().join(' ')).toContain('Worktree branch already exists: xt/existing');
        expect(mocked.spawnSync).not.toHaveBeenCalledWith('bd', expect.anything(), expect.anything());
        expect(mocked.spawnSync).not.toHaveBeenCalledWith(
            'git', expect.arrayContaining(['worktree', 'add']), expect.anything(),
        );
    });

    it('cleans partial state from a failed git worktree creation before bd fallback', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-partial-'));
        roots.push(repoRoot);
        const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', `${path.basename(repoRoot)}-xt-codex-partial`);
        process.chdir(repoRoot);
        let branchChecks = 0;

        mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
            const joined = args.join(' ');
            if (command === 'sh') return { status: 0, stdout: '/opt/xtrm/bin/codex\n', stderr: '' };
            if (command === 'git' && joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
            if (command === 'git' && joined === 'rev-parse --git-common-dir') return { status: 0, stdout: '.git\n', stderr: '' };
            if (command === 'git' && joined === 'check-ref-format --branch xt/partial') return { status: 0, stdout: '', stderr: '' };
            if (command === 'git' && joined === 'show-ref --verify --quiet refs/heads/xt/partial') {
                branchChecks += 1;
                return { status: branchChecks === 1 ? 1 : 0, stdout: '', stderr: '' };
            }
            if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
            if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
                fs.ensureDirSync(worktreePath);
                return { status: 1, stdout: '', stderr: 'partial failure' };
            }
            if (command === 'bd' && args[0] === 'worktree') {
                return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        });

        exitByThrow();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
        await expect(launchCodexWorktreeSession({
            name: 'partial',
            attach: false,
            json: true,
            yolo: true,
        })).rejects.toThrow('exit:1');

        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'git', ['worktree', 'remove', '--force', worktreePath], expect.objectContaining({ cwd: repoRoot }),
        );
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'git', ['branch', '-D', 'xt/partial'], expect.objectContaining({ cwd: repoRoot }),
        );
        // Fail-closed: partial state never reaches the bd fallback.
        expect(mocked.spawnSync).not.toHaveBeenCalledWith(
            'bd', expect.arrayContaining(['worktree', 'create']), expect.anything(),
        );
    });

    it('falls back to bd worktree create when git worktree add fails cleanly', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-gitfail-'));
        roots.push(repoRoot);
        const worktreePath = path.join(repoRoot, '.xtrm', 'worktrees', `${path.basename(repoRoot)}-xt-codex-gitfail`);
        const codexHome = path.join(repoRoot, 'codex-home');
        process.env.CODEX_HOME = codexHome;
        process.chdir(repoRoot);

        mocked.spawnSync.mockImplementation((command: string, args: string[] = []) => {
            const joined = args.join(' ');
            if (command === 'sh') return { status: 0, stdout: '/opt/xtrm/bin/codex\n', stderr: '' };
            if (command === 'git' && joined === 'rev-parse --show-toplevel') return { status: 0, stdout: `${repoRoot}\n`, stderr: '' };
            if (command === 'git' && joined === 'rev-parse --git-common-dir') return { status: 0, stdout: '.git\n', stderr: '' };
            if (command === 'git' && joined === 'check-ref-format --branch xt/gitfail') return { status: 0, stdout: '', stderr: '' };
            if (command === 'git' && joined.startsWith('show-ref --verify')) {
                return { status: 1, stdout: '', stderr: '' };
            }
            if (command === 'tmux' && args[0] === 'has-session') return { status: 1, stdout: '', stderr: '' };
            if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') {
                return { status: 1, stdout: '', stderr: 'git add unavailable' };
            }
            if (command === 'bd' && args[0] === 'worktree') {
                fs.ensureDirSync(worktreePath);
                return { status: 0, stdout: '', stderr: '' };
            }
            if (command === 'tmux' && args[0] === 'new-session') return { status: 1, stdout: '', stderr: 'stop here' };
            return { status: 0, stdout: '', stderr: '' };
        });

        exitByThrow();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { launchCodexWorktreeSession } = await import('../utils/codex-worktree-session.js');
        await expect(launchCodexWorktreeSession({
            name: 'gitfail',
            attach: false,
            json: true,
            yolo: true,
        })).rejects.toThrow('exit:1');

        // git-first attempted, then bd fallback created the worktree (later
        // tmux failure proves creation succeeded and triggered cleanup).
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'git', expect.arrayContaining(['worktree', 'add']), expect.anything(),
        );
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'bd', expect.arrayContaining(['worktree', 'create']), expect.anything(),
        );
        expect(mocked.spawnSync).toHaveBeenCalledWith(
            'git', ['worktree', 'remove', '--force', worktreePath], expect.objectContaining({ cwd: repoRoot }),
        );
    });
});
