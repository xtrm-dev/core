// CORE-2607: the Issue-to-PR link the shim writes after `gh pr create`.
//
// These are the golden unit cases for the resolution rules the coordinator ruled
// on: the URL parse (repository and number from the URL, never from --repo), the
// body marker first and the title/branch fallback only without one, one distinct
// ref or a warn-and-skip, and the exact `sb provenance attach` argv.

import { describe, expect, it } from 'vitest';

import {
    ATTACH_TIMEOUT_MS,
    chooseIssueRef,
    issueRefsInText,
    linkCreatedPr,
    parseCreatedPrUrl,
    readCreateBody,
    readCreateTitle,
    resolveLinkRange,
    type RunGit,
} from '../core/gh-pr-link.js';
import type { SbProject } from '../core/sb-receipt.js';

const PROJECTS: SbProject[] = [
    { id: 'prj_core', prefix: 'CORE', name: 'core' },
    { id: 'prj_xtrm', prefix: 'XTRM', name: 'xtrm' },
    { id: 'prj_specialists', prefix: 'SPECIALISTS', name: 'specialists' },
];

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const CREATED = 'https://github.com/xtrm-dev/core/pull/912\n';

function projectList(projects: SbProject[] = PROJECTS): string {
    return JSON.stringify({ schema: 'substrate-cli/v1', command: 'project.list', ok: true, data: projects });
}

