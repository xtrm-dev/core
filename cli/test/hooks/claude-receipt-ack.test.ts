import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    parseTranscriptTargets,
    readTranscriptTail,
    emitDeliveredReceipts,
    buildDeliveredReceipt,
    sendDeliveredReceipt,
    claudeReceiptAck,
    claudeReceiptAckStop,
    receiptAckDebugLine,
    receiptAckStateFile,
    RECEIPT_TIMEOUT_MS,
    MAX_TARGETS,
    MAX_TRANSCRIPT_TAIL_BYTES,
} from '../../../hooks/claude-receipt-ack.mjs';

const NO_AGENT_HOST = { XTRM_AGENT_HOST: '0' };

// CORE-2494: pin the hook debug sink to a temp file so unit runs never touch
// the real ~/.xtrm/logs/claude-receipt-ack.log. Applies file-wide (outer
// hooks run before describe-level ones); the new pins read the file back.
const RECEIPT_ACK_DEBUG_ENV = 'CLAUDE_RECEIPT_ACK_DEBUG_FILE';
let receiptAckDebugDir = '';
let savedReceiptAckDebugFile: string | undefined;
beforeEach(async () => {
    savedReceiptAckDebugFile = process.env[RECEIPT_ACK_DEBUG_ENV];
    receiptAckDebugDir = await mkdtemp(path.join(tmpdir(), 'xtrm-claude-ack-debug-'));
    process.env[RECEIPT_ACK_DEBUG_ENV] = path.join(receiptAckDebugDir, 'claude-receipt-ack.log');
});
afterEach(async () => {
    if (savedReceiptAckDebugFile === undefined) delete process.env[RECEIPT_ACK_DEBUG_ENV];
    else process.env[RECEIPT_ACK_DEBUG_ENV] = savedReceiptAckDebugFile;
    if (receiptAckDebugDir) await rm(receiptAckDebugDir, { recursive: true, force: true });
});

