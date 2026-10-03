// XTRM-567: `xt host ensure --json` (PRD xtrm-app §35.8 item 2) end to end against the built CLI —
// start, reuse, stale-info replacement, concurrent ensures, detachment, and the JSON error form.
// Every test runs on a temp HOME and XDG_RUNTIME_DIR and kills each host it started.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validate } from '@xtrm/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist/index.cjs');

interface Run {
    code: number | null;
    stdout: string;
    stderr: string;
}

let root: string;
let env: NodeJS.ProcessEnv;
const hostPids = new Set<number>();

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Resolves on 'close', so it only settles once no process holds the ensure's stdout/stderr pipes. */
function ensure(timeoutMs = 20_000): Promise<Run> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [dist, 'host', 'ensure', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        const timer = setTimeout(() => reject(new Error(`ensure did not close its stdio in ${timeoutMs} ms: ${stderr}`)), timeoutMs);
        child.once('error', reject);
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function parseResult(run: Run): { schema: string; version: string; protocol: { major: number }; port: number; pid: number } {
    const lines = run.stdout.trim().split('\n');
    expect(lines, `stdout must carry exactly one JSON object: ${run.stdout}`).toHaveLength(1);
    const result = JSON.parse(lines[0]);
    expect(validate('xtrm.agent-host-ensure.v1', result).errors).toEqual([]);
    if (typeof result.pid === 'number') hostPids.add(result.pid);
    return result;
}

function getSessions(port: number): Promise<{ status: number; body: { schema?: string; kind?: string } }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/v1/sessions', agent: false }, (res) => {
            let text = '';
            res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        });
        req.on('error', reject);
    });
}

async function waitDead(pid: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (alive(pid)) {
        if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
        await new Promise((r) => setTimeout(r, 20));
    }
}

const infoPath = () => path.join(root, 'home', '.xtrm', 'run', 'agent-host.json');

beforeEach(() => {
    expect(existsSync(dist), `build the CLI first: ${dist}`).toBe(true);
    root = mkdtempSync(path.join(os.tmpdir(), 'xt-host-ensure-'));
    for (const dir of ['home', 'run', 'pi-agent', 'pi-coding-agent']) mkdirSync(path.join(root, dir), { mode: 0o700 });
    env = {
        ...process.env,
        HOME: path.join(root, 'home'),
        XDG_RUNTIME_DIR: path.join(root, 'run'),
        PI_AGENT_DIR: path.join(root, 'pi-agent'),
        PI_CODING_AGENT_DIR: path.join(root, 'pi-coding-agent'),
    };
});

afterEach(async () => {
    try {
        const recorded = JSON.parse(readFileSync(infoPath(), 'utf8')) as { pid?: number };
        if (typeof recorded.pid === 'number') hostPids.add(recorded.pid);
    } catch {
        /* no info file */
    }
    for (const pid of hostPids) {
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            /* already gone */
        }
    }
    for (const pid of hostPids) {
        try {
            await waitDead(pid);
        } catch {
            process.kill(pid, 'SIGKILL');
        }
    }
    hostPids.clear();
    rmSync(root, { recursive: true, force: true });
});

describe('xt host ensure --json', () => {
    it('starts a detached host, then reuses it', async () => {
        const first = await ensure();
        expect(first.code, first.stderr).toBe(0);
        const started = parseResult(first);
        expect(started.protocol.major).toBe(1);
        expect(alive(started.pid)).toBe(true);
        expect(started.pid).not.toBe(process.pid);
        const sessions = await getSessions(started.port);
        expect(sessions.status).toBe(200);
        expect(sessions.body).toMatchObject({ schema: 'xtrm.agent-host-api.v1', kind: 'session_list' });

        const second = await ensure();
        expect(second.code, second.stderr).toBe(0);
        const reused = parseResult(second);
        expect(reused.pid).toBe(started.pid);
        expect(reused.port).toBe(started.port);
        expect(second.stderr).not.toContain('starting agent host');
    }, 60_000);

    it('replaces the stale info of a killed host', async () => {
        const first = parseResult(await ensure());
        process.kill(first.pid, 'SIGKILL');
        await waitDead(first.pid);
        expect(JSON.parse(readFileSync(infoPath(), 'utf8')).pid).toBe(first.pid);

        const run = await ensure();
        expect(run.code, run.stderr).toBe(0);
        const next = parseResult(run);
        expect(next.pid).not.toBe(first.pid);
        expect(run.stderr).toContain('replacing stale host info');
        expect(JSON.parse(readFileSync(infoPath(), 'utf8')).pid).toBe(next.pid);
        expect((await getSessions(next.port)).status).toBe(200);
    }, 60_000);

    it('starts one host for concurrent ensures', async () => {
        const runs = await Promise.all([ensure(), ensure(), ensure(), ensure()]);
        for (const run of runs) expect(run.code, run.stderr).toBe(0);
        const results = runs.map(parseResult);
        expect(new Set(results.map((r) => r.pid)).size).toBe(1);
        expect(new Set(results.map((r) => r.port)).size).toBe(1);
        expect(runs.filter((r) => r.stderr.includes('starting agent host'))).toHaveLength(1);
    }, 60_000);

    it('prints one JSON error object and exits non-zero when the host cannot start', async () => {
        // A live listener that is not an agent host holds the producer socket path.
        const socketPath = path.join(root, 'run', 'xtrm', 'agent-host.sock');
        mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
        const squatter = net.createServer((socket) => socket.destroy());
        await new Promise<void>((resolve) => squatter.listen(socketPath, resolve));
        try {
            const run = await ensure();
            expect(run.code).not.toBe(0);
            const lines = run.stdout.trim().split('\n');
            expect(lines).toHaveLength(1);
            const failure = JSON.parse(lines[0]);
            expect(validate('xtrm.agent-host-ensure.v1', failure).errors).toEqual([]);
            expect(failure.error.code).toBe('host_exited');
            expect(failure.error.message).toContain('already listening');
        } finally {
            await new Promise<void>((resolve) => squatter.close(() => resolve()));
        }
    }, 60_000);
});
