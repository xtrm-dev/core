/**
 * Direct connection mode of the XTRM agent host (PRD xtrm-app §35.5; XTRM-568).
 *
 * The host keeps binding 127.0.0.1. Remote clients on the tailnet reach it through an HTTPS
 * front such as `tailscale serve`, which proxies to the loopback port. A request counts as
 * local only when it arrived on loopback, names a loopback host, and carries no proxy
 * forwarding header; every other request must present a device-session bearer token.
 *
 * - Pairing tokens: 128-bit random, single use, at most 10 minutes, held only as SHA-256 hashes.
 * - Device sessions: 256-bit random bearer tokens, stored as SHA-256 hashes in a 0600 file under
 *   ~/.xtrm/agent-host, revocable, compared in constant time.
 *
 * Tokens are high-entropy random values, so a plain SHA-256 is enough: there is nothing to
 * brute-force that a slow KDF would protect. No token is ever logged or written in clear.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA_ID, type AgentHostAuthV1, type AgentHostDeviceSummary } from '@xtrm/contracts';

export const PAIRING_TOKEN_PREFIX = 'xtp_';
export const DEVICE_TOKEN_PREFIX = 'xtd_';
export const PAIRING_TOKEN_BYTES = 16;
export const DEVICE_TOKEN_BYTES = 32;
export const MAX_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 16;
const MAX_DEVICE_NAME_LENGTH = 64;
const STORE_SCHEMA = 'xtrm.agent-host-devices.v1';

/**
 * Headers a reverse proxy adds. `tailscale serve` always sets X-Forwarded-Host, sets
 * X-Forwarded-For to the tailnet source, and adds Tailscale-User-* for user-owned nodes.
 * Any one of them makes a request remote, whatever its source address.
 */
export const PROXY_HEADERS: readonly string[] = [
    'forwarded',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'tailscale-user-login',
    'tailscale-user-name',
    'tailscale-user-profile-pic',
    'tailscale-app-capabilities',
];

export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface DirectModeOptions {
    /** Host names the HTTPS front forwards, e.g. `machine.tailnet.ts.net`. Never a wildcard. */
    hostnames: readonly string[];
    /** Device store file; default ~/.xtrm/agent-host/devices.json. */
    storePath?: string;
    /** Pairing token lifetime, at most 10 minutes. */
    pairingTtlMs?: number;
    now?: () => number;
}

export type DeviceSummary = AgentHostDeviceSummary;

interface StoredDevice extends DeviceSummary {
    tokenHash: string;
}

interface PendingPairing {
    hash: Buffer;
    expiresAt: number;
}

export function defaultDeviceStorePath(): string {
    return path.join(os.homedir(), '.xtrm', 'agent-host', 'devices.json');
}

/**
 * A host name the direct mode may answer: a DNS name or an IP literal, no port, no wildcard,
 * and never an unspecified address. Returns the lower-cased name or throws.
 */
export function normalizeDirectHostname(value: string): string {
    const name = value.trim().toLowerCase();
    if (!name || name.includes('*') || name.includes('/') || /\s/.test(name)) {
        throw new Error(`invalid direct host name: ${JSON.stringify(value)}`);
    }
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    if (net.isIP(bare)) {
        const unspecified = net.isIPv4(bare) ? bare === '0.0.0.0' : bare.split(':').every((group) => /^0*$/.test(group));
        if (unspecified) {
            throw new Error(`direct host name must not be an unspecified address: ${value}`);
        }
        return net.isIPv6(bare) ? `[${bare}]` : bare;
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*\.?$/.test(name)) {
        throw new Error(`invalid direct host name: ${JSON.stringify(value)}`);
    }
    return name.replace(/\.$/, '');
}

export function isLoopbackAddress(address: string | undefined): boolean {
    if (!address) return false;
    const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
    if (net.isIPv4(v4)) return v4.startsWith('127.');
    return address === '::1';
}

export function hasProxyHeaders(headers: http.IncomingHttpHeaders): boolean {
    return PROXY_HEADERS.some((name) => headers[name] !== undefined);
}

