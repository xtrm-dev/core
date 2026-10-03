/**
 * `xt host` — the XTRM agent host (PRD xtrm-app §35.5, §35.8 item 3; XTRM-563).
 *
 * `xt host start` runs the host in the foreground: one process per user, the producer
 * socket for in-session extensions, and the xtrm.agent-host-api.v1 client API on
 * 127.0.0.1. `xt host status` reads the info file and checks that the recorded pid lives.
 * `xt host ensure` starts the host detached or reuses the running one and prints
 * xtrm.agent-host-ensure.v1 (§35.8 item 2, the SSH bootstrap; XTRM-567).
 * `xt host start --direct --direct-host <name>` turns on direct mode for tailnet clients behind
 * `tailscale serve`; `xt host pair`, `xt host devices` and `xt host revoke` manage device
 * sessions (§35.5; XTRM-568). The listener stays on 127.0.0.1 in every mode.
 */

import http from 'node:http';
import { Command } from 'commander';
import kleur from 'kleur';
import { DeviceAuthority, tailscaleServeCommand, type AgentHostAuthMessage, type DeviceSummary } from '../core/agent-host-auth.js';
import { AGENT_HOST_BIND_ADDRESS, defaultInfoPath, readAgentHostInfo, startAgentHost, type AgentHostInfo } from '../core/agent-host.js';
import { ensureAgentHost, pidAlive, toEnsureError, toEnsureResult } from '../core/agent-host-ensure.js';
import { defaultSessionIndexOptions } from '../core/agent-host-session-index.js';

