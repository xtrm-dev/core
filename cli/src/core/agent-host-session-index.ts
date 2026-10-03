/**
 * Incremental session index of the XTRM agent host (PRD xtrm-app §35.5, §35.2, §26; XTRM-565).
 *
 * Covers sessions that are not running. Provider journals (Pi: ~/.pi/agent/sessions,
 * Claude: ~/.claude/projects) stay authoritative: the index is a projection cache that is
 * built once at startup and then updated from file-watch events, re-reading only the bytes
 * appended since the last read. Request paths never touch the disk.
 *
 * - Journals are opened read-only; nothing is written into provider directories.
 * - The optional on-disk cache only stores per-file read offsets and the derived summary
 *   state. Deleting it loses nothing: the next start rebuilds the same list.
 * - Only journals directly inside a project directory (`<root>/<dir>/<file>.jsonl`) count;
 *   deeper files (Claude subagent transcripts) are not sessions of their own.
 */

import { existsSync, type FSWatcher, statSync, watch } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentHostApiV1, AgentSessionSummary } from '@xtrm/contracts';

export type HistoryProvider = 'pi' | 'claude';
type SessionDetail = Extract<AgentHostApiV1, { kind: 'session_detail' }>;

export interface SessionIndexRoot {
    provider: HistoryProvider;
    /** Directory holding one sub-directory per project, each holding `*.jsonl` journals. */
    dir: string;
}

export interface SessionIndexOptions {
    roots: SessionIndexRoot[];
    /** Rebuildable cache file; omit to keep the index in memory only. */
    cachePath?: string;
    log?: (message: string) => void;
}

/** Bump when the derived state changes shape or meaning; older caches are then ignored. */
const CACHE_VERSION = 1;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const CACHE_WRITE_DELAY_MS = 2_000;
const TITLE_MAX_CHARS = 200;
const BOUNDED_MAX_CHARS = 1024;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]+/g;
const HAS_CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

export function defaultSessionIndexOptions(home = os.homedir()): SessionIndexOptions {
    return {
        roots: [
            { provider: 'pi', dir: path.join(home, '.pi', 'agent', 'sessions') },
            { provider: 'claude', dir: path.join(home, '.claude', 'projects') },
        ],
        cachePath: path.join(home, '.xtrm', 'cache', 'agent-host', 'session-index.json'),
    };
}

/** Resumable per-journal parse state: an append continues from `offset` with this state. */
interface JournalState {
    sessionId?: string;
    cwd?: string;
    /** Operator-set title (Pi session_info, Claude custom-title); null when explicitly cleared. */
    name?: string | null;
    /** Claude ai-title. */
    aiTitle?: string;
    firstPrompt?: string;
    model?: string;
    startedAt?: number;
    lastActivityAt?: number;
    /** One human request and the activity it causes form one Frame (PRD Frame invariant). */
    frameCount: number;
    /** Pi journals must open with a `session` header; anything else is not a session file. */
    invalid?: boolean;
}

interface JournalRecord {
    provider: HistoryProvider;
    ino: number;
    size: number;
    mtimeMs: number;
    /** Bytes consumed, always just past a newline. A trailing partial line is re-read later. */
    offset: number;
    state: JournalState;
}

interface CacheFile {
    version: number;
    roots: SessionIndexRoot[];
    journals: Record<string, JournalRecord>;
}

export class SessionIndex {
    /** Resolves once the startup build has drained. Lists served before then are partial. */
    readonly ready: Promise<void>;

    private readonly roots: SessionIndexRoot[];
    private readonly cachePath: string | undefined;
    private readonly log: (message: string) => void;
    private readonly journals = new Map<string, JournalRecord>();
    private readonly watchers = new Map<string, FSWatcher>();
    /** Roots that do not exist yet, keyed by the nearest existing ancestor being watched. */
    private readonly pendingRoots = new Map<string, Set<SessionIndexRoot>>();
    private readonly queue = new Set<string>();
    private readonly queued = new Map<string, HistoryProvider>();
    private draining: Promise<void> | null = null;
    private summaries: AgentSessionSummary[] | null = null;
    private byId: Map<string, AgentSessionSummary> | null = null;
    private cacheTimer: NodeJS.Timeout | null = null;
    private cacheDirty = false;
    private closed = false;

