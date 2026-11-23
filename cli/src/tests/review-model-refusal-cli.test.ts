// XTRM-962 finding 2 (review 6015797868): the wiring that turns the model
// cross-check on *is* the call in `xt identity review-post`, and a unit test of
// the helper proves the helper instead. Before this file, three mutations left
// the suite green: reverting the call to the pre-fix expression, passing `opts`
// empty, and passing null.
//
// So this drives the built CLI with an injected environment, the way
// `identity-env-cli.test.ts` does, and relies on the ordering the command now
// has: the model refusal fires before any token is minted, which makes it
// observable on a machine with no GitHub App — and makes "reached the App" the
// control that proves the refusal is about the model and not about being offline.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '..', '..', 'dist', 'index.cjs');

// CORE-2757: one registry, one teardown. An inline `finally` does not survive a
// per-test timeout kill; the CORE-2612 guard would then name `xtrm-reviewmodel-*`.
const created: string[] = [];

function tmpdir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';

const BODY = `Review by pr-reviewer (sonnet-5.5) at head ${HEAD.slice(0, 12)}

- Verdict: PARTIAL
`;

/** Run `identity review-post` as a reviewer seat with the given model environment. */
function reviewPost(env: Record<string, string>): { status: number | null; stderr: string; stdout: string } {
    const home = tmpdir('xtrm-reviewmodel-home-');
    const dir = tmpdir('xtrm-reviewmodel-body-');
    const body = path.join(dir, 'body.md');
    fs.writeFileSync(body, BODY);
    const base: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: home,
        XTRM_ROLE: 'reviewer',
        SUBSTRATE_HOLDER: 'probe',
        // A plain environment: neither variable is inherited from the test runner,
        // so a pass cannot come from whatever model this suite happens to run under.
        PI_MODEL: undefined,
        XTRM_REVIEW_MODEL: undefined,
        XTRM_MODEL: undefined,
        ...env,
    };
    for (const key of Object.keys(base)) if (base[key] === undefined) delete base[key];
    const result = spawnSync(process.execPath, [CLI, 'identity', 'review-post', '--repo', 'xtrm-dev/core', '--pr', '1', '--body-file', body], { env: base, encoding: 'utf8', timeout: 60_000 });
    return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
}

describe('a reviewer post cannot proceed without a model to compare against', () => {
    it('refuses before minting a token when the session exposes no model', () => {
        const run = reviewPost({});
        expect(run.status).toBe(1);
        expect(run.stderr).toMatch(/no session model to compare line 1 against/);
        expect(run.stderr).toMatch(/Export \$PI_MODEL/);
        // The control that makes this an assertion about ORDER: the refusal exists
        // so a header cannot post unverified, and it must land before the App is
        // reached, otherwise a machine that has the App would post instead.
        expect(run.stderr).not.toMatch(/app\.json/);
    });

    it('proceeds past the model gate when the session exposes $PI_MODEL', () => {
        const run = reviewPost({ PI_MODEL: 'sonnet-5.5' });
        expect(run.status).toBe(1);
        expect(run.stderr).not.toMatch(/no session model to compare/);
        // No App on this machine: reaching the App is the proof that the model
        // gate let the post through, which is what the mutation must break.
        expect(run.stderr).toMatch(/app\.json|GitHub App/);
    });

    it('accepts $XTRM_REVIEW_MODEL as the expectation when $PI_MODEL is absent', () => {
        const run = reviewPost({ XTRM_REVIEW_MODEL: 'sonnet-5.5' });
        expect(run.stderr).not.toMatch(/no session model to compare/);
        expect(run.stderr).toMatch(/app\.json|GitHub App/);
    });

    it('accepts --model as the expectation when neither variable is set', () => {
        const home = tmpdir('xtrm-reviewmodel-home-');
        const dir = tmpdir('xtrm-reviewmodel-body-');
        const body = path.join(dir, 'body.md');
        fs.writeFileSync(body, BODY);
        const result = spawnSync(process.execPath, [CLI, 'identity', 'review-post', '--repo', 'xtrm-dev/core', '--pr', '1', '--body-file', body, '--model', 'sonnet-5.5'], {
            env: { PATH: process.env.PATH, HOME: home, XTRM_ROLE: 'reviewer', SUBSTRATE_HOLDER: 'probe' },
            encoding: 'utf8',
            timeout: 60_000,
        });
        expect(result.stderr ?? '').not.toMatch(/no session model to compare/);
        expect(result.stderr ?? '').toMatch(/app\.json|GitHub App/);
    });
});