/** Read back the debug lines this test's hook invocations appended. */
async function readAckDebugLines(): Promise<string[]> {
    try {
        const text = await readFile(process.env[RECEIPT_ACK_DEBUG_ENV]!, 'utf8');
        return text.split('\n').filter((line) => line.length > 0);
    } catch {
        return [];
    }
}

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
function spawnHook(
    script: string,
    args: string[],
    payload: unknown,
    cwd: string,
    timeoutMs = 30000,
    extraEnv: NodeJS.ProcessEnv = {},
): Promise<Spawned> {
    return new Promise((resolve) => {
        const proc = spawn(process.execPath, [path.join(HOOKS, script), ...args], {
            cwd,
            // Neutralize tmux: the runner may carry a live TMUX_PANE, which would
            // send the Stop branch down the real inbox-reminder picker path
            // (seconds of subprocess calls). Ack tests pin the ack, not tmux.
            env: { ...process.env, TMUX: '', TMUX_PANE: '', CLAUDE_PROJECT_DIR: cwd, ...NO_AGENT_HOST, ...extraEnv },
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

describe('claude-receipt-ack debug observability (CORE-2494)', () => {
    let dir: string;
    let sockPath: string;
    let server: net.Server | null = null;
    let received: string[];

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'xtrm-claude-ack-dbg-'));
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

    it('pins the exact debug line shape', () => {
        expect(receiptAckDebugLine('invoke', { event: 'UserPromptSubmit', attempted: 0 })).toBe(
            '[claude-receipt-ack] invoke event=UserPromptSubmit attempted=0',
        );
        expect(
            receiptAckDebugLine('receipt', { sock: '/tmp/a.sock', orig_msg_id: 'm-1', outcome: 'delivered' }),
        ).toBe('[claude-receipt-ack] receipt sock=/tmp/a.sock orig_msg_id=m-1 outcome=delivered');
    });

    it('plain prompt leaves a fired/not-parsed trail: one invoke line, attempted=0', async () => {
        const result = await claudeReceiptAck({ hook_event_name: 'UserPromptSubmit', prompt: 'plain prompt' });
        expect(result).toEqual({ attempted: 0, delivered: 0 });
        const lines = await readAckDebugLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('[claude-receipt-ack] invoke event=UserPromptSubmit attempted=0');
        expect(lines[0]).toContain('session=');
    });

    it('loopback send trails invoke + delivered with the message id', async () => {
        await listen();
        const result = await claudeReceiptAck({
            hook_event_name: 'UserPromptSubmit',
            prompt: envelope('m-dbg-1', `uds:${sockPath}`),
        });
        expect(result).toEqual({ attempted: 1, delivered: 1 });
        await untilReceived(received, 1);
        const lines = await readAckDebugLines();
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('invoke event=UserPromptSubmit attempted=1');
        expect(lines[1]).toContain(`receipt sock=${sockPath} orig_msg_id=m-dbg-1 outcome=delivered`);
    });

    it('dead socket trails invoke + dial-failed without changing the fail-open counts', async () => {
        const result = await claudeReceiptAck({
            hook_event_name: 'UserPromptSubmit',
            prompt: envelope('m-dbg-dead', 'uds:/nonexistent-dir/xtrm-ack-dbg.sock'),
        });
        expect(result).toEqual({ attempted: 1, delivered: 0 });
        const lines = await readAckDebugLines();
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('invoke event=UserPromptSubmit attempted=1');
        expect(lines[1]).toContain('orig_msg_id=m-dbg-dead outcome=dial-failed');
    });

    it('a broken debug sink stays fail-open: counts unchanged, nothing thrown', async () => {
        process.env[RECEIPT_ACK_DEBUG_ENV] = dir; // a directory: append fails
        await expect(
            claudeReceiptAck({ hook_event_name: 'UserPromptSubmit', prompt: 'plain prompt' }),
        ).resolves.toEqual({ attempted: 0, delivered: 0 });
        await expect(
            claudeReceiptAck({
                hook_event_name: 'UserPromptSubmit',
                prompt: envelope('m-dbg-broken', 'uds:/nonexistent-dir/x.sock'),
            }),
        ).resolves.toEqual({ attempted: 1, delivered: 0 });
    });

    it('dispatch.mjs event: debug lands in the file, stdout/stderr stay empty, exit 0', async () => {
        await listen();
        const payload = {
            session_id: 'ack-debug-test',
            cwd: dir,
            hook_event_name: 'UserPromptSubmit',
            prompt: `please continue\n${envelope('m-dbg-dispatch-1', `uds:${sockPath}`)}`,
        };
        const result = await spawnHook('dispatch.mjs', ['event'], payload, dir);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
        await untilReceived(received, 1);
        const lines = await readAckDebugLines();
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(lines[0]).toContain('invoke event=UserPromptSubmit attempted=1');
        expect(lines.some((line) => line.includes('orig_msg_id=m-dbg-dispatch-1 outcome=delivered'))).toBe(true);
    });
});

describe('claude-receipt-ack Stop transcript tail-scan (CORE-2496)', () => {
    it('parses JSON-escaped envelopes from raw JSONL bytes', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'xtrm-stop-scan-'));
        try {
            const sock = path.join(dir, 'pi.sock');
            // As Claude writes it: the envelope inside a JSON string, quotes escaped.
            const line = JSON.stringify({
                type: 'user',
                message: {
                    role: 'user',
                    content: `<cross-session-message message-id="m-tail-1" from="uds:${sock}">\nhi\n</cross-session-message>`,
                },
            });
            expect(line).toContain('\\"');
            expect(parseTranscriptTargets(line)).toEqual([{ messageId: 'm-tail-1', sockPath: sock }]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('ignores assistant text and tags without message-id or uds: from', () => {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'working on it' } }),
            JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain follow-up, no envelope' } }),
            `<cross-session-message from="uds:/tmp/a.sock">\nhi\n</cross-session-message>`,
            `<cross-session-message message-id="m-x">\nhi\n</cross-session-message>`,
            `<cross-session-message message-id="m-y" from="peer-name">\nhi\n</cross-session-message>`,
        ].join('\n');
        expect(parseTranscriptTargets(lines)).toEqual([]);
        expect(parseTranscriptTargets('')).toEqual([]);
        expect(parseTranscriptTargets(null as never)).toEqual([]);
    });

    it('acks only inbound records: never assistant text, tool results or request logs (CORE-2554 C3)', () => {
        const env = (id: string) => `<cross-session-message message-id="${id}" from="uds:/tmp/a.sock">\nhi\n</cross-session-message>`;
        const lines = [
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: env('m-quoted') }] } }),
            JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: env('m-tool') }] } }),
            JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: env('m-blob') } }),
            JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: env('m-text-part') }] } }),
            JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: env('m-queued') } }),
            '{"type":"user","message":{"role":"user","content":"<cross-session-message message-id=\\"m-partial',
        ].join('\n');
        expect(parseTranscriptTargets(lines)).toEqual([
            { messageId: 'm-text-part', sockPath: '/tmp/a.sock' },
            { messageId: 'm-queued', sockPath: '/tmp/a.sock' },
        ]);
    });

    it('dedupes repeats within one chunk and caps at MAX_TARGETS', () => {
        const one = (id: string) =>
            JSON.stringify({ type: 'user', message: { role: 'user', content: `<cross-session-message message-id="${id}" from="uds:/tmp/a.sock">\nhi\n</cross-session-message>` } });
        const many = [one('m-1'), 'between', one('m-2'), one('m-1')].join('\n');
        expect(parseTranscriptTargets(many)).toEqual([
            { messageId: 'm-1', sockPath: '/tmp/a.sock' },
            { messageId: 'm-2', sockPath: '/tmp/a.sock' },
        ]);
        const over = Array.from({ length: MAX_TARGETS + 5 }, (_, i) => one(`m-${i}`)).join('\n');
        expect(parseTranscriptTargets(over)).toHaveLength(MAX_TARGETS);
    });

    it('matches the prompt scan on the same envelope (no UserPromptSubmit behavior change)', () => {
        const text = envelope('m-parity-1', 'uds:/tmp/p.sock');
        const record = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
        expect(parseTranscriptTargets(record)).toEqual(parseReceiptTargets({ prompt: text }));
    });
});

