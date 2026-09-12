import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    collectSubstrateSummary,
    mapExportEdgeKind,
    parseBeadsExportFile,
    parseBeadsExportText,
    preservationExitCode,
    verifyBeadsExportAgainstProject,
    verifyPreservation,
    type BeadsExportSummary,
    type SubstrateSummary,
} from '../core/substrate-verify.js';
import type { SbRunner } from '../core/substrate.js';

// A9 preservation verifier (bead xtrm-a2oup): export-parse-only expectations
// vs bulk substrate snapshots. No test ever requires a real `sb` binary;
// the one collector test asserts the bulk-only call shape via a stub.

let tmpDir = '';

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-verify-test-'));
});

afterEach(() => {
    fs.removeSync(tmpDir);
});

const EXPORT_TEXT = [
    '{"id":"bd-a","title":"A","status":"open","dependencies":[{"issue_id":"bd-a","depends_on_id":"bd-b","type":"blocks"}]}',
    '{"id":"bd-b","title":"B","status":"open"}',
    '{"id":"bd-c","title":"C","status":"closed","notes":"a note body","comments":[{"id":"c1","issue_id":"bd-c","author":"t","text":"hi"}]}',
].join('\n');

function exportSummary(): BeadsExportSummary {
    const parsed = parseBeadsExportText(EXPORT_TEXT);
    expect(parsed.ok).toBe(true);
    return parsed.summary as BeadsExportSummary;
}

function substrateSummary(): SubstrateSummary {
    return {
        // blocks {bd-a depends-on bd-b} orients prerequisite -> dependent.
        aliasEntries: [
            { alias: 'bd-a', issueId: 'iss-a' },
            { alias: 'bd-b', issueId: 'iss-b' },
            { alias: 'bd-c', issueId: 'iss-c' },
        ],
        issueIds: ['iss-a', 'iss-b', 'iss-c'],
        edges: [{ from: 'iss-b', to: 'iss-a', kind: 'blocks' }],
        notesTotal: 1,
        commentsTotal: 1,
    };
}

describe('parseBeadsExportText (export-embedded lines are authoritative)', () => {
    it('parses ids, embedded dependencies, notes, and comments directly', () => {
        const summary = exportSummary();
        expect(summary.issueIds).toEqual(['bd-a', 'bd-b', 'bd-c']);
        expect(summary.records).toBe(3);
        expect(summary.edges).toEqual([{ issue_id: 'bd-a', depends_on_id: 'bd-b', type: 'blocks' }]);
        expect(summary.notesTotal).toBe(1);
        expect(summary.commentsTotal).toBe(1);
    });

    it('fails closed on unparseable JSON without throwing', () => {
        const parsed = parseBeadsExportText('{"id":"bd-a"}\nnot json\n');
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatch(/line 2/);
    });

    it('fails closed on duplicate issue ids', () => {
        const parsed = parseBeadsExportText('{"id":"bd-a"}\n{"id":"bd-a"}\n');
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatch(/duplicate/);
    });

    it('fails closed on malformed dependency entries', () => {
        const parsed = parseBeadsExportText('{"id":"bd-a","dependencies":[{"issue_id":"bd-a"}]}\n');
        expect(parsed.ok).toBe(false);
        expect(parsed.error).toMatch(/malformed dependency/);
    });

    it('reads the export file without per-ID board queries', () => {
        const file = path.join(tmpDir, 'export.jsonl');
        fs.writeFileSync(file, `${EXPORT_TEXT}\n`);
        const parsed = parseBeadsExportFile(file);
        expect(parsed.ok).toBe(true);
        expect(parsed.summary?.records).toBe(3);
        expect(parseBeadsExportFile(path.join(tmpDir, 'missing.jsonl')).ok).toBe(false);
    });
});

