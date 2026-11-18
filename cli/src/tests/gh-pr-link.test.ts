// CORE-2607: the Issue-to-PR link the shim writes after `gh pr create`.
//
// These are the golden unit cases for the resolution rules the coordinator ruled
// on: the URL parse (repository and number from the URL, never from --repo), the
// body marker first and the title/branch fallback only without one, one distinct
// ref or a warn-and-skip, and the exact `sb provenance attach` argv.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
    ATTACH_TIMEOUT_MS,
    LINK_TAIL_MS,
    LINK_TIMEOUT_ENV_VAR,
    LINK_TIMEOUT_MAX_MS,
    LINK_TIMEOUT_MIN_MS,
    REMOTE_ATTACH_TIMEOUT_MS,
    REMOTE_SB_CALL_MS,
    chooseIssueRef,
    isShallowRepository,
    issueRefsInText,
    linkCreatedPr,
    parseCreatedPrUrl,
    parseSbRemoteMode,
    readCreateBody,
    readCreateTitle,
    resolveLinkBudgetMs,
    resolveLinkCeilingMs,
    resolveLinkRange,
    sbRemoteConfigPath,
    sbRemoteMode,
    type GhPrLinkResult,
    type RunGit,
} from '../core/gh-pr-link.js';
import type { SbProject } from '../core/sb-receipt.js';
import { resolveWorkerSessionId } from '../core/session-identity.js';

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
    /** CORE-2638: what `git rev-parse --is-shallow-repository` answers. */
    shallow?: boolean;
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
        if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
            return options.shallow === undefined
                ? { status: 1, stdout: '', stderr: "error: unknown option" }
                : { status: 0, stdout: `${options.shallow}\n`, stderr: '' };
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

// CORE-2745: in remote mode every `sb` call is an ssh round trip, so the local
// five seconds ran out by design. The budget follows sb's mode, read from sb's own
// config (never a probe call), and one env var overrides it in either mode.
const REMOTE_CONFIG = JSON.stringify({ remote: 'ssh:dawid@159.195.49.110', remoteSb: '/usr/bin/sb' });
const LOCAL_CONFIG = JSON.stringify({ checkouts: {} });
const localRead = () => {
    throw new Error('ENOENT: no substrate.json');
};

