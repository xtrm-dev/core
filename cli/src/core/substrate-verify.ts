/**
 * A9 preservation verifier (xtrm-6qu.9 core slice, bead xtrm-a2oup).
 *
 * Compares a `bd export` JSONL file (parsed directly — each line already
 * embeds labels/dependencies/comments, so no per-ID board queries) against
 * the Substrate state for one project (single bulk `sb export project`
 * snapshot, never per-ID `issue show` / `journal show`).
 *
 * Fail-closed on every mismatch path: the result carries `ok: false` plus
 * explicit errors, and `preservationExitCode` maps that to a nonzero exit.
 * The verifier itself never writes markers, receipts, or the board.
 *
 * Interface assumptions for xtrm-side .9.1 receipt coordination (explicit):
 * 1. Canonical receipt schema is owned xtrm-side (.9.1 lane).
 *    `PreservationResult` here is local verifier output, NOT the receipt.
 * 2. Read surfaces used: bulk `sb export project --project <id> --json`
 *    only (chosen `sb issue` read set: none — the project snapshot already
 *    carries issues[].aliases[] plus top-level edges[]). Documented per the
 *    pc7hs interface contract (`sb issue` read verbs TBD by implementer).
 * 3. Notes/comments substrate counts default to 0: `sb import beads`
 *    (0.1.0) takes no notes/comments intake and the project snapshot
 *    excludes the journal, while per-ref `journal show` is excluded by the
 *    no-per-ID rule. A future bulk notes surface plugs into
 *    `substrateNotes` / `substrateComments`; until then any export with
 *    notes/comments fails closed here by design.
 * 4. Edge kind/orientation mapping mirrors `sb` 0.1.0 import behavior
 *    exactly: parent-child => parent_child from dependency to dependent,
 *    blocks => blocks from prerequisite to dependent, discovered-from =>
 *    discovered_from, supersedes => supersedes, relates-to / validates /
 *    unknown => relates_to from dependent to dependency.
 * 5. `sb project create --prefix` / `project link` names are confirmed
 *    existing (used only by live-evidence setup, not by this module).
 */

import fs from 'fs-extra';

import { defaultSbRunner, parseSbEnvelope, type SbRunner } from './substrate.js';

export interface BeadsExportEdge {
    issue_id: string;
    depends_on_id: string;
    type: string;
}

export interface BeadsExportSummary {
    /** Unique issue ids in first-seen order. */
    issueIds: string[];
    /** Every embedded dependencies[] entry, in file order. */
    edges: BeadsExportEdge[];
    /** Issues carrying a non-empty `notes` string (at most one per issue). */
    notesTotal: number;
    /** Total `comments[]` entries across all lines. */
    commentsTotal: number;
    /** Parsed record count (lines); exceeds issueIds when ids duplicate. */
    records: number;
}

export interface SubstrateAliasEntry {
    alias: string;
    issueId: string;
}

export interface SubstrateEdge {
    from: string;
    to: string;
    kind: string;
}

export interface SubstrateSummary {
    aliasEntries: SubstrateAliasEntry[];
    issueIds: string[];
    edges: SubstrateEdge[];
    /** No bulk surface exists yet (see header); defaults to 0. */
    notesTotal?: number;
    /** No bulk surface exists yet (see header); defaults to 0. */
    commentsTotal?: number;
}

export interface PreservationCounts {
    exportIssues: number;
    substrateIssues: number;
    substrateAliases: number;
    exportEdges: number;
    substrateEdges: number;
    exportNotes: number;
    substrateNotes: number;
    exportComments: number;
    substrateComments: number;
}

export interface PreservationResult {
    ok: boolean;
    counts: PreservationCounts;
    errors: string[];
    missingAliases: string[];
    orphanAliases: string[];
    collisions: string[];
    missingEdges: string[];
    extraEdges: string[];
}

/** Map an export edge type to its Substrate kind (mirrors sb 0.1.0). */
export function mapExportEdgeKind(type: string): string {
    switch (type) {
        case 'parent-child': return 'parent_child';
        case 'blocks': return 'blocks';
        case 'discovered-from': return 'discovered_from';
        case 'supersedes': return 'supersedes';
        case 'relates-to':
        case 'validates':
            return 'relates_to';
        default: return 'relates_to';
    }
}

function edgeKey(from: string, to: string, kind: string): string {
    return `${from}\u0000${to}\u0000${kind}`;
}

function edgeLabel(from: string, to: string, kind: string): string {
    return `${from} -> ${to} [${kind}]`;
}

