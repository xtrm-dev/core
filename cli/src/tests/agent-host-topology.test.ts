// XTRM-629: the agent host serves a live tmux topology feed. Runs against a PRIVATE tmux server
// (`tmux -L xtrm629-<random>`, no config file) and kills only that server; the operator's tmux
// server and sessions are never addressed.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyTopologyUpdate, encodeFrame, validate } from '@xtrm/contracts';
import type { AgentEventV1, AgentHostApiV1, TopologyProjectionV1 } from '@xtrm/contracts';
import { AGENT_HOST_BIND_ADDRESS, startAgentHost, type AgentHost } from '../core/agent-host.js';
import { defaultRunner, type CommandRunner } from '../core/topology-projection.js';

const SOCKET = `xtrm629-${randomBytes(6).toString('hex')}`;
const tmuxEnv = (() => {
    const env = { ...process.env };
    delete env.TMUX; // never fall back to the server this test runs inside
    return env;
})();
const hasTmux = (() => {
    try {
        execFileSync('tmux', ['-V'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

function tmux(...args: string[]): string {
    if (!SOCKET.startsWith('xtrm629-')) throw new Error('refusing to address a tmux server this test did not create');
    return execFileSync('tmux', ['-L', SOCKET, ...args], { env: tmuxEnv, encoding: 'utf8' });
}

/** Only tmux is real; every enrichment source reports unavailable, so no operator database is read. */
const tmuxOnlyRunner: CommandRunner = (bin, args, opts) =>
    bin === 'tmux' ? defaultRunner(bin, args, opts) : Promise.resolve({ kind: 'missing' });

const here = path.dirname(fileURLToPath(import.meta.url));
const identityFixture = (
    JSON.parse(readFileSync(path.resolve(here, '../../../packages/contracts/fixtures/agent-protocol.json'), 'utf8')) as { events: AgentEventV1[] }
).events[0];

type Topology = AgentHostApiV1 & { kind: 'topology_snapshot' | 'topology_update' };

/** SSE client that keeps the applied projection and when each message arrived. */
class TopologyClient {
    projection: TopologyProjectionV1 | null = null;
    revision = '';
    readonly messages: Array<{ message: Topology; at: number }> = [];
    private req: http.ClientRequest | null = null;

    static open(port: number, headers: Record<string, string> = {}): Promise<TopologyClient> {
        const client = new TopologyClient();
        return new Promise((resolve, reject) => {
            client.req = http.get({ host: AGENT_HOST_BIND_ADDRESS, port, path: '/v1/topology/events', headers }, (res) => {
                if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
                expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
                let buffer = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => {
                    buffer += chunk;
                    let end: number;
                    while ((end = buffer.indexOf('\n\n')) !== -1) {
                        const block = buffer.slice(0, end);
                        buffer = buffer.slice(end + 2);
                        const data = block.split('\n').find((l) => l.startsWith('data: '));
                        if (data) client.receive(JSON.parse(data.slice(6)) as Topology);
                    }
                });
                resolve(client);
            });
            client.req.on('error', reject);
        });
    }

    private receive(message: Topology): void {
        this.messages.push({ message, at: Date.now() });
        expect(validate('xtrm.agent-host-api.v1', message).errors).toEqual([]);
        if (message.kind === 'topology_snapshot') {
            this.projection = message.projection;
        } else {
            expect(message.base_revision).toBe(this.revision);
            this.projection = applyTopologyUpdate(this.projection!, message);
        }
        this.revision = message.revision;
    }

    /** Wait until the applied projection satisfies `probe`; returns ms since `since`. */
    async until(probe: (p: TopologyProjectionV1) => boolean, since: number, timeoutMs = 5000): Promise<number> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (this.projection && probe(this.projection)) return this.messages.at(-1)!.at - since;
            if (Date.now() > deadline) throw new Error('topology condition not reached');
            await new Promise((r) => setTimeout(r, 5));
        }
    }

    close(): void {
        this.req?.destroy();
    }
}

function getJson(port: number, route: string, headers: Record<string, string> = {}): Promise<{ status: number; body: AgentHostApiV1 }> {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: AGENT_HOST_BIND_ADDRESS, port, path: route, headers }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c: string) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
        });
        req.on('error', reject);
    });
}

function postJson(port: number, route: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: AGENT_HOST_BIND_ADDRESS, port, path: route, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (c: string) => (text += c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
            },
        );
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