describe('verifyPreservation (alias map complete, no orphans, no collisions)', () => {
    it('passes on exact reconciliation with exit zero', () => {
        const result = verifyPreservation(exportSummary(), substrateSummary());
        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
        expect(preservationExitCode(result)).toBe(0);
        expect(result.counts).toMatchObject({
            exportIssues: 3, substrateIssues: 3, substrateAliases: 3,
            exportEdges: 1, substrateEdges: 1, exportNotes: 1, substrateNotes: 1,
            exportComments: 1, substrateComments: 1,
        });
    });

    it('fails closed on a missing alias with nonzero exit', () => {
        const substrate = substrateSummary();
        substrate.aliasEntries = substrate.aliasEntries.filter((entry) => entry.alias !== 'bd-c');
        substrate.issueIds = ['iss-a', 'iss-b'];
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(preservationExitCode(result)).toBe(1);
        expect(result.missingAliases).toEqual(['bd-c']);
        expect(result.errors.some((error) => error.includes('missing aliases'))).toBe(true);
    });

    it('fails closed on orphan substrate aliases and issues', () => {
        const substrate = substrateSummary();
        substrate.aliasEntries.push({ alias: 'bd-z', issueId: 'iss-z' });
        substrate.issueIds.push('iss-z');
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(result.orphanAliases.length).toBeGreaterThan(0);
    });

    it('fails closed when a substrate issue has no export alias', () => {
        const substrate = substrateSummary();
        substrate.issueIds.push('iss-extra');
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(result.orphanAliases.some((entry) => entry.includes('iss-extra'))).toBe(true);
    });

    it('fails closed on alias collisions', () => {
        const substrate = substrateSummary();
        substrate.aliasEntries.push({ alias: 'bd-a', issueId: 'iss-b' });
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(result.collisions.length).toBeGreaterThan(0);
    });
});

describe('verifyPreservation (edges match exactly: count + endpoints)', () => {
    it('fails closed on edge count mismatch', () => {
        const substrate = substrateSummary();
        substrate.edges = [];
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(result.missingEdges).toHaveLength(1);
    });

    it('fails closed on edge endpoint mismatch', () => {
        const substrate = substrateSummary();
        substrate.edges = [{ from: 'iss-b', to: 'iss-c', kind: 'blocks' }];
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(result.missingEdges).toHaveLength(1);
        expect(result.extraEdges).toHaveLength(1);
    });

    it('fails closed on extra substrate edges (e.g. duplicated re-import)', () => {
        const substrate = substrateSummary();
        substrate.edges.push({ from: 'iss-b', to: 'iss-a', kind: 'blocks' });
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(result.extraEdges).toHaveLength(1);
    });

    it('maps unknown export edge types to relates_to like sb 0.1.0', () => {
        expect(mapExportEdgeKind('parent-child')).toBe('parent_child');
        expect(mapExportEdgeKind('blocks')).toBe('blocks');
        expect(mapExportEdgeKind('mystery-kind')).toBe('relates_to');
        const parsed = parseBeadsExportText('{"id":"bd-a","dependencies":[{"issue_id":"bd-a","depends_on_id":"bd-b","type":"mystery-kind"}]}\n{"id":"bd-b"}\n');
        const substrate: SubstrateSummary = {
            aliasEntries: [{ alias: 'bd-a', issueId: 'iss-a' }, { alias: 'bd-b', issueId: 'iss-b' }],
            issueIds: ['iss-a', 'iss-b'],
            edges: [{ from: 'iss-a', to: 'iss-b', kind: 'relates_to' }],
        };
        expect(verifyPreservation(parsed.summary as BeadsExportSummary, substrate).ok).toBe(true);
    });
});

describe('verifyPreservation (notes/comments intake exact)', () => {
    it('fails closed when export notes/comments have no substrate intake', () => {
        // Documents the live sb 0.1.0 gap: import takes no notes/comments,
        // so any export carrying them must fail closed until A9 intake lands.
        const substrate = substrateSummary();
        substrate.notesTotal = 0;
        substrate.commentsTotal = 0;
        const result = verifyPreservation(exportSummary(), substrate);
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.includes('notes mismatch'))).toBe(true);
        expect(result.errors.some((error) => error.includes('comments mismatch'))).toBe(true);
    });
});

