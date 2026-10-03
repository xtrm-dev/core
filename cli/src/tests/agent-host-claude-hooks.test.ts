// XTRM-569: Claude Code hooks as a presence-only agent host producer (PRD xtrm-app §35.6,
// §35.8 item 4, §36.12 item 4). Runs the real hook command against a real host socket, one
// short-lived process and connection per hook, as Claude Code invokes it.
//
// XTRM-592: the reporter runs inside the CORE-2339 dispatcher, so each hook below runs the
// one command the compiled .xtrm/config/hooks.json registers for its event.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEventV1 } from '@xtrm/contracts';
import { startAgentHost, type AgentHost } from '../core/agent-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const xtrmDir = path.resolve(here, '../../../.xtrm');
const sessionId = '5d1c9a52-0000-4000-8000-00000000c1a0';

interface HookRun {
    code: number | null;
    stdout: string;
    ms: number;
}

const compiled = JSON.parse(readFileSync(path.join(xtrmDir, 'config', 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
};

/** The script argv Claude runs for an event: the event's single registered xt command. */
function commandFor(event: unknown): string[] {
    const commands = (compiled.hooks[String(event)] ?? []).flatMap((group) => group.hooks.map((h) => h.command));
    expect(commands, `${String(event)} must register exactly one xt hook process`).toHaveLength(1);
    const [node, script, ...args] = commands[0].split(' ');
    expect(node).toBe('node');
    return [script.replace('${CLAUDE_PLUGIN_ROOT}', xtrmDir), ...args];
}

/**
 * A throwaway project for the hook payload cwd: the dispatcher also runs the xt loggers
 * and the SessionStart reap sweep against it, so it must never be this repository. A fresh
 * reap stamp rate-limits the sweep, so no `xt worktree reap` is spawned.
 */
function makeProject(root: string): string {
    const project = path.join(root, 'project');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    writeFileSync(path.join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(path.join(project, '.xtrm'), { recursive: true });
    writeFileSync(path.join(project, '.xtrm', '.last-reap-sweep'), new Date().toISOString());
    return project;
}

/** Run the hook as Claude does: JSON on stdin, inherited env, no tmux pane (never touch the caller's). */
function runHook(socketPath: string, input: Record<string, unknown>, nodeArgs: string[] = []): Promise<HookRun> {
    const cwd = path.join(path.dirname(socketPath), 'project');
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        XTRM_AGENT_HOST_SOCKET: socketPath,
        XTRM_SESSION_NAME: 'claude-test',
        CLAUDE_PROJECT_DIR: cwd,
    };
    for (const key of ['TMUX', 'TMUX_PANE', 'XTMUX_AGENT_ROLE', 'XTMUX_AGENT_BEAD', 'XTRM_AGENT_HOST', 'XTRM_AGENT_LAUNCH']) {
        delete env[key];
    }
    return new Promise((resolve, reject) => {
        const started = performance.now();
        const child = spawn(process.execPath, [...nodeArgs, ...commandFor(input.hook_event_name)], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, ms: performance.now() - started }));
        child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd, ...input }));
    });
}

async function until<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, 10));
    }
}

