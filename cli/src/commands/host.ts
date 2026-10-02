/**
 * `xt host` — the XTRM agent host (PRD xtrm-app §35.5, §35.8 item 3; XTRM-563).
 *
 * `xt host start` runs the host in the foreground: one process per user, the producer
 * socket for in-session extensions, and the xtrm.agent-host-api.v1 client API on
 * 127.0.0.1. `xt host status` reads the info file and checks that the recorded pid lives.
 */

import { Command } from 'commander';
import kleur from 'kleur';
import { defaultInfoPath, readAgentHostInfo, startAgentHost } from '../core/agent-host.js';

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function createHostCommand(version = '0.0.0'): Command {
    const cmd = new Command('host').description(
        'XTRM agent host: live session registry, loopback client API, event fan-out and command routing',
    );

    cmd.command('start')
        .description('Run the agent host in the foreground (binds 127.0.0.1 only)')
        .option('--port <port>', 'Client API port on 127.0.0.1 (0 picks a free port)', '0')
        .option('--socket <path>', 'Producer socket path (default $XDG_RUNTIME_DIR/xtrm/agent-host.sock)')
        .option('--json', 'Print the host info as JSON once listening', false)
        .action(async (options: { port: string; socket?: string; json?: boolean }) => {
            const port = Number(options.port);
            if (!Number.isInteger(port) || port < 0 || port > 65535) {
                console.error(kleur.red(`Invalid --port: ${options.port}`));
                process.exitCode = 1;
                return;
            }
            let host;
            try {
                host = await startAgentHost({ port, socketPath: options.socket, version });
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
