// XTRM-568: direct connection mode — tailnet clients behind an HTTPS front (tailscale serve)
// pair once with a one-time token and then carry a revocable device session; local loopback
// clients keep working without one; the listener stays on 127.0.0.1 in every mode.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    DEVICE_TOKEN_PREFIX,
    MAX_PAIRING_TTL_MS,
    normalizeDirectHostname,
    PAIRING_TOKEN_PREFIX,
} from '../core/agent-host-auth.js';
import { AGENT_HOST_BIND_ADDRESS, startAgentHost, type AgentHost } from '../core/agent-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONT = 'machine.tailnet.ts.net';
/** What `tailscale serve` adds when it proxies a tailnet request to the loopback port. */
const TAILSCALE_HEADERS = {
    host: `${FRONT}:8447`,
    'x-forwarded-host': `${FRONT}:8447`,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.101.102.103',
    'tailscale-user-login': 'operator@example.com',
};

interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
}

function request(host: AgentHost, method: string, route: string, headers: Record<string, string> = {}, body?: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: AGENT_HOST_BIND_ADDRESS,
                port: host.info.port,
                method,
                path: route,
                headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
            },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (text += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(text) }));
            },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

const remote = (host: AgentHost, method: string, route: string, extra: Record<string, string> = {}, body?: unknown) =>
    request(host, method, route, { ...TAILSCALE_HEADERS, ...extra }, body);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function issuePairingToken(host: AgentHost): Promise<string> {
    const reply = await request(host, 'POST', '/v1/pairing', {}, {});
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ schema: 'xtrm.agent-host-auth.v1', kind: 'pairing_token' });
    return reply.body.token as string;
}

function pair(host: AgentHost, pairingToken: string, deviceName = 'phone'): Promise<Reply> {
    return remote(host, 'POST', '/v1/pair', {}, {
        schema: 'xtrm.agent-host-auth.v1',
        kind: 'pair_request',
        pairingToken,
        deviceName,
    });
}

