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
let nodeOnly = '';

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
            PATH: `${options.path ?? bin}:${nodeOnly}`,
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
    nodeOnly = path.join(tmp, 'node-only');
    fs.mkdirSync(nodeOnly, { recursive: true });
    fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
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

describe('an unverified Issue is visible on the allow path (CORE-2590 review 1)', () => {
    it('prints one warning line naming the reason and still allows', () => {
        fakeXt({
            allow: true,
            repo: 'o/r',
            pr: 5,
            head: 'b'.repeat(40),
            issueRef: 'CORE-2590',
            issueLookup: 'unknown',
            issueLookupDetail: 'XTRM_MERGE_GUARD_OFFLINE is set',
        });
        const result = runHook('pre', mergePayload('gh pr merge 5 --repo o/r --squash'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stderr, /merge allowed without an Issue check/);
        assert.match(result.stderr, /XTRM_MERGE_GUARD_OFFLINE is set/);
        assert.equal(checkCalls().length, 1);
    });
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


describe('wrappers and absolute paths are gated (review B)', () => {
    const commands = [
        '/usr/bin/gh pr merge 5',
        'command gh pr merge 5',
        'env X=1 gh pr merge 5',
        'sudo -E gh pr merge 5',
        'time gh pr merge 5',
        'nohup gh pr merge 5',
        'exec gh pr merge 5',
        'xargs gh pr merge 5',
        '! gh pr merge 5',
        '( gh pr merge 5 )',
        '{ gh pr merge 5; }',
    ];
    for (const command of commands) {
        it(`gates: ${command}`, () => {
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, result.stderr);
            const checks = checkCalls();
            assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
            const argvAt = checks[0].argv.indexOf('--gh-args');
            const forwarded = JSON.parse(checks[0].argv[argvAt + 1]);
            assert.equal(forwarded[0], 'pr');
            assert.equal(forwarded[1], 'merge');
            assert.equal(forwarded[2], '5');
        });
    }

    it('leaves eval and command substitution to the shim', () => {
        for (const command of ['eval "gh pr merge 5"', 'sh -c "gh pr merge 5"', 'gh pr merge $(pr-number)']) {
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, `${command}: ${result.stderr}`);
        }
    });
});

describe('heredocs, comments and continuations (review C)', () => {
    it('does not gate a merge line inside a heredoc body', () => {
        const command = 'cat <<EOF > notes.txt\ngh pr merge 5\nEOF\ngit status';
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(checkCalls().length, 0);
    });

    it('still sees the merge after a heredoc command', () => {
        const command = 'cat <<\'EOF\' > notes.txt\nbody\nEOF\ngh pr merge 5';
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '5']);
    });

    it('ignores an apostrophe in a comment', () => {
        const command = "# don't gh pr merge here\ngh status";
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(checkCalls().length, 0);
    });

    it('treats backslash-newline as a continuation, not as a target', () => {
        const command = 'gh pr \\\nmerge \\\n5';
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '5']);
    });
});