    constructor(options: SessionIndexOptions) {
        this.roots = options.roots.map((r) => ({ provider: r.provider, dir: path.resolve(r.dir) }));
        this.cachePath = options.cachePath;
        this.log = options.log ?? (() => {});
        this.ready = this.build();
    }

    /** History-only summaries, most recent activity first. Served from memory. */
    list(): AgentSessionSummary[] {
        this.project();
        return this.summaries!;
    }

    get(sessionId: string): AgentSessionSummary | null {
        this.project();
        return this.byId!.get(sessionId) ?? null;
    }

    detail(sessionId: string): SessionDetail | null {
        const session = this.get(sessionId);
        return session ? { schema: 'xtrm.agent-host-api.v1', kind: 'session_detail', session } : null;
    }

    /** Number of journals tracked (including ones that are not listable sessions). */
    get journalCount(): number {
        return this.journals.size;
    }

    /** Resolves when every queued refresh has been applied. */
    async settled(): Promise<void> {
        while (this.draining) await this.draining;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const watcher of this.watchers.values()) watcher.close();
        this.watchers.clear();
        this.queue.clear();
        await this.ready.catch(() => {});
        await this.settled();
        if (this.cacheTimer) clearTimeout(this.cacheTimer);
        if (this.cacheDirty) await this.writeCache();
    }

    // --- build and watch ---

    private async build(): Promise<void> {
        await this.loadCache();
        for (const root of this.roots) {
            // Watch before listing so a change made during the scan is never missed.
            this.watchRoot(root);
            await this.scanRoot(root);
        }
        // Journals from the cache that no longer exist on disk.
        for (const file of this.journals.keys()) if (!this.queued.has(file)) this.enqueue(file, this.journals.get(file)!.provider);
        await this.settled();
        this.scheduleCacheWrite();
    }

    private watchRoot(root: SessionIndexRoot): void {
        if (existsSync(root.dir)) {
            this.watchDir(root.dir, (name) => {
                if (name) void this.addProjectDir(root, path.join(root.dir, name));
            });
            return;
        }
        // The root does not exist yet: watch the nearest existing ancestor and wait for it
        // to appear. One stat per event on that ancestor, no periodic rescans.
        const ancestor = this.nearestExistingDir(root.dir);
        const pending = this.pendingRoots.get(ancestor) ?? new Set<SessionIndexRoot>();
        pending.add(root);
        this.pendingRoots.set(ancestor, pending);
        this.watchDir(ancestor, () => void this.pollPendingRoots(ancestor));
    }

    private async pollPendingRoots(ancestor: string): Promise<void> {
        const pending = this.pendingRoots.get(ancestor);
        if (!pending) return;
        for (const root of [...pending]) {
            const info = await stat(root.dir).catch(() => null);
            if (!info?.isDirectory()) continue;
            pending.delete(root);
            if (pending.size === 0) {
                this.pendingRoots.delete(ancestor);
                this.watchers.get(ancestor)?.close();
                this.watchers.delete(ancestor);
            }
            this.watchRoot(root);
            await this.scanRoot(root);
        }
    }

    private async scanRoot(root: SessionIndexRoot): Promise<void> {
        let dirs: string[];
        try {
            dirs = await readdir(root.dir);
        } catch (error) {
            this.log(`session index: cannot read ${root.dir}: ${(error as Error).message}`);
            return;
        }
        for (const name of dirs) await this.addProjectDir(root, path.join(root.dir, name));
    }

    /** The closest ancestor of `dir` that exists as a directory (falls back to the filesystem root). */
    private nearestExistingDir(dir: string): string {
        let current = dir;
        for (;;) {
            current = path.dirname(current);
            try {
                if (statSync(current).isDirectory()) return current;
            } catch {
                // Not a directory or unreadable: keep climbing.
            }
            if (path.dirname(current) === current) return current;
        }
    }

    private async addProjectDir(root: SessionIndexRoot, dir: string): Promise<void> {
        if (this.closed) return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            // Not a directory, or removed: drop any journals indexed under it.
            const watcher = this.watchers.get(dir);
            if (watcher) {
                watcher.close();
                this.watchers.delete(dir);
                for (const file of this.journals.keys()) if (path.dirname(file) === dir) this.enqueue(file, root.provider);
            }
            return;
        }
        if (!this.watchers.has(dir)) {
            this.watchDir(dir, (name) => {
                if (name?.endsWith('.jsonl')) this.enqueue(path.join(dir, name), root.provider);
            });
        }
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) this.enqueue(path.join(dir, entry.name), root.provider);
        }
    }

    private watchDir(dir: string, onEvent: (name: string | null) => void): void {
        if (this.closed || this.watchers.has(dir)) return;
        try {
            const watcher = watch(dir, { persistent: false }, (_event, name) => onEvent(name ? String(name) : null));
            watcher.on('error', (error) => {
                this.log(`session index: watcher for ${dir} failed: ${error.message}`);
                watcher.close();
                this.watchers.delete(dir);
            });
            this.watchers.set(dir, watcher);
        } catch (error) {
            this.log(`session index: cannot watch ${dir}: ${(error as Error).message}`);
        }
    }

    /** Queue one journal for refresh. Repeated events for a queued file coalesce. */
    private enqueue(file: string, provider: HistoryProvider): void {
        if (this.closed) return;
        this.queue.add(file);
        this.queued.set(file, provider);
        this.draining ??= this.drain();
    }

    private async drain(): Promise<void> {
        try {
            while (this.queue.size > 0 && !this.closed) {
                const file = this.queue.values().next().value as string;
                this.queue.delete(file);
                try {
                    await this.refresh(file, this.queued.get(file)!);
                } catch (error) {
                    this.log(`session index: cannot read ${file}: ${(error as Error).message}`);
                }
            }
        } finally {
            this.draining = null;
        }
    }

    /** Bring one journal up to date: unchanged → skip; grown → read the appended bytes; else re-read. */
    private async refresh(file: string, provider: HistoryProvider): Promise<void> {
        let info;
        try {
            info = await stat(file);
        } catch {
            if (this.journals.delete(file)) this.changed();
            return;
        }
        if (!info.isFile()) return;
        const previous = this.journals.get(file);
        if (previous && previous.ino === info.ino && previous.size === info.size && previous.mtimeMs === info.mtimeMs) return;

        const appendable = previous && previous.ino === info.ino && info.size >= previous.offset && !previous.state.invalid;
        const record: JournalRecord = appendable
            ? { ...previous, state: { ...previous.state } }
            : { provider, ino: info.ino, size: 0, mtimeMs: 0, offset: 0, state: { frameCount: 0 } };
        const apply = provider === 'pi' ? applyPiLine : applyClaudeLine;
        record.offset = await readLines(file, record.offset, (line) => apply(record.state, line));
        record.size = info.size;
        record.mtimeMs = info.mtimeMs;
        if (provider === 'claude') record.state.sessionId ??= path.basename(file, '.jsonl');
        this.journals.set(file, record);
        this.changed();
    }

    private changed(): void {
        this.summaries = null;
        this.byId = null;
        this.scheduleCacheWrite();
    }

    // --- projection ---

    private project(): void {
        if (this.summaries) return;
        const byId = new Map<string, AgentSessionSummary>();
        for (const [file, record] of this.journals) {
            const summary = toSummary(file, record);
            if (!summary) continue;
            const other = byId.get(summary.sessionId);
            if (!other || (summary.lastActivityAt ?? 0) > (other.lastActivityAt ?? 0)) byId.set(summary.sessionId, summary);
        }
        this.byId = byId;
        this.summaries = [...byId.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    }

    // --- cache ---

    private async loadCache(): Promise<void> {
        if (!this.cachePath) return;
        let cache: CacheFile;
        try {
            cache = JSON.parse(await readFile(this.cachePath, 'utf8')) as CacheFile;
        } catch {
            return;
        }
        if (cache.version !== CACHE_VERSION || JSON.stringify(cache.roots) !== JSON.stringify(this.roots)) return;
        for (const [file, record] of Object.entries(cache.journals ?? {})) this.journals.set(file, record);
    }

    private scheduleCacheWrite(): void {
        if (!this.cachePath) return;
        this.cacheDirty = true;
        if (this.cacheTimer || this.closed) return;
        this.cacheTimer = setTimeout(() => {
            this.cacheTimer = null;
            void this.writeCache();
        }, CACHE_WRITE_DELAY_MS);
        this.cacheTimer.unref();
    }

    private async writeCache(): Promise<void> {
        if (!this.cachePath) return;
        this.cacheDirty = false;
        const cache: CacheFile = { version: CACHE_VERSION, roots: this.roots, journals: Object.fromEntries(this.journals) };
        const tmp = `${this.cachePath}.${process.pid}.tmp`;
        try {
            await mkdir(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
            await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
            await rename(tmp, this.cachePath);
        } catch (error) {
            this.log(`session index: cannot write cache ${this.cachePath}: ${(error as Error).message}`);
        }
    }
}

/**
 * Read complete lines from `offset` to end of file and return the offset just past the last
 * newline. The file is opened read-only.
 */
async function readLines(file: string, offset: number, onLine: (line: string) => void): Promise<number> {
    const handle = await open(file, 'r');
    try {
        const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let position = offset;
        let consumed = offset;
        let carry: Buffer | null = null;
        for (;;) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            const data: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
            const lastNewline = data.lastIndexOf(0x0a);
            if (lastNewline === -1) {
                carry = Buffer.from(data);
                continue;
            }
            const text = data.toString('utf8', 0, lastNewline);
            for (const line of text.split('\n')) if (line) onLine(line);
            // `data` always starts at `consumed`: the carry is the unconsumed tail of the last read.
            consumed += lastNewline + 1;
            carry = lastNewline + 1 < data.length ? Buffer.from(data.subarray(lastNewline + 1)) : null;
        }
        return consumed;
    } finally {
        await handle.close();
    }
}

