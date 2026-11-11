// CORE-2607: the Issue-to-PR link the shim writes after `gh pr create`.
//
// These are the golden unit cases for the resolution rules the coordinator ruled
// on: the URL parse (repository and number from the URL, never from --repo), the
// body marker first and the title/branch fallback only without one, one distinct
// ref or a warn-and-skip, and the exact `sb provenance attach` argv.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

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
    // sb 0.3 `FLAG_ALLOWLIST` for the two verbs the link uses, plus the global
    // flags. A flag outside this set makes sb answer "unknown flag --x", the
    // receipt fails and the link degrades to a warning: the argv mas stay inside.
    const SB_ALLOWED: Record<string, string[]> = {
        global: ['db', 'json'],
        'provenance attach': ['project', 'receipt', 'holder'],
        'issue link pr': ['project', 'repo', 'number', 'url', 'commit', 'commits-range', 'holder'],
    };

    function flagsOf(argv: string[]): string[] {
        return argv.filter((arg) => arg.startsWith('--')).map((arg) => arg.slice(2).split('=')[0] as string);
    }

    function deps(overrides: {
        stdout?: string;
        argv?: string[];
        projects?: SbProject[] | 'fail';
        attachOk?: boolean;
        attachError?: string;
        commitsOk?: boolean;
        commitsError?: string;
        throwAttach?: boolean;
        bodyText?: string;
        branch?: string;
        base?: string | null;
    } = {}) {
        const receiptCalls: string[][] = [];
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
                receiptCalls.push(args);
                if (overrides.throwAttach) throw new Error('boom');
                if (args[0] === 'provenance') {
                    return overrides.attachOk === false
                        ? { ok: false, error: overrides.attachError ?? 'sb exited 1: refused' }
                        : { ok: true };
                }
                return overrides.commitsOk === false
                    ? { ok: false, error: overrides.commitsError ?? 'sb exited 1: unknown flag --commits-range' }
                    : { ok: true };
            },
        });
        return { result, receiptCalls, projectCalls };
    }

    it('writes T1 then T2 with the exact argv sb allows for each verb', () => {
        const { result, receiptCalls, projectCalls } = deps();
        expect(result).toEqual({
            attached: true,
            ref: 'CORE-2607',
            canonical: 'xtrm-dev/core#912',
            argv: ['provenance', 'attach', 'CORE-2607', 'pr', 'xtrm-dev/core#912', '--project', 'prj_core'],
            commitsArgv: [
                'issue', 'link', 'pr', 'CORE-2607',
                '--repo', 'xtrm-dev/core',
                '--number', '912',
                '--commits-range', `${BASE}..${HEAD}`,
                '--project', 'prj_core',
            ],
        });
        expect(receiptCalls).toEqual([result.argv, result.commitsArgv]);
        // One project list read, not two: the resolution and the prefix match share it.
        expect(projectCalls).toEqual([['project', 'list', '--json']]);
    });

    it('uses only flags in sb allowlists for each verb, and no --receipt', () => {
        const { result } = deps();
        const t1 = flagsOf(result.argv as string[]).filter((flag) => !SB_ALLOWED.global.includes(flag));
        const t2 = flagsOf(result.commitsArgv as string[]).filter((flag) => !SB_ALLOWED.global.includes(flag));
        // Non-empty, so a dropped flag cannot make the check pass vacuously.
        expect(t1).toEqual(['project']);
        expect(t2.sort()).toEqual(['commits-range', 'number', 'project', 'repo']);
        for (const flag of t1) expect(SB_ALLOWED['provenance attach']).toContain(flag);
        for (const flag of t2) expect(SB_ALLOWED['issue link pr']).toContain(flag);
        // T1 resolves b2/b3 (the ambient claim's receipt), so no --receipt.
        expect(result.argv).not.toContain('--receipt');
    });

    it('takes the repository and number from the URL, never from --repo', () => {
        const { result, receiptCalls } = deps({ argv: ['pr', 'create', '--repo', 'other/repo', '--body', '<!-- xtrm issue=CORE-2607 holder=h run=r -->'] });
        expect(result.canonical).toBe('xtrm-dev/core#912');
        expect(result.commitsArgv).toContain('xtrm-dev/core');
        expect(result.commitsArgv).not.toContain('other/repo');
        expect(receiptCalls.some((argv) => argv.includes('other/repo'))).toBe(false);
    });

    it('resolves the project from the ref prefix, not the cwd or the repository name', () => {
        // A core worktree that attaches an XTRM Issue must name prj_xtrm.
        const { result } = deps({
            stdout: 'https://github.com/xtrm-dev/specialists/pull/5\n',
            bodyText: '<!-- xtrm issue=XTRM-728 holder=h run=r -->',
        });
        expect(result.argv?.[result.argv.indexOf('--project') + 1]).toBe('prj_xtrm');
        expect(result.commitsArgv?.[result.commitsArgv.indexOf('--project') + 1]).toBe('prj_xtrm');
    });

    it('falls back to sb issue link --commit HEAD when no base resolves', () => {
        const { result } = deps({ base: null });
        expect(result.commitsArgv).toEqual([
            'issue', 'link', 'pr', 'CORE-2607',
            '--repo', 'xtrm-dev/core',
            '--number', '912',
            '--commit', HEAD,
            '--project', 'prj_core',
        ]);
        expect(result.attached).toBe(true);
    });

    it('warns once and skips when the output carries no URL', () => {
        const { result, receiptCalls } = deps({ stdout: '' });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/no pull request URL/);
        expect(receiptCalls).toEqual([]);
    });

    it('warns once and skips when no Issue ref resolves', () => {
        const { result, receiptCalls } = deps({ bodyText: 'no marker here', branch: 'feature/x' });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/not linked to a Substrate Issue/);
        expect(receiptCalls).toEqual([]);
    });

    it('warns once and skips when the project cannot be resolved', () => {
        const { result, receiptCalls } = deps({ projects: 'fail' });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/cannot resolve the Substrate project for CORE-2607/);
        expect(receiptCalls).toEqual([]);
    });

    it('attaches T1 and warns about the commits when HEAD cannot be read', () => {
        const receiptCalls: string[][] = [];
        const result = linkCreatedPr(CREATED, ['pr', 'create', '--body', '<!-- xtrm issue=CORE-2607 holder=h run=r -->'], {
            cwd: '/nowhere',
            env: {},
            runGit: gitFake({ head: null }).runGit,
            runSb: () => ({ status: 0, stdout: projectList(), stderr: '' }),
            runAttach: (args) => {
                receiptCalls.push(args);
                return { ok: true };
            },
        });
        expect(result.attached).toBe(true);
        expect(result.commitsArgv).toBeUndefined();
        expect(result.warning).toMatch(/HEAD cannot be read in \/nowhere/);
        expect(receiptCalls).toEqual([result.argv]);
    });

    it('warns once when T1 fails, and does not attempt T2', () => {
        const { result, receiptCalls } = deps({ attachOk: false, attachError: 'unknown provenance verb: attach' });
        expect(result.attached).toBe(false);
        expect(result.ref).toBe('CORE-2607');
        expect(result.warning).toMatch(/created xtrm-dev\/core#912, but the Substrate link to CORE-2607 failed: unknown provenance verb/);
        expect(result.warning).not.toMatch(/\n/);
        expect(receiptCalls).toHaveLength(1);
    });

    it('keeps T1 attached and warns once when T2 fails', () => {
        const { result, receiptCalls } = deps({ commitsOk: false });
        expect(result.attached).toBe(true);
        expect(result.warning).toMatch(/linked xtrm-dev\/core#912 to CORE-2607, but its commit evidence failed: .*unknown flag --commits-range/);
        expect(receiptCalls).toHaveLength(2);
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

// The argv above is only as good as sb's flag allowlist: a flag sb does not
// declare makes the whole receipt fail ("unknown flag --x for `verb`") and the
// link degrades to a warning, so the golden tests alone cannot see it. This
// suite hands the argv the module actually builds to a real sb, against a
// scratch store. The deployed sb may predate the two verbs (0.2.6 answers
// "unknown flag --project for provenance.attach"), and then there is no
// allowlist to test: the case skips visibly instead of passing quietly. Set
// XTRM_TEST_SB to point it at another binary.
describe('the real sb surface', () => {
    const SB = (() => {
        if (process.env.XTRM_TEST_SB) return process.env.XTRM_TEST_SB;
        try {
            return execFileSync('sh', ['-c', 'command -v sb'], { encoding: 'utf8' }).trim();
        } catch {
            return '';
        }
    })();
    const dir = mkdtempSync(join(tmpdir(), 'xtrm-sb-surface-'));
    const db = join(dir, 'state.db');
    // The probe below runs before the skip checks, so the directory exists even
    // when this file ends in context.skip(). CORE-2612: remove it here, not only
    // in the finally of the executed branch.
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function runSb(args: string[]): string {
        const result = spawnSync(SB, [...args, '--db', db, '--json'], { encoding: 'utf8', timeout: 20_000 });
        return `${result.stdout ?? ''}${result.stderr ?? ''}`;
    }

    /** The argv the module builds, captured from the injected runner. */
    function receipts(): string[][] {
        const recorded: string[][] = [];
        linkCreatedPr(CREATED, ['pr', 'create', '--body', '<!-- xtrm issue=CORE-2607 holder=h run=r -->'], {
            cwd: '/repo',
            env: {},
            runGit: gitFake({ mergeBases: { 'origin/HEAD': BASE } }).runGit,
            runSb: () => ({ status: 0, stdout: projectList(), stderr: '' }),
            runAttach: (args) => {
                recorded.push(args);
                return { ok: true };
            },
        });
        return recorded;
    }

    // Probing the deployed binary once: an unknown verb or an unknown baseline
    // flag means this sb predates XTRM-727's CLI surface.
    const shipped = SB !== '' && (() => {
        const probe = runSb(['issue', 'link', 'pr', 'CORE-1', '--repo', 'xtrm-dev/core', '--number', '1', '--project', 'prj_probe']);
        return !/unknown (issue )?verb|unknown flag --(repo|project|number)/.test(probe);
    })();

    it('takes argv that the deployed sb accepts, or skips visibly', (context) => {
        if (!SB) {
            console.warn('[CORE-2607] sb is not installed here: the allowlist check is skipped, not passed');
            context.skip();
            return;
        }
        if (!shipped) {
            console.warn('[CORE-2607] the deployed sb predates provenance.attach/issue.link: the allowlist check is skipped, not passed');
            context.skip();
            return;
        }
        try {
            const argv = receipts();
            expect(argv).toHaveLength(2);
            for (const receipt of argv) {
                expect(runSb(receipt)).not.toMatch(/unknown flag --/);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