describe('fail-closed, help, chains, cwd and tool scope (review D)', () => {
    it('blocks with guard ON when xt cannot run, and names the flag', () => {
        // A non-executable `xt` on PATH: spawn fails, the hook must fail closed
        // rather than let an unchecked merge through. (A truly absent binary is the
        // same branch; node's own bin directory may itself contain a global xt.)
        const broken = path.join(tmp, 'no-xt');
        fs.mkdirSync(broken, { recursive: true });
        fs.writeFileSync(path.join(broken, 'xt'), 'not executable');
        const result = runHook('pre', mergePayload('gh pr merge 5'), { XTRM_MERGE_GUARD: 'on' }, { path: broken });
        assert.equal(result.status, 2);
        assert.match(result.stderr, /XTRM_MERGE_GUARD/);
    });

    it('does not treat a flag VALUE of -h or --help as help', () => {
        for (const command of ['gh pr merge 5 --body -h', 'gh pr merge 5 --body-file --help']) {
            const before = checkCalls().length;
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(checkCalls().length - before, 1, command);
        }
    });

    it('does not gate the merge command\'s own --help', () => {
        const result = runHook('pre', mergePayload('gh pr merge 5 --help'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(checkCalls().length, 0);
    });

    it('forwards the payload cwd to merge-check', () => {
        const cwd = path.join(tmp, 'work');
        fs.mkdirSync(cwd, { recursive: true });
        const result = runHook('pre', mergePayload('gh pr merge 5', cwd), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks[0].argv[checks[0].argv.indexOf('--cwd') + 1], cwd);
    });

    it('checks every merge in a chain', () => {
        const result = runHook('pre', mergePayload('gh pr merge 5 && gh pr merge 6'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const forwarded = checkCalls().map((call) => JSON.parse(call.argv[call.argv.indexOf('--gh-args') + 1]));
        assert.deepEqual(forwarded, [['pr', 'merge', '5'], ['pr', 'merge', '6']]);
    });

    it('never checks a non-Bash tool', () => {
        const result = runHook('pre', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { command: 'gh pr merge 5' } }, { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0);
        assert.equal(checkCalls().length, 0);
    });

    it('reports an oversized command accurately, and allows it with the guard off', () => {
        const huge = `gh pr merge 5 --body ${'x'.repeat(110_000)}`;
        const on = runHook('pre', mergePayload(huge), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(on.status, 2);
        assert.match(on.stderr, /too large to inspect/);
        const off = runHook('pre', mergePayload(huge), {});
        assert.equal(off.status, 0);
    });
});


describe('quoted heredoc delimiters (review 1)', () => {
    const bodies = [
        ["<<'EOF'", 'EOF'],
        ['<<"EOF"', 'EOF'],
        ['<<\\EOF', 'EOF'],
        ['<<E"O"F', 'EOF'],
        ['<<-EOF', '\tEOF'],
    ];
    for (const [marker, terminator] of bodies) {
        it(`skips a ${marker} body that contains a merge`, () => {
            const command = `gh pr create --body-file - ${marker}\nReview body\ngh pr merge 5\n${terminator}`;
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(checkCalls().length, 0, command);
        });
    }

    it('an apostrophe in a quoted body does not hide the merge after the terminator', () => {
        const command = "cat <<'EOF' > f\ndon't merge this\nEOF\ngh pr merge 5";
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '5']);
    });
});

describe('a trailing comment does not swallow the next command (review 2)', () => {
    it('gates the merge after a commented command', () => {
        const command = 'git status # check\ngh pr merge --repo o/r 5';
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '--repo', 'o/r', '5']);
    });

    it('still ignores a leading comment line and a CRLF command', () => {
        const leading = runHook('pre', mergePayload('# check\ngh pr merge 5'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(leading.status, 0, leading.stderr);
        assert.equal(checkCalls().length, 1);
        const crlf = runHook('pre', mergePayload('gh pr merge 5\r\n'), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(crlf.status, 0, crlf.stderr);
        assert.equal(checkCalls().length, 2);
    });
});

describe('parentheses and braces separate commands (H25)', () => {
    for (const command of ['(gh pr merge 5)', 'gh pr merge 5) || true', '{ gh pr merge 5; }', '( gh pr merge 5 ) && true']) {
        it(`gates: ${command}`, () => {
            const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
            assert.equal(result.status, 0, result.stderr);
            const checks = checkCalls();
            assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
            const argvAt = checks[0].argv.indexOf('--gh-args');
            assert.equal(JSON.parse(checks[0].argv[argvAt + 1])[2], '5');
        });
    }
});

describe('heredoc LOWs from the #883 review', () => {
    it('registers two heredocs on one line and skips both bodies', () => {
        // `cat <<'A' <<"B"` has both bodies after the newline, in order.
        const command = "cat <<'A' <<\"B\" > out.txt\ngh pr merge 7\nA\ngh pr merge 8\nB\ngh pr merge 9";
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1, checks.map((call) => call.argv.join(' ')).join(' | '));
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '9']);
    });

    it('matches the terminator exactly for an unquoted heredoc', () => {
        // ' EOF' and 'EOFX' are body lines, not terminators; the merge inside the
        // body must stay inert and the merge after the exact terminator must gate.
        const command = "cat <<EOF > out.txt\nbody\n EOF\ngh pr merge 7\nEOF\ngh pr merge 9";
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1);
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '9']);
    });

    it('accepts blanks between << and the delimiter', () => {
        const command = "cat <<   'EOF' > out.txt\ngh pr merge 7\nEOF\ngh pr merge 9";
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        const checks = checkCalls();
        assert.equal(checks.length, 1);
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '9']);
    });

    it('gates a merge after a tab-indented <<- terminator', () => {
        const command = 'cat <<-EOF > out.txt\n\tbody\n\tEOF\ngh pr merge 5';
        const result = runHook('pre', mergePayload(command), { XTRM_MERGE_GUARD: 'on' });
        const checks = checkCalls();
        assert.equal(checks.length, 1);
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '5']);
    });

    it('does not let an apostrophe in a trailing comment hide the next merge (H22)', () => {
        const result = runHook('pre', mergePayload("git status # don't merge\ngh pr merge 5"), { XTRM_MERGE_GUARD: 'on' });
        assert.equal(result.status, 0, result.stderr);
        const checks = checkCalls();
        assert.equal(checks.length, 1);
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '5']);
    });

    it('carries no carriage return into the argv for a CRLF command (H32)', () => {
        const result = runHook('pre', mergePayload('gh pr merge 5\r\n'), { XTRM_MERGE_GUARD: 'on' });
        const checks = checkCalls();
        assert.equal(checks.length, 1);
        const argvAt = checks[0].argv.indexOf('--gh-args');
        assert.deepEqual(JSON.parse(checks[0].argv[argvAt + 1]), ['pr', 'merge', '5']);
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