/** A git fake: `rev-parse HEAD`, the branch, and a merge-base answer per upstream. */
function gitFake(options: {
    head?: string | null;
    branch?: string;
    mergeBases?: Record<string, string | null>;
} = {}): { runGit: RunGit; calls: string[][] } {
    const calls: string[][] = [];
    const runGit: RunGit = (args) => {
        calls.push(args);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
            return options.head === null ? { status: 128, stdout: '', stderr: 'fatal' } : { status: 0, stdout: `${options.head ?? HEAD}\n`, stderr: '' };
        }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
            return { status: 0, stdout: `${options.branch ?? 'xt/shim-attach'}\n`, stderr: '' };
        }
        if (args[0] === 'merge-base') {
            const base = options.mergeBases?.[args[2] ?? ''] ?? null;
            return base ? { status: 0, stdout: `${base}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unexpected git call' };
    };
    return { runGit, calls };
}

describe('the attach budget', () => {
    it('gives the attach five seconds, the coordinator ruling', () => {
        expect(ATTACH_TIMEOUT_MS).toBe(5000);
    });
});

describe('parseCreatedPrUrl', () => {
    it('reads owner, repository and number, and stores owner/repo#n', () => {
        expect(parseCreatedPrUrl(CREATED)).toEqual({
            owner: 'xtrm-dev',
            repo: 'core',
            number: 912,
            slug: 'xtrm-dev/core',
            canonical: 'xtrm-dev/core#912',
            url: 'https://github.com/xtrm-dev/core/pull/912',
        });
    });

    it('takes the LAST URL gh printed, not an earlier one in a warning', () => {
        const stdout = 'Warning: a pull request already exists: https://github.com/xtrm-dev/core/pull/111\n'
            + 'https://github.com/xtrm-dev/core/pull/912\n';
        expect(parseCreatedPrUrl(stdout)?.canonical).toBe('xtrm-dev/core#912');
    });

    it('does not mistake a compare URL for a created PR', () => {
        expect(parseCreatedPrUrl('Create a pull request for \'b\' on GitHub by visiting:\n  https://github.com/xtrm-dev/core/pull/new/b\n')).toBeNull();
    });

    it('rejects a non-GitHub or a look-alike host, and an empty output', () => {
        expect(parseCreatedPrUrl('https://gitlab.com/xtrm-dev/core/pull/912')).toBeNull();
        expect(parseCreatedPrUrl('https://github.com.evil.test/xtrm-dev/core/pull/912')).toBeNull();
        expect(parseCreatedPrUrl('https://evil.test/github.com/xtrm-dev/core/pull/912')).toBeNull();
        expect(parseCreatedPrUrl('')).toBeNull();
        expect(parseCreatedPrUrl(null)).toBeNull();
    });

    it('tolerates CRLF output', () => {
        expect(parseCreatedPrUrl('https://github.com/xtrm-dev/core/pull/7\r\n')?.canonical).toBe('xtrm-dev/core#7');
    });
});

describe('readCreateBody and readCreateTitle', () => {
    it('reads the literal --body value in every spelling, and never treats a value as a flag', () => {
        expect(readCreateBody(['pr', 'create', '--body', 'hello']).text).toBe('hello');
        expect(readCreateBody(['pr', 'create', '--body=hello']).text).toBe('hello');
        expect(readCreateBody(['pr', 'create', '-b', 'hello']).text).toBe('hello');
        expect(readCreateBody(['pr', 'create', '--body', '-c']).text).toBe('-c');
    });

    it('reads the --body-file content, and treats an unreadable file as no marker', () => {
        const readFile = (file: string) => {
            if (file === 'body.md') return '<!-- xtrm issue=CORE-2607 holder=h run=r -->\n';
            throw new Error(`ENOENT: ${file}`);
        };
        const fromFile = readCreateBody(['pr', 'create', '--body-file', 'body.md'], readFile);
        expect(fromFile).toMatchObject({ source: 'body-file', file: 'body.md' });
        expect(fromFile.text).toContain('CORE-2607');
        const missing = readCreateBody(['pr', 'create', '--body-file', 'gone.md'], readFile);
        expect(missing).toMatchObject({ source: 'body-file', file: 'gone.md', text: '' });
        expect(readCreateBody(['pr', 'create', '--body-file', '-'], readFile)).toMatchObject({ source: 'body-file', text: '' });
    });

    it('keeps gh\'s order: the last body flag supplies the text', () => {
        const readFile = () => 'from file';
        expect(readCreateBody(['pr', 'create', '--body', 'from text', '--body-file', 'f.md'], readFile).text).toBe('from file');
        expect(readCreateBody(['pr', 'create', '--body-file', 'f.md', '--body', 'from text'], readFile).text).toBe('from text');
    });

    it('reads --title in every spelling', () => {
        expect(readCreateTitle(['pr', 'create', '--title', 'Wire it (CORE-2607)'])).toBe('Wire it (CORE-2607)');
        expect(readCreateTitle(['pr', 'create', '--title=Wire it'])).toBe('Wire it');
        expect(readCreateTitle(['pr', 'create', '-t', 'Wire it'])).toBe('Wire it');
        expect(readCreateTitle(['pr', 'create', '--fill'])).toBe('');
    });
});

describe('issueRefsInText', () => {
    it('finds a ref in a title and a lower-case ref in a branch', () => {
        expect(issueRefsInText('fix: wire the shim (CORE-2607)', ['CORE'])).toEqual(['CORE-2607']);
        expect(issueRefsInText('core-2607-gh-shim', ['CORE'])).toEqual(['CORE-2607']);
        expect(issueRefsInText('xtrm-184.2.3-thing', ['XTRM'])).toEqual(['XTRM-184.2.3']);
    });

    it('rejects a prefix inside a longer word and an unknown prefix', () => {
        expect(issueRefsInText('XXCORE-2607', ['CORE'])).toEqual([]);
        expect(issueRefsInText('CORE-2607x', ['CORE'])).toEqual([]);
        expect(issueRefsInText('FOO-1', ['CORE', 'XTRM'])).toEqual([]);
        expect(issueRefsInText(undefined, ['CORE'])).toEqual([]);
    });

    it('de-duplicates a ref named twice', () => {
        expect(issueRefsInText('CORE-2607 and core-2607', ['CORE'])).toEqual(['CORE-2607']);
    });
});

describe('chooseIssueRef', () => {
    it('uses the body marker first, even when the title names another ref', () => {
        const choice = chooseIssueRef({
            bodyText: 'Implements the slice.\n\n<!-- xtrm issue=CORE-2607 holder=h run=r -->\n',
            title: 'fix: something (CORE-9999)',
            branch: 'core-9999',
            projects: PROJECTS,
        });
        expect(choice).toEqual({ ref: 'CORE-2607', source: 'marker', reason: null });
    });

    it('accepts a hierarchical ref in the marker', () => {
        expect(chooseIssueRef({ bodyText: '<!-- xtrm issue=XTRM-184.2.3 holder=h run=r -->', projects: PROJECTS }).ref).toBe('XTRM-184.2.3');
    });

    it('ignores a marker inside a fenced block and falls back', () => {
        const body = '```\n<!-- xtrm issue=CORE-9999 holder=h run=r -->\n```\n';
        expect(chooseIssueRef({ bodyText: body, title: 'wire it (CORE-2607)', projects: PROJECTS })).toEqual({
            ref: 'CORE-2607',
            source: 'title',
            reason: null,
        });
    });

    it('warns and skips on two different markers instead of guessing', () => {
        const body = '<!-- xtrm issue=CORE-2607 holder=h run=r -->\n<!-- xtrm issue=CORE-2608 holder=h run=r -->\n';
        const choice = chooseIssueRef({ bodyText: body, title: 'wire it (CORE-2607)', projects: PROJECTS });
        expect(choice.ref).toBeNull();
        expect(choice.reason).toMatch(/more than one Issue \(CORE-2607, CORE-2608\)/);
    });

    it('does not fall back when a marker exists but is not a ref', () => {
        const choice = chooseIssueRef({
            bodyText: '<!-- xtrm issue=whatever holder=h run=r -->',
            title: 'wire it (CORE-2607)',
            projects: PROJECTS,
        });
        expect(choice.ref).toBeNull();
        expect(choice.reason).toMatch(/not a Substrate Issue ref/);
    });

    it('falls back to the title, the branch, or both when they agree', () => {
        expect(chooseIssueRef({ title: 'wire it (CORE-2607)', projects: PROJECTS })).toEqual({ ref: 'CORE-2607', source: 'title', reason: null });
        expect(chooseIssueRef({ branch: 'core-2607-gh-shim', projects: PROJECTS })).toEqual({ ref: 'CORE-2607', source: 'branch', reason: null });
        expect(chooseIssueRef({ title: 'CORE-2607', branch: 'core-2607-x', projects: PROJECTS })).toEqual({
            ref: 'CORE-2607',
            source: 'title and branch',
            reason: null,
        });
    });

    it('warns and skips when the title and the branch name different Issues', () => {
        const choice = chooseIssueRef({ title: 'wire it (CORE-2607)', branch: 'core-2608-x', projects: PROJECTS });
        expect(choice.ref).toBeNull();
        expect(choice.reason).toMatch(/different Issues \(CORE-2607, CORE-2608\)/);
    });

    it('warns and skips when nothing names a known project ref', () => {
        const choice = chooseIssueRef({ title: 'wire it', branch: 'feature/x', projects: PROJECTS });
        expect(choice.ref).toBeNull();
        expect(choice.reason).toMatch(/no xtrm Issue marker/);
    });
});

describe('resolveLinkRange', () => {
    it('prefers origin/HEAD, then origin/main, then the branch upstream', () => {
        const order: string[] = [];
        const runGit: RunGit = (args) => {
            if (args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n`, stderr: '' };
            order.push(args[2]);
            if (args[2] === 'origin/HEAD') return { status: 1, stdout: '', stderr: '' };
            return { status: 0, stdout: `${BASE}\n`, stderr: '' };
        };
        expect(resolveLinkRange(runGit, '/repo')).toEqual({ head: HEAD, base: BASE });
        expect(order).toEqual(['origin/HEAD', 'origin/main']);
    });

    it('uses the branch upstream last and reports no base when every candidate fails', () => {
        const { runGit } = gitFake({ mergeBases: { '@{upstream}': BASE } });
        expect(resolveLinkRange(runGit, '/repo')).toEqual({ head: HEAD, base: BASE });
        const none = gitFake().runGit;
        expect(resolveLinkRange(none, '/repo')).toEqual({ head: HEAD, base: null });
    });

    it('gives up when HEAD cannot be read', () => {
        const { runGit } = gitFake({ head: null });
        expect(resolveLinkRange(runGit, '/repo')).toBeNull();
    });
});

