// CORE-2619: `run=` in the hidden xtrm marker is the worker's own runtime
// session id (PI_SESSION_ID for Pi, the Claude session id for Claude). A tmux
// session id ($0, $1, $7 — what XTRM_SESSION_ID carries) is shared by every
// window in that tmux session, so it cannot attribute a run. CORE-2618 reported
// `XTRM_SESSION_ID=$1` as a quoting bug; it was the real tmux id of the shared
// session, so the defect is the marker guidance and this refusal, not a quote.
//
// The CLI half runs the built CLI (cli/dist/index.cjs, tracked and checked by
// CI), because the gh shim executes it as a separate program.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { markerRunRefusal } from '../core/gh-pr-link.js';
import { markerRunVerdict, TMUX_SESSION_ID_PATTERN } from '../core/review-posting.js';

const CLI = resolve(__dirname, '..', '..', 'dist', 'index.cjs');
const RUN_UUID = '01a1cb5f-5915-7026-b5ba-d3041434385c';

describe('markerRunVerdict', () => {
    it('refuses a tmux session id and names the right variable', () => {
        const verdict = markerRunVerdict('$1');
        expect(verdict).toContain('run=$1 is a tmux session id (XTRM_SESSION_ID)');
        expect(verdict).toContain('every window');
        expect(verdict).toContain('PI_SESSION_ID for Pi');
        expect(verdict).toContain('Claude session id for Claude');
    });

    it('treats every $N form as a tmux session id, not just $1', () => {
        // $1 is the value CORE-2618 reported; the rule is the shape, not the number.
        for (const value of ['$0', '$1', '$7', '$123']) {
            expect(TMUX_SESSION_ID_PATTERN.test(value)).toBe(true);
            expect(markerRunVerdict(value)).toContain('tmux session id');
        }
    });

    it('accepts a runtime session id', () => {
        expect(markerRunVerdict(RUN_UUID)).toBeNull();
        expect(markerRunVerdict('run-9c1f')).toBeNull();
        expect(markerRunVerdict('  0b7e4a  ')).toBeNull();
    });

    it('refuses a quoted tmux session id (CORE-2622)', () => {
        // A shell that does not expand $1 writes the quotes into the marker.
        for (const value of ['"$1"', "'$1'", ' " $7 " ']) {
            expect(markerRunVerdict(value)).toContain('tmux session id');
        }
        // The refusal reads like the marker, so the quote style survives into it.
        expect(markerRunVerdict('"$1"')).toContain('run="$1" is a tmux session id');
    });

    it('accepts a quoted runtime session id', () => {
        expect(markerRunVerdict(`"${RUN_UUID}"`)).toBeNull();
    });

    it('leaves an absent run= to the other marker rules', () => {
        expect(markerRunVerdict(undefined)).toBeNull();
        expect(markerRunVerdict(null)).toBeNull();
        expect(markerRunVerdict('')).toBeNull();
        expect(markerRunVerdict('   ')).toBeNull();
    });

    it('does not read a $N that is not the whole value', () => {
        expect(markerRunVerdict('run-$1')).toBeNull();
        expect(markerRunVerdict('$1x')).toBeNull();
        expect(markerRunVerdict('XTRM_SESSION_ID')).toBeNull();
    });
});