describe('Claude hook reporter → xt host (XTRM-569)', () => {
    let dir: string;
    let socketPath: string;
    let host: AgentHost;
    let frames: AgentEventV1[];
    let project: string;

    beforeEach(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-claude-'));
        project = makeProject(dir);
        socketPath = path.join(dir, 'agent-host.sock');
        host = await startAgentHost({ socketPath, infoPath: path.join(dir, 'agent-host.json'), log: () => {} });
        // Bind the subscription to this test's own array: a frame delivered late by the
        // previous test's host must not land in the next test's sink (XTRM-579).
        const sink: AgentEventV1[] = [];
        frames = sink;
        host.registry.subscribe((frame) => sink.push(frame));
    });

    afterEach(async () => {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const summary = () => host.registry.list().find((s) => s.sessionId === sessionId);
    // XTRM-579: delivery is best effort — the reporter hard-exits 0 when its budget runs
    // out. Until XTRM-583 that budget counted node boot, so under parallel load every
    // invocation could miss. The budget now starts with the hook's own work, so misses
    // should be rare; a zero-frame invocation is still re-invoked (and logged) rather than
    // failed. Retries only ever happen after a miss, so no duplicate frames can distort the
    // assertions below, and the retry log keeps a regression visible.
    const hook = async (input: Record<string, unknown>) => {
        const before = frames.length;
        let run: HookRun | undefined;
        let misses = 0;
        // Fail with the measured cause before vitest's 30 s test timeout swallows it:
        // under sustained load each spawn itself takes seconds, so a fixed attempt cap
        // would time out inside vitest instead of reporting the budget miss.
        const giveUpAt = Date.now() + 25000;
        for (;;) {
            run = await runHook(socketPath, input);
            expect(run.code).toBe(0);
            expect(run.stdout).toBe('');
            if (await until(() => frames.length > before, 250).then(() => true, () => false)) {
                if (misses > 0)
                    console.error(`[xtrm-579] ${String(input.hook_event_name)} delivered after ${misses} retry(s), final invocation ms=${run!.ms.toFixed(0)}`);
                return run;
            }
            misses++;
            if (Date.now() > giveUpAt) throw new Error('hook never delivered a frame (reporter budget miss under sustained load)');
            // When the invocation itself ran long the miss was load-caused; back off so
            // the retry waits out the load spike instead of burning attempts into it.
            if (run.ms >= 250) await new Promise((r) => setTimeout(r, 500));
        }
    };

    it('reports presence, state transitions and classified tools until SessionEnd', async () => {
        await hook({ hook_event_name: 'SessionStart', source: 'startup' });
        const identity = host.registry.detail(sessionId)!.identity!;
        expect(identity).toMatchObject({
            runtime: { name: 'claude', version: null },
            producer: { name: 'xtrm-tools/agent-host-reporter' },
            sessionName: 'claude-test',
            sessionFile: '/tmp/t.jsonl',
            cwd: project,
            worktree: project,
            branch: 'main',
            launch: 'terminal',
            capabilities: ['presence'],
        });
        expect(summary()).toMatchObject({ provider: 'claude', state: 'settled', capabilities: ['presence'] });
        // The hook connection is gone, but a presence-only session stays.
        await until(() => summary()?.extensionConnected === false);

        await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'not reported' });
        expect(summary()!.state).toBe('working');
        expect(JSON.stringify(frames)).not.toContain('not reported');

        await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'toolu_1', tool_input: { file_path: '/x' } });
        await hook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_1', tool_response: { file: 'body' } });
        await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__context7__query-docs', tool_use_id: 'toolu_2', tool_input: {} });
        await hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
        expect(summary()!.state).toBe('waiting_for_input');
        await hook({ hook_event_name: 'PostToolUse', tool_name: 'mcp__context7__query-docs', tool_use_id: 'toolu_2', tool_response: {} });
        expect(summary()!.state).toBe('working');
        await hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_3', tool_input: { prompt: 'p' } });
        await hook({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' });

        const origins = frames
            .filter((f) => f.payload.type === 'tool_execution_start' || f.payload.type === 'tool_execution_end')
            .map((f) => [f.payload.type, (f.payload as { toolName: string }).toolName, (f.payload as { origin?: unknown }).origin]);
        expect(origins).toEqual([
            ['tool_execution_start', 'Read', { class: 'native' }],
            ['tool_execution_end', 'Read', { class: 'native' }],
            ['tool_execution_start', 'mcp__context7__query-docs', { class: 'mcp', server: 'context7' }],
            ['tool_execution_end', 'mcp__context7__query-docs', { class: 'mcp', server: 'context7' }],
            ['tool_execution_start', 'Agent', { class: 'coordination' }],
        ]);
        expect(frames.find((f) => f.payload.type === 'tool_execution_end')!.payload).toMatchObject({ result: null, isError: false });
        expect(frames.at(-1)!.payload).toEqual({ type: 'subagent_end', agentId: 'a1', agentType: 'Explore' });

        await hook({ hook_event_name: 'Stop', stop_hook_active: false });
        expect(summary()!.state).toBe('settled');
        expect(summary()!.frameCount).toBe(1);

        await hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
        expect(frames.at(-1)!.payload).toEqual({ type: 'session_shutdown', reason: 'quit' });
        expect(summary()).toBeUndefined();
    });

    it('reopens a Frame on a tool call after Stop (a Stop hook continued the turn)', async () => {
        await hook({ hook_event_name: 'SessionStart', source: 'resume' });
        await hook({ hook_event_name: 'Stop' });
        await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_9', tool_input: { command: 'ls' } });
        expect(summary()).toMatchObject({ state: 'working', frameCount: 1 });
    });

    it('drops large tool input instead of forwarding file bodies', async () => {
        await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'toolu_w', tool_input: { content: 'x'.repeat(10_000) } });
        // Select the Write event by its toolCallId so an out-of-order or stale frame
        // cannot satisfy the lookup (XTRM-579).
        const start = frames.find(
            (f) => f.payload.type === 'tool_execution_start' && (f.payload as { toolCallId?: string }).toolCallId === 'toolu_w',
        )!;
        expect((start.payload as { args: unknown }).args).toMatchObject({ truncated: true });
    });

    it('delivers when node boot is slow: the budget counts from hook work, not process start (XTRM-583)', async () => {
        // A preload that busy-waits 200 ms stands in for node boot on a loaded machine. The
        // old from-process-start 80 ms budget dropped this invocation every time. No retry.
        const slowBoot = `data:text/javascript,${encodeURIComponent('const end = Date.now() + 200; while (Date.now() < end);')}`;
        const run = await runHook(socketPath, { hook_event_name: 'UserPromptSubmit' }, ['--import', slowBoot]);
        expect(run).toMatchObject({ code: 0, stdout: '' });
        await until(() => summary()?.state === 'working');
    });

    it('exits 0 quickly with no output when no host is running', async () => {
        const run = await runHook(path.join(dir, 'absent.sock'), { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't' });
        expect(run).toMatchObject({ code: 0, stdout: '' });
        expect(run.ms).toBeLessThan(1000);
    });

    it('keeps a guard decision on stdout while reporting the same PreToolUse (XTRM-592)', async () => {
        // The dispatcher's boundary guard blocks an edit outside the worktree; the presence
        // report runs in the same process and must neither swallow nor delay that decision.
        const worktree = path.join(dir, 'repo', '.xtrm', 'worktrees', 'wt');
        const run = await runHook(socketPath, {
            hook_event_name: 'PreToolUse',
            cwd: worktree,
            tool_name: 'Edit',
            tool_use_id: 'toolu_guard',
            tool_input: { file_path: path.join(dir, 'repo', 'outside.ts') },
        });
        expect(run.code).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({ decision: 'block' });
        await until(() => frames.find((f) => (f.payload as { toolCallId?: string }).toolCallId === 'toolu_guard'));
    });

    it('exits 0 with no output on malformed stdin', async () => {
        const child = spawn(process.execPath, commandFor('PreToolUse'), {
            cwd: project,
            env: { ...process.env, XTRM_AGENT_HOST_SOCKET: socketPath, CLAUDE_PROJECT_DIR: project, TMUX: '' },
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stdin.end('not json');
        const code = await new Promise((resolve) => child.on('close', resolve));
        expect(code).toBe(0);
        expect(stdout).toBe('');
        expect(host.registry.list()).toEqual([]);
    });
});