describe('claude-receipt-ack Stop position tracking (CORE-2496)', () => {
    let dir: string;
    let sockPath: string;
    let transcriptPath: string;
    let server: net.Server | null = null;
    let received: string[];

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'xtrm-stop-pos-'));
        sockPath = path.join(dir, 'pi.sock');
        transcriptPath = path.join(dir, 't.jsonl');
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

    function userLine(messageId: string, from: string, body = 'hello'): string {
        return (
            JSON.stringify({
                type: 'user',
                message: {
                    role: 'user',
                    content: `<cross-session-message message-id="${messageId}" from="${from}">\n${body}\n</cross-session-message>`,
                },
            }) + '\n'
        );
    }

    function stopInput() {
        return { session_id: 'stop-pos-test', cwd: dir, hook_event_name: 'Stop', transcript_path: transcriptPath };
    }

    it('acks once then stays silent: second Stop with no append attempts nothing', async () => {
        await listen();
        const { appendFileSync, writeFileSync } = await import('node:fs');
        writeFileSync(transcriptPath, userLine('m-pos-1', `uds:${sockPath}`), 'utf8');
        const first = await claudeReceiptAckStop(stopInput());
        expect(first).toEqual({ attempted: 1, delivered: 1 });
        await untilReceived(received, 1);
        expect(JSON.parse(received[0]).orig_msg_id).toBe('m-pos-1');

        const second = await claudeReceiptAckStop(stopInput());
        expect(second).toEqual({ attempted: 0, delivered: 0 });
        expect(received).toHaveLength(1);
    });

    it('a later append acks only the new envelope', async () => {
        await listen();
        const { appendFileSync, writeFileSync } = await import('node:fs');
        writeFileSync(transcriptPath, userLine('m-pos-a', `uds:${sockPath}`), 'utf8');
        await expect(claudeReceiptAckStop(stopInput())).resolves.toEqual({ attempted: 1, delivered: 1 });
        await untilReceived(received, 1);

        appendFileSync(
            transcriptPath,
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }) +
                '\n' +
                userLine('m-pos-b', `uds:${sockPath}`, 'second'),
            'utf8',
        );
        const third = await claudeReceiptAckStop(stopInput());
        expect(third).toEqual({ attempted: 1, delivered: 1 });
        await untilReceived(received, 2);
        expect(JSON.parse(received[1]).orig_msg_id).toBe('m-pos-b');
    });

    it('state file holds positions only, never transcript content', async () => {
        await listen();
        const { writeFileSync, readFileSync } = await import('node:fs');
        const body = 'secret-body-marker-xyz';
        writeFileSync(transcriptPath, userLine('m-pos-secret', `uds:${sockPath}`, body), 'utf8');
        await claudeReceiptAckStop(stopInput());
        await untilReceived(received, 1);
        const stateText = readFileSync(receiptAckStateFile(), 'utf8');
        expect(stateText).toContain(transcriptPath);
        expect(stateText).not.toContain(body);
        expect(stateText).not.toContain('m-pos-secret');
    });

    it('truncation re-anchors instead of replaying history or throwing', async () => {
        await listen();
        const { writeFileSync } = await import('node:fs');
        writeFileSync(transcriptPath, userLine('m-pos-old', `uds:${sockPath}`), 'utf8');
        await expect(claudeReceiptAckStop(stopInput())).resolves.toEqual({ attempted: 1, delivered: 1 });
        await untilReceived(received, 1);

        // Rotation: a shorter file replaces the transcript (offset now past EOF).
        writeFileSync(
            transcriptPath,
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'fresh start' } }) + '\n',
            'utf8',
        );
        await expect(claudeReceiptAckStop(stopInput())).resolves.toEqual({ attempted: 0, delivered: 0 });
        expect(received).toHaveLength(1);
    });

    it('readTranscriptTail bounds a huge turn to MAX_TRANSCRIPT_TAIL_BYTES', async () => {
        const { writeFileSync, statSync } = await import('node:fs');
        const padding = 'x'.repeat(2 * MAX_TRANSCRIPT_TAIL_BYTES);
        writeFileSync(transcriptPath, padding + userLine('m-pos-huge', `uds:${sockPath}`), 'utf8');
        const tail = readTranscriptTail(transcriptPath, { stateFile: receiptAckStateFile() });
        expect(tail.end).toBe(statSync(transcriptPath).size);
        expect(Buffer.byteLength(tail.text, 'utf8')).toBeLessThanOrEqual(MAX_TRANSCRIPT_TAIL_BYTES);
        expect(tail.text).toContain('m-pos-huge');
    });
});

