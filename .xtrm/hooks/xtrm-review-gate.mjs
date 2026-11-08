#!/usr/bin/env node
// xtrm-review-gate.mjs — client-side review gate (CORE-2530, parent CORE-2524).
//
// GitHub Actions is billing-locked and the organisation is on the Free plan, so
// nothing on GitHub requires a review before a merge. This hook is the check:
//
//   pre  (Bash): a `gh pr merge` command runs `xt identity merge-check` first.
//                A refusal exits 2, so the merge never reaches GitHub.
//   post (Bash): a successful `gh pr create` prints the reviewer routing
//                reminder for the PR's scrutiny tier. It never blocks.
//
// It runs as its own process because merge-check talks to the GitHub API and to
// Substrate, which does not fit the 2 s budget of the shared PreToolUse
// dispatcher (policy: policies/xtrm-review-gate.json, timeout 30 s).
//
// Operator safety: a hook that cannot run its guard must not silently permit a
// merge. With `xt` missing, the hook blocks and names the escape hatch
// (XTRM_MERGE_GUARD_OVERRIDE). The guard itself is fail-closed on GitHub/App
// errors; see xt identity merge-check.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const OVERRIDE_ENV = 'XTRM_MERGE_GUARD_OVERRIDE';
const GUARD_TIMEOUT_MS = 25_000;

function readPayload() {
    try {
        const text = readFileSync(0, 'utf8').trim();
        if (!text) return null;
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

function allow() {
    process.exit(0);
}

function block(reason) {
    process.stderr.write(`${reason}\n`);
    // Exit 2 is the blocking-error contract for Claude Code PreToolUse: the
    // tool call does not run and the text is shown to the agent.
    process.exit(2);
}

/** Only Bash matters here; the policy matcher says so too, and a direct call may omit it. */
function isBash(payload) {
    const tool = payload && payload.tool_name;
    return !tool || tool === 'Bash';
}

function commandOf(payload) {
    const input = payload && payload.tool_input;
    if (!input || typeof input !== 'object') return '';
    return typeof input.command === 'string' ? input.command : '';
}

/** `gh pr merge` in the command, outside a help invocation. */
function isMerge(command) {
    if (!/\bgh\s+pr\s+merge\b/.test(command)) return false;
    return !/(^|\s)(--help|-h)(\s|$)/.test(command);
}

function isCreate(command) {
    if (!/\bgh\s+pr\s+create\b/.test(command)) return false;
    return !/(^|\s)(--help|-h)(\s|$)/.test(command);
}

function tokens(command) {
    return command.split(/\s+/).filter(Boolean);
}

/** -R/--repo value, or null. */
function repoFlag(argv) {
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '-R' || token === '--repo') return argv[index + 1] ?? null;
        if (token.startsWith('--repo=')) return token.slice('--repo='.length);
        if (token.startsWith('-R=')) return token.slice(3);
    }
    return null;
}

function prFromArgv(argv) {
    for (const token of argv) {
        const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(token);
        if (url) return { repo: url[1], pr: Number(url[2]) };
    }
    for (const token of argv) {
        if (/^\d+$/.test(token)) return { repo: null, pr: Number(token) };
    }
    return null;
}

/** Resolve owner/name and number from the repository at `cwd` via the real gh. */
function resolveFromCwd(cwd) {
    const view = spawnSync('gh', ['pr', 'view', '--json', 'number,url'], {
        cwd: cwd || process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
    });
    if (view.error || view.status !== 0) return null;
    try {
        const info = JSON.parse(view.stdout);
        const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(info.url ?? '');
        if (!match) return null;
        return { repo: match[1], pr: Number(match[2]) };
    } catch (error) {
        return null;
    }
}

function reminderText() {
    const file = path.join(os.homedir(), '.xtrm', 'config', 'reviewer-routing.md');
    let text = '';
    try {
        text = readFileSync(file, 'utf8').trim();
    } catch (error) {
        text = '';
    }
    if (text) return text;
    return [
        'Review gate: do not merge this PR before a review by the reviewer App at its current head.',
        '- HIGH or critical scrutiny: Claude-backed reviewer (the reviewer subagent in PR mode, or `xt claude --role pr-reviewer`).',
        '- MEDIUM or LOW: the pr-reviewer specialist verdict is acceptable.',
        '- PASS -> APPROVE, PARTIAL -> COMMENT (needs a coordinator decision in the Issue Journal), FAIL -> REQUEST_CHANGES.',
        'Run `xt identity setup` to install the full reminder at ~/.xtrm/config/reviewer-routing.md.',
    ].join('\n');
}

function pre(payload) {
    if (!isBash(payload)) allow();
    const command = commandOf(payload);
    if (!isMerge(command)) allow();
    if ((process.env[OVERRIDE_ENV] ?? '').trim()) {
        process.stderr.write(`xtrm-review-gate: ${OVERRIDE_ENV} is set; the merge guard was not consulted\n`);
        allow();
    }
    const argv = tokens(command);
    const explicit = prFromArgv(argv);
    const repo = repoFlag(argv) ?? explicit?.repo ?? null;
    const resolved = explicit && explicit.repo
        ? explicit
        : repo && explicit?.pr
            ? { repo, pr: explicit.pr }
            : resolveFromCwd(payload?.cwd);
    if (!resolved?.repo || !resolved?.pr) {
        block([
            'merge blocked (xtrm-review-gate): cannot determine the repository and PR for this `gh pr merge`.',
            'Pass the PR number (gh pr merge <n>) or run it from the repository, then retry.',
        ].join('\n'));
    }
    const check = spawnSync('xt', ['identity', 'merge-check', '--repo', resolved.repo, '--pr', String(resolved.pr)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GUARD_TIMEOUT_MS,
    });
    if (check.error) {
        block([
            `merge blocked (xtrm-review-gate): the merge guard could not run (${check.error.message}).`,
            `Install xt on PATH, or re-run with ${OVERRIDE_ENV}=<reason> after checking the review yourself.`,
        ].join('\n'));
    }
    if (check.status !== 0) {
        const detail = (check.stderr || check.stdout || '').trim();
        block([
            detail || `merge blocked (xtrm-review-gate): the guard refused ${resolved.repo}#${resolved.pr}.`,
            '',
            'Do not retry the merge. Get a review at the current head first, then merge.',
        ].join('\n'));
    }
    allow();
}

function post(payload) {
    if (!isBash(payload)) allow();
    const command = commandOf(payload);
    if (!isCreate(command)) allow();
    const response = JSON.stringify(payload?.tool_response ?? {});
    const created = /https:\/\/github\.com\/([^/"\\]+)\/([^/"\\]+)\/pull\/(\d+)/.exec(response);
    if (!created) allow();
    const text = `${reminderText()}\n\nPR: https://github.com/${created[1]}/${created[2]}/pull/${created[3]}`;
    // PostToolUse additional context: the agent sees this without a user turn.
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
    }));
    allow();
}

const mode = process.argv[2];
const payload = readPayload();
if (mode === 'pre') pre(payload);
else if (mode === 'post') post(payload);
else allow();
