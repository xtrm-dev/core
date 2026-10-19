import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

// CORE-2492: the Claude-side receipt ack. Pins parsing (message-id + uds: from
// out of the UserPromptSubmit prompt), the delivered frame shape
// (protocol.ts buildReceiptFrame), failure silence, and the dispatch.mjs
// event wiring (exit code unchanged, no stdout context).

const HOOKS = path.resolve(__dirname, '../../../hooks');

// Static import of the .mjs hook: vitest resolves ESM fine. cli/test is
// excluded from the cli tsconfig typecheck, so the missing .d.ts is not a
// type error in CI (vitest itself never typechecks).
// @ts-ignore - untyped .mjs hook module
import {
    parseReceiptTargets,
    buildDeliveredReceipt,
    sendDeliveredReceipt,
    claudeReceiptAck,
    RECEIPT_TIMEOUT_MS,
    MAX_TARGETS,
} from '../../../hooks/claude-receipt-ack.mjs';

const NO_AGENT_HOST = { XTRM_AGENT_HOST: '0' };

/** Poll until the server side observed the receipt (client flush resolves
 *  before the server's event loop reads the bytes — asserting at once races). */
async function untilReceived(received: string[], count: number, ms = 5000): Promise<void> {
    const start = Date.now();
    while (received.length < count) {
        if (Date.now() - start > ms) throw new Error(`timed out waiting for ${count} receipt(s), got ${received.length}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

interface Spawned {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** Async spawn (never spawnSync against an in-process server: the blocked
 *  parent loop cannot answer the child's FIN and the child lingers). */
function spawnHook(script: string, args: string[], payload: unknown, cwd: string, timeoutMs = 30000): Promise<Spawned> {
    return new Promise((resolve) => {
        const proc = spawn(process.execPath, [path.join(HOOKS, script), ...args], {
            cwd,
            env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...NO_AGENT_HOST },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += String(d); });
        proc.stderr.on('data', (d) => { stderr += String(d); });
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve({ status: null, stdout, stderr });
        }, timeoutMs);
        proc.on('error', () => {
            clearTimeout(timer);
            resolve({ status: null, stdout, stderr });
        });
        proc.on('close', (code) => {
            clearTimeout(timer);
            resolve({ status: code, stdout, stderr });
        });
        proc.stdin.on('error', () => { /* child exited first: EPIPE is expected */ });
        proc.stdin.write(JSON.stringify(payload));
        proc.stdin.end();
    });
}

function envelope(messageId: string, from: string, body = 'hello'): string {
    return `<cross-session-message message-id="${messageId}" from="${from}">\n${body}\n</cross-session-message>`;
}

describe('claude-receipt-ack parsing (CORE-2492)', () => {
    it('extracts one (messageId, sockPath) pair from an injected frame', () => {
        const targets = parseReceiptTargets({
            hook_event_name: 'UserPromptSubmit',
            prompt: `do the thing\n${envelope('m-1', 'uds:/tmp/pi-123.sock')}\nthanks`,
        });
        expect(targets).toEqual([{ messageId: 'm-1', sockPath: '/tmp/pi-123.sock' }]);
    });

    it('extracts every frame and dedupes repeats', () => {
        const prompt = [
            envelope('m-1', 'uds:/tmp/a.sock'),
            'between',
            envelope('m-2', 'uds:/tmp/b.sock'),
            envelope('m-1', 'uds:/tmp/a.sock'),
        ].join('\n');
        const targets = parseReceiptTargets({ hook_event_name: 'UserPromptSubmit', prompt });
        expect(targets).toEqual([
            { messageId: 'm-1', sockPath: '/tmp/a.sock' },
            { messageId: 'm-2', sockPath: '/tmp/b.sock' },
        ]);
    });

    it('ignores attribute order and single quotes', () => {
        const targets = parseReceiptTargets({
            prompt: `<cross-session-message from='uds:/tmp/x.sock' message-id='m-9'>\nhi\n</cross-session-message>`,
        });
        expect(targets).toEqual([{ messageId: 'm-9', sockPath: '/tmp/x.sock' }]);
    });

    it('yields nothing without both message-id and a uds: from', () => {
        // Protocol envelope (no message-id in content): no receipt — the Pi
        // waiter keys on orig_msg_id, so a receipt without it resolves nothing.
        expect(parseReceiptTargets({ prompt: '<cross-session-message from="uds:/tmp/a.sock">\nhi\n</cross-session-message>' })).toEqual([]);
        // No return address.
        expect(parseReceiptTargets({ prompt: envelope('m-1', '') })).toEqual([]);
        expect(parseReceiptTargets({ prompt: '<cross-session-message message-id="m-1">\nhi\n</cross-session-message>' })).toEqual([]);
        // A bare roster name draws no ack (CORE-2465: it starves the waiter).
        expect(parseReceiptTargets({ prompt: envelope('m-1', 'peer-name') })).toEqual([]);
        // Plain prompt, empty prompt, missing prompt, garbage input.
        expect(parseReceiptTargets({ prompt: 'just a normal prompt' })).toEqual([]);
        expect(parseReceiptTargets({ prompt: '' })).toEqual([]);
        expect(parseReceiptTargets({})).toEqual([]);
        expect(parseReceiptTargets(null)).toEqual([]);
        expect(parseReceiptTargets('not an object' as never)).toEqual([]);
    });

    it('rejects unsafe ids and socket paths', () => {
        expect(parseReceiptTargets({ prompt: envelope('m\n1', 'uds:/tmp/a.sock') })).toEqual([]);
        expect(parseReceiptTargets({ prompt: envelope('m-1', 'uds:relative.sock') })).toEqual([]);
        expect(parseReceiptTargets({ prompt: envelope('', 'uds:/tmp/a.sock') })).toEqual([]);
    });

    it('accepts array prompt parts and caps pathological input', () => {
        const targets = parseReceiptTargets({ prompt: ['intro', envelope('m-1', 'uds:/tmp/a.sock')] });
        expect(targets).toEqual([{ messageId: 'm-1', sockPath: '/tmp/a.sock' }]);
        const targets2 = parseReceiptTargets({ prompt: [{ text: envelope('m-2', 'uds:/tmp/b.sock') }] });
        expect(targets2).toEqual([{ messageId: 'm-2', sockPath: '/tmp/b.sock' }]);
        expect(MAX_TARGETS).toBeGreaterThan(0);
        expect(RECEIPT_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    });
});

describe('claude-receipt-ack frame shape (CORE-2492)', () => {
    it('builds the protocol.ts buildReceiptFrame delivered shape', () => {
        const frame = buildDeliveredReceipt('m-1');
        expect(frame).toMatchObject({
            msgV: 1,
            type: 'control',
            action: 'peer_message_status',
            status: 'delivered',
            orig_msg_id: 'm-1',
        });
        expect(typeof frame.msg_id).toBe('string');
        expect(frame.msg_id).not.toBe('');
        // No from/reason: the waiter resolves on (status, orig_msg_id) alone.
        expect(frame).not.toHaveProperty('from');
        expect(frame).not.toHaveProperty('reason');
    });

    it('mints a fresh msg_id per receipt', () => {
        expect(buildDeliveredReceipt('m-1').msg_id).not.toBe(buildDeliveredReceipt('m-1').msg_id);
    });
});

describe('claude-receipt-ack delivery (CORE-2492)', () => {
    let dir: string;
    let sockPath: string;
    let server: net.Server | null = null;
    let received: string[];

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'xtrm-claude-ack-'));
        sockPath = path.join(dir, 'pi.sock');
        received = [];
    });

    afterEach(async () => {
        if (server) {
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            server = null;
        }
        await rm(dir, { recursive: true, force: true });
    });

    function listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            server = net.createServer((conn) => {
                conn.setEncoding('utf8');
                let buffer = '';
                conn.on('data', (chunk: string) => {
                    buffer += chunk;
                    let newline: number;
                    while ((newline = buffer.indexOf('\n')) !== -1) {
                        received.push(buffer.slice(0, newline));
                        buffer = buffer.slice(newline + 1);
                    }
                });
                conn.on('end', () => {
                    try {
                        conn.end();
                    } catch {
                        /* already closed */
                    }
                });
                conn.on('error', () => {});
            });
            server.once('error', reject);
            server.listen(sockPath, () => {
                server!.removeListener('error', reject);
                resolve();
            });
        });
    }

    it('sends one delivered NDJSON line the Pi waiter can resolve', async () => {
        await listen();
        const ok = await sendDeliveredReceipt(sockPath, 'm-live-1');
        expect(ok).toBe(true);
        await untilReceived(received, 1);
        const frame = JSON.parse(received[0]);
        expect(frame).toMatchObject({
            msgV: 1,
            type: 'control',
            action: 'peer_message_status',
            status: 'delivered',
            orig_msg_id: 'm-live-1',
        });
    });

    it('acks every injected frame in the prompt', async () => {
        await listen();
        const other = path.join(dir, 'other.sock');
        const prompt = [envelope('m-a', `uds:${sockPath}`), envelope('m-b', `uds:${other}`)].join('\n');
        const result = await claudeReceiptAck({ hook_event_name: 'UserPromptSubmit', prompt });
        // m-a delivers; the dead socket fails silently.
        expect(result).toEqual({ attempted: 2, delivered: 1 });
        await untilReceived(received, 1);
        expect(JSON.parse(received[0]).orig_msg_id).toBe('m-a');
    });

    it('never throws and never blocks: dead socket, garbage input, instant resolve', async () => {
        await expect(sendDeliveredReceipt('/nonexistent/xtrm-ack-test.sock', 'm-1', { timeoutMs: 200 })).resolves.toBe(false);
        await expect(sendDeliveredReceipt('', '', {})).resolves.toBe(false);
        await expect(claudeReceiptAck(null)).resolves.toEqual({ attempted: 0, delivered: 0 });
        await expect(claudeReceiptAck({ prompt: 'plain prompt' })).resolves.toEqual({ attempted: 0, delivered: 0 });
        const start = Date.now();
        await expect(claudeReceiptAck({ prompt: envelope('m-1', 'uds:/nonexistent-dir/x.sock') })).resolves.toEqual({
            attempted: 1,
            delivered: 0,
        });
        // A dead socket fails fast, far inside the hook budget — no 30 s hang.
        expect(Date.now() - start).toBeLessThan(5000);
    });

    it('dispatch.mjs event: UserPromptSubmit acks without output and keeps exit 0', async () => {
        await listen();
        const payload = {
            session_id: 'ack-test',
            cwd: dir,
            hook_event_name: 'UserPromptSubmit',
            prompt: `please continue\n${envelope('m-dispatch-1', `uds:${sockPath}`)}`,
        };
        const result = await spawnHook('dispatch.mjs', ['event'], payload, dir);
        expect(result.status).toBe(0);
        // No stdout: the receipt must not leak into the prompt as context.
        expect(result.stdout).toBe('');
        await untilReceived(received, 1);
        expect(JSON.parse(received[0])).toMatchObject({ status: 'delivered', orig_msg_id: 'm-dispatch-1' });
    });

    it('dispatch.mjs event: UserPromptSubmit without a frame stays silent with exit 0', async () => {
        const result = await spawnHook(
            'dispatch.mjs',
            ['event'],
            { session_id: 'ack-test', cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'plain prompt' },
            dir,
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
    });

    it('standalone entry keeps the stdin/exit-0 contract', async () => {
        await listen();
        const result = await spawnHook(
            'claude-receipt-ack.mjs',
            [],
            {
                hook_event_name: 'UserPromptSubmit',
                prompt: envelope('m-standalone-1', `uds:${sockPath}`),
            },
            dir,
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        await untilReceived(received, 1);
        expect(JSON.parse(received[0]).orig_msg_id).toBe('m-standalone-1');
    });
});
