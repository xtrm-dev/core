/**
 * `xt host ensure` (PRD xtrm-app §35.5, §35.8 item 2; XTRM-567): start the per-user agent host
 * if none is running, or reuse the running one, and report it as xtrm.agent-host-ensure.v1.
 *
 * The desktop app runs this over `ssh <target> -- "${SHELL:-/bin/sh}" -lc 'xt host ensure --json'`,
 * so a started host must outlive that SSH session: it runs `xt host start` in its own session
 * (setsid via `detached`), with stdin closed and stdout/stderr on a log file, never on the
 * inherited SSH channel. The host stays bound to 127.0.0.1; the app reaches it by port forwarding.
 *
 * Race safety: an exclusive lock file next to the info file serializes concurrent ensures, and
 * each holder re-checks for a live host before starting one, so two ensures start one host. A
 * lock whose holder pid is dead is broken. The host's own socket claim (a second host on a live
 * socket refuses to start) is the backstop.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    closeSync,
    linkSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AgentHostEnsureV1 } from '@xtrm/contracts';
import { AGENT_HOST_BIND_ADDRESS, defaultInfoPath, readAgentHostInfo, type AgentHostInfo } from './agent-host.js';

export const AGENT_HOST_ENSURE_SCHEMA = 'xtrm.agent-host-ensure.v1';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const PROBE_TIMEOUT_MS = 2_000;
/** A lock file without a parseable holder (holder died mid-write) counts as stale after this. */
const UNOWNED_LOCK_STALE_MS = 10_000;
const MAX_LOG_BYTES = 1024 * 1024;
const LOG_TAIL_BYTES = 2048;

export class AgentHostEnsureError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'AgentHostEnsureError';
    }
}

export interface EnsureAgentHostOptions {
    /** The xt build to start the host from, as [executable, ...entry]. Default: process.execPath + process.argv[1]. */
    xtCommand?: string[];
    /** Extra arguments after `host start` (for example `--socket`, `--no-history`). */
    hostArgs?: string[];
    env?: NodeJS.ProcessEnv;
    /** Overall budget for waiting on the lock and on a started host. */
    timeoutMs?: number;
    /** Where the detached host's stdout/stderr go. Default: agent-host.log next to the info file. */
    logPath?: string;
    log?: (message: string) => void;
}

export interface EnsureAgentHostResult {
    info: AgentHostInfo;
    /** True when this call started the host; false when it reused a running one. */
    started: boolean;
}

export function pidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export function toEnsureResult(info: AgentHostInfo): AgentHostEnsureV1 {
    return {
        schema: AGENT_HOST_ENSURE_SCHEMA,
        version: info.version,
        protocol: { major: info.protocol.major },
        port: info.port,
        pid: info.pid,
    };
}

export function toEnsureError(error: unknown): AgentHostEnsureV1 {
    const code = error instanceof AgentHostEnsureError ? error.code : 'ensure_failed';
    const message = error instanceof Error ? error.message : String(error);
    return { schema: AGENT_HOST_ENSURE_SCHEMA, error: { code, message: message.slice(0, 4096) } };
}

/** GET /v1/sessions answers with an xtrm.agent-host-api.v1 body: the port belongs to a live agent host. */
export function probeAgentHost(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get({ host: AGENT_HOST_BIND_ADDRESS, port, path: '/v1/sessions', timeout: timeoutMs, agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(false);
                try {
                    resolve((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { schema?: unknown }).schema === 'xtrm.agent-host-api.v1');
                } catch {
                    resolve(false);
                }
            });
            res.on('error', () => resolve(false));
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve(false));
    });
}

/** The host recorded in the info file, when its pid lives and its port answers as an agent host. */
async function liveHost(infoPath: string): Promise<AgentHostInfo | null> {
    const info = readAgentHostInfo(infoPath);
    if (!info || !pidAlive(info.pid) || !Number.isInteger(info.port)) return null;
    return (await probeAgentHost(info.port)) ? info : null;
}