/** What `ssh -L <local>:127.0.0.1:<port>` does: a byte pipe from a local port to the host's port. */
function portForward(targetPort: number): Promise<{ port: number; close(): Promise<void> }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
        const upstream = net.connect(targetPort, AGENT_HOST_BIND_ADDRESS);
        for (const s of [client, upstream]) {
            sockets.add(s);
            s.on('error', () => {});
            s.on('close', () => sockets.delete(s));
        }
        client.pipe(upstream).pipe(client);
    });
    return new Promise((resolve) => {
        server.listen(0, AGENT_HOST_BIND_ADDRESS, () => {
            resolve({
                port: (server.address() as net.AddressInfo).port,
                close: () => {
                    for (const s of sockets) s.destroy();
                    return new Promise((r) => server.close(() => r()));
                },
            });
        });
    });
}

const stable = (p: TopologyProjectionV1) => ({ ...p, generated_at_ms: 0, sources: p.sources.map((s) => ({ ...s, duration_ms: 0 })) });

describe.skipIf(!hasTmux)('agent host topology feed on a private tmux server (XTRM-629)', () => {
    let dir: string;
    let host: AgentHost;
    let alphaPane: string;
    let socketPath = '';
    const latencies: Record<string, number> = {};

    beforeAll(async () => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'xt-host-topology-'));
        // -f /dev/null: the private server loads no operator config, plugins or hooks.
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'alpha', '-x', '120', '-y', '30');
        alphaPane = tmux('display-message', '-p', '-t', 'alpha', '#{pane_id}').trim();
        socketPath = tmux('display-message', '-p', '#{socket_path}').trim();
        host = await startAgentHost({
            socketPath: path.join(dir, 'agent-host.sock'),
            infoPath: path.join(dir, 'agent-host.json'),
            log: () => {},
            topology: { tmuxArgs: ['-L', SOCKET], runner: tmuxOnlyRunner },
        });
    });

    afterAll(async () => {
        await host?.close();
        try {
            tmux('kill-server');
        } catch {
            /* already gone */
        }
        // kill-server can leave the socket file behind; remove only this test's own.
        if (path.basename(socketPath) === SOCKET) rmSync(socketPath, { force: true });
        rmSync(dir, { recursive: true, force: true });
        console.info(`[XTRM-629] update latency ms: ${JSON.stringify(latencies)}`);
    });

    it('streams a snapshot, then updates within 1 s of session, window, pane and @agent_state changes', async () => {
        const client = await TopologyClient.open(host.info.port);
        try {
            await client.until((p) => p.panes.some((pane) => pane.pane_id === alphaPane && pane.session_name === 'alpha'), Date.now());
            expect(client.messages[0].message.kind).toBe('topology_snapshot');
            const shell = client.projection!.panes.find((pane) => pane.pane_id === alphaPane)!;
            expect(shell).toMatchObject({ agent: null, agent_session: null, window_index: 0, pane_index: 0 });
            await client.until(() => host.topology.controlClientUp, Date.now());

            let t = Date.now();
            tmux('new-session', '-d', '-s', 'beta');
            latencies.session_created = await client.until((p) => p.panes.some((pane) => pane.session_name === 'beta'), t);

            t = Date.now();
            tmux('rename-window', '-t', 'beta:0', 'renamed');
            latencies.window_renamed = await client.until((p) => p.panes.some((pane) => pane.session_name === 'beta' && pane.window_name === 'renamed'), t);

            t = Date.now();
            tmux('new-window', '-d', '-t', 'alpha', '-n', 'second');
            latencies.window_created = await client.until((p) => p.panes.some((pane) => pane.window_name === 'second'), t);

            const before = client.projection!.panes.length;
            t = Date.now();
            tmux('split-window', '-d', '-t', 'alpha:second');
            latencies.pane_created = await client.until((p) => p.panes.length === before + 1, t);

            t = Date.now();
            tmux('rename-session', '-t', 'beta', 'gamma');
            latencies.session_renamed = await client.until((p) => p.panes.some((pane) => pane.session_name === 'gamma'), t);

            t = Date.now();
            tmux('set-option', '-p', '-t', alphaPane, '@agent_state', 'working');
            latencies.agent_state = await client.until((p) => p.panes.find((pane) => pane.pane_id === alphaPane)?.agent?.state === 'working', t);

            t = Date.now();
            tmux('kill-pane', '-t', 'alpha:second.1');
            latencies.pane_closed = await client.until((p) => p.panes.length === before, t);

            t = Date.now();
            tmux('kill-session', '-t', 'gamma');
            latencies.session_closed = await client.until((p) => !p.panes.some((pane) => pane.session_name === 'gamma'), t);

            for (const [event, ms] of Object.entries(latencies)) {
                expect(ms, `${event} took ${ms} ms`).toBeLessThan(1000);
            }
            // Diffs were sent: every update applied cleanly against its base revision (checked on receipt).
            expect(client.messages.some(({ message }) => message.kind === 'topology_update')).toBe(true);
            // Read-only: the observer changed nothing a list can see beyond its own attachment.
            expect(tmux('list-sessions', '-F', '#{session_name}').trim().split('\n')).toEqual(['alpha']);
        } finally {
            client.close();
        }
    });

    it('marks the pane that hosts a registered agent session with that session id', async () => {
        const client = await TopologyClient.open(host.info.port);
        const producer = net.connect(path.join(dir, 'agent-host.sock'));
        try {
            await new Promise((r) => producer.once('connect', r));
            const identity = {
                ...identityFixture,
                seq: 0,
                at: Date.now(),
                payload: { ...identityFixture.payload, tmux: { session: 'alpha', paneId: alphaPane } },
            } as AgentEventV1;
            const t = Date.now();
            producer.write(encodeFrame(identity));
            latencies.session_registered = await client.until(
                (p) => p.panes.find((pane) => pane.pane_id === alphaPane)?.agent_session?.session_id === identityFixture.sessionId,
                t,
            );
            expect(latencies.session_registered).toBeLessThan(1000);
            const pane = client.projection!.panes.find((x) => x.pane_id === alphaPane)!;
            expect(pane.agent_session).toMatchObject({ session_id: identityFixture.sessionId, provider: 'pi' });
            // Panes without an agent stay in the tree with no session.
            expect(client.projection!.panes.filter((x) => x.pane_id !== alphaPane).every((x) => x.agent_session === null)).toBe(true);
        } finally {
            producer.destroy();
            client.close();
        }
    });

    it('serves the same snapshot over the local socket and over an SSH-style port forward', async () => {
        const forward = await portForward(host.info.port);
        try {
            const local = await getJson(host.info.port, '/v1/topology');
            // ssh -L presents the forwarded port on the client side as localhost:<local port>.
            const bridged = await getJson(forward.port, '/v1/topology', { host: `localhost:${forward.port}` });
            expect(local.status).toBe(200);
            expect(bridged.status).toBe(200);
            if (local.body.kind !== 'topology_snapshot' || bridged.body.kind !== 'topology_snapshot') throw new Error('expected snapshots');
            expect(validate('xtrm.agent-host-api.v1', bridged.body).errors).toEqual([]);
            expect(bridged.body.revision).toBe(local.body.revision);
            expect(stable(bridged.body.projection)).toEqual(stable(local.body.projection));

            const stream = await TopologyClient.open(forward.port, { host: `localhost:${forward.port}` });
            await stream.until(() => true, Date.now());
            expect(stream.messages[0].message.kind).toBe('topology_snapshot');
            expect(stream.revision).toBe(local.body.revision);
            stream.close();
        } finally {
            await forward.close();
        }
    });

    it('serves the feed to a paired direct-mode device and refuses an unauthenticated one', async () => {
        const front = 'machine.tailnet.ts.net';
        const tailnet = { host: `${front}:8447`, 'x-forwarded-for': '100.101.102.103', 'x-forwarded-proto': 'https' };
        const direct = await startAgentHost({
            socketPath: path.join(dir, 'agent-host-direct.sock'),
            infoPath: path.join(dir, 'agent-host-direct.json'),
            log: () => {},
            direct: { hostnames: [front], storePath: path.join(dir, 'devices', 'devices.json') },
            topology: { tmuxArgs: ['-L', SOCKET], runner: tmuxOnlyRunner },
        });
        try {
            const port = direct.info.port;
            expect((await getJson(port, '/v1/topology', tailnet)).status).toBe(401);
            const issued = await postJson(port, '/v1/pairing', {});
            const paired = await postJson(
                port,
                '/v1/pair',
                { schema: 'xtrm.agent-host-auth.v1', kind: 'pair_request', pairingToken: issued.body.token, deviceName: 'phone' },
                tailnet,
            );
            const auth = { ...tailnet, authorization: `Bearer ${paired.body.token as string}` };
            const remote = await getJson(port, '/v1/topology', auth);
            const local = await getJson(host.info.port, '/v1/topology');
            expect(remote.status).toBe(200);
            if (remote.body.kind !== 'topology_snapshot' || local.body.kind !== 'topology_snapshot') throw new Error('expected snapshots');
            // Same tmux world; agent_session differs only because sessions register per host.
            const panes = (p: TopologyProjectionV1) => p.panes.map(({ agent_session: _session, ...pane }) => pane);
            expect(panes(remote.body.projection)).toEqual(panes(local.body.projection));

            const stream = await TopologyClient.open(port, auth);
            await stream.until(() => true, Date.now());
            expect(stream.messages[0].message.kind).toBe('topology_snapshot');
            stream.close();
        } finally {
            await direct.close();
        }
    });
});
