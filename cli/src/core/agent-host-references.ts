/**
 * Typed @ reference resolvers of the XTRM agent host (PRD xtrm-app §36.6, §36.12 item 2; XTRM-570).
 *
 * Serves POST /v1/references/resolve for the kinds the host owns:
 * - `@file:<path>[#L<a>-<b>]` is read from the session's cwd on this machine, never written.
 *   The path must stay inside the cwd: absolute paths outside it, `..` escapes and symlinks that
 *   resolve outside it are rejected. Revision is the content hash.
 * - `@commit:<sha>` is read from local git in the session's cwd (read-only: no fetch, no checkout).
 *   Revision is the full commit id; the diff is always a pointer.
 * - `@session:<name|id>` and `@agent:<name>` come from the live registry and the session index.
 *   They attach context only and never deliver a message (§36.6 rule 4).
 * - `@frame:<session>/<n>` is the request and settled response of a Frame the host retained.
 *
 * Budgets are UTF-8 bytes of the rendered content. Content above a kind's budget becomes an
 * excerpt plus a pointer. A reference that cannot be resolved carries a per-reference error;
 * only a request the host cannot parse at all fails as a whole.
 *
 * Pointers are locators the agent can follow in its own cwd: `@file:<path>#L<a>-<b>` for the full
 * file or range, `git show <sha>` for a commit diff, the session journal (or `@frame:`) for a Frame.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentHostApiV1, AgentSessionSummary, ContextReference, ContextReferenceKind } from '@xtrm/contracts';
import type { AgentHostRegistry, FrameRecord } from './agent-host-registry.js';
import type { SessionIndex } from './agent-host-session-index.js';

export type ReferenceResolveRequest = Extract<AgentHostApiV1, { kind: 'reference_resolve_request' }>;
export type ReferenceResolveResult = Extract<AgentHostApiV1, { kind: 'reference_resolve_result' }>;

const KB = 1024;
/** PRD §36.12 item 2: per-kind budgets in UTF-8 bytes of rendered context. */
export const REFERENCE_BUDGET_BYTES = {
    commit: 4 * KB,
    file: 32 * KB,
    session: 4 * KB,
    agent: 4 * KB,
    frame: 8 * KB,
} as const;
/** PRD §36.12 item 2: total per submit; above it the composer blocks submit. */
export const SUBMIT_BUDGET_BYTES = 96 * KB;
export const MAX_REFERENCES_PER_REQUEST = 64;
/** Larger files are not read at all; the agent can open them itself. */
const MAX_FILE_BYTES = 16 * 1024 * KB;
/** §36.12 item 2: without a requested range, an oversize file is excerpted to its first lines. */
const FILE_EXCERPT_LINES = 200;
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 4 * 1024 * KB;
const BOUNDED_MAX_CHARS = 1024;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]+/g;

const ALL_KINDS: readonly ContextReferenceKind[] = [
    'issue',
    'epic',
    'gh-issue',
    'pr',
    'commit',
    'file',
    'session',
    'agent',
    'frame',
    'artifact',
    'program',
    'chain',
];

/** The request cannot be answered per reference (bad syntax, too many references). */
export class ReferenceRejection extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/** A per-reference failure; becomes `status: unresolved` with `error: code`. */
class Unresolved extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

export interface ReferenceResolverDeps {
    registry: AgentHostRegistry;
    sessionIndex: SessionIndex | null;
}

interface ParsedReference {
    raw: string;
    kind: ContextReferenceKind;
    body: string;
}

interface SessionMatch {
    summary: AgentSessionSummary;
    live: boolean;
    lastSeq?: number;
}

export function parseReference(raw: string): ParsedReference {
    const match = /^@?([a-z][a-z-]*):([\s\S]*)$/.exec(raw);
    const kind = match?.[1] as ContextReferenceKind | undefined;
    if (!match || !kind || !ALL_KINDS.includes(kind)) {
        throw new ReferenceRejection('invalid_reference', `${bounded(raw)} is not a typed reference (@<kind>:<value>)`);
    }
    return { raw, kind, body: match[2] };
}

export async function resolveReferences(
    request: ReferenceResolveRequest,
    deps: ReferenceResolverDeps,
): Promise<ReferenceResolveResult> {
    if (request.references.length > MAX_REFERENCES_PER_REQUEST) {
        throw new ReferenceRejection('too_many_references', `at most ${MAX_REFERENCES_PER_REQUEST} references per request`);
    }
    const parsed = request.references.map(parseReference);
    const references: ContextReference[] = [];
    // Sequential on purpose: file reads and git calls stay bounded to one at a time.
    for (const ref of parsed) {
        try {
            references.push(await resolveOne(ref, request.sessionId, deps));
        } catch (error) {
            if (!(error instanceof Unresolved)) throw error;
            references.push({ kind: ref.kind, raw: ref.raw, status: 'unresolved', error: error.code });
        }
    }
    const totalBytes = references.reduce((sum, ref) => sum + (ref.status === 'resolved' ? (ref.bytes ?? 0) : 0), 0);
    return {
        schema: 'xtrm.agent-host-api.v1',
        kind: 'reference_resolve_result',
        references,
        totalBytes,
        overBudget: totalBytes > SUBMIT_BUDGET_BYTES,
    };
}