export function createHostCommand(version = '0.0.0'): Command {
    const cmd = new Command('host').description(
        'XTRM agent host: live session registry, loopback client API, event fan-out and command routing',
    );

    cmd.command('start')
        .description('Run the agent host in the foreground (binds 127.0.0.1 only)')
        .option('--port <port>', 'Client API port on 127.0.0.1 (0 picks a free port)', '0')
        .option('--socket <path>', 'Producer socket path (default $XDG_RUNTIME_DIR/xtrm/agent-host.sock)')
        .option('--json', 'Print the host info as JSON once listening', false)
        .option('--no-history', 'Do not index stopped sessions from the Pi and Claude journals')
        .option('--direct', 'Direct mode: accept proxied tailnet requests that carry a paired device session', false)
        .option('--direct-host <names>', 'Comma-separated host names the HTTPS front forwards (e.g. machine.tailnet.ts.net)')
        .action(async (options: { port: string; socket?: string; json?: boolean; history: boolean; direct?: boolean; directHost?: string }) => {
            const port = Number(options.port);
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                console.error(kleur.red(`Invalid --port: ${options.port}`));
                process.exitCode = 1;
                return;
            }
            const directHostnames = (options.directHost ?? '').split(',').map((h) => h.trim()).filter(Boolean);
            if (options.direct !== (directHostnames.length > 0)) {
                console.error(kleur.red('--direct and --direct-host <names> go together'));
                process.exitCode = 1;
                return;
            }
            let host;
            try {
                host = await startAgentHost({
                    port,
                    socketPath: options.socket,
                    version,
                    ...(options.history ? { sessionIndex: defaultSessionIndexOptions() } : {}),
                    ...(options.direct ? { direct: { hostnames: directHostnames } } : {}),
                });
            } catch (error) {
                console.error(kleur.red(`✗ ${(error as Error).message}`));
                process.exitCode = 1;
                return;
            }
            const { info } = host;
            if (options.json) console.log(JSON.stringify(info));
            else console.log(`xt host listening on http://${info.address}:${info.port} · socket ${info.socket} · pid ${info.pid}`);
            if (info.direct && !options.json) {
                console.log(`direct mode on for ${info.direct.hostnames.join(', ')}; the operator runs the HTTPS front:`);
                console.log(`  ${tailscaleServeCommand(info.port)}`);
                if (port === 0) console.log(kleur.yellow('  pass --port <n> so the front keeps pointing at the host after a restart'));
            }

            const stop = () => {
                void host.close().then(() => process.exit(0));
            };
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
        });

    cmd.command('ensure')
        .description('Start the agent host detached if none is running, or reuse it; print its port and pid')
        .option('--json', 'Print exactly one xtrm.agent-host-ensure.v1 object on stdout', false)
        .option('--timeout <ms>', 'How long to wait for the lock and for a started host', '30000')
        .action(async (options: { json?: boolean; timeout: string }) => {
            const timeoutMs = Number(options.timeout);
            try {
                if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid --timeout: ${options.timeout}`);
                const { info, started } = await ensureAgentHost({ timeoutMs });
                if (options.json) console.log(JSON.stringify(toEnsureResult(info)));
                else console.log(`${started ? 'started' : 'running'} · http://${info.address}:${info.port} · pid ${info.pid} · v${info.version}`);
            } catch (error) {
                const failure = toEnsureError(error);
                if (options.json) console.log(JSON.stringify(failure));
                else if ('error' in failure) console.error(kleur.red(`✗ ${failure.error.code}: ${failure.error.message}`));
                process.exitCode = 1;
            }
        });

    cmd.command('status')
        .description('Report whether an agent host is running for this user')
        .option('--json', 'Print machine-readable status', false)
        .action((options: { json?: boolean }) => {
            const info = readAgentHostInfo();
            const running = info !== null && pidAlive(info.pid);
            if (options.json) {
                console.log(JSON.stringify({ running, ...(running ? { info } : {}), infoPath: defaultInfoPath() }));
            } else if (running) {
                console.log(`running · http://${info.address}:${info.port} · socket ${info.socket} · pid ${info.pid}`);
            } else {
                console.log('not running');
            }
            if (!running) process.exitCode = 1;
        });

    cmd.command('pair')
        .description('Issue a one-time pairing token (single use, 10 minutes) for a direct-mode client')
        .option('--json', 'Print the xtrm.agent-host-auth.v1 pairing_token object', false)
        .action(async (options: { json?: boolean }) => {
            try {
                const info = runningHost();
                if (!info?.direct) throw new Error('no agent host is running in direct mode; start it with xt host start --direct');
                const reply = await localApi(info, 'POST', '/v1/pairing', {});
                if (reply.kind !== 'pairing_token') throw new Error(`unexpected reply ${reply.kind}`);
                if (options.json) console.log(JSON.stringify(reply));
                else {
                    console.log(reply.token);
                    console.log(`single use · expires ${new Date(reply.expiresAt).toISOString()} · exchange it at POST /v1/pair on ${info.direct.hostnames.join(', ')}`);
                }
            } catch (error) {
                console.error(kleur.red(`✗ ${(error as Error).message}`));
                process.exitCode = 1;
            }
        });

    cmd.command('devices')
        .description('List paired direct-mode devices')
        .option('--json', 'Print the xtrm.agent-host-auth.v1 device_list object', false)
        .action(async (options: { json?: boolean }) => {
            try {
                const info = runningHost();
                // The running direct-mode host owns the store; otherwise the file is read directly.
                const devices: DeviceSummary[] = info?.direct
                    ? await localApi(info, 'GET', '/v1/devices').then((r) => (r.kind === 'device_list' ? r.devices : []))
                    : new DeviceAuthority().list();
                if (options.json) console.log(JSON.stringify({ schema: 'xtrm.agent-host-auth.v1', kind: 'device_list', devices }));
                else if (devices.length === 0) console.log('no paired devices');
                else for (const d of devices) console.log(`${d.deviceId}  ${d.name}  paired ${new Date(d.createdAt).toISOString()}`);
            } catch (error) {
                console.error(kleur.red(`✗ ${(error as Error).message}`));
                process.exitCode = 1;
            }
        });

    cmd.command('revoke')
        .description('Revoke a direct-mode device session')
        .argument('<deviceId>', 'Device id from xt host devices')
        .action(async (deviceId: string) => {
            try {
                const info = runningHost();
                if (info?.direct) await localApi(info, 'DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`);
                else if (!new DeviceAuthority().revoke(deviceId)) throw new Error(`no device ${deviceId}`);
                console.log(`revoked ${deviceId}`);
            } catch (error) {
                console.error(kleur.red(`✗ ${(error as Error).message}`));
                process.exitCode = 1;
            }
        });

    return cmd;
}

function runningHost(): AgentHostInfo | null {
    const info = readAgentHostInfo();
    return info && pidAlive(info.pid) ? info : null;
}

type ApiReply = AgentHostAuthMessage | { kind: 'error'; code: string; message: string };

/** One request to the local host API as a local client: loopback, loopback Host, no proxy headers. */
function localApi(info: AgentHostInfo, method: string, route: string, body?: unknown): Promise<AgentHostAuthMessage> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: AGENT_HOST_BIND_ADDRESS,
                port: info.port,
                method,
                path: route,
                headers: body === undefined ? {} : { 'content-type': 'application/json' },
            },
            (res) => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', (chunk: string) => (text += chunk));
                res.on('end', () => {
                    try {
                        const reply = JSON.parse(text) as ApiReply;
                        if (reply.kind === 'error') reject(new Error(`${reply.code}: ${reply.message}`));
                        else resolve(reply);
                    } catch {
                        reject(new Error(`the agent host answered ${res.statusCode} with a non-JSON body`));
                    }
                });
            },
        );
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}