describe('the link budget follows sb mode (CORE-2745)', () => {
    it('keeps the five second budget in local mode', () => {
        expect(resolveLinkBudgetMs({ env: {}, readFile: localRead })).toBe(ATTACH_TIMEOUT_MS);
        expect(resolveLinkBudgetMs({ env: {}, readFile: () => LOCAL_CONFIG })).toBe(ATTACH_TIMEOUT_MS);
    });

    it('sizes a remote budget for the whole worst-case sequence of round trips', () => {
        // Seven calls: project list, attach, claim read, dispatch, allocate, attach
        // retry, issue link pr. The allowance covers the 1906 ms maximum measured.
        expect(resolveLinkBudgetMs({ env: {}, readFile: () => REMOTE_CONFIG })).toBe(REMOTE_ATTACH_TIMEOUT_MS);
        expect(REMOTE_ATTACH_TIMEOUT_MS).toBeGreaterThanOrEqual(7 * REMOTE_SB_CALL_MS);
        expect(REMOTE_SB_CALL_MS).toBeGreaterThan(1906);
        expect(REMOTE_ATTACH_TIMEOUT_MS).toBeGreaterThan(ATTACH_TIMEOUT_MS);
    });

    it('detects remote mode from sb\'s own config, never from a probe call', () => {
        expect(sbRemoteMode({ env: {}, readFile: () => REMOTE_CONFIG })).toBe(true);
        expect(sbRemoteMode({ env: {}, readFile: () => LOCAL_CONFIG })).toBe(false);
        expect(sbRemoteMode({ env: {}, readFile: localRead })).toBe(false);
        expect(sbRemoteMode({ env: {}, readFile: () => 'not json' })).toBe(false);
        // An explicit local store is never forwarded, so it means local mode.
        expect(sbRemoteMode({ env: { SUBSTRATE_DB: '/tmp/state.db' }, readFile: () => REMOTE_CONFIG })).toBe(false);
    });

    it('reads SUBSTRATE_REMOTE_CONFIG, sb\'s own override of the config path', () => {
        const seen: string[] = [];
        const readFile = (file: string) => {
            seen.push(file);
            return REMOTE_CONFIG;
        };
        const override = '/custom/substrate.json';
        sbRemoteMode({ env: { SUBSTRATE_REMOTE_CONFIG: override }, readFile, homeDir: '/home/worker' });
        sbRemoteMode({ env: {}, readFile, homeDir: '/home/worker' });
        expect(seen[0]).toBe(override);
        expect(seen[1]).toBe('/home/worker/.xtrm/config/substrate.json');
        expect(sbRemoteConfigPath({ SUBSTRATE_REMOTE_CONFIG: override }, '/home/worker')).toBe(override);
    });

    it('reads only a non-empty remote setting as remote mode', () => {
        expect(parseSbRemoteMode(JSON.stringify({ remote: 'ssh:host' }))).toBe(true);
        expect(parseSbRemoteMode(JSON.stringify({ remote: '   ' }))).toBe(false);
        expect(parseSbRemoteMode(JSON.stringify({ remote: null }))).toBe(false);
        expect(parseSbRemoteMode(JSON.stringify({ remote: '' }))).toBe(false);
        // CORE-2745 review F4: an empty object is no setting, not a remote mode.
        expect(parseSbRemoteMode(JSON.stringify({ remote: {} }))).toBe(false);
        expect(parseSbRemoteMode(JSON.stringify({ remote: [] }))).toBe(false);
        expect(parseSbRemoteMode(JSON.stringify({ remote: { host: 'h' } }))).toBe(true);
        expect(parseSbRemoteMode('{}')).toBe(false);
        expect(parseSbRemoteMode('')).toBe(false);
        expect(parseSbRemoteMode(null)).toBe(false);
    });

    it('lets one env var override the budget in either mode, clamped', () => {
        expect(resolveLinkBudgetMs({ env: { [LINK_TIMEOUT_ENV_VAR]: '25000' }, readFile: localRead })).toBe(25000);
        expect(resolveLinkBudgetMs({ env: { [LINK_TIMEOUT_ENV_VAR]: '25000' }, readFile: () => REMOTE_CONFIG })).toBe(25000);
        // Clamped at both ends, so a stray value cannot turn the link into a blocker.
        expect(resolveLinkBudgetMs({ env: { [LINK_TIMEOUT_ENV_VAR]: '10' }, readFile: localRead })).toBe(LINK_TIMEOUT_MIN_MS);
        expect(resolveLinkBudgetMs({ env: { [LINK_TIMEOUT_ENV_VAR]: '999999' }, readFile: localRead })).toBe(LINK_TIMEOUT_MAX_MS);
        // An invalid value falls back to the mode default silently, never an error.
        for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
            expect(resolveLinkBudgetMs({ env: { [LINK_TIMEOUT_ENV_VAR]: bad }, readFile: localRead })).toBe(ATTACH_TIMEOUT_MS);
            expect(resolveLinkBudgetMs({ env: { [LINK_TIMEOUT_ENV_VAR]: bad }, readFile: () => REMOTE_CONFIG })).toBe(REMOTE_ATTACH_TIMEOUT_MS);
        }
    });

    it('keeps the caller\'s kill above the budget it gives the link', () => {
        expect(resolveLinkCeilingMs({ env: {}, readFile: localRead })).toBe(ATTACH_TIMEOUT_MS + LINK_TAIL_MS);
        expect(resolveLinkCeilingMs({ env: {}, readFile: () => REMOTE_CONFIG })).toBe(REMOTE_ATTACH_TIMEOUT_MS + LINK_TAIL_MS);
        const overridden = { env: { [LINK_TIMEOUT_ENV_VAR]: '9000' }, readFile: localRead };
        expect(resolveLinkCeilingMs(overridden) - resolveLinkBudgetMs(overridden)).toBe(LINK_TAIL_MS);
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
        expect(resolveLinkRange(runGit, '/repo')).toEqual({ head: HEAD, base: BASE, shallow: false });
        expect(order).toEqual(['origin/HEAD', 'origin/main']);
    });

    it('uses the branch upstream last and reports no base when every candidate fails', () => {
        const { runGit } = gitFake({ mergeBases: { '@{upstream}': BASE } });
        expect(resolveLinkRange(runGit, '/repo')).toEqual({ head: HEAD, base: BASE, shallow: false });
        const none = gitFake().runGit;
        expect(resolveLinkRange(none, '/repo')).toEqual({ head: HEAD, base: null, shallow: false });
    });

    it('gives up when HEAD cannot be read', () => {
        const { runGit } = gitFake({ head: null });
        expect(resolveLinkRange(runGit, '/repo')).toBeNull();
    });
});

