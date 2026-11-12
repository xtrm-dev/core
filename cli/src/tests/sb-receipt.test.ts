// CORE-2611: a receipt names its project. `sb` resolves the project from the
// cwd, so a reviewer working in a `core` worktree that reviewed an `xtrm` PR was
// refused ("ref XTRM-728 belongs to project prj_xtrm, not the effective project
// prj_core") and lost the Journal receipt. The project comes from data `sb`
// already owns — the Issue ref prefix, else the PR repository name — and never
// from a hard-coded id.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    issueRefPrefix,
    listProjects,
    parseProjectList,
    pickReceiptProject,
    resolveReceiptProject,
    runReceipt,
    withReceiptProject,
    type SbProject,
} from '../core/sb-receipt.js';

const PROJECTS: SbProject[] = [
    { id: 'prj_core', prefix: 'CORE', name: 'core' },
    { id: 'prj_xtrm', prefix: 'XTRM', name: 'xtrm' },
    { id: 'prj_omni', prefix: 'OMNI', name: 'omni-search-engine' },
    { id: 'prj_omni_search_engine', prefix: 'OMNISEARCHENGINE', name: 'omni-search-engine' },
];

function projectList(projects: SbProject[] = PROJECTS): string {
    return JSON.stringify({ schema: 'substrate-cli/v1', command: 'project.list', ok: true, data: projects });
}

describe('parseProjectList', () => {
    it('reads id, prefix and name from the JSON envelope', () => {
        expect(parseProjectList(projectList())).toEqual(PROJECTS);
    });

    it('returns no projects for a refusal, a non-JSON body or a missing data array', () => {
        expect(parseProjectList('')).toEqual([]);
        expect(parseProjectList('sb: command not found')).toEqual([]);
        expect(parseProjectList('{"ok":false,"error":"no database"}')).toEqual([]);
        expect(parseProjectList('{"ok":true,"data":{"id":"prj_core"}}')).toEqual([]);
        expect(parseProjectList('[{"id":"prj_core"}]')).toEqual([]);
    });

    it('skips entries without an id or a prefix', () => {
        const partial = JSON.stringify({ ok: true, data: [{ id: 'prj_a', prefix: 'A', name: 'a' }, { id: 'prj_b' }, { prefix: 'C' }, null] });
        expect(parseProjectList(partial)).toEqual([{ id: 'prj_a', prefix: 'A', name: 'a' }]);
    });
});

describe('issueRefPrefix', () => {
    it('reads the prefix of a plain and a hierarchical ref, case-insensitively', () => {
        expect(issueRefPrefix('XTRM-728')).toBe('xtrm');
        expect(issueRefPrefix('XTRM-184.2.3')).toBe('xtrm');
        expect(issueRefPrefix('core-2611')).toBe('core');
        expect(issueRefPrefix('iss_01a1ca2f')).toBe('');
        expect(issueRefPrefix('')).toBe('');
        expect(issueRefPrefix(null)).toBe('');
    });
});

describe('pickReceiptProject', () => {
    it('resolves a cross-project receipt from the Issue ref, not from the cwd', () => {
        expect(pickReceiptProject(PROJECTS, { issueRef: 'XTRM-728' })).toBe('prj_xtrm');
        expect(pickReceiptProject(PROJECTS, { issueRef: 'CORE-2611' })).toBe('prj_core');
    });

    it('resolves a hierarchical ref by its leading prefix', () => {
        expect(pickReceiptProject(PROJECTS, { issueRef: 'XTRM-184.2.3' })).toBe('prj_xtrm');
    });

    it('falls back to the PR repository name when the ref prefix matches nothing', () => {
        expect(pickReceiptProject(PROJECTS, { issueRef: 'BD-9', repo: 'xtrm-dev/xtrm' })).toBe('prj_xtrm');
        expect(pickReceiptProject(PROJECTS, { repo: 'xtrm-dev/core' })).toBe('prj_core');
    });

    it('refuses to guess when the repository name is ambiguous', () => {
        expect(pickReceiptProject(PROJECTS, { repo: 'xtrm-dev/omni-search-engine' })).toBeNull();
    });

    it('returns null when neither the ref nor the repository names a project', () => {
        expect(pickReceiptProject(PROJECTS, { issueRef: 'NOPE-1', repo: 'acme/unknown' })).toBeNull();
        expect(pickReceiptProject([], { issueRef: 'XTRM-728' })).toBeNull();
        expect(pickReceiptProject(PROJECTS, {})).toBeNull();
    });

    it('returns null when two projects share the ref prefix', () => {
        const duplicated: SbProject[] = [...PROJECTS, { id: 'prj_xtrm_two', prefix: 'XTRM', name: 'xtrm-two' }];
        expect(pickReceiptProject(duplicated, { issueRef: 'XTRM-728' })).toBeNull();
    });
});