describe('claude-receipt-ack Stop multi-envelope turn (CORE-2496)', () => {
    let dir: string;
    let sockA: string;
    let sockB: string;
    let transcriptPath: string;
    let servers: net.Server[] = [];
    let receivedA: string[];
    let receivedB: string[];

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'xtrm-stop-multi-'));
        sockA = path.join(dir, 'a.sock');
        sockB = path.join(dir, 'b.sock');
        transcriptPath = path.join(dir, 't.jsonl');
        receivedA = [];
        receivedB = [];
    });

    afterEach(async () => {
        await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
        servers = [];
        await rm(dir, { recursive: true, force: true });
    });

    function listenOn(sock: string, received: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const s = net.createServer((conn) => {
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
            s.once('error', reject);
            s.listen(sock, () => {
                s.removeListener('error', reject);
                resolve();
            });
            servers.push(s);
        });
    }

    function userLine(messageId: string, from: string): string {
        return (
            JSON.stringify({
                type: 'user',
                message: { role: 'user', content: `<cross-session-message message-id="${messageId}" from="${from}">\nhi\n</cross-session-message>` },
            }) + '\n'
        );
    }

    it('acks every envelope in one turn, one receipt per message', async () => {
        await listenOn(sockA, receivedA);
        await listenOn(sockB, receivedB);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(transcriptPath, userLine('m-multi-1', `uds:${sockA}`) + userLine('m-multi-2', `uds:${sockB}`), 'utf8');
        const result = await claudeReceiptAckStop({
            session_id: 'stop-multi',
            cwd: dir,
            hook_event_name: 'Stop',
            transcript_path: transcriptPath,
        });
        expect(result).toEqual({ attempted: 2, delivered: 2 });
        await untilReceived(receivedA, 1);
        await untilReceived(receivedB, 1);
        expect(JSON.parse(receivedA[0]).orig_msg_id).toBe('m-multi-1');
        expect(JSON.parse(receivedB[0]).orig_msg_id).toBe('m-multi-2');
    });

    it('a dead socket fails that message only, per-message precise', async () => {
        await listenOn(sockA, receivedA);
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
            transcriptPath,
            userLine('m-multi-live', `uds:${sockA}`) + userLine('m-multi-dead', 'uds:/nonexistent-dir/xtrm-stop.sock'),
            'utf8',
        );
        const result = await claudeReceiptAckStop({
            session_id: 'stop-multi-dead',
            cwd: dir,
            hook_event_name: 'Stop',
            transcript_path: transcriptPath,
        });
        expect(result).toEqual({ attempted: 2, delivered: 1 });
        await untilReceived(receivedA, 1);
        expect(JSON.parse(receivedA[0]).orig_msg_id).toBe('m-multi-live');
    });
});

