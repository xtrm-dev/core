// CORE-2530: the xtrm-review-gate hook, executed as the real process Claude Code
// runs, with an stdin PreToolUse payload and a fake `xt` on PATH.
//
// Covers the review findings: text that merely mentions `gh pr merge` must not
// trigger; guard OFF is inert; the hook forwards the gh argv it parsed verbatim,
// so the PR it checks is the PR the shim resolves; quoted and root-flag forms
// resolve; the override is never decided by the hook.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const HOOK = path.join(process.cwd(), 'hooks', 'xtrm-review-gate.mjs');
const NODE_DIR = path.dirname(process.execPath);

let tmp = '';
let bin = '';
let calls = '';

function writeExecutable(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.chmodSync(file, 0o755);
}

/** A fake xt that records every invocation (argv + the override it saw). */
function fakeXt(answer = { allow: true, repo: 'o/r', pr: 5, head: 'b'.repeat(40) }, exitCode = 0) {
    const body = `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ argv: process.argv.slice(2), override: process.env.XTRM_MERGE_GUARD_OVERRIDE || '' }) + '\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(answer))});
process.exit(${exitCode});
`;
    writeExecutable(path.join(bin, 'xt'), body);
}

function runHook(mode, payload, extraEnv = {}, options = {}) {
    const result = spawnSync(process.execPath, [HOOK, mode], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: {
            // The fake xt runs on node, so node's own directory stays on PATH; the
            // hook's `xt` lookup is confined to the first entry.
            PATH: `${options.path ?? bin}:${NODE_DIR}`,
            HOME: tmp,
            ...extraEnv,
        },
        cwd: options.cwd ?? tmp,
        timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function mergePayload(command, cwd = tmp) {
    return { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } };
}

function recorded() {
    try {
        return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
        return [];
    }
}

function checkCalls() {
    return recorded().filter((call) => call.argv[0] === 'identity' && call.argv[1] === 'merge-check');
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-gate-'));
    bin = path.join(tmp, 'bin');
    calls = path.join(tmp, 'calls.log');
    fs.mkdirSync(bin, { recursive: true });
    fakeXt();
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('mentions never trigger the guard (item 1)', () => {
    const commands = [
        "gh pr create --body 'this mentions gh pr merge in prose'",
        "git commit -m 'notes: never gh pr merge without a review'",
        "git commit -F - <<'EOF'\nsubject\n\nwe should not gh pr merge this\nEOF",
        "rg 'gh pr merge' src",
        "sb journal append CORE-1 --kind note --semantic '{\"summary\":\"ran gh pr merge 5\"}'",
        'echo "gh pr merge 5"',
    ];
    for (const command of commands) {
        it(`allows: ${command.split('\n')[0].slice(0, 48)}`, () => {
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(checkCalls().length, 0);
        });
    }
});

describe('guard OFF is inert in every case (item 2)', () => {
    it('allows with no cwd PR and with xt absent from PATH', () => {
        const empty = path.join(tmp, 'empty-bin');
        fs.mkdirSync(empty, { recursive: true });
        const result = runHook('pre', mergePayload('gh pr merge 5'), {}, { path: empty });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(checkCalls().length, 0);
    });

    it('allows an unresolvable branch merge with the guard off', () => {
        const result = runHook('pre', mergePayload('gh pr merge feat-x'), {});
        assert.equal(result.status, 0, result.stderr);
    });
});

describe('the hook forwards the argv it parsed (item 3)', () => {
    const cases = [
        ['gh pr merge 5', ['pr', 'merge', '5']],
        ['gh pr merge feat-x', ['pr', 'merge', 'feat-x']],
        ['gh pr merge 5 -Ro/r', ['pr', 'merge', '5', '-Ro/r']],
        ['gh pr merge --repo o/r -b 42 5', ['pr', 'merge', '--repo', 'o/r', '-b', '42', '5']],
        ['gh pr merge https://github.com/o/r/pull/77', ['pr', 'merge', 'https://github.com/o/r/pull/77']],
    ];
    for (const [command, expected] of cases) {
        it(`passes ${command} verbatim`, () => {
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, result.stderr);
            const checks = checkCalls();
            assert.equal(checks.length, 1);
            const argvAt = checks[0].argv.indexOf('--gh-args');
            assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), expected);
        });
    }

    it('blocks when the guard refuses, with the guard message', () => {
        fakeXt({ allow: false, repo: 'o/r', pr: 5, head: '', message: 'merge refused: no review at head' }, 1);
        const result = runHook('pre', mergePayload('gh pr merge 5'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /no review at head/);
    });
});

describe('the override is merge-check business, not the hook’s (item 4)', () => {
    it('still calls the guard when an inline override precedes the command', () => {
        const result = runHook('pre', mergePayload('XTRM_MERGE_GUARD_OVERRIDE=why gh pr merge 5'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1);
        // The assignment reaches merge-check, which applies the role gate and the log.
        assert.equal(checks[0].override, 'why');
    });

    it('forwards an env override to the guard instead of allowing locally', () => {
        const result = runHook('pre', mergePayload('gh pr merge 5'), { XTRM_MERGE_GUARD: 'on', XTRM_MERGE_GUARD_OVERRIDE: 'why' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(checkCalls().length, 1);
        assert.equal(checkCalls()[0].override, 'why');
    });

    it('blocks when the guard refuses a worker override', () => {
        fakeXt({ allow: false, repo: 'o/r', pr: 5, head: '', message: 'override refused: the role worker may not override' }, 1);
        const result = runHook('pre', mergePayload('gh pr merge 5'), { XTRM_MERGE_GUARD: 'on', XTRM_MERGE_GUARD_OVERRIDE: 'why' });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /override refused/);
    });
});

describe('guarded forms (item 5)', () => {
    const commands = [
        ['gh -R o/r pr merge 5', ['-R', 'o/r', 'pr', 'merge', '5']],
        ['gh pr -R o/r merge 5', ['pr', '-R', 'o/r', 'merge', '5']],
        ["gh 'pr' merge 5", ['pr', 'merge', '5']],
        ['"gh" pr merge 5', ['pr', 'merge', '5']],
        ['gh pr merge 5; ls -h', ['pr', 'merge', '5']],
        ['gh pr merge 5 && echo --help', ['pr', 'merge', '5']],
    ];
    for (const [command, expected] of commands) {
        it(`gates ${command}`, () => {
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, result.stderr);
            const checks = checkCalls();
            assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
            const argvAt = checks[0].argv.indexOf('--gh-args');
            assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), expected);
        });
    }

    it('does not gate gh api (the shim is the backstop)', () => {
        const result = runHook('pre', mergePayload('gh api repos/o/r/pulls/5/merge -X PUT'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0);
        assert.equal(checkCalls().length, 0);
    });
});

describe('the create reminder (post)', () => {
    it('prints the tier line from the fallback reminder when no file is installed', () => {
        const result = runHook('post', {
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'gh pr create --title x --body y' },
            tool_response: { stdout: 'https://github.com/o/r/pull/12' },
        });
        assert.equal(result.status, 0);
        const output = JSON.parse(result.stdout);
        const text = output.hookSpecificOutput.additionalContext;
        assert.match(text, /HIGH or critical scrutiny: Claude-backed reviewer/);
        assert.match(text, /pull\/12/);
    });
});