/** Host header without its port, lower-cased; IPv6 literals keep their brackets. */
export function requestHostname(headers: http.IncomingHttpHeaders): string {
    return (headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
}

/** Local means: loopback peer, loopback Host header, and no proxy forwarding header. */
export function isLocalRequest(req: http.IncomingMessage): boolean {
    return (
        isLoopbackAddress(req.socket.remoteAddress) &&
        LOOPBACK_HOSTNAMES.has(requestHostname(req.headers)) &&
        !hasProxyHeaders(req.headers)
    );
}

/** The bearer token of an `Authorization: Bearer <token>` header, else null. */
export function bearerToken(headers: http.IncomingHttpHeaders): string | null {
    const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(headers.authorization ?? '');
    return match ? match[1] : null;
}

function hashToken(token: string): Buffer {
    return createHash('sha256').update(token, 'utf8').digest();
}

function newToken(prefix: string, bytes: number): string {
    return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function sanitizeDeviceName(value: unknown): string {
    const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    return name.slice(0, MAX_DEVICE_NAME_LENGTH) || 'device';
}

/**
 * Pairing tokens and device sessions of one host. The host process is the only writer of
 * the store while it runs; `xt host devices|revoke` use the host API then, and open the
 * file directly only when no host is running.
 */
export class DeviceAuthority {
    readonly storePath: string;
    private readonly pairingTtlMs: number;
    private readonly now: () => number;
    private readonly pending: PendingPairing[] = [];
    private devices: StoredDevice[];

    constructor(options: { storePath?: string; pairingTtlMs?: number; now?: () => number } = {}) {
        this.storePath = options.storePath ?? defaultDeviceStorePath();
        const ttl = options.pairingTtlMs ?? MAX_PAIRING_TTL_MS;
        if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_PAIRING_TTL_MS) {
            throw new Error(`pairing token lifetime must be within (0, ${MAX_PAIRING_TTL_MS}] ms`);
        }
        this.pairingTtlMs = ttl;
        this.now = options.now ?? Date.now;
        this.devices = this.load();
    }

    /** A new single-use pairing token. Only its hash is kept. */
    issuePairingToken(): { token: string; expiresAt: number } {
        this.prunePending();
        const token = newToken(PAIRING_TOKEN_PREFIX, PAIRING_TOKEN_BYTES);
        const expiresAt = this.now() + this.pairingTtlMs;
        this.pending.push({ hash: hashToken(token), expiresAt });
        if (this.pending.length > MAX_PENDING_PAIRINGS) this.pending.shift();
        return { token, expiresAt };
    }

    /**
     * Exchange a pairing token for a device session. The token is consumed on its first
     * match, even when it has expired, so it never works twice. Returns null on any failure.
     */
    exchange(pairingToken: string, deviceName: unknown): { device: DeviceSummary; token: string } | null {
        if (!pairingToken.startsWith(PAIRING_TOKEN_PREFIX)) return null;
        const hash = hashToken(pairingToken);
        let match = -1;
        // Compare against every pending hash; no early exit.
        this.pending.forEach((entry, i) => {
            if (timingSafeEqual(entry.hash, hash)) match = i;
        });
        if (match === -1) return null;
        const [entry] = this.pending.splice(match, 1);
        if (entry.expiresAt <= this.now()) return null;

        const token = newToken(DEVICE_TOKEN_PREFIX, DEVICE_TOKEN_BYTES);
        const device: StoredDevice = {
            deviceId: randomUUID(),
            name: sanitizeDeviceName(deviceName),
            createdAt: this.now(),
            tokenHash: hashToken(token).toString('hex'),
        };
        this.devices.push(device);
        this.save();
        return { device: summary(device), token };
    }

    /** The device a bearer token belongs to, else null. Constant time over the stored set. */
    authenticate(token: string | null): DeviceSummary | null {
        if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
        const hash = hashToken(token);
        let found: StoredDevice | null = null;
        for (const device of this.devices) {
            const stored = Buffer.from(device.tokenHash, 'hex');
            if (stored.length === hash.length && timingSafeEqual(stored, hash)) found = device;
        }
        return found ? summary(found) : null;
    }

    list(): DeviceSummary[] {
        return this.devices.map(summary);
    }

    /** Revoke one device session; false when the id is unknown. */
    revoke(deviceId: string): boolean {
        const before = this.devices.length;
        this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
        if (this.devices.length === before) return false;
        this.save();
        return true;
    }

    private prunePending(): void {
        const now = this.now();
        for (let i = this.pending.length - 1; i >= 0; i -= 1) {
            if (this.pending[i].expiresAt <= now) this.pending.splice(i, 1);
        }
    }

    private load(): StoredDevice[] {
        let text: string;
        try {
            text = readFileSync(this.storePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        // Tighten a store some other tool loosened.
        if ((statSync(this.storePath).mode & 0o077) !== 0) chmodSync(this.storePath, 0o600);
        const parsed = JSON.parse(text) as { schema?: unknown; devices?: unknown };
        if (parsed.schema !== STORE_SCHEMA || !Array.isArray(parsed.devices)) {
            throw new Error(`unrecognized device store ${this.storePath}`);
        }
        return parsed.devices.filter(
            (d): d is StoredDevice =>
                !!d &&
                typeof d.deviceId === 'string' &&
                typeof d.name === 'string' &&
                typeof d.createdAt === 'number' &&
                typeof d.tokenHash === 'string' &&
                /^[0-9a-f]{64}$/.test(d.tokenHash),
        );
    }

    private save(): void {
        mkdirSync(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.storePath}.${process.pid}.tmp`;
        writeFileSync(tmp, `${JSON.stringify({ schema: STORE_SCHEMA, devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, this.storePath);
    }
}

function summary(device: StoredDevice): DeviceSummary {
    return { deviceId: device.deviceId, name: device.name, createdAt: device.createdAt };
}

/** The operator command that puts the HTTPS front in place; xt never runs it. */
export function tailscaleServeCommand(port: number, httpsPort = 8447): string {
    return `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${port}`;
}

export const AGENT_HOST_AUTH_SCHEMA = SCHEMA_ID.agentHostAuth;

/** Host replies of xtrm.agent-host-auth.v1 (@xtrm/contracts); error replies keep xtrm.agent-host-api.v1. */
export type AgentHostAuthMessage = Exclude<AgentHostAuthV1, { kind: 'pair_request' }>;

/** Body of POST /v1/pair: `{schema, kind: 'pair_request', pairingToken, deviceName?}`. */
export function parsePairRequest(text: string): { pairingToken: string; deviceName: unknown } | null {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object') return null;
    const value = body as Record<string, unknown>;
    if (value.schema !== AGENT_HOST_AUTH_SCHEMA || value.kind !== 'pair_request') return null;
    if (typeof value.pairingToken !== 'string' || value.pairingToken.length > 256) return null;
    return { pairingToken: value.pairingToken, deviceName: value.deviceName };
}