describe('claude-receipt-ack Stop fail-open (CORE-2496)', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'xtrm-stop-fail-'));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('missing, absent, directory and garbage transcripts resolve empty without throwing', async () => {
        const { writeFileSync, mkdirSync } = await import('node:fs');
        await expect(claudeReceiptAckStop({ hook_event_name: 'Stop' })).resolves.toEqual({ attempted: 0, delivered: 0 });
        await expect(
            claudeReceiptAckStop({ hook_event_name: 'Stop', transcript_path: path.join(dir, 'nope.jsonl') }),
        ).resolves.toEqual({ attempted: 0, delivered: 0 });
        const sub = path.join(dir, 'sub');
        mkdirSync(sub, { recursive: true });
        await expect(claudeReceiptAckStop({ hook_event_name: 'Stop', transcript_path: sub })).resolves.toEqual({
            attempted: 0,
            delivered: 0,
        });
        const garbage = path.join(dir, 't.jsonl');
        writeFileSync(garbage, 'not json at all {{{', 'utf8');
        await expect(claudeReceiptAckStop({ hook_event_name: 'Stop', transcript_path: garbage })).resolves.toEqual({
            attempted: 0,
            delivered: 0,
        });
        await expect(claudeReceiptAckStop(null)).resolves.toEqual({ attempted: 0, delivered: 0 });
    });

    it('a broken state sink stays fail-open and still attempts the ack', async () => {
        const { writeFileSync } = await import('node:fs');
        const transcriptPath = path.join(dir, 't.jsonl');
        writeFileSync(
            transcriptPath,
            JSON.stringify({
                type: 'user',
                message: {
                    role: 'user',
                    content: `<cross-session-message message-id="m-fail-state" from="uds:/nonexistent-dir/x.sock">\nhi\n</cross-session-message>`,
                },
            }) + '\n',
            'utf8',
        );
        await expect(
            claudeReceiptAckStop(
                { hook_event_name: 'Stop', transcript_path: transcriptPath },
                { stateFile: dir }, // a directory: state write fails silently
            ),
        ).resolves.toEqual({ attempted: 1, delivered: 0 });
    });

    it('emitDeliveredReceipts with no targets resolves empty', async () => {
        await expect(emitDeliveredReceipts([])).resolves.toEqual({ attempted: 0, delivered: 0 });
        await expect(emitDeliveredReceipts(null as never)).resolves.toEqual({ attempted: 0, delivered: 0 });
    });

    it('dispatch.mjs event Stop with a transcript delivers, keeps exit 0 and empty stdout', async () => {
        const sock = path.join(dir, 'pi.sock');
        const transcriptPath = path.join(dir, 't.jsonl');
        const received: string[] = [];
        const srv = net.createServer((conn) => {
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
        await new Promise<void>((resolve, reject) => {
            srv.once('error', reject);
            srv.listen(sock, () => {
                srv.removeListener('error', reject);
                resolve();
            });
        });
        try {
            const { writeFileSync } = await import('node:fs');
            writeFileSync(
                transcriptPath,
                JSON.stringify({
                    type: 'user',
                    message: {
                        role: 'user',
                        content: `<cross-session-message message-id="m-dispatch-stop-1" from="uds:${sock}">\nhi\n</cross-session-message>`,
                    },
                }) + '\n',
                'utf8',
            );
            const result = await spawnHook(
                'dispatch.mjs',
                ['event'],
                { session_id: 'stop-dispatch-test', cwd: dir, hook_event_name: 'Stop', transcript_path: transcriptPath },
                dir,
            );
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
            await untilReceived(received, 1);
            expect(JSON.parse(received[0])).toMatchObject({ status: 'delivered', orig_msg_id: 'm-dispatch-stop-1' });
            const lines = await readAckDebugLines();
            expect(lines.some((line) => line.includes('invoke event=Stop attempted=1'))).toBe(true);
        } finally {
            await new Promise<void>((resolve) => srv.close(() => resolve()));
        }
    });

    it('dispatch.mjs event Stop without a transcript stays silent with exit 0', async () => {
        const result = await spawnHook(
            'dispatch.mjs',
            ['event'],
            { session_id: 'stop-silent-test', cwd: dir, hook_event_name: 'Stop', stop_hook_active: false },
            dir,
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('');
    });
});