describe('linkCreatedPr', () => {
    function deps(overrides: {
        stdout?: string;
        argv?: string[];
        projects?: SbProject[] | 'fail';
        attachOk?: boolean;
        attachError?: string;
        throwAttach?: boolean;
        bodyText?: string;
        branch?: string;
        base?: string | null;
    } = {}) {
        const attachCalls: string[][] = [];
        const projectCalls: string[][] = [];
        const { runGit } = gitFake({
            branch: overrides.branch ?? 'core-2607-gh-shim',
            mergeBases: { 'origin/HEAD': overrides.base === null ? null : (overrides.base ?? BASE) },
        });
        const runSb = (args: string[]) => {
            projectCalls.push(args);
            if (overrides.projects === 'fail') return { status: 1, stdout: '', stderr: 'sb: no store' };
            return { status: 0, stdout: projectList(overrides.projects ?? PROJECTS), stderr: '' };
        };
        const result = linkCreatedPr(overrides.stdout ?? CREATED, overrides.argv ?? ['pr', 'create', '--body', overrides.bodyText ?? '<!-- xtrm issue=CORE-2607 holder=h run=r -->'], {
            cwd: '/repo',
            env: {},
            runGit,
            runSb,
            readFile: () => {
                throw new Error('no file');
            },
            runAttach: (args) => {
                attachCalls.push(args);
                if (overrides.throwAttach) throw new Error('boom');
                return overrides.attachOk === false
                    ? { ok: false, error: overrides.attachError ?? 'sb exited 1: refused' }
                    : { ok: true };
            },
        });
        return { result, attachCalls, projectCalls };
    }

    it('attaches with the exact argv: ref, canonical, range and project', () => {
        const { result, attachCalls, projectCalls } = deps();
        expect(result).toEqual({
            attached: true,
            ref: 'CORE-2607',
            canonical: 'xtrm-dev/core#912',
            argv: ['provenance', 'attach', 'CORE-2607', 'pr', 'xtrm-dev/core#912', '--commits-range', `${BASE}..${HEAD}`, '--project', 'prj_core'],
        });
        expect(attachCalls).toEqual([result.argv]);
        // One project list read, not two: the resolution and the prefix match share it.
        expect(projectCalls).toEqual([['project', 'list', '--json']]);
    });

    it('never passes --receipt (T1 comes from the ambient claim, T2 from the range)', () => {
        const { result } = deps();
        expect(result.argv).not.toContain('--receipt');
    });

    it('resolves the project from the ref prefix, not the cwd or the repository name', () => {
        // A core worktree that attaches an XTRM Issue must name prj_xtrm.
        const { result } = deps({
            stdout: 'https://github.com/xtrm-dev/specialists/pull/5\n',
            bodyText: '<!-- xtrm issue=XTRM-728 holder=h run=r -->',
        });
        expect(result.argv?.[result.argv.indexOf('--project') + 1]).toBe('prj_xtrm');
    });

    it('falls back to --commit HEAD when no base resolves', () => {
        const { result } = deps({ base: null });
        expect(result.argv).toEqual(['provenance', 'attach', 'CORE-2607', 'pr', 'xtrm-dev/core#912', '--commit', HEAD, '--project', 'prj_core']);
    });

    it('warns once and skips when the output carries no URL', () => {
        const { result, attachCalls } = deps({ stdout: '' });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/no pull request URL/);
        expect(attachCalls).toEqual([]);
    });

    it('warns once and skips when no Issue ref resolves', () => {
        const { result, attachCalls } = deps({ bodyText: 'no marker here', branch: 'feature/x' });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/not linked to a Substrate Issue/);
        expect(attachCalls).toEqual([]);
    });

    it('warns once and skips when the project cannot be resolved', () => {
        const { result, attachCalls } = deps({ projects: 'fail' });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/cannot resolve the Substrate project for CORE-2607/);
        expect(attachCalls).toEqual([]);
    });

    it('warns once and skips when HEAD cannot be read (no base, no commit)', () => {
        const attachCalls: string[][] = [];
        const result = linkCreatedPr(CREATED, ['pr', 'create', '--body', '<!-- xtrm issue=CORE-2607 holder=h run=r -->'], {
            cwd: '/nowhere',
            env: {},
            runGit: gitFake({ head: null }).runGit,
            runSb: () => ({ status: 0, stdout: projectList(), stderr: '' }),
            runAttach: (args) => {
                attachCalls.push(args);
                return { ok: true };
            },
        });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/cannot read HEAD in \/nowhere/);
        expect(attachCalls).toEqual([]);
    });

    it('warns once when the attach fails, and keeps the create result', () => {
        const { result } = deps({ attachOk: false, attachError: 'unknown provenance verb: attach' });
        expect(result.attached).toBe(false);
        expect(result.ref).toBe('CORE-2607');
        expect(result.warning).toMatch(/created xtrm-dev\/core#912, but the Substrate link to CORE-2607 failed: unknown provenance verb/);
        // One line, because it is appended after the create's own output.
        expect(result.warning).not.toMatch(/\n/);
    });

    it('turns an unexpected throw into one warning, never a failed create', () => {
        const { result } = deps({ throwAttach: true });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/not linked to its Substrate Issue: boom/);
    });

    it('takes the ref from the title when the body has no marker', () => {
        const { result } = deps({ bodyText: '', argv: ['pr', 'create', '--title', 'wire it (CORE-2607)'] });
        expect(result.ref).toBe('CORE-2607');
        expect(result.attached).toBe(true);
    });
});
