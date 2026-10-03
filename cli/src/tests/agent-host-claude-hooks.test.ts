// XTRM-569: Claude Code hooks as a presence-only agent host producer (PRD xtrm-app §35.6,
// §35.8 item 4, §36.12 item 4). Runs the real hook script against a real host socket, one
// short-lived process and connection per hook, as Claude Code invokes it.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEventV1 } from '@xtrm/contracts';
import { startAgentHost, type AgentHost } from '../core/agent-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const reporter = path.resolve(here, '../../../.xtrm/hooks/agent-host-reporter.mjs');
const sessionId = '5d1c9a52-0000-4000-8000-00000000c1a0';

interface HookRun {
    code: number | null;
    stdout: string;
    ms: number;
}

/** Run the hook as Claude does: JSON on stdin, inherited env, no tmux pane (never touch the caller's). */
function runHook(socketPath: string, input: Record<string, unknown>, nodeArgs: string[] = []): Promise<HookRun> {
    const env: NodeJS.ProcessEnv = { ...process.env, XTRM_AGENT_HOST_SOCKET: socketPath, XTRM_SESSION_NAME: 'claude-test' };
    for (const key of ['TMUX', 'TMUX_PANE', 'XTMUX_AGENT_ROLE', 'XTMUX_AGENT_BEAD', 'XTRM_AGENT_HOST', 'XTRM_AGENT_LAUNCH']) {
        delete env[key];
    }
    return new Promise((resolve, reject) => {
        const started = performance.now();
        const child = spawn(process.execPath, [...nodeArgs, reporter], { env, stdio: ['pipe', 'pipe', 'ignore'] });
        let stdout = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, ms: performance.now() - started }));
        child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: '/tmp/t.jsonl', cwd: here, ...input }));
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

    beforeEach(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-claude-'));
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
            cwd: here,
            launch: 'terminal',
            capabilities: ['presence'],
        });
        expect(identity.worktree).toBeTruthy();
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

    it('exits 0 with no output on malformed stdin', async () => {
        const child = spawn(process.execPath, [reporter], {
            env: { ...process.env, XTRM_AGENT_HOST_SOCKET: socketPath, TMUX: '' },
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
