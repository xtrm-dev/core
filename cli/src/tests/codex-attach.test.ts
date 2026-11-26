import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    spawnSync: vi.fn((_command?: unknown, _args?: unknown, _options?: unknown) => ({ status: 0, stdout: '', stderr: '' })),
    listXtWorktrees: vi.fn(),
    getRepoRoot: vi.fn(() => '/repo'),
    /** CORE-2728: per-test control over what the binding read answers. */
    attachDispatcherEnv: vi.fn((): Record<string, string> => ({})),
}));

vi.mock('node:child_process', () => ({ spawnSync: mocked.spawnSync }));
vi.mock('../commands/worktree.js', () => ({
    listXtWorktrees: mocked.listXtWorktrees,
    getRepoRoot: mocked.getRepoRoot,
}));

// CORE-2728: hermetic dispatcher restore; the binding read and the live lookup are
// covered in attach-restores-dispatcher.test.ts.
// CORE-2727: buildAttachEnv also strips the attacher's keys, so the strip helper is
// kept real here rather than mocked away.
vi.mock('../core/dispatcher-identity.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/dispatcher-identity.js')>();
    return { ...actual, attachDispatcherEnv: mocked.attachDispatcherEnv };
});

const roots: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    mocked.spawnSync.mockClear();
    mocked.attachDispatcherEnv.mockReset();
    mocked.attachDispatcherEnv.mockReturnValue({});
    for (const root of roots.splice(0)) fs.removeSync(root);
});

function codexWorktree(extra: Record<string, unknown> = {}): string {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-attach-'));
    roots.push(worktree);
    fs.ensureDirSync(path.join(worktree, '.xtrm'));
    fs.writeJsonSync(path.join(worktree, '.xtrm', 'session-meta.json'), {
        runtime: 'codex',
        launchedAt: '2026-08-02T18:29:29.000Z',
        threadId: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
        safetyProfile: 'codex-yolo',
        profileName: 'xtrm-0123456789abcdef',
        profilePath: path.join(os.homedir(), '.codex', 'xtrm-0123456789abcdef.config.toml'),
        ...extra,
    });
    mocked.listXtWorktrees.mockReturnValue([{
        path: worktree,
        branch: 'refs/heads/xt/demo',
        head: 'abc',
        prunable: false,
        runtime: 'codex',
    }]);
    return worktree;
}

function resumeCall(worktree: string): { args: string[]; env: NodeJS.ProcessEnv } {
    const call = mocked.spawnSync.mock.calls.find(([command]) => command === 'codex');
    expect(call).toBeTruthy();
    return { args: (call?.[1] ?? []) as string[], env: (call?.[2] as { env: NodeJS.ProcessEnv }).env };
}

async function attach(): Promise<void> {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
    }) as never);
    const { createAttachCommand } = await import('../commands/attach.js');
    await expect(createAttachCommand().parseAsync(['node', 'xt', 'demo'])).rejects.toThrow('exit:0');
    exitSpy.mockRestore();
}

describe('xt attach Codex resume', () => {
    it('resumes the exact persisted UUID and never uses --last', async () => {
        const worktree = codexWorktree();
        mocked.attachDispatcherEnv.mockReturnValue({
            XTRM_DISPATCHER_PARTICIPANT: 'test-dispatcher',
            XTRM_DISPATCHER_NAME: 'test-dispatcher',
            XTRM_DISPATCHER_ADDRESS: 'uds:/test.sock',
        });

        // CORE-2728: attach restores the dispatcher persisted at launch into the resume env.
        await attach();

        const { args, env } = resumeCall(worktree);
        expect(args).toEqual([
            '--profile',
            'xtrm-0123456789abcdef',
            'resume',
            '--dangerously-bypass-approvals-and-sandbox',
            '019fc3bc-fb7a-7ae0-9536-125624bf726b',
        ]);
        expect(env).toEqual(expect.objectContaining({
            XTRM_DISPATCHER_PARTICIPANT: 'test-dispatcher',
            XTRM_DISPATCHER_NAME: 'test-dispatcher',
            XTRM_DISPATCHER_ADDRESS: 'uds:/test.sock',
        }));
        expect(mocked.spawnSync.mock.calls.flat(2)).not.toContain('--last');
    });

    it('CORE-2728 F2a: with no restored dispatcher, the attacher\'s XTRM_DISPATCHER_* never reaches the pane', async () => {
        const worktree = codexWorktree();
        // The binding read answers "no dispatcher" while the attacher's own env is full
        // of one: the resume must carry neither its participant nor its address/name.
        mocked.attachDispatcherEnv.mockReturnValue({});
        const saved: Record<string, string | undefined> = {};
        for (const key of ['XTRM_DISPATCHER_PARTICIPANT', 'XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS']) {
            saved[key] = process.env[key];
            process.env[key] = 'attacher';
        }
        try {
            await attach();
        } finally {
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
        const { env } = resumeCall(worktree);
        for (const key of ['XTRM_DISPATCHER_PARTICIPANT', 'XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS']) {
            expect(env[key]).toBeUndefined();
        }
    });

    it('CORE-2728 F2b: the recorded issue names the issue, never the attacher\'s XTRM_AGENT_ISSUE', async () => {
        const worktree = codexWorktree({ issue: 'CORE-2728' });
        // A different work item in the attacher's environment must not win: the record
        // of THIS worktree is the only source of its issue.
        const savedIssue = process.env.XTRM_AGENT_ISSUE;
        process.env.XTRM_AGENT_ISSUE = 'OTHER-1';
        try {
            await attach();
        } finally {
            if (savedIssue === undefined) delete process.env.XTRM_AGENT_ISSUE;
            else process.env.XTRM_AGENT_ISSUE = savedIssue;
        }
        expect(mocked.attachDispatcherEnv).toHaveBeenCalledTimes(1);
        // CORE-2740: the ref travels with its provenance and the worker's worktree.
        expect(mocked.attachDispatcherEnv).toHaveBeenCalledWith('CORE-2728', {
            bindingId: null,
            workspace: worktree,
        });
    });

    it('CORE-2728 F2b: no issue in the record and no issue in the environment leaves the issue absent', async () => {
        codexWorktree();
        const savedIssue = process.env.XTRM_AGENT_ISSUE;
        process.env.XTRM_AGENT_ISSUE = 'OTHER-1';
        try {
            await attach();
        } finally {
            if (savedIssue === undefined) delete process.env.XTRM_AGENT_ISSUE;
            else process.env.XTRM_AGENT_ISSUE = savedIssue;
        }
        expect(mocked.attachDispatcherEnv).toHaveBeenCalledWith(null, expect.objectContaining({
            bindingId: null,
        }));
    });
});