/** Parse export text without touching the board. Never throws. */
export function parseBeadsExportText(text: string): { ok: boolean; summary?: BeadsExportSummary; error?: string } {
    const issueIds: string[] = [];
    const seen = new Set<string>();
    const duplicates: string[] = [];
    const edges: BeadsExportEdge[] = [];
    let notesTotal = 0;
    let commentsTotal = 0;
    let records = 0;
    const lines = text.split('\n');
    for (const [index, raw] of lines.entries()) {
        if (!raw.trim()) continue;
        let record: Record<string, unknown>;
        try {
            record = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return { ok: false, error: `export line ${index + 1}: unparseable JSON` };
        }
        if (!record || typeof record !== 'object') return { ok: false, error: `export line ${index + 1}: not an object` };
        const id = record.id;
        if (typeof id !== 'string' || !id.trim()) return { ok: false, error: `export line ${index + 1}: missing issue id` };
        records += 1;
        if (seen.has(id)) {
            if (!duplicates.includes(id)) duplicates.push(id);
        } else {
            seen.add(id);
            issueIds.push(id);
        }
        const deps = record.dependencies;
        if (deps !== undefined) {
            if (!Array.isArray(deps)) return { ok: false, error: `export line ${index + 1} (${id}): dependencies is not an array` };
            for (const entry of deps) {
                const edge = entry as Partial<BeadsExportEdge>;
                if (!edge || typeof edge.issue_id !== 'string' || typeof edge.depends_on_id !== 'string' || typeof edge.type !== 'string') {
                    return { ok: false, error: `export line ${index + 1} (${id}): malformed dependency entry` };
                }
                edges.push({ issue_id: edge.issue_id, depends_on_id: edge.depends_on_id, type: edge.type });
            }
        }
        if (typeof record.notes === 'string' && record.notes.trim()) notesTotal += 1;
        if (record.comments !== undefined) {
            if (!Array.isArray(record.comments)) return { ok: false, error: `export line ${index + 1} (${id}): comments is not an array` };
            commentsTotal += record.comments.length;
        }
    }
    if (duplicates.length > 0) {
        return { ok: false, error: `export has duplicate issue ids: ${[...duplicates].sort().join(', ')}` };
    }
    return { ok: true, summary: { issueIds, edges, notesTotal, commentsTotal, records } };
}