async function resolveOne(ref: ParsedReference, sessionId: string | undefined, deps: ReferenceResolverDeps): Promise<ContextReference> {
    switch (ref.kind) {
        case 'file':
            return resolveFile(ref, sessionCwd(sessionId, deps));
        case 'commit':
            return resolveCommit(ref, sessionCwd(sessionId, deps));
        case 'session':
            return resolveSession(ref, findSession(ref.body, deps), deps);
        case 'agent':
            return resolveSession(ref, findAgent(ref.body, deps), deps);
        case 'frame':
            return resolveFrame(ref, deps);
        default:
            // @issue, @epic, @gh-issue, @pr, @artifact, @program, @chain resolve in the app (XTRM-572).
            throw new Unresolved('not_host_resolved');
    }
}

// --- @file ---

async function resolveFile(ref: ParsedReference, cwd: string): Promise<ContextReference> {
    const match = /^([\s\S]*?)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(ref.body)!;
    const requested = match[1];
    if (!requested || requested.includes('\0')) throw new Unresolved('invalid_reference');
    const range = match[2] ? { start: Number(match[2]), end: Number(match[3] ?? match[2]) } : null;
    if (range && (range.start < 1 || range.end < range.start)) throw new Unresolved('invalid_line_range');

    let root: string;
    try {
        root = await realpath(cwd);
    } catch {
        throw new Unresolved('cwd_unavailable');
    }
    // Lexical check first: `..` escapes and absolute paths outside the cwd never touch the disk.
    const target = path.resolve(cwd, requested);
    if (!isInside(path.resolve(cwd), target) && !isInside(root, target)) throw new Unresolved('path_outside_cwd');

    const real = await realpathOrUnresolved(target);
    // Symlinks (in the file or any parent) must resolve inside the cwd as well.
    if (!isInside(root, real)) throw new Unresolved('path_outside_cwd');

    let handle;
    try {
        // O_NONBLOCK: a FIFO in the cwd must not hang the request. O_NOFOLLOW: the last component
        // cannot be swapped for a symlink between realpath and open.
        handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch {
        throw new Unresolved('file_unreadable');
    }
    let buffer: Buffer;
    try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Unresolved('not_a_file');
        if (info.size > MAX_FILE_BYTES) throw new Unresolved('file_too_large');
        // A parent directory may have been swapped for a symlink after realpath: the opened file
        // must still be the one the path resolves to inside the cwd.
        const again = await realpathOrUnresolved(target);
        const check = await stat(again).catch(() => null);
        if (!isInside(root, again) || !check || check.ino !== info.ino || check.dev !== info.dev) {
            throw new Unresolved('path_outside_cwd');
        }
        buffer = await readBounded(handle, MAX_FILE_BYTES);
    } finally {
        await handle.close();
    }

    const relative = path.relative(root, real) || path.basename(real);
    const revision = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
    const base: ContextReference = {
        kind: 'file',
        raw: ref.raw,
        status: 'resolved',
        title: bounded(range ? `${relative}#L${range.start}-${range.end}` : relative),
        revision,
        budgetBytes: REFERENCE_BUDGET_BYTES.file,
    };
    if (buffer.includes(0)) {
        // Binary content is never inlined; the agent gets the revision and a pointer.
        return { ...base, title: bounded(relative), bytes: 0, truncated: true, pointer: bounded(`@file:${relative}`) };
    }

    const lines = splitLines(buffer.toString('utf8'));
    let start = 1;
    let end = lines.length;
    if (range) {
        if (range.start > lines.length) throw new Unresolved('line_out_of_range');
        start = range.start;
        end = Math.min(range.end, lines.length);
    }
    const selected = lines.slice(start - 1, end).join('\n');
    if (Buffer.byteLength(selected, 'utf8') <= REFERENCE_BUDGET_BYTES.file) {
        return { ...base, content: selected, bytes: Buffer.byteLength(selected, 'utf8'), truncated: false };
    }
    const excerptSource = range ? selected : lines.slice(0, FILE_EXCERPT_LINES).join('\n');
    const content = truncateUtf8(excerptSource, REFERENCE_BUDGET_BYTES.file);
    return {
        ...base,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        truncated: true,
        pointer: bounded(`@file:${relative}#L${start}-${end}`),
    };
}

