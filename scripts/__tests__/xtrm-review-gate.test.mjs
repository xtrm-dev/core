// CORE-2530: the xtrm-review-gate hook, executed as the real process Claude Code
// runs. A fake `xt` and a fake `gh` on PATH prove the blocking and the reminder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const HOOK = path.join(process.cwd(), 'hooks', 'xtrm-review-gate.mjs');

let tmp = '';
let bin = '';

function writeExecutable(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
}

function fakeXt(exitCode, stderr) {
    writeExecutable(path.join(bin, 'xt'), `#!/bin/sh\nprintf '%s' "$XTRM_TEST_STDERR" >&2\nexit ${exitCode}\n`);
    return stderr;
}

function runHook(mode, payload, extraEnv = {}) {
    const result = spawnSync(process.execPath, [HOOK, mode], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: {
            PATH: bin,
            HOME: tmp,
            ...extraEnv,
        },
        timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function payload(command, extra = {}) {
    return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tmp, ...extra };
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-gate-'));
    bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pre: gh pr merge', () => {
    it('blocks with the guard refusal when xt refuses', () => {
        writeExecutable(path.join(bin, 'xt'), '#!/bin/sh\nprintf "merge refused for xtrm-dev/core#42: stale\\n" >&2\nexit 1\n');
        const result = runHook('pre', payload('gh pr merge 42 --repo xtrm-dev/core --squash'));
        assert.equal(result.status, 2);
        assert.match(result.stderr, /merge refused for xtrm-dev\/core#42: stale/);
        assert.match(result.stderr, /Do not retry the merge/);
    });

    it('allows the merge when the guard allows it', () => {
        writeExecutable(path.join(bin, 'xt'), '#!/bin/sh\nexit 0\n');
        const result = runHook('pre', payload('gh pr merge 42 --repo xtrm-dev/core --squash'));
        assert.equal(result.status, 0);
    });

    it('blocks when xt is not installed and names the override', () => {
        const result = runHook('pre', payload('gh pr merge 42 --repo xtrm-dev/core'));
        assert.equal(result.status, 2);
        assert.match(result.stderr, /merge guard could not run/);
        assert.match(result.stderr, /XTRM_MERGE_GUARD_OVERRIDE/);
    });

    it('honours the override without consulting the guard', () => {
        writeExecutable(path.join(bin, 'xt'), '#!/bin/sh\nexit 1\n');
        const result = runHook('pre', payload('gh pr merge 42 --repo xtrm-dev/core'), { XTRM_MERGE_GUARD_OVERRIDE: 'manual review done' });
        assert.equal(result.status, 0);
        assert.match(result.stderr, /not consulted/);
    });

    it('leaves other commands, help and non-Bash tools alone', () => {
        const marker = path.join(tmp, 'xt-called');
        writeExecutable(path.join(bin, 'xt'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
        for (const command of ['git status', 'gh pr merge --help', 'gh pr view 42']) {
            const result = runHook('pre', payload(command));
            assert.equal(result.status, 0, command);
        }
        const nonBash = runHook('pre', { ...payload('gh pr merge 42'), tool_name: 'Read' });
        assert.equal(nonBash.status, 0);
        assert.equal(fs.existsSync(marker), false);
    });

    it('blocks a merge whose repository and PR cannot be resolved', () => {
        writeExecutable(path.join(bin, 'gh'), '#!/bin/sh\nexit 1\n');
        writeExecutable(path.join(bin, 'xt'), '#!/bin/sh\nexit 0\n');
        const result = runHook('pre', payload('gh pr merge --squash'));
        assert.equal(result.status, 2);
        assert.match(result.stderr, /cannot determine the repository and PR/);
    });

    it('resolves the PR from the branch when only the number is missing', () => {
        writeExecutable(path.join(bin, 'gh'), '#!/bin/sh\necho "$XTRM_TEST_PR_JSON"\n');
        const calls = path.join(tmp, 'xt-args');
        writeExecutable(path.join(bin, 'xt'), `#!/bin/sh\necho "$@" >> ${calls}\nexit 0\n`);
        const result = runHook('pre', payload('gh pr merge --squash --repo xtrm-dev/core'), {
            XTRM_TEST_PR_JSON: JSON.stringify({ number: 7, url: 'https://github.com/xtrm-dev/core/pull/7' }),
        });
        assert.equal(result.status, 0);
        assert.match(fs.readFileSync(calls, 'utf8'), /identity merge-check --repo xtrm-dev\/core --pr 7/);
    });
});

describe('post: gh pr create', () => {
    it('prints the routing reminder with the PR URL and never blocks', () => {
        const result = runHook('post', payload('gh pr create --fill', {
            tool_response: { stdout: 'https://github.com/xtrm-dev/core/pull/881\n' },
        }));
        assert.equal(result.status, 0);
        const output = JSON.parse(result.stdout);
        assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
        assert.match(output.hookSpecificOutput.additionalContext, /reviewer App at its current head/);
        assert.match(output.hookSpecificOutput.additionalContext, /https:\/\/github\.com\/xtrm-dev\/core\/pull\/881/);
    });

    it('reads the installed reminder file when present', () => {
        const file = path.join(tmp, '.xtrm', 'config', 'reviewer-routing.md');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'OPERATOR EDITED ROUTING\n');
        const result = runHook('post', payload('gh pr create --fill', {
            tool_response: { stdout: 'https://github.com/xtrm-dev/core/pull/9' },
        }));
        assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /OPERATOR EDITED ROUTING/);
    });

    it('emits nothing for another command or a create without a PR URL', () => {
        assert.equal(runHook('post', payload('git status')).stdout, '');
        assert.equal(runHook('post', payload('gh pr create --fill', { tool_response: { stdout: 'boom' } })).stdout, '');
    });
});