// --- provider parsers ---

const PI_TYPE = /^\{"type":"([^"]+)"/;
const PI_TIMESTAMP = /"timestamp":"([^"]+)"/;
const PI_ROLE = /"message":\{"role":"([^"]+)"/;

/**
 * Pi journals: a `session` header, then entries written with `type` first. Message lines can be
 * megabytes of tool output, so they are classified from their prefix and only the first user
 * message is fully parsed (for the fallback title).
 */
function applyPiLine(state: JournalState, line: string): void {
    if (state.invalid) return;
    const type = PI_TYPE.exec(line)?.[1];
    if (state.sessionId === undefined) {
        const header = type === 'session' ? parse(line) : null;
        if (!header || typeof header.id !== 'string') {
            state.invalid = true;
            return;
        }
        state.sessionId = header.id;
        if (typeof header.cwd === 'string' && header.cwd) state.cwd = header.cwd;
        state.startedAt = epoch(header.timestamp);
        return;
    }
    if (type === 'message') {
        const head = line.slice(0, 512);
        let role = PI_ROLE.exec(head)?.[1];
        let at = epoch(PI_TIMESTAMP.exec(head)?.[1]);
        let entry: Record<string, unknown> | null = null;
        if (!role) {
            entry = parse(line);
            const message = entry?.message as Record<string, unknown> | undefined;
            role = typeof message?.role === 'string' ? message.role : undefined;
            at ??= epoch(entry?.timestamp);
        }
        if (role !== 'user' && role !== 'assistant') return;
        if (at !== undefined) state.lastActivityAt = Math.max(state.lastActivityAt ?? 0, at);
        if (role !== 'user') return;
        state.frameCount += 1;
        if (state.firstPrompt === undefined) {
            entry ??= parse(line);
            const text = textOf((entry?.message as Record<string, unknown> | undefined)?.content);
            if (text) state.firstPrompt = text;
        }
        return;
    }
    if (type === 'session_info') {
        const entry = parse(line);
        state.name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : null;
    } else if (type === 'model_change') {
        const entry = parse(line);
        if (typeof entry?.modelId === 'string') {
            state.model = typeof entry.provider === 'string' ? `${entry.provider}/${entry.modelId}` : entry.modelId;
        }
    }
}