export async function ensureAgentHost(options: EnsureAgentHostOptions = {}): Promise<EnsureAgentHostResult> {
    // The started host writes the default info file, so ensure reads the same one.
    const infoPath = defaultInfoPath();
    const log = options.log ?? ((message: string) => process.stderr.write(`[xt host ensure] ${message}\n`));
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const running = await liveHost(infoPath);
    if (running) return { info: running, started: false };

    mkdirSync(path.dirname(infoPath), { recursive: true, mode: 0o700 });
    const release = await acquireLock(`${infoPath}.lock`, deadline);
    try {
        // Another ensure may have started the host while this one waited for the lock.
        const started = await liveHost(infoPath);
        if (started) return { info: started, started: false };
        const stale = readAgentHostInfo(infoPath);
        if (stale) log(`replacing stale host info (pid ${stale.pid} is not a live agent host)`);
        return { info: await startDetachedHost(infoPath, options, deadline, log), started: true };
    } finally {
        release();
    }
}

async function startDetachedHost(
    infoPath: string,
    options: EnsureAgentHostOptions,
    deadline: number,
    log: (message: string) => void,
): Promise<AgentHostInfo> {
    const [command, ...entry] = options.xtCommand ?? [process.execPath, process.argv[1] ?? ''];
    const logPath = options.logPath ?? path.join(path.dirname(infoPath), 'agent-host.log');
    let logSize = 0;
    try {
        logSize = statSync(logPath).size;
    } catch {
        /* no log yet */
    }
    const logStart = logSize > MAX_LOG_BYTES ? 0 : logSize;
    const logFd = openSync(logPath, logSize > MAX_LOG_BYTES ? 'w' : 'a', 0o600);
    let child;
    try {
        child = spawn(command, [...entry, 'host', 'start', ...(options.hostArgs ?? [])], {
            detached: true,
            stdio: ['ignore', logFd, logFd],
            env: options.env ?? process.env,
        });
    } finally {
        closeSync(logFd);
    }
    let exit: string | null = null;
    let spawnError: Error | null = null;
    child.once('error', (error) => (spawnError = error));
    child.once('exit', (code, signal) => (exit = signal ? `signal ${signal}` : `code ${code}`));
    child.unref();
    const pid = child.pid;
    log(`starting agent host (pid ${pid ?? '?'}, log ${logPath})`);

    for (;;) {
        if (spawnError) throw new AgentHostEnsureError('host_spawn_failed', `could not start xt host: ${(spawnError as Error).message}`);
        if (exit) {
            throw new AgentHostEnsureError('host_exited', `xt host start exited with ${exit}${logTail(logPath, logStart)}`);
        }
        const info = readAgentHostInfo(infoPath);
        if (pid !== undefined && info?.pid === pid && (await probeAgentHost(info.port))) return info;
        if (Date.now() > deadline) {
            if (pid !== undefined) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {
                    /* already gone */
                }
            }
            throw new AgentHostEnsureError('host_start_timeout', `xt host did not become ready in time${logTail(logPath, logStart)}`);
        }
        await sleep(POLL_MS);
    }
}

function logTail(logPath: string, from: number): string {
    try {
        const text = readFileSync(logPath).subarray(from).toString('utf8').trim();
        return text ? `: ${text.slice(-LOG_TAIL_BYTES)}` : '';
    } catch {
        return '';
    }
}

async function acquireLock(lockPath: string, deadline: number): Promise<() => void> {
    const token = `${process.pid} ${randomUUID()}`;
    for (;;) {
        try {
            writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
            return () => {
                if (readText(lockPath) === token) safeUnlink(lockPath);
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        breakStaleLock(lockPath);
        if (Date.now() > deadline) {
            throw new AgentHostEnsureError('lock_timeout', `another xt host ensure holds ${lockPath}`);
        }
        await sleep(POLL_MS);
    }
}

/**
 * Remove a lock whose holder is gone. The lock is renamed aside and compared with what was read,
 * so a lock a live ensure re-created in between is put back (link never overwrites) instead of
 * being deleted.
 */
function breakStaleLock(lockPath: string): void {
    const content = readText(lockPath);
    if (content === null) return;
    const holder = Number.parseInt(content.split(' ')[0] ?? '', 10);
    if (Number.isInteger(holder) && holder > 0) {
        if (pidAlive(holder)) return;
    } else {
        try {
            if (Date.now() - statSync(lockPath).mtimeMs < UNOWNED_LOCK_STALE_MS) return;
        } catch {
            return;
        }
    }
    const aside = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
        renameSync(lockPath, aside);
    } catch {
        return;
    }
    if (readText(aside) !== content) {
        try {
            linkSync(aside, lockPath);
        } catch {
            /* a newer lock already took the path */
        }
    }
    safeUnlink(aside);
}

function readText(file: string): string | null {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function safeUnlink(file: string): void {
    try {
        unlinkSync(file);
    } catch {
        /* already gone */
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