describe('verifyPreservation (idempotent rerun)', () => {
    it('returns byte-identical JSON on rerun with zero side effects', () => {
        const first = verifyPreservation(exportSummary(), substrateSummary());
        const second = verifyPreservation(exportSummary(), substrateSummary());
        expect(second).toEqual(first);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(first.ok).toBe(true);
    });
});

describe('collectSubstrateSummary (one bulk snapshot, never per-ID verbs)', () => {
    function stubExportProject(snapshot: unknown, status = 0): { run: SbRunner; calls: string[][] } {
        const calls: string[][] = [];
        const run: SbRunner = (args) => {
            calls.push(args);
            return { status, stdout: JSON.stringify({ schema: 'substrate-cli/v1', command: 'export.project', ok: true, data: snapshot }), stderr: '' };
        };
        return { run, calls };
    }

    it('collects aliases and edges from a single bulk call', () => {
        const { run, calls } = stubExportProject({
            issues: [
                { issue: { id: 'iss-a' }, aliases: [{ alias: 'bd-a', kind: 'beads' }] },
                { issue: { id: 'iss-b' }, aliases: [{ alias: 'bd-b', kind: 'beads' }] },
            ],
            edges: [{ fromIssue: 'iss-b', toIssue: 'iss-a', kind: 'blocks' }],
        });
        const collected = collectSubstrateSummary('prj_x', run);
        expect(collected.ok).toBe(true);
        expect(calls).toEqual([['export', 'project', '--project', 'prj_x', '--json']]);
        expect(collected.summary?.aliasEntries).toHaveLength(2);
        expect(collected.summary?.edges).toEqual([{ from: 'iss-b', to: 'iss-a', kind: 'blocks' }]);
    });

    it('fails closed on nonzero exit and unexpected shapes', () => {
        const failing: SbRunner = () => ({ status: 1, stdout: '', stderr: 'boom' });
        expect(collectSubstrateSummary('prj_x', failing).ok).toBe(false);
        const { run } = stubExportProject({ issues: [], edges: 'nope' });
        expect(collectSubstrateSummary('prj_x', run).ok).toBe(false);
    });
});

describe('verifyBeadsExportAgainstProject (file vs project, fail-closed)', () => {
    it('passes end to end against a stubbed bulk snapshot', () => {
        const file = path.join(tmpDir, 'export.jsonl');
        fs.writeFileSync(file, `${EXPORT_TEXT}\n`);
        const run: SbRunner = () => ({
            status: 0,
            stdout: JSON.stringify({
                schema: 'substrate-cli/v1', command: 'export.project', ok: true,
                data: {
                    issues: [
                        { issue: { id: 'iss-a' }, aliases: [{ alias: 'bd-a', kind: 'beads' }] },
                        { issue: { id: 'iss-b' }, aliases: [{ alias: 'bd-b', kind: 'beads' }] },
                        { issue: { id: 'iss-c' }, aliases: [{ alias: 'bd-c', kind: 'beads' }] },
                    ],
                    edges: [{ fromIssue: 'iss-b', toIssue: 'iss-a', kind: 'blocks' }],
                },
            }),
            stderr: '',
        });
        const result = verifyBeadsExportAgainstProject(file, 'prj_x', { run, notesTotal: 1, commentsTotal: 1 });
        expect(result.ok).toBe(true);
        expect(preservationExitCode(result)).toBe(0);
    });

    it('fails closed when the export file is missing', () => {
        const run: SbRunner = () => { throw new Error('must not run when the export is unreadable'); };
        const result = verifyBeadsExportAgainstProject(path.join(tmpDir, 'missing.jsonl'), 'prj_x', { run });
        expect(result.ok).toBe(false);
        expect(preservationExitCode(result)).toBe(1);
    });
});