/**
 * Claude journals: one JSON object per line, `type` anywhere in the object. A Frame starts at
 * a human prompt: a non-meta user entry that is not a tool result and not a system-originated
 * notification.
 */
function applyClaudeLine(state: JournalState, line: string): void {
    const entry = parse(line);
    if (!entry || entry.isSidechain === true) return;
    if (state.cwd === undefined && typeof entry.cwd === 'string' && entry.cwd) state.cwd = entry.cwd;
    const at = epoch(entry.timestamp);
    if (at !== undefined) state.startedAt = Math.min(state.startedAt ?? at, at);
    switch (entry.type) {
        case 'custom-title':
            state.name = typeof entry.customTitle === 'string' && entry.customTitle.trim() ? entry.customTitle.trim() : null;
            return;
        case 'ai-title':
            if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) state.aiTitle = entry.aiTitle.trim();
            return;
        case 'assistant': {
            const model = (entry.message as Record<string, unknown> | undefined)?.model;
            if (typeof model === 'string' && model && !model.startsWith('<')) state.model = model;
            if (at !== undefined) state.lastActivityAt = Math.max(state.lastActivityAt ?? 0, at);
            return;
        }
        case 'user': {
            if (at !== undefined) state.lastActivityAt = Math.max(state.lastActivityAt ?? 0, at);
            if (entry.isMeta === true) return;
            const origin = entry.origin as { kind?: unknown } | undefined;
            if (origin && origin.kind !== 'human') return;
            const content = (entry.message as Record<string, unknown> | undefined)?.content;
            if (Array.isArray(content) && content.some((part) => (part as { type?: unknown })?.type === 'tool_result')) return;
            state.frameCount += 1;
            if (state.firstPrompt === undefined) {
                const text = textOf(content);
                if (text) state.firstPrompt = text;
            }
            return;
        }
    }
}