describe('resolveReceiptProject', () => {
    it('asks sb once for the project list and resolves the ref', () => {
        const calls: string[][] = [];
        const project = resolveReceiptProject({ issueRef: 'XTRM-728' }, {
            env: { SUBSTRATE_DB: '/tmp/scratch.db' },
            runSb: (args) => {
                calls.push(args);
                return { status: 0, stdout: projectList(), stderr: '' };
            },
        });
        expect(project).toBe('prj_xtrm');
        expect(calls).toEqual([['project', 'list', '--json']]);
    });

    it('accepts an already-read project list, so a caller that needs the prefixes pays one call', () => {
        const calls: string[][] = [];
        const project = resolveReceiptProject({ issueRef: 'XTRM-728' }, {
            projects: PROJECTS,
            runSb: (args) => {
                calls.push(args);
                return { status: 0, stdout: projectList(), stderr: '' };
            },
        });
        expect(project).toBe('prj_xtrm');
        expect(calls).toEqual([]);
    });

    it('reads no projects when sb cannot answer', () => {
        expect(listProjects({ runSb: () => ({ status: 1, stdout: '', stderr: 'sb: no store' }) })).toEqual([]);
        expect(listProjects({ runSb: () => ({ status: 0, stdout: projectList(), stderr: '' }) })).toEqual(PROJECTS);
    });

    it('degrades to the previous behaviour when sb cannot answer', () => {
        const failing = resolveReceiptProject({ issueRef: 'XTRM-728' }, {
            runSb: () => ({ status: 1, stdout: '', stderr: 'sb: database is locked' }),
        });
        expect(failing).toBeNull();
        const throwing = resolveReceiptProject({ issueRef: 'XTRM-728' }, {
            runSb: () => {
                throw new Error('ENOENT sb');
            },
        });
        expect(throwing).toBeNull();
    });
});

describe('withReceiptProject', () => {
    it('appends --project with an id and leaves the argv untouched without one', () => {
        const args = ['journal', 'append', 'XTRM-728', '--kind', 'result', '--json'];
        expect(withReceiptProject(args, 'prj_xtrm')).toEqual([...args, '--project', 'prj_xtrm']);
        expect(withReceiptProject(args, null)).toEqual(args);
        expect(withReceiptProject(args, '')).toEqual(args);
        expect(args).toHaveLength(6);
    });
});

describe('a receipt has a hard budget (CORE-2607)', () => {
    it('abandons an sb that has not answered in time and names the budget', () => {
        const bin = mkdtempSync(path.join(os.tmpdir(), 'xtrm-sb-slow-'));
        try {
            const file = path.join(bin, 'sb');
            writeFileSync(file, '#!/bin/sh\n/bin/sleep 1\nexit 0\n');
            chmodSync(file, 0o755);
            const started = Date.now();
            const result = runReceipt(['provenance', 'attach', 'CORE-2607'], { PATH: bin }, { timeoutMs: 200 });
            expect(result.ok).toBe(false);
            expect(result.error).toContain('no answer in 200 ms');
            // The budget is real: the shim must not wait out a slow sb.
            expect(Date.now() - started).toBeLessThan(900);
        } finally {
            rmSync(bin, { recursive: true, force: true });
        }
    });

    it('leaves a fast receipt alone', () => {
        const bin = mkdtempSync(path.join(os.tmpdir(), 'xtrm-sb-fast-'));
        try {
            const file = path.join(bin, 'sb');
            writeFileSync(file, '#!/bin/sh\nexit 0\n');
            chmodSync(file, 0o755);
            expect(runReceipt(['provenance', 'attach', 'CORE-2607'], { PATH: bin }, { timeoutMs: 200 })).toEqual({ ok: true, stdout: '' });
        } finally {
            rmSync(bin, { recursive: true, force: true });
        }
    });
});