async function realpathOrUnresolved(target: string): Promise<string> {
    try {
        return await realpath(target);
    } catch (error) {
        throw new Unresolved((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'file_not_found' : 'file_unreadable');
    }
}

async function readBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
        const chunk = Buffer.alloc(Math.min(1024 * KB, maxBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        // The file grew past the limit after the size check.
        if (total > maxBytes) throw new Unresolved('file_too_large');
        chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
}

function splitLines(text: string): string[] {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
}

function isInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// --- @commit ---

async function resolveCommit(ref: ParsedReference, cwd: string): Promise<ContextReference> {
    // Hex only: nothing that git could read as an option, a range or a ref expression.
    if (!/^[0-9a-f]{4,64}$/i.test(ref.body)) throw new Unresolved('invalid_reference');
    const full = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref.body}^{commit}`])).trim();
    if (!/^[0-9a-f]{40,64}$/.test(full)) throw new Unresolved('commit_not_found');
    const header = await git(cwd, ['show', '-s', '--no-color', '--format=%an <%ae>%n%aI%n%B', full]);
    const [author = '', date = '', ...messageLines] = header.split('\n');
    const message = messageLines.join('\n').trimEnd();
    const statText = (await git(cwd, ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--format=', full])).trim();
    const rendered = `commit ${full}\nAuthor: ${author}\nDate:   ${date}\n\n${message}\n${statText ? `\n${statText}\n` : ''}`;
    const fits = Buffer.byteLength(rendered, 'utf8') <= REFERENCE_BUDGET_BYTES.commit;
    const content = fits ? rendered : truncateUtf8(rendered, REFERENCE_BUDGET_BYTES.commit);
    return {
        kind: 'commit',
        raw: ref.raw,
        status: 'resolved',
        title: bounded(message.split('\n')[0] || full),
        revision: full,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        budgetBytes: REFERENCE_BUDGET_BYTES.commit,
        truncated: !fits,
        // §36.12 item 2: the diff is always by pointer.
        pointer: `git show ${full}`,
    };
}

function git(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
            {
                cwd,
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: GIT_MAX_BUFFER,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0' },
            },
            (error, stdout, stderr) => {
                if (!error) return resolve(stdout);
                if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !stderr) return reject(new Unresolved('git_unavailable'));
                if (/not a git repository/i.test(stderr)) return reject(new Unresolved('not_a_git_repository'));
                reject(new Unresolved('commit_not_found'));
            },
        );
    });
}

// --- @session, @agent ---

function sessionCwd(sessionId: string | undefined, deps: ReferenceResolverDeps): string {
    if (!sessionId) throw new Unresolved('session_required');
    const cwd = deps.registry.detail(sessionId)?.identity?.cwd ?? deps.sessionIndex?.get(sessionId)?.cwd;
    if (!cwd) throw new Unresolved('session_not_found');
    return cwd;
}

function findSession(key: string, deps: ReferenceResolverDeps): SessionMatch {
    if (!key) throw new Unresolved('invalid_reference');
    const detail = deps.registry.detail(key);
    if (detail) return { summary: detail.session, live: true, lastSeq: detail.lastSeq };
    const history = deps.sessionIndex?.get(key);
    if (history) return { summary: history, live: false };

    const live = deps.registry.list().filter((s) => s.name === key);
    if (live.length > 1) throw new Unresolved('ambiguous_reference');
    if (live.length === 1) return { summary: live[0], live: true, lastSeq: deps.registry.detail(live[0].sessionId)?.lastSeq };
    // History names repeat across runs: the most recent one is meant (index lists newest first).
    const named = deps.sessionIndex?.list().find((s) => s.name === key);
    if (named) return { summary: named, live: false };
    throw new Unresolved('session_not_found');
}

/** The agent identity's current live session: by session name, then role; most recent activity wins. */
function findAgent(name: string, deps: ReferenceResolverDeps): SessionMatch {
    if (!name) throw new Unresolved('invalid_reference');
    const live = deps.registry.list();
    const byName = live.filter((s) => s.name === name);
    const candidates = byName.length > 0 ? byName : live.filter((s) => s.role === name);
    if (candidates.length === 0) throw new Unresolved('agent_not_live');
    const summary = candidates.reduce((a, b) => ((b.lastActivityAt ?? 0) > (a.lastActivityAt ?? 0) ? b : a));
    return { summary, live: true, lastSeq: deps.registry.detail(summary.sessionId)?.lastSeq };
}

function resolveSession(ref: ParsedReference, match: SessionMatch, deps: ReferenceResolverDeps): ContextReference {
    const kind = ref.kind as 'session' | 'agent';
    const budget = REFERENCE_BUDGET_BYTES[kind];
    const s = match.summary;
    const lines = [
        `session ${s.sessionId}${s.name ? ` "${s.name}"` : ''}`,
        `provider: ${s.provider}  state: ${s.state}`,
        `cwd: ${s.cwd}`,
        ...(s.branch ? [`branch: ${s.branch}`] : []),
        ...(s.role ? [`role: ${s.role}`] : []),
        ...(s.workItem ? [`work item: ${[s.workItem.system, s.workItem.project, s.workItem.ref].filter(Boolean).join(' ')}`] : []),
        `frames: ${s.frameCount ?? 0}`,
    ];
    let header = `${lines.join('\n')}\n`;
    const settled = match.live ? [...(deps.registry.frames(s.sessionId) ?? [])].reverse().find((f) => f.settled) : undefined;
    let content = header;
    let truncated = false;
    let pointer: string | undefined;
    if (settled?.response !== undefined) {
        header += `\nlast settled response (frame ${settled.n}):\n`;
        const room = budget - Buffer.byteLength(header, 'utf8');
        const response = truncateUtf8(settled.response, Math.max(0, room));
        truncated = response.length < settled.response.length || settled.responseBytes > Buffer.byteLength(settled.response, 'utf8');
        content = header + response;
        if (truncated) pointer = s.sessionFile ?? `@frame:${s.sessionId}/${settled.n}`;
    }
    if (Buffer.byteLength(content, 'utf8') > budget) {
        content = truncateUtf8(content, budget);
        truncated = true;
    }
    return {
        kind,
        raw: ref.raw,
        status: 'resolved',
        title: bounded(s.name ?? s.sessionId),
        revision: match.live && match.lastSeq !== undefined ? `seq:${match.lastSeq}` : `activity:${s.lastActivityAt ?? 0}`,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        budgetBytes: budget,
        truncated,
        ...(pointer ? { pointer: bounded(pointer) } : {}),
    };
}

// --- @frame ---

function resolveFrame(ref: ParsedReference, deps: ReferenceResolverDeps): ContextReference {
    const slash = ref.body.lastIndexOf('/');
    const n = Number(ref.body.slice(slash + 1));
    if (slash <= 0 || !Number.isInteger(n) || n < 1) throw new Unresolved('invalid_reference');
    const match = findSession(ref.body.slice(0, slash), deps);
    const s = match.summary;
    if (n > (s.frameCount ?? 0)) throw new Unresolved('frame_not_found');
    const record: FrameRecord | undefined = match.live ? deps.registry.frames(s.sessionId)?.find((f) => f.n === n) : undefined;
    // The host keeps the last Frames of live sessions only; history Frames stay in the journal.
    if (!record) throw new Unresolved('frame_not_retained');

    const budget = REFERENCE_BUDGET_BYTES.frame;
    const head = `frame ${n} of session ${s.sessionId} (${record.settled ? 'settled' : 'open'})\nrequest:\n`;
    const request = truncateUtf8(record.request ?? '(no request text reported)', Math.max(0, budget - Buffer.byteLength(head, 'utf8')));
    const middle = `\n\nresponse:\n`;
    const responseText = record.response ?? (record.settled ? '(no response text reported)' : '(not settled)');
    const prefix = head + request + middle;
    const room = budget - Buffer.byteLength(prefix, 'utf8');
    const response = room > 0 ? truncateUtf8(responseText, room) : '';
    const content = room > 0 ? prefix + response : truncateUtf8(prefix, budget);
    const truncated =
        Buffer.byteLength(content, 'utf8') < Buffer.byteLength(head + (record.request ?? '') + middle + responseText, 'utf8') ||
        record.requestBytes > Buffer.byteLength(record.request ?? '', 'utf8') ||
        record.responseBytes > Buffer.byteLength(record.response ?? '', 'utf8');
    return {
        kind: 'frame',
        raw: ref.raw,
        status: 'resolved',
        title: bounded(`frame ${n} · ${s.name ?? s.sessionId}`),
        revision: `seq:${record.seq}`,
        content,
        bytes: Buffer.byteLength(content, 'utf8'),
        budgetBytes: budget,
        truncated,
        ...(truncated ? { pointer: bounded(s.sessionFile ?? `@frame:${s.sessionId}/${n}`) } : {}),
    };
}

// --- helpers ---

/**
 * At most `maxBytes` UTF-8 bytes of `text`, never splitting a character; ends at a line boundary
 * when one falls in the last quarter of the cut.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    const buffer = Buffer.from(text, 'utf8');
    let end = maxBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
    const cut = buffer.subarray(0, end).toString('utf8');
    const newline = cut.lastIndexOf('\n');
    return newline >= 0 && newline >= cut.length * 0.75 ? cut.slice(0, newline + 1) : cut;
}

/** A contract boundedString: no control characters, at most 1024 characters, never empty. */
function bounded(value: string): string {
    return value.replace(CONTROL_CHARS, ' ').slice(0, BOUNDED_MAX_CHARS) || '?';
}