/** The linkCreatedPr harness, shared by the ordered tests and the shallow cases. */
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
    shallow?: boolean;
} = {}) {
    const receiptCalls: string[][] = [];
    const projectCalls: string[][] = [];
    const { runGit } = gitFake({
        branch: overrides.branch ?? 'core-2607-gh-shim',
        mergeBases: { 'origin/HEAD': overrides.base === null ? null : (overrides.base ?? BASE) },
        shallow: overrides.shallow,
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

// CORE-2631: a fresh issue has no WorkReceipt, so `provenance attach` fails with
// `no_receipt`. The shim recovers once: dispatch -> allocate -> attach. A receipt
// that already exists makes the first attach succeed, so recovery is a no-op on
// repeat runs. Any other failure never triggers dispatch or allocate.
/** The no_receipt recovery harness, shared by the CORE-2631 and CORE-2639 cases. */
function recoveryDeps(overrides: {
    attachErrors?: string[];   // sequence of errors for attach calls
    dispatchOk?: boolean;
    dispatchError?: string;
    allocateOk?: boolean;
    allocateError?: string;
    commitsOk?: boolean;
    held?: boolean;            // whether the issue is live-held
    holder?: string;           // holder name when held
    activationId?: string | null; // activation on the live claim
    env?: NodeJS.ProcessEnv;   // the process env the linker sees
    flatClaim?: boolean;       // answer with the flat {claim} shape instead of the envelope
    showFails?: boolean;       // the claim read fails outright
    attachFailureStdout?: string; // the payload the failed attach answers with (CORE-2745)
    dispatcherDeps?: import('../core/dispatcher-identity.js').DispatcherIdentityDeps; // CORE-2728 live-session probe
} = {}) {
    const calls: { kind: string; argv: string[] }[] = [];
    const { runGit } = gitFake({
        branch: 'core-2631-gh-shim',
        mergeBases: { 'origin/HEAD': BASE },
    });
    const runSb = () => ({ status: 0, stdout: projectList(PROJECTS), stderr: '' });
    let attachIndex = 0;
    const attachErrors = overrides.attachErrors ?? [];
    const isHeld = overrides.held ?? false;
    const holderName = overrides.holder ?? 'pi152-core';
    const result = linkCreatedPr(CREATED, ['pr', 'create', '--body', '<!-- xtrm issue=CORE-2607 holder=h run=r -->'], {
        cwd: '/repo',
        env: overrides.env ?? {},
        runGit,
        runSb,
        readFile: () => { throw new Error('no file'); },
        ...(overrides.dispatcherDeps ? { dispatcherDeps: overrides.dispatcherDeps } : {}),
        runAttach: (args) => {
            const kind = args[1]; // show | attach | dispatch | allocate
            calls.push({ kind, argv: [...args] });
            if (kind === 'show') {
                // The real sb answer: {schema, command, ok, data: {claim}}.
                // An earlier version read the top level and saw null forever.
                const claim = isHeld
                    ? { holder: holderName, activationId: overrides.activationId ?? null, releasedAt: null }
                    : null;
                const payload = overrides.flatClaim
                    ? { claim }
                    : { schema: 'substrate-cli/v1', command: 'issue.show', ok: true, data: { claim } };
                if (overrides.showFails) {
                    return { ok: false, error: 'sb exited 1: no store', stdout: '' };
                }
                return { ok: true, stdout: JSON.stringify(payload) };
            }
            if (kind === 'attach') {
                const err = attachErrors[attachIndex++];
                if (err) return { ok: false, error: err, stdout: overrides.attachFailureStdout ?? '' };
                return { ok: true, stdout: '' };
            }
            if (kind === 'dispatch') {
                return overrides.dispatchOk === false
                    ? { ok: false, error: overrides.dispatchError ?? 'dispatch failed', stdout: '' }
                    : { ok: true, stdout: '' };
            }
            if (kind === 'allocate') {
                return overrides.allocateOk === false
                    ? { ok: false, error: overrides.allocateError ?? 'allocate failed', stdout: '' }
                    : { ok: true, stdout: '' };
            }
            return { ok: true, stdout: '' };
        },
    });
    return { result, calls };
}

describe('linkCreatedPr recovery on no_receipt (CORE-2631)', () => {

    it('recovers from no_receipt: dispatch + allocate once, attach retried once, attached true', () => {
        const { result, calls } = recoveryDeps({ attachErrors: ['no_receipt: no receipt for this issue; run sb provenance dispatch CORE-2607 first'] });
        expect(result.attached).toBe(true);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        const allocates = calls.filter((c) => c.kind === 'allocate');
        const attaches = calls.filter((c) => c.kind === 'attach');
        expect(dispatches).toHaveLength(1);
        expect(allocates).toHaveLength(1);
        expect(attaches).toHaveLength(2);
        // dispatch carries the ref and project
        expect(dispatches[0].argv).toContain('CORE-2607');
        expect(dispatches[0].argv).toContain('--project');
        expect(dispatches[0].argv).toContain('prj_core');
        // unclaimed issue (held: false): no --participant
        expect(dispatches[0].argv).not.toContain('--participant');
        // allocate carries the ref
        expect(allocates[0].argv).toContain('CORE-2607');
        expect(allocates[0].argv).toContain('--project');
        // attach retried with the same argv
        expect(attaches[0].argv).toEqual(attaches[1].argv);
    });

    it('passes --participant with the session holder when the issue is live-held by it', () => {
        const { result, calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            held: true,
            holder: 'pi152-core',
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        expect(result.attached).toBe(true);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0].argv).toContain('--participant');
        expect(dispatches[0].argv).toContain('pi152-core');
    });

    // The production state CORE-2631 was filed from: the agent environment has
    // SUBSTRATE_HOLDER set while the Issue is unclaimed. An env-based decision
    // passes the flag here; a claim-based one must not.
    it('omits --participant when the issue is unclaimed, even with SUBSTRATE_HOLDER set', () => {
        const { result, calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            held: false,
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        expect(result.attached).toBe(true);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0].argv).not.toContain('--participant');
    });

    // Review finding: echoing the observed holder would pass sb's anti-steal
    // check by construction and attribute this session's work to the claimant.
    it('never dispatches under a holder that is not the session\'s own', () => {
        const { result, calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            held: true,
            holder: 'someone-else',
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
            dispatchOk: false,
            dispatchError: 'sb exited 1: holder/activation mismatch (anti-steal)',
        });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/anti-steal/);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        expect(dispatches).toHaveLength(1);
        expect(dispatches[0].argv).not.toContain('--participant');
        expect(dispatches[0].argv).not.toContain('someone-else');
    });

    // Regression for the FAIL review: the claim lives at data.claim in sb's
    // envelope, and reading the top level made every Issue look unclaimed.
    it('reads the claim from the sb envelope (data.claim), not the top level', () => {
        const { result, calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            held: true,
            holder: 'pi152-core',
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        expect(result.attached).toBe(true);
        const dispatch = calls.find((c) => c.kind === 'dispatch');
        expect(dispatch?.argv).toContain('--participant');
        expect(dispatch?.argv).toContain('pi152-core');
    });

    it('still accepts a flat {claim} answer', () => {
        const { calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            held: true,
            holder: 'pi152-core',
            flatClaim: true,
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        const dispatch = calls.find((c) => c.kind === 'dispatch');
        expect(dispatch?.argv).toContain('--participant');
    });

    it('says the claim could not be read when the read fails', () => {
        const { result } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            showFails: true,
            dispatchOk: false,
            dispatchError: 'sb exited 1: participant is required (anti-steal)',
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/claim could not be read/);
    });

    it('passes --activation when the live claim carries one', () => {
        const { calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            held: true,
            holder: 'pi152-core',
            activationId: 'act:abc123',
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        const dispatch = calls.find((c) => c.kind === 'dispatch');
        expect(dispatch?.argv).toContain('--activation');
        expect(dispatch?.argv).toContain('act:abc123');
    });

    it('does not attempt dispatch or allocate when attach fails for another reason', () => {
        const { result, calls } = recoveryDeps({ attachErrors: ['unknown migration: foo'] });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/failed: .*unknown migration/);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        const allocates = calls.filter((c) => c.kind === 'allocate');
        expect(dispatches).toHaveLength(0);
        expect(allocates).toHaveLength(0);
        const attaches = calls.filter((c) => c.kind === 'attach');
        expect(attaches).toHaveLength(1);
    });

    it('is a no-op when a receipt already exists (attach succeeds first time)', () => {
        const { result, calls } = recoveryDeps({ attachErrors: [] });
        expect(result.attached).toBe(true);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        const allocates = calls.filter((c) => c.kind === 'allocate');
        expect(dispatches).toHaveLength(0);
        expect(allocates).toHaveLength(0);
        const attaches = calls.filter((c) => c.kind === 'attach');
        expect(attaches).toHaveLength(1);
    });

    it('warns once when dispatch fails during recovery', () => {
        const { result, calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            dispatchOk: false,
            dispatchError: 'sb exited 1: unknown flag --participant',
        });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/failed: .*unknown flag --participant/);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        expect(dispatches).toHaveLength(1);
        const allocates = calls.filter((c) => c.kind === 'allocate');
        expect(allocates).toHaveLength(0);
    });

    it('warns once when allocate fails during recovery', () => {
        const { result, calls } = recoveryDeps({
            attachErrors: ['no_receipt: no receipt for this issue'],
            allocateOk: false,
            allocateError: 'sb exited 1: no binding',
        });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/failed: .*no binding/);
        const dispatches = calls.filter((c) => c.kind === 'dispatch');
        const allocates = calls.filter((c) => c.kind === 'allocate');
        expect(dispatches).toHaveLength(1);
        expect(allocates).toHaveLength(1);
        const attaches = calls.filter((c) => c.kind === 'attach');
        expect(attaches).toHaveLength(1);
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

describe('shallow clone (CORE-2638)', () => {
    it('asks git whether the checkout is shallow', () => {
        expect(isShallowRepository(gitFake({ shallow: true }).runGit, '/repo')).toBe(true);
        expect(isShallowRepository(gitFake({ shallow: false }).runGit, '/repo')).toBe(false);
        // A git that does not know the flag must not be mistaken for a shallow repo.
        expect(isShallowRepository(gitFake().runGit, '/repo')).toBe(false);
    });

    it('skips the range deliberately instead of letting merge-base pick an unwalkable base', () => {
        const { runGit, calls } = gitFake({ shallow: true, mergeBases: { 'origin/HEAD': BASE } });
        expect(resolveLinkRange(runGit, '/repo')).toEqual({ head: HEAD, base: null, shallow: true });
        expect(calls.some((args) => args[0] === 'merge-base')).toBe(false);
    });

    it('records --commit HEAD so the evidence still lands, with no warning', () => {
        const { result, receiptCalls } = deps({ shallow: true, base: BASE });
        expect(result.attached).toBe(true);
        expect(result.warning).toBeUndefined();
        expect(result.commitsArgv).toEqual([
            'issue', 'link', 'pr', 'CORE-2607',
            '--repo', 'xtrm-dev/core',
            '--number', '912',
            '--commit', HEAD,
            '--project', 'prj_core',
        ]);
        expect(receiptCalls).toHaveLength(2);
    });

    it('names the shallow clone for a range-shaped failure, without leaking the raw git error', () => {
        const raw = `sb: issue.link failed git log ${BASE}..${HEAD} failed: fatal: Invalid revision range ${BASE}..${HEAD}`;
        const { result } = deps({ shallow: true, base: BASE, commitsOk: false, commitsError: raw });
        expect(result.attached).toBe(true);
        expect(result.warning).toMatch(/unavailable in a shallow clone/);
        expect(result.warning).toMatch(/git fetch --unshallow/);
        expect(result.warning).not.toMatch(/Invalid revision range/);
        // One line, as the contract requires.
        expect(result.warning).not.toMatch(/\n/);
    });

    it('keeps a shallow checkout\'s NON-range failure and appends the shallow note', () => {
        // The shallow skip means the argv is always --commit, so an old sb can still
        // reject it; rewriting that into a shallow-clone remedy would hide the cause.
        const raw = 'sb exited 1: unknown flag --commit';
        const { result } = deps({ shallow: true, base: BASE, commitsOk: false, commitsError: raw });
        expect(result.attached).toBe(true);
        expect(result.warning).toMatch(/commit evidence failed: sb exited 1: unknown flag --commit/);
        expect(result.warning).toMatch(/this checkout is a shallow clone/);
        expect(result.warning).not.toMatch(/unavailable in a shallow clone/);
        expect(result.warning).not.toMatch(/\n/);
    });

    it('probes shallowness once per link, not once per consumer', () => {
        const { runGit, calls } = gitFake({ shallow: true, mergeBases: { 'origin/HEAD': BASE } });
        const result = linkCreatedPr(CREATED, ['pr', 'create', '--body', '<!-- xtrm issue=CORE-2607 holder=h run=r -->'], {
            cwd: '/repo',
            env: {},
            runGit,
            runSb: () => ({ status: 0, stdout: projectList(PROJECTS), stderr: '' }),
            readFile: () => { throw new Error('no file'); },
            runAttach: (args) => (args[0] === 'issue'
                ? { ok: false, error: 'sb exited 1: unknown flag --commit' }
                : { ok: true }),
        });
        expect(result.attached).toBe(true);
        expect(calls.filter((args) => args[1] === '--is-shallow-repository')).toHaveLength(1);
    });

    it('keeps the original diagnostic on a full clone', () => {
        const raw = 'sb exited 1: unknown flag --commits-range';
        const { result } = deps({ shallow: false, base: BASE, commitsOk: false, commitsError: raw });
        expect(result.warning).toMatch(/commit evidence failed: sb exited 1: unknown flag --commits-range/);
        expect(result.warning).not.toMatch(/shallow/);
    });
});

describe('provenance dispatch session identity (CORE-2639)', () => {
    const NO_RECEIPT = 'no_receipt: no receipt for this issue; run sb provenance dispatch CORE-2607 first';

    function dispatchArgvOf(env: NodeJS.ProcessEnv): string[] {
        const { calls } = recoveryDeps({ attachErrors: [NO_RECEIPT], env });
        const dispatch = calls.find((call) => call.kind === 'dispatch');
        expect(dispatch, 'the recovery path must dispatch').toBeDefined();
        return dispatch?.argv ?? [];
    }

    it("passes the worker's own runtime session id when the environment carries one", () => {
        const argv = dispatchArgvOf({ PI_SESSION_ID: '01a1cc7e-f75d' });
        expect(argv[argv.indexOf('--session') + 1]).toBe('01a1cc7e-f75d');
    });

    it('falls back through the Claude and Codex variables', () => {
        expect(dispatchArgvOf({ CLAUDE_SESSION_ID: 'claude-sess' })[dispatchArgvOf({ CLAUDE_SESSION_ID: 'claude-sess' }).indexOf('--session') + 1])
            .toBe('claude-sess');
        const codex = dispatchArgvOf({ CODEX_SESSION_ID: 'codex-sess' });
        expect(codex[codex.indexOf('--session') + 1]).toBe('codex-sess');
    });

    it('never forwards a tmux session id, and omits the flag when nothing is available', () => {
        expect(dispatchArgvOf({})).not.toContain('--session');
        expect(dispatchArgvOf({ XTRM_SESSION_ID: '$1' })).not.toContain('--session');
        // A tmux-shaped value under a worker variable is refused too.
        expect(dispatchArgvOf({ PI_SESSION_ID: '$7' })).not.toContain('--session');
        // The worker value wins over a tmux id sitting beside it.
        const both = dispatchArgvOf({ PI_SESSION_ID: 'worker-1', XTRM_SESSION_ID: '$3' });
        expect(both[both.indexOf('--session') + 1]).toBe('worker-1');
    });
});

describe('resolveWorkerSessionId', () => {
    it('takes the first present, non-tmux value', () => {
        expect(resolveWorkerSessionId({ PI_SESSION_ID: 'pi-1', CLAUDE_SESSION_ID: 'c-1' })).toBe('pi-1');
        expect(resolveWorkerSessionId({ CLAUDE_SESSION_ID: 'c-1' })).toBe('c-1');
        expect(resolveWorkerSessionId({ PI_SESSION_ID: '   ' })).toBeNull();
        expect(resolveWorkerSessionId({ PI_SESSION_ID: '$2' })).toBeNull();
        expect(resolveWorkerSessionId({})).toBeNull();
    });

    it('skips a tmux-shaped value and keeps looking', () => {
        expect(resolveWorkerSessionId({ PI_SESSION_ID: '$1', CLAUDE_SESSION_ID: 'c-2' })).toBe('c-2');
    });
});

// CORE-2728 (D8): the recovery dispatch carries WHO dispatched this worker (its own
// launch-recalled participant) and the dispatcher's session when a live session of
// that participant carries a Claude session id. Absent stays absent.
describe('linkCreatedPr dispatch carries the dispatcher identity (CORE-2728)', () => {
    const SESSION_UUID = '01a1ec56-3da4-77fb-aed5-c6dee5eb40ce';

    function registry(
        holder: string,
        sessionId: string | null = SESSION_UUID,
    ): { dir: string; deps: import('../core/dispatcher-identity.js').DispatcherIdentityDeps } {
        const dir = mkdtempSync(join(tmpdir(), 'xtrm-gh-pr-link-dispatcher-'));
        mkdirSync(join(dir, 'sessions'), { recursive: true });
        writeFileSync(join(dir, 'sessions', '100.json'), JSON.stringify({
            pid: 100,
            name: 'g04z-lead',
            messagingSocketPath: '/run/cc/100.sock',
            ...(sessionId === null ? {} : { sessionId }),
        }));
        return {
            dir,
            deps: {
                sessionsDir: join(dir, 'sessions'),
                readProcess: () => ({ ppid: 1 }),
                readEnviron: (pid: number) => (pid === 100 ? { SUBSTRATE_HOLDER: holder } : null),
                env: {},
            },
        };
    }

    it('passes --dispatcher-participant and --dispatcher-session from the worker environment', () => {
        const { dir, deps } = registry('g04z');
        try {
            const { calls } = recoveryDeps({
                attachErrors: ['no_receipt: no receipt for this issue'],
                env: { SUBSTRATE_HOLDER: 'pi152-core', XTRM_DISPATCHER_PARTICIPANT: 'g04z' },
                dispatcherDeps: deps,
            });
            const dispatch = calls.find((c) => c.kind === 'dispatch');
            expect(dispatch?.argv).toContain('--dispatcher-participant');
            expect(dispatch?.argv[dispatch.argv.indexOf('--dispatcher-participant') + 1]).toBe('g04z');
            expect(dispatch?.argv).toContain('--dispatcher-session');
            expect(dispatch?.argv[dispatch.argv.indexOf('--dispatcher-session') + 1]).toBe(SESSION_UUID);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('passes no dispatcher flag when the worker environment names no participant', () => {
        const { dir, deps } = registry('g04z');
        try {
            const { calls } = recoveryDeps({
                attachErrors: ['no_receipt: no receipt for this issue'],
                env: { SUBSTRATE_HOLDER: 'pi152-core' },
                dispatcherDeps: deps,
            });
            const dispatch = calls.find((c) => c.kind === 'dispatch');
            expect(dispatch?.argv).not.toContain('--dispatcher-participant');
            expect(dispatch?.argv).not.toContain('--dispatcher-session');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('CORE-2728 F5: a tmux `$N` registry session id passes no --dispatcher-session', () => {
        const { dir, deps } = registry('g04z', '$42');
        try {
            const { calls } = recoveryDeps({
                attachErrors: ['no_receipt: no receipt for this issue'],
                env: { XTRM_DISPATCHER_PARTICIPANT: 'g04z' },
                dispatcherDeps: deps,
            });
            const dispatch = calls.find((c) => c.kind === 'dispatch');
            expect(dispatch?.argv).toContain('--dispatcher-participant');
            expect(dispatch?.argv).not.toContain('--dispatcher-session');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('CORE-2728 F6: a participant sb would refuse passes neither dispatcher flag', () => {
        const { dir, deps } = registry('g04z');
        try {
            const { calls } = recoveryDeps({
                attachErrors: ['no_receipt: no receipt for this issue'],
                // 129 characters: over the Substrate label bound -> no flag at all.
                env: { XTRM_DISPATCHER_PARTICIPANT: `not a label-${'x'.repeat(117)}` },
                dispatcherDeps: deps,
            });
            const dispatch = calls.find((c) => c.kind === 'dispatch');
            expect(dispatch?.argv).not.toContain('--dispatcher-participant');
            expect(dispatch?.argv).not.toContain('--dispatcher-session');
            // The session is only ever looked up FOR a passed participant.
            expect(dispatch?.argv).toContain('CORE-2607');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a participant with no live session passes the participant and no session', () => {
        const { dir, deps } = registry('someone-else');
        try {
            const { calls } = recoveryDeps({
                attachErrors: ['no_receipt: no receipt for this issue'],
                env: { XTRM_DISPATCHER_PARTICIPANT: 'g04z' },
                dispatcherDeps: deps,
            });
            const dispatch = calls.find((c) => c.kind === 'dispatch');
            expect(dispatch?.argv).toContain('--dispatcher-participant');
            expect(dispatch?.argv).not.toContain('--dispatcher-session');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// CORE-2745: the recovery in remote mode, timed. Every sb call costs a fixed wall
// time, and a call that outlives the budget it was given is killed the way
// spawnSync reports it ("no answer in N ms"). The clock is virtual, so the case is
// deterministic and the assertions are about the budget arithmetic, not the host.
const COMPLETE_BODY = ['pr', 'create', '--body', '<!-- xtrm issue=CORE-2607 holder=pi152-core run=01a1cc7e -->'];
const NO_RECEIPT = 'no_receipt: no receipt for this issue; run sb provenance dispatch CORE-2607 first';

function latencyDeps(options: {
    perCallMs: number;
    env?: NodeJS.ProcessEnv;
    readFile?: (file: string) => string;
    held?: boolean;
    holder?: string;
}): { result: GhPrLinkResult; calls: { kind: string; timeoutMs: number }[]; elapsedMs: number } {
    const clock = { now: 1_000_000 };
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const calls: { kind: string; timeoutMs: number }[] = [];
    const holder = options.holder ?? 'pi152-core';
    const { runGit } = gitFake({ branch: 'core-2745-budget', mergeBases: { 'origin/HEAD': BASE } });
    let attachIndex = 0;
    /** Charge one call and report a kill when its own budget cannot cover it. */
    const spend = (kind: string, timeoutMs?: number): { ok: false; error: string } | null => {
        calls.push({ kind, timeoutMs: timeoutMs ?? -1 });
        clock.now += options.perCallMs;
        if (typeof timeoutMs === 'number' && timeoutMs < options.perCallMs) {
            return { ok: false, error: `sb (sb) exited null: sb: no answer in ${timeoutMs} ms` };
        }
        return null;
    };
    let result: GhPrLinkResult;
    try {
        result = linkCreatedPr(CREATED, COMPLETE_BODY, {
            cwd: '/repo',
            env: options.env ?? {},
            runGit,
            ...(options.readFile ? { readFile: options.readFile } : { readFile: () => { throw new Error('no file'); } }),
            runSb: () => {
                spend('project-list');
                return { status: 0, stdout: projectList(PROJECTS), stderr: '' };
            },
            runAttach: (args, _env, timeoutMs) => {
                const kind = args[1] === 'show' ? 'show'
                    : args[1] === 'attach' ? 'attach'
                        : args[1] === 'dispatch' ? 'dispatch'
                            : args[1] === 'allocate' ? 'allocate'
                                : 'issue-link';
                const killed = spend(kind, timeoutMs);
                if (killed) return killed;
                if (kind === 'attach') {
                    const failed = attachIndex++ === 0;
                    return failed ? { ok: false, error: NO_RECEIPT, stdout: '' } : { ok: true, stdout: '' };
                }
                if (kind === 'show') {
                    const claim = options.held === false ? null : { holder, activationId: null, releasedAt: null };
                    return { ok: true, stdout: JSON.stringify({ schema: 'substrate-cli/v1', command: 'issue.show', ok: true, data: { claim } }) };
                }
                return { ok: true, stdout: '' };
            },
        });
    } finally {
        spy.mockRestore();
    }
    return { result, calls, elapsedMs: clock.now - 1_000_000 };
}

describe('the recovery fits the budget in remote mode (CORE-2745)', () => {
    it('completes the whole sequence at 1500 ms per call, inside the remote budget', () => {
        const { result, calls, elapsedMs } = latencyDeps({
            perCallMs: 1_500,
            readFile: () => REMOTE_CONFIG,
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        expect(result.attached).toBe(true);
        expect(result.warning).toBeUndefined();
        // Every step of the real sequence ran, and the sum stays inside the budget.
        expect(calls.map((call) => call.kind)).toEqual(['project-list', 'attach', 'show', 'dispatch', 'allocate', 'attach', 'issue-link']);
        expect(elapsedMs).toBe(7 * 1_500);
        expect(elapsedMs).toBeLessThan(REMOTE_ATTACH_TIMEOUT_MS);
        // Each call was given the remaining budget, never the local five seconds.
        for (const call of calls.slice(1)) expect(call.timeoutMs).toBeGreaterThan(0);
    });

    it('the same latency cannot fit the local budget: one line names the step and the finish command', () => {
        const { result } = latencyDeps({ perCallMs: 1_500, env: { SUBSTRATE_HOLDER: 'pi152-core' } });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/created xtrm-dev\/core#912, but the Substrate link to CORE-2607 ran out of time at the claim read \(sb issue show\)/);
        expect(result.warning).toMatch(/finish with: sb issue show CORE-2607 --json, then sb provenance dispatch CORE-2607/);
        expect(result.warning).toContain('--project prj_core');
        // ONE stderr line: the shim prefixes it and never splits it.
        expect(result.warning).not.toMatch(/\n/);
    });

    // CORE-2745 review F1: the claim-read step is the one that FINDS the holder, so
    // the finish line must carry the read and a dispatch sb will accept on a
    // live-held Issue. A bare `dispatch` is refused there (anti-steal), which is the
    // very case the read exists for.
    it('finishes a claim-read timeout with the participant, not a dispatch sb would refuse', () => {
        const { result } = latencyDeps({ perCallMs: 1_500, env: { SUBSTRATE_HOLDER: 'pi152-core' } });
        expect(result.warning).toMatch(/finish with: sb issue show CORE-2607 --json, then sb provenance dispatch CORE-2607 --participant pi152-core --activation '<activationId from the show>' --project prj_core, then sb provenance allocate CORE-2607 --project prj_core, then sb provenance attach CORE-2607 pr xtrm-dev\/core#912 --project prj_core/);
        expect(result.warning).toMatch(/--participant pi152-core only when the show answer names it as the claim holder, and --activation is that answer's activationId/);
        expect(result.warning).not.toMatch(/\n/);
    });

    it('names the step the budget ended at, and the exact command that finishes from there', () => {
        // 6000 ms: the project list, attach and claim read fit; dispatch does not.
        const { result } = latencyDeps({
            perCallMs: 1_500,
            env: { SUBSTRATE_HOLDER: 'pi152-core', [LINK_TIMEOUT_ENV_VAR]: '6000' },
            held: true,
        });
        expect(result.attached).toBe(false);
        expect(result.warning).toMatch(/ran out of time at sb provenance dispatch; finish with: sb provenance dispatch CORE-2607/);
        expect(result.warning).toMatch(/then sb provenance allocate CORE-2607 --project prj_core, then sb provenance attach CORE-2607 pr xtrm-dev\/core#912 --project prj_core/);
        expect(result.warning).not.toMatch(/\n/);
    });

    it('names the move when the retry attach is what ran out of time', () => {
        const { result, calls } = latencyDeps({
            perCallMs: 1_500,
            readFile: () => REMOTE_CONFIG,
            env: { SUBSTRATE_HOLDER: 'pi152-core', [LINK_TIMEOUT_ENV_VAR]: '8500' },
        });
        // project list + attach + claim read + dispatch + allocate = 7500 ms of 8500,
        // so the retry leaves no room: T1 stays unattached, and the line says so.
        expect(result.attached).toBe(false);
        expect(calls.at(-1)?.kind).toBe('allocate');
        expect(calls.filter((call) => call.kind === 'attach')).toHaveLength(1);
        expect(result.warning).toMatch(/ran out of time at the sb provenance attach retry; finish with: sb provenance attach CORE-2607 pr xtrm-dev\/core#912 --project prj_core/);
        expect(result.warning).not.toMatch(/\n/);
    });

    it('names the commit-evidence command when only T2 runs out of time', () => {
        // 10400 ms: T1 and the recovery land, the commit evidence does not.
        const { result, calls } = latencyDeps({
            perCallMs: 1_500,
            readFile: () => REMOTE_CONFIG,
            env: { SUBSTRATE_HOLDER: 'pi152-core', [LINK_TIMEOUT_ENV_VAR]: '10400' },
        });
        expect(calls.at(-1)?.kind).toBe('issue-link');
        expect(result.attached).toBe(true);
        expect(result.warning).toMatch(/linked xtrm-dev\/core#912 to CORE-2607, but its commit evidence ran out of time at sb issue link pr; finish with: sb issue link pr CORE-2607 --repo xtrm-dev\/core --number 912 --commits-range/);
        expect(result.warning).not.toMatch(/\n/);
    });
});

describe('the recovery makes fewer round trips (CORE-2745)', () => {
    it('skips the claim read when the shell has no holder: no participant could be sent', () => {
        const { result, calls } = recoveryDeps({ attachErrors: [NO_RECEIPT], env: {} });
        expect(result.attached).toBe(true);
        expect(calls.filter((call) => call.kind === 'show')).toHaveLength(0);
        const dispatch = calls.find((call) => call.kind === 'dispatch');
        expect(dispatch?.argv).not.toContain('--participant');
    });

    it('reuses the claim the failed attach already answered with', () => {
        const payload = JSON.stringify({
            schema: 'substrate-cli/v1',
            command: 'provenance.attach',
            ok: false,
            error: NO_RECEIPT,
            data: { claim: { holder: 'pi152-core', activationId: 'act-42', releasedAt: null } },
        });
        const { result, calls } = recoveryDeps({
            attachErrors: [NO_RECEIPT],
            attachFailureStdout: payload,
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        expect(result.attached).toBe(true);
        expect(calls.filter((call) => call.kind === 'show')).toHaveLength(0);
        const dispatch = calls.find((call) => call.kind === 'dispatch');
        expect(dispatch?.argv).toContain('--participant');
        expect(dispatch?.argv[dispatch.argv.indexOf('--activation') + 1]).toBe('act-42');
    });

    it('still reads the claim when the attach answer carries none, and keeps the anti-steal rule', () => {
        const { calls } = recoveryDeps({
            attachErrors: [NO_RECEIPT],
            attachFailureStdout: JSON.stringify({ schema: 'substrate-cli/v1', command: 'provenance.attach', ok: false, error: NO_RECEIPT }),
            held: true,
            holder: 'someone-else',
            env: { SUBSTRATE_HOLDER: 'pi152-core' },
        });
        expect(calls.filter((call) => call.kind === 'show')).toHaveLength(1);
        const dispatch = calls.find((call) => call.kind === 'dispatch');
        // The shell holder differs from the claim holder: no participant, so sb's
        // own anti-steal refusal is the message rather than a forged identity.
        expect(dispatch?.argv).not.toContain('--participant');
    });
});