describe('markerRunRefusal', () => {
    const readFile = () => '';

    it('refuses the body marker', () => {
        const refusal = markerRunRefusal(
            ['pr', 'create', '--body', '<!-- xtrm issue=CORE-2619 holder=pi152-core run=$1 -->'],
            readFile,
        );
        expect(refusal).toContain('PI_SESSION_ID');
    });

    it('refuses the marker from --body-file', () => {
        const refusal = markerRunRefusal(
            ['pr', 'create', '--body-file', 'body.md'],
            () => '<!-- xtrm issue=CORE-2619 holder=pi152-core run=$4 -->',
        );
        expect(refusal).toContain('run=$4');
    });

    it('accepts a runtime session id', () => {
        expect(markerRunRefusal(['pr', 'create', '--body', `<!-- xtrm issue=CORE-2619 holder=h run=${RUN_UUID} -->`], readFile))
            .toBeNull();
    });

    it('refuses a quoted run= in the body, and in an edit (CORE-2622)', () => {
        const body = '<!-- xtrm issue=CORE-2622 holder=h run="$1" -->';
        expect(markerRunRefusal(['pr', 'create', '--body', body], readFile)).toContain('PI_SESSION_ID');
        expect(markerRunRefusal(['pr', 'edit', '5', '--body', body], readFile)).toContain('PI_SESSION_ID');
    });

    it('is not decided by a marker inside a code fence or in a quote', () => {
        const fenced = ['```md', '<!-- xtrm issue=CORE-2619 holder=h run=$1 -->', '```'].join('\n');
        expect(markerRunRefusal(['pr', 'create', '--body', fenced], readFile)).toBeNull();
        const quoted = '> <!-- xtrm issue=CORE-2619 holder=h run=$1 -->';
        expect(markerRunRefusal(['pr', 'create', '--body', quoted], readFile)).toBeNull();
    });

    it('takes the last marker, the one the guard and the link use', () => {
        const both = [
            '<!-- xtrm issue=CORE-2619 holder=h run=$1 -->',
            `<!-- xtrm issue=CORE-2619 holder=h run=${RUN_UUID} -->`,
        ].join('\n');
        expect(markerRunRefusal(['pr', 'create', '--body', both], readFile)).toBeNull();
    });

    it('says nothing when the create carries no body at all', () => {
        expect(markerRunRefusal(['pr', 'create', '--title', 'no body'], readFile)).toBeNull();
    });
});

describe('xt identity marker-check (what the gh shim calls)', () => {
    let dir = '';

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'xtrm-marker-run-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function markerCheck(argv: string[], cwd = dir): { status: number | null; json: { ok: boolean; refusal: string | null } | null } {
        const result = spawnSync(
            process.execPath,
            [CLI, 'identity', 'marker-check', '--argv', JSON.stringify(argv), '--cwd', cwd],
            { encoding: 'utf8', cwd },
        );
        let json: { ok: boolean; refusal: string | null } | null = null;
        try {
            json = JSON.parse(result.stdout || 'null') as { ok: boolean; refusal: string | null } | null;
        } catch {
            json = null;
        }
        return { status: result.status, json };
    }

    it('refuses a $N run= and exits 0, so the shim can read the refusal', () => {
        const checked = markerCheck(['pr', 'create', '--body', '<!-- xtrm issue=CORE-2619 holder=h run=$1 -->']);
        expect(checked.status).toBe(0);
        expect(checked.json?.ok).toBe(true);
        expect(checked.json?.refusal).toContain('PI_SESSION_ID');
    });

    it('answers null for a runtime session id', () => {
        const checked = markerCheck(['pr', 'create', '--body', `<!-- xtrm issue=CORE-2619 holder=h run=${RUN_UUID} -->`]);
        expect(checked.status).toBe(0);
        expect(checked.json).toEqual({ ok: true, refusal: null });
    });

    it('reads a relative --body-file against --cwd', () => {
        writeFileSync(join(dir, 'body.md'), '<!-- xtrm issue=CORE-2619 holder=h run=$2 -->\n');
        const checked = markerCheck(['pr', 'create', '--body-file', 'body.md']);
        expect(checked.json?.refusal).toContain('run=$2');
    });

    it('exits 2 on an unreadable argv, so a shim failure stays fail-open', () => {
        const result = spawnSync(process.execPath, [CLI, 'identity', 'marker-check', '--argv', 'not-json'], { encoding: 'utf8' });
        expect(result.status).toBe(2);
        expect(result.stdout).toContain('"refusal":null');
    });
});

describe('clear surface (CORE-2622 review, rule: a verb the shim calls is in xt help)', () => {
    it('xt help lists the marker-check verb in the IDENTITY block', () => {
        const result = spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('xt identity marker-check');
        // It belongs to the identity surface, next to the other shim verbs.
        const identityBlock = result.stdout.slice(result.stdout.indexOf('AGENT IDENTITY (GITHUB APPS)'));
        expect(identityBlock.indexOf('xt identity marker-check')).toBeGreaterThan(-1);
        expect(identityBlock.indexOf('xt identity marker-check')).toBeLessThan(identityBlock.indexOf('xt identity setup'));
    });
});
