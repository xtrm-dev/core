import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    renameSync,
    lstatSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';

import { parseCodexSessionMeta } from './codex-runtime.js';

export interface CodexWorktreeSession {
    runtime: 'codex';
    launchedAt: string;
    threadId: string;
    safetyProfile: 'codex-yolo' | 'codex-workspace-write';
    profileName: string;
    profilePath: string;
    /**
     * CORE-2728: the Substrate Issue this session was launched for (`--bead`).
     * Recorded so `xt attach` can find the launch binding — and the original
     * dispatcher — after the pane (and its @agent_bead) is gone. Absent when the
     * launch carried no bead; a record without it stays valid.
     */
    bead?: string;
}

export interface CodexTrustProfile {
    name: string;
    path: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SESSION_FILES = 4_096;
const MAX_DIRECTORY_DEPTH = 8;
const FIRST_LINE_BYTES = 64 * 1024;
const PROFILE_NAME = /^xtrm-[0-9a-f]{16}$/;

function trustProfileContent(worktreePath: string): string {
    return `[projects.${JSON.stringify(worktreePath)}]\ntrust_level = "trusted"\n`;
}

export function codexTrustProfile(codexHome: string, worktreePath: string): CodexTrustProfile {
    const digest = createHash('sha256').update(worktreePath).digest('hex').slice(0, 16);
    const name = `xtrm-${digest}`;
    return { name, path: path.join(codexHome, `${name}.config.toml`) };
}

export function ensureCodexTrustProfile(codexHome: string, worktreePath: string): CodexTrustProfile {
    const profile = codexTrustProfile(codexHome, worktreePath);
    const expected = trustProfileContent(worktreePath);
    mkdirSync(codexHome, { recursive: true });
    if (existsSync(profile.path)) {
        const stat = lstatSync(profile.path);
        if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(profile.path, 'utf8') !== expected) {
            throw new Error(`refusing to replace non-owned Codex profile ${profile.path}`);
        }
        return profile;
    }
    writeFileSync(profile.path, expected, { flag: 'wx', mode: 0o600 });
    return profile;
}

export function removeCodexTrustProfile(profile: CodexTrustProfile, worktreePath: string): boolean {
    if (!PROFILE_NAME.test(profile.name)
        || path.basename(profile.path) !== `${profile.name}.config.toml`
        || !existsSync(profile.path)) return false;
    try {
        const stat = lstatSync(profile.path);
        if (!stat.isFile() || stat.isSymbolicLink()
            || readFileSync(profile.path, 'utf8') !== trustProfileContent(worktreePath)) return false;
        unlinkSync(profile.path);
        return true;
    } catch {
        return false;
    }
}

function sessionMetaPath(worktreePath: string): string {
    return path.join(worktreePath, '.xtrm', 'session-meta.json');
}

function readFirstLine(filePath: string): string | null {
    let fd: number | undefined;
    try {
        fd = openSync(filePath, 'r');
        const buffer = Buffer.allocUnsafe(FIRST_LINE_BYTES);
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/, 1)[0] ?? null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function collectSessionFiles(root: string): string[] {
    if (!existsSync(root)) return [];
    const files: string[] = [];
    const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    while (pending.length > 0 && files.length < MAX_SESSION_FILES) {
        const current = pending.pop();
        if (!current) break;
        let entries;
        try {
            entries = readdirSync(current.directory, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (files.length >= MAX_SESSION_FILES) break;
            const entryPath = path.join(current.directory, entry.name);
            if (entry.isDirectory() && current.depth < MAX_DIRECTORY_DEPTH) {
                pending.push({ directory: entryPath, depth: current.depth + 1 });
            } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                files.push(entryPath);
            }
        }
    }
    return files;
}

export function findCodexSession(input: {
    sessionsRoot: string;
    cwd: string;
    launchedAfterMs: number;
}): { threadId: string; cliVersion: string | null; timestampMs: number; filePath: string } | null {
    let newest: ReturnType<typeof findCodexSession> = null;
    for (const filePath of collectSessionFiles(input.sessionsRoot)) {
        const line = readFirstLine(filePath);
        if (!line) continue;
        const parsed = parseCodexSessionMeta(line, input);
        if (!parsed || (newest && newest.timestampMs >= parsed.timestampMs)) continue;
        newest = { ...parsed, filePath };
    }
    return newest;
}

export function writeCodexWorktreeSession(worktreePath: string, session: CodexWorktreeSession): boolean {
    const destination = sessionMetaPath(worktreePath);
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(temporary, JSON.stringify(session, null, 2));
        renameSync(temporary, destination);
        return true;
    } catch {
        try { unlinkSync(temporary); } catch { /* best effort */ }
        return false;
    }
}

export function readCodexWorktreeSession(worktreePath: string): CodexWorktreeSession | null {
    try {
        const parsed = JSON.parse(readFileSync(sessionMetaPath(worktreePath), 'utf8')) as Record<string, unknown>;
        if (parsed.runtime !== 'codex'
            || typeof parsed.launchedAt !== 'string'
            || !Number.isFinite(Date.parse(parsed.launchedAt))
            || typeof parsed.threadId !== 'string'
            || !UUID.test(parsed.threadId)
            || (parsed.safetyProfile !== 'codex-yolo' && parsed.safetyProfile !== 'codex-workspace-write')
            || typeof parsed.profileName !== 'string'
            || !PROFILE_NAME.test(parsed.profileName)
            || typeof parsed.profilePath !== 'string'
            || !path.isAbsolute(parsed.profilePath)
            || path.basename(parsed.profilePath) !== `${parsed.profileName}.config.toml`) {
            return null;
        }
        // Only the fields above are trusted: the bead is read explicitly, so an
        // absent one is a valid record and a non-string/empty one is dropped rather
        // than carried. A damaged file can then never name an Issue, and the ref
        // shape is still validated by the attach-side reader before it reaches `sb`.
        const { bead: rawBead, ...validated } = parsed;
        const session = validated as unknown as CodexWorktreeSession;
        const bead = typeof rawBead === 'string' ? rawBead.trim() : '';
        if (bead) session.bead = bead;
        return session;
    } catch {
        return null;
    }
}