describe('xt host direct mode (XTRM-568)', () => {
    let dir: string;
    let storePath: string;
    let logs: string[];
    let clock: number;
    const hosts: AgentHost[] = [];

    async function start(direct: boolean): Promise<AgentHost> {
        const host = await startAgentHost({
            socketPath: path.join(dir, `agent-host-${hosts.length}.sock`),
            infoPath: path.join(dir, `agent-host-${hosts.length}.json`),
            log: (m) => logs.push(m),
            ...(direct ? { direct: { hostnames: [FRONT], storePath, now: () => clock } } : {}),
        });
        hosts.push(host);
        return host;
    }

    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-direct-'));
        storePath = path.join(dir, 'state', 'devices.json');
        logs = [];
        clock = 1_000_000;
    });

    afterEach(async () => {
        await Promise.all(hosts.splice(0).map((h) => h.close()));
        rmSync(dir, { recursive: true, force: true });
    });

    it('binds 127.0.0.1 with direct mode off and on; no wildcard host name is accepted', async () => {
        expect(AGENT_HOST_BIND_ADDRESS).toBe('127.0.0.1');
        const plain = await start(false);
        const direct = await start(true);
        expect(plain.info.address).toBe('127.0.0.1');
        expect(direct.info.address).toBe('127.0.0.1');
        expect(direct.info.direct).toEqual({ hostnames: [FRONT] });
        expect(plain.info.direct).toBeUndefined();
        for (const bad of ['*', '*.ts.net', '0.0.0.0', '::', '[::]', '0:0::0', '', 'a b', 'host:8447']) {
            expect(() => normalizeDirectHostname(bad), bad).toThrow();
        }
        expect(normalizeDirectHostname('Machine.Tailnet.ts.net.')).toBe(FRONT);
        await expect(
            startAgentHost({ socketPath: path.join(dir, 'x.sock'), infoPath: path.join(dir, 'x.json'), direct: { hostnames: [] } }),
        ).rejects.toThrow(/at least one host name/);
    });

    it('source check: every agent-host listen() uses the loopback constant or the Unix socket path', () => {
        const core = path.resolve(here, '../core');
        const files = readdirSync(core)
            .filter((f) => f.startsWith('agent-host') && f.endsWith('.ts'))
            .map((f) => path.join(core, f))
            .concat(path.resolve(here, '../commands/host.ts'));
        const calls: string[] = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            for (const m of text.matchAll(/(?<!function )\blisten\(([^)]*)\)/g)) calls.push(m[1].trim());
            // No wildcard bind literal outside the host-name validator that rejects it.
            const outsideValidator = text.replace(/export function normalizeDirectHostname[\s\S]*?\n}\n/, '');
            expect(outsideValidator, file).not.toMatch(/['"](0\.0\.0\.0|::|\[::\])['"]/);
        }
        expect(calls.sort()).toEqual(
            [
                'httpServer, options.port ?? 0, AGENT_HOST_BIND_ADDRESS',
                'socketServer, socketPath',
                'target, done',
                'target, host, done',
            ].sort(),
        );
    });

    it('with direct mode off, a proxied request is refused even with a loopback Host', async () => {
        const host = await start(false);
        expect((await request(host, 'GET', '/v1/sessions')).status).toBe(200);
        for (const header of ['x-forwarded-for', 'x-forwarded-host', 'tailscale-user-login', 'forwarded']) {
            const reply = await request(host, 'GET', '/v1/sessions', { host: '127.0.0.1', [header]: 'x' });
            expect(reply.status, header).toBe(403);
            expect(reply.body).toMatchObject({ kind: 'error', code: 'direct_mode_disabled' });
        }
        // The tailnet front name is not an allowed Host without direct mode.
        expect((await remote(host, 'GET', '/v1/sessions')).body).toMatchObject({ code: 'forbidden_host' });
        expect((await request(host, 'POST', '/v1/pairing', {}, {})).body).toMatchObject({ code: 'direct_mode_disabled' });
    });

    it('serves a local loopback client without a token; a loopback request with proxy headers is remote', async () => {
        const host = await start(true);
        expect((await request(host, 'GET', '/v1/sessions')).status).toBe(200);
        expect((await request(host, 'GET', '/v1/sessions', { host: 'localhost' })).status).toBe(200);
        for (const extra of <Record<string, string>[]>[
            { 'x-forwarded-for': '127.0.0.1' },
            { 'tailscale-user-login': 'operator@example.com' },
            { 'x-forwarded-host': 'localhost' },
        ]) {
            const reply = await request(host, 'GET', '/v1/sessions', { host: '127.0.0.1', ...extra });
            expect(reply.status, JSON.stringify(extra)).toBe(401);
        }
        // A spoofed loopback Host behind the front is still remote: tailscale serve adds X-Forwarded-*.
        expect((await remote(host, 'GET', '/v1/sessions', { host: 'localhost' })).status).toBe(401);
        // The front name without proxy headers is not local either.
        expect((await request(host, 'GET', '/v1/sessions', { host: FRONT })).status).toBe(401);
        // DNS-rebinding guard stays: any other host name is refused outright.
        expect((await request(host, 'GET', '/v1/sessions', { host: 'evil.example' })).body).toMatchObject({ code: 'forbidden_host' });
    });

    it('rejects an unauthenticated or forged proxied request with 401 and a Bearer challenge', async () => {
        const host = await start(true);
        const none = await remote(host, 'GET', '/v1/sessions');
        expect(none.status).toBe(401);
        expect(none.headers['www-authenticate']).toBe('Bearer realm="xt-host"');
        expect(none.body).toMatchObject({ kind: 'error', code: 'unauthorized' });
        for (const auth of [`Bearer ${DEVICE_TOKEN_PREFIX}forged`, 'Bearer ', 'Basic dXNlcjpwYXNz', `bearer ${DEVICE_TOKEN_PREFIX}x`]) {
            expect((await remote(host, 'GET', '/v1/sessions', { authorization: auth })).status, auth).toBe(401);
        }
        // A pairing token is not a device session.
        const pairingToken = await issuePairingToken(host);
        expect((await remote(host, 'GET', '/v1/sessions', bearer(pairingToken))).status).toBe(401);
    });

    it('exchanges a pairing token once for a device session; a replay is rejected', async () => {
        const host = await start(true);
        const pairingToken = await issuePairingToken(host);
        expect(pairingToken.startsWith(PAIRING_TOKEN_PREFIX)).toBe(true);
        expect(Buffer.from(pairingToken.slice(PAIRING_TOKEN_PREFIX.length), 'base64url')).toHaveLength(16);

        const paired = await pair(host, pairingToken, 'phone\u0007');
        expect(paired.status).toBe(200);
        expect(paired.body).toMatchObject({ schema: 'xtrm.agent-host-auth.v1', kind: 'device_session', device: { name: 'phone' } });
        const token = paired.body.token as string;
        expect(Buffer.from(token.slice(DEVICE_TOKEN_PREFIX.length), 'base64url')).toHaveLength(32);

        const replay = await pair(host, pairingToken);
        expect(replay.status).toBe(401);
        expect(replay.body).toMatchObject({ code: 'invalid_pairing_token' });

        const sessions = await remote(host, 'GET', '/v1/sessions', bearer(token));
        expect(sessions.status).toBe(200);
        expect(sessions.body).toMatchObject({ kind: 'session_list' });

        // The store holds hashes only, in a 0600 file under a 0700 directory.
        const store = readFileSync(storePath, 'utf8');
        expect(store).not.toContain(token);
        expect(store).not.toContain(token.slice(DEVICE_TOKEN_PREFIX.length));
        expect(statSync(storePath).mode & 0o777).toBe(0o600);
        expect(statSync(path.dirname(storePath)).mode & 0o777).toBe(0o700);

        // Neither token ever reaches the log.
        const joined = logs.join('\n');
        expect(joined).toContain('paired device');
        expect(joined).not.toContain(token);
        expect(joined).not.toContain(pairingToken);
    });

    it('rejects an expired pairing token, and consumes it', async () => {
        const host = await start(true);
        const pairingToken = await issuePairingToken(host);
        clock += MAX_PAIRING_TTL_MS;
        expect((await pair(host, pairingToken)).status).toBe(401);
        clock -= MAX_PAIRING_TTL_MS;
        expect((await pair(host, pairingToken)).status).toBe(401);
        await expect(
            startAgentHost({
                socketPath: path.join(dir, 'ttl.sock'),
                infoPath: path.join(dir, 'ttl.json'),
                direct: { hostnames: [FRONT], pairingTtlMs: MAX_PAIRING_TTL_MS + 1, storePath },
            }),
        ).rejects.toThrow(/lifetime/);
    });

    it('rejects a revoked device, closes its event stream, and keeps sessions across a host restart', async () => {
        const host = await start(true);
        const a = (await pair(host, await issuePairingToken(host), 'phone')).body;
        const b = (await pair(host, await issuePairingToken(host), 'tablet')).body;
        const tokenA = a.token as string;
        const tokenB = b.token as string;
        const idA = (a.device as { deviceId: string }).deviceId;

        const listed = await request(host, 'GET', '/v1/devices');
        expect(listed.body).toMatchObject({ kind: 'device_list' });
        expect((listed.body.devices as { name: string }[]).map((d) => d.name).sort()).toEqual(['phone', 'tablet']);
        expect(JSON.stringify(listed.body)).not.toMatch(/tokenHash|xtd_/);

        // Device A holds an event stream open.
        const streamClosed = new Promise<void>((resolve, reject) => {
            const req = http.get(
                { host: AGENT_HOST_BIND_ADDRESS, port: host.info.port, path: '/v1/events', headers: { ...TAILSCALE_HEADERS, ...bearer(tokenA) } },
                (res) => {
                    expect(res.statusCode).toBe(200);
                    res.resume();
                    res.on('close', () => resolve());
                    res.once('data', () => {
                        void request(host, 'DELETE', `/v1/devices/${idA}`).then((r) => expect(r.status).toBe(200), reject);
                    });
                },
            );
            req.on('error', () => resolve());
        });
        await streamClosed;

        expect((await remote(host, 'GET', '/v1/sessions', bearer(tokenA))).status).toBe(401);
        expect((await remote(host, 'GET', '/v1/sessions', bearer(tokenB))).status).toBe(200);
        expect((await request(host, 'DELETE', `/v1/devices/${idA}`)).status).toBe(404);

        await host.close();
        const restarted = await start(true);
        expect((await remote(restarted, 'GET', '/v1/sessions', bearer(tokenB))).status).toBe(200);
        expect((await remote(restarted, 'GET', '/v1/sessions', bearer(tokenA))).status).toBe(401);
    });

    it('keeps pairing issuance and device management local only, even for a paired device', async () => {
        const host = await start(true);
        const token = (await pair(host, await issuePairingToken(host))).body.token as string;
        const deviceId = ((await request(host, 'GET', '/v1/devices')).body.devices as { deviceId: string }[])[0].deviceId;
        expect((await remote(host, 'POST', '/v1/pairing', bearer(token), {})).body).toMatchObject({ code: 'local_only' });
        expect((await remote(host, 'GET', '/v1/devices', bearer(token))).body).toMatchObject({ code: 'local_only' });
        expect((await remote(host, 'DELETE', `/v1/devices/${deviceId}`, bearer(token))).body).toMatchObject({ code: 'local_only' });
        // Pairing issuance keeps the JSON content-type rule (no simple cross-site form POST).
        const form = await request(host, 'POST', '/v1/pairing', { 'content-type': 'application/x-www-form-urlencoded' });
        expect(form.status).toBe(415);
    });
});
