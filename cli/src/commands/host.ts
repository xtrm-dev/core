/**
 * `xt host` — the XTRM agent host (PRD xtrm-app §35.5, §35.8 item 3; XTRM-563).
 *
 * `xt host start` runs the host in the foreground: one process per user, the producer
 * socket for in-session extensions, and the xtrm.agent-host-api.v1 client API on
 * 127.0.0.1. `xt host status` reads the info file and checks that the recorded pid lives.
 * `xt host ensure` starts the host detached or reuses the running one and prints
 * xtrm.agent-host-ensure.v1 (§35.8 item 2, the SSH bootstrap; XTRM-567).
 */

import { Command } from 'commander';
import kleur from 'kleur';
import { defaultInfoPath, readAgentHostInfo, startAgentHost } from '../core/agent-host.js';
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
        .action(async (options: { port: string; socket?: string; json?: boolean; history: boolean }) => {
            const port = Number(options.port);
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                console.error(kleur.red(`Invalid --port: ${options.port}`));
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
                });
            } catch (error) {
                console.error(kleur.red(`✗ ${(error as Error).message}`));
                process.exitCode = 1;
                return;
            }
            const { info } = host;
            if (options.json) console.log(JSON.stringify(info));
            else console.log(`xt host listening on http://${info.address}:${info.port} · socket ${info.socket} · pid ${info.pid}`);

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

    return cmd;
}
