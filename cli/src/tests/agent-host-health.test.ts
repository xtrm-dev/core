/**
 * CORE-2554 E1/E3: the health route, health probes that never read the
 * session list, and the scrubbed spawn environment of a detached host.
 */
import { closeSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startAgentHost, type AgentHost } from '../core/agent-host.js';
import { hostSpawnEnv, openHostLog, probeAgentHost, probeHealth } from '../core/agent-host-ensure.js';

function stub(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number; paths: string[] }> {
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
        paths.push(req.url ?? '');
        handler(req, res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, paths })));
}

describe('agent host health (CORE-2554 E1)', () => {
    let dir: string;
    let host: AgentHost;

    beforeEach(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-health-'));
        host = await startAgentHost({ socketPath: path.join(dir, 'h.sock'), infoPath: path.join(dir, 'h.json'), log: () => {} });
    });

    afterEach(async () => {
        await host.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it('GET /v1/health answers ok with the pid, and the probes accept it', async () => {
        expect(await probeHealth(host.info.port, 500)).toBe('ok');
        expect(await probeAgentHost(host.info.port, 500)).toBe(true);
    });
});

describe('health probes against other servers (CORE-2554 E1)', () => {
    it('an older host (404 on /v1/health) is recognised by its live session list, never the bare list', async () => {
        const { server, port, paths } = await stub((req, res) => {
            if (req.url === '/v1/health') {
                res.writeHead(404).end('{}');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ schema: 'xtrm.agent-host-api.v1', kind: 'session_list', sessions: [] }));
        });
        try {
            expect(await probeHealth(port, 500)).toBe('missing');
            expect(await probeAgentHost(port, 500)).toBe(true);
            expect(paths).toContain('/v1/sessions?scope=live');
            expect(paths).not.toContain('/v1/sessions');
        } finally {
            server.close();
        }
    });

    it('a server that accepts but never answers reads as down within the budget', async () => {
        const { server, port } = await stub(() => {});
        try {
            const started = Date.now();
            expect(await probeHealth(port, 150)).toBe('down');
            expect(Date.now() - started).toBeLessThan(1000);
        } finally {
            server.closeAllConnections();
            server.close();
        }
    });
});

describe('detached host environment (CORE-2554 E3)', () => {
    it('drops session identity and keeps process basics', () => {
        const env = hostSpawnEnv({
            PATH: '/usr/bin',
            HOME: '/home/op',
            XDG_RUNTIME_DIR: '/run/user/1000',
            SUBSTRATE_HOLDER: 'worker-7',
            XTRM_SESSION_NAME: 'market-data',
            XTRM_DISPATCHER_NAME: 'coord',
            TMUX: '/tmp/tmux-1000/default,1,0',
            TMUX_PANE: '%3',
            CLAUDECODE: '1',
            XTRM_AGENT_HOST_SOCKET: '/run/user/1000/xtrm/agent-host.sock',
        });
        expect(env).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/op',
            XDG_RUNTIME_DIR: '/run/user/1000',
            XTRM_AGENT_HOST_SOCKET: '/run/user/1000/xtrm/agent-host.sock',
        });
    });
});

describe('host log rotation (CORE-2554 E5)', () => {
    it('rotates an oversized log to .1 instead of truncating it; a small log appends', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-log-'));
        try {
            const log = path.join(dir, 'agent-host.log');
            writeFileSync(log, 'old wedge evidence\n');
            const small = openHostLog(log, 1024);
            closeSync(small.fd);
            expect(small.start).toBe('old wedge evidence\n'.length);
            writeFileSync(log, 'x'.repeat(2048));
            const big = openHostLog(log, 1024);
            closeSync(big.fd);
            expect(big.start).toBe(0);
            expect(readFileSync(`${log}.1`, 'utf8')).toHaveLength(2048);
            expect(readFileSync(log, 'utf8')).toBe('');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