/** Read and parse an export file. Never throws. */
export function parseBeadsExportFile(filePath: string): { ok: boolean; summary?: BeadsExportSummary; error?: string } {
    try {
        return parseBeadsExportText(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return { ok: false, error: `cannot read export file: ${err instanceof Error ? err.message : String(err)}` };
    }
}

/**
 * Pure preservation check: export summary vs substrate summary.
 * Deterministic — same inputs always yield byte-identical JSON.
 */
export function verifyPreservation(exportSummary: BeadsExportSummary, substrate: SubstrateSummary): PreservationResult {
    const errors: string[] = [];
    const missingAliases: string[] = [];
    const orphanAliases: string[] = [];
    const collisions: string[] = [];
    const missingEdges: string[] = [];
    const extraEdges: string[] = [];
    const substrateNotes = substrate.notesTotal ?? 0;
    const substrateComments = substrate.commentsTotal ?? 0;

    const exportSet = new Set(exportSummary.issueIds);
    const aliasByAlias = new Map<string, string[]>();
    for (const entry of substrate.aliasEntries) {
        const list = aliasByAlias.get(entry.alias) ?? [];
        list.push(entry.issueId);
        aliasByAlias.set(entry.alias, list);
    }
    for (const [alias, issueIds] of [...aliasByAlias.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (issueIds.length > 1) collisions.push(`${alias} -> ${[...new Set(issueIds)].sort().join(', ')}`);
        if (!exportSet.has(alias)) orphanAliases.push(alias);
    }
    const issueBySubstrate = new Map<string, string[]>();
    for (const entry of substrate.aliasEntries) {
        const list = issueBySubstrate.get(entry.issueId) ?? [];
        list.push(entry.alias);
        issueBySubstrate.set(entry.issueId, list);
    }
    for (const [issueId, aliases] of [...issueBySubstrate.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (new Set(aliases).size > 1) collisions.push(`${issueId} <- ${[...new Set(aliases)].sort().join(', ')}`);
    }
    for (const id of exportSummary.issueIds) {
        const mapped = aliasByAlias.get(id);
        if (!mapped || mapped.length === 0) missingAliases.push(id);
    }
    const substrateIssueSet = new Set(substrate.issueIds);
    for (const entry of substrate.aliasEntries) {
        if (!substrateIssueSet.has(entry.issueId)) orphanAliases.push(`${entry.alias} -> missing issue ${entry.issueId}`);
    }
    const beadsAliases = new Set(substrate.aliasEntries.map((entry) => entry.alias));
    for (const issueId of substrate.issueIds) {
        const aliases = issueBySubstrate.get(issueId) ?? [];
        if (!aliases.some((alias) => exportSet.has(alias) && beadsAliases.has(alias))) {
            orphanAliases.push(`issue without export alias: ${issueId}`);
        }
    }

    const aliasToIssue = new Map<string, string>();
    for (const entry of substrate.aliasEntries) {
        if (!aliasToIssue.has(entry.alias)) aliasToIssue.set(entry.alias, entry.issueId);
    }
    const expectedCounts = new Map<string, number>();
    const expectedLabel = new Map<string, string>();
    for (const edge of exportSummary.edges) {
        const fromIssue = aliasToIssue.get(edge.issue_id);
        const toIssue = aliasToIssue.get(edge.depends_on_id);
        if (!fromIssue || !toIssue) {
            missingEdges.push(`${edge.issue_id} -> ${edge.depends_on_id} [${edge.type}]: endpoint not imported`);
            continue;
        }
        const kind = mapExportEdgeKind(edge.type);
        const from = (kind === 'parent_child' || kind === 'blocks') ? toIssue : fromIssue;
        const to = (kind === 'parent_child' || kind === 'blocks') ? fromIssue : toIssue;
        const key = edgeKey(from, to, kind);
        expectedCounts.set(key, (expectedCounts.get(key) ?? 0) + 1);
        expectedLabel.set(key, edgeLabel(from, to, kind));
    }
    const actualCounts = new Map<string, number>();
    const actualLabel = new Map<string, string>();
    for (const edge of substrate.edges) {
        const key = edgeKey(edge.from, edge.to, edge.kind);
        actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
        actualLabel.set(key, edgeLabel(edge.from, edge.to, edge.kind));
    }
    for (const key of [...new Set([...expectedCounts.keys(), ...actualCounts.keys()])].sort()) {
        const want = expectedCounts.get(key) ?? 0;
        const got = actualCounts.get(key) ?? 0;
        if (want > got) {
            for (let i = 0; i < want - got; i += 1) missingEdges.push(expectedLabel.get(key) as string);
        } else if (got > want) {
            for (let i = 0; i < got - want; i += 1) extraEdges.push(actualLabel.get(key) as string);
        }
    }

    if (missingAliases.length > 0) errors.push(`missing aliases for ${missingAliases.length} export issue(s): ${[...missingAliases].sort().slice(0, 5).join(', ')}${missingAliases.length > 5 ? '…' : ''}`);
    if (orphanAliases.length > 0) errors.push(`orphan substrate entries: ${orphanAliases.length} (${[...orphanAliases].sort().slice(0, 3).join('; ')}${orphanAliases.length > 3 ? '; …' : ''})`);
    if (collisions.length > 0) errors.push(`alias collisions: ${collisions.length} (${[...collisions].sort().slice(0, 3).join('; ')}${collisions.length > 3 ? '; …' : ''})`);
    if (missingEdges.length > 0) errors.push(`missing substrate edges: ${missingEdges.length} of ${exportSummary.edges.length} export edges`);
    if (extraEdges.length > 0) errors.push(`extra substrate edges: ${extraEdges.length} (export has ${exportSummary.edges.length})`);
    if (exportSummary.notesTotal !== substrateNotes) errors.push(`notes mismatch: export ${exportSummary.notesTotal} vs substrate ${substrateNotes}`);
    if (exportSummary.commentsTotal !== substrateComments) errors.push(`comments mismatch: export ${exportSummary.commentsTotal} vs substrate ${substrateComments}`);

    const ok = errors.length === 0
        && missingAliases.length === 0
        && orphanAliases.length === 0
        && collisions.length === 0
        && missingEdges.length === 0
        && extraEdges.length === 0;
    return {
        ok,
        counts: {
            exportIssues: exportSummary.records,
            substrateIssues: substrate.issueIds.length,
            substrateAliases: substrate.aliasEntries.length,
            exportEdges: exportSummary.edges.length,
            substrateEdges: substrate.edges.length,
            exportNotes: exportSummary.notesTotal,
            substrateNotes,
            exportComments: exportSummary.commentsTotal,
            substrateComments,
        },
        errors,
        missingAliases: [...missingAliases].sort(),
        orphanAliases: [...orphanAliases].sort(),
        collisions: [...collisions].sort(),
        missingEdges: [...missingEdges].sort(),
        extraEdges: [...extraEdges].sort(),
    };
}

/** Exit mapping for CLI wiring: 0 only when the receipt marks success. */
export function preservationExitCode(result: PreservationResult): number {
    return result.ok ? 0 : 1;
}

interface ProjectSnapshotIssue {
    issue?: { id?: unknown };
    aliases?: Array<{ alias?: unknown; kind?: unknown }>;
}

interface ProjectSnapshotEdge {
    fromIssue?: unknown;
    from?: unknown;
    toIssue?: unknown;
    to?: unknown;
    kind?: unknown;
}

/**
 * Collect the substrate summary with one bulk snapshot call.
 * Never runs per-ID verbs. Never throws.
 */
export function collectSubstrateSummary(
    projectId: string,
    run: SbRunner,
    opts: { notesTotal?: number; commentsTotal?: number } = {},
): { ok: boolean; summary?: SubstrateSummary; error?: string; raw?: string } {
    let result: ReturnType<SbRunner>;
    try {
        result = run(['export', 'project', '--project', projectId, '--json']);
    } catch (err) {
        return { ok: false, error: `sb export project failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const raw = String(result.stdout ?? '');
    if (result.status !== 0) {
        return { ok: false, error: (result.stderr || result.error || `sb export project exited ${result.status}`).trim(), raw };
    }
    const payload = parseSbEnvelope<{ issues?: unknown; edges?: unknown }>(raw);
    const data = payload && typeof payload.data === 'object' ? payload.data : null;
    if (!payload || payload.ok !== true || !data || !Array.isArray(data.issues) || !Array.isArray(data.edges)) {
        return { ok: false, error: 'sb export project emitted an unexpected shape', raw };
    }
    const aliasEntries: SubstrateAliasEntry[] = [];
    const issueIds: string[] = [];
    for (const entry of data.issues as ProjectSnapshotIssue[]) {
        const id = entry?.issue?.id;
        if (typeof id !== 'string' || !id) return { ok: false, error: 'sb export project has an issue without an id', raw };
        issueIds.push(id);
        for (const alias of entry.aliases ?? []) {
            if (alias?.kind !== 'beads' || typeof alias.alias !== 'string' || !alias.alias) continue;
            aliasEntries.push({ alias: alias.alias, issueId: id });
        }
    }
    const edges: SubstrateEdge[] = [];
    for (const entry of data.edges as ProjectSnapshotEdge[]) {
        const from = entry.fromIssue ?? entry.from;
        const to = entry.toIssue ?? entry.to;
        if (typeof from !== 'string' || typeof to !== 'string' || typeof entry.kind !== 'string') {
            return { ok: false, error: 'sb export project has a malformed edge', raw };
        }
        edges.push({ from, to, kind: entry.kind });
    }
    return { ok: true, summary: { aliasEntries, issueIds, edges, notesTotal: opts.notesTotal ?? 0, commentsTotal: opts.commentsTotal ?? 0 }, raw };
}

/**
 * End-to-end file-vs-project check. Fail-closed; never throws.
 * `opts.run` defaults to the real `sb` runner; tests inject a stub.
 */
export function verifyBeadsExportAgainstProject(
    exportPath: string,
    projectId: string,
    opts: { run?: SbRunner; notesTotal?: number; commentsTotal?: number } = {},
): PreservationResult {
    const fail = (error: string): PreservationResult => ({
        ok: false,
        counts: {
            exportIssues: 0, substrateIssues: 0, substrateAliases: 0, exportEdges: 0,
            substrateEdges: 0, exportNotes: 0, substrateNotes: opts.notesTotal ?? 0,
            exportComments: 0, substrateComments: opts.commentsTotal ?? 0,
        },
        errors: [error],
        missingAliases: [],
        orphanAliases: [],
        collisions: [],
        missingEdges: [],
        extraEdges: [],
    });
    const parsed = parseBeadsExportFile(exportPath);
    if (!parsed.ok || !parsed.summary) return fail(parsed.error ?? 'export parse failed');
    let collected: ReturnType<typeof collectSubstrateSummary>;
    try {
        collected = collectSubstrateSummary(projectId, opts.run ?? defaultSbRunner, { notesTotal: opts.notesTotal, commentsTotal: opts.commentsTotal });
    } catch (err) {
        return fail(`substrate collection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!collected.ok || !collected.summary) return fail(collected.error ?? 'substrate collection failed');
    return verifyPreservation(parsed.summary, collected.summary);
}