function toSummary(file: string, record: JournalRecord): AgentSessionSummary | null {
    const { state } = record;
    if (state.invalid || !state.sessionId || !state.cwd) return null;
    const sessionId = bounded(state.sessionId, 256);
    const cwd = state.cwd.length <= 4096 && !HAS_CONTROL_CHAR.test(state.cwd) ? state.cwd : null;
    if (!sessionId || !cwd) return null;
    const title = bounded(state.name ?? state.aiTitle ?? state.firstPrompt, TITLE_MAX_CHARS);
    const model = bounded(state.model, BOUNDED_MAX_CHARS);
    const startedAt = state.startedAt ?? Math.floor(record.mtimeMs);
    const lastActivityAt = Math.max(state.lastActivityAt ?? startedAt, startedAt);
    return {
        sessionId,
        provider: record.provider,
        state: 'history_only',
        ...(title ? { name: title } : {}),
        cwd,
        extensionConnected: false,
        capabilities: [],
        ...(model ? { model } : {}),
        frameCount: state.frameCount,
        startedAt,
        lastActivityAt,
        ...(file.length <= 4096 ? { sessionFile: file } : {}),
    };
}

function parse(line: string): Record<string, unknown> | null {
    try {
        const value = JSON.parse(line) as unknown;
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function epoch(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
    if (typeof value !== 'string') return undefined;
    const ms = Date.parse(value);
    return Number.isNaN(ms) || ms < 0 ? undefined : ms;
}

function textOf(content: unknown): string | undefined {
    if (typeof content === 'string') return bounded(content, TITLE_MAX_CHARS);
    if (!Array.isArray(content)) return undefined;
    for (const part of content) {
        const p = part as { type?: unknown; text?: unknown };
        if (p?.type === 'text' && typeof p.text === 'string') {
            const text = bounded(p.text, TITLE_MAX_CHARS);
            if (text) return text;
        }
    }
    return undefined;
}

/** Single-line, control-free, non-empty, at most `max` characters — or undefined. */
function bounded(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
