#!/usr/bin/env node
// xtrm-review-gate.mjs — client-side review gate (CORE-2530, parent CORE-2524).
//
// GitHub Actions is billing-locked and the organisation is on the Free plan, so
// nothing on GitHub requires a review before a merge. This hook is the check:
//
//   pre  (Bash): a simple command whose argv is `gh … pr … merge` runs
//                `xt identity merge-check` first. A refusal exits 2, so the merge
//                never reaches GitHub. With XTRM_MERGE_GUARD unset the hook is
//                inert: it exits 0 and never calls the guard.
//   post (Bash): a successful `gh pr create` prints the reviewer routing
//                reminder for the PR's scrutiny tier. It never blocks.
//
// It runs as its own process because merge-check talks to the GitHub API and to
// Substrate, which does not fit the 2 s budget of the shared PreToolUse
// dispatcher (policy: policies/xtrm-review-gate.json, timeout 30 s).
//
// Static limits (CORE-2530 review): the hook sees one shell command string. It
// cannot see `$GH pr merge`, `g\h pr merge`, or a string handed to `sh -c` or
// eval. The gh shim (CORE-2528) is the backstop for those; see
// .xtrm/skills/default/engineering-quality/references/review.md.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const GUARD_ENV = 'XTRM_MERGE_GUARD';
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

function guardEnabled(env) {
    const value = String(env[GUARD_ENV] ?? '').trim().toLowerCase();
    return value === 'on' || value === '1' || value === 'true' || value === 'yes';
}

/**
 * Tokenise a shell command into simple commands: split on `;`, `&&`, `||`, `|`
 * and newlines; honour single quotes, double quotes and backslash escapes; skip
 * heredoc bodies entirely, so a commit message that mentions `gh pr merge` never
 * looks like a merge. This is deliberately a scanner, not a shell: it never
 * expands variables or globs, and anything it cannot parse is left as text.
 */
function simpleCommands(command) {
    const commands = [];
    let argv = [];
    let word = '';
    let started = false;
    let quote = '';
    let heredoc = null;
    let index = 0;
    const flushWord = () => {
        if (started) { argv.push(word); }
        word = '';
        started = false;
    };
    const flushCommand = () => {
        flushWord();
        if (argv.length) commands.push(argv);
        argv = [];
    };
    while (index < command.length) {
        const char = command[index];
        if (heredoc) {
            // Consume the body up to a line that is exactly the delimiter.
            const newline = command.indexOf('\n', index);
            const line = newline < 0 ? command.slice(index) : command.slice(index, newline);
            if (line.trim() === heredoc) {
                heredoc = null;
                index = newline < 0 ? command.length : newline + 1;
                continue;
            }
            if (newline < 0) break;
            index = newline + 1;
            continue;
        }
        if (quote === "'") {
            if (char === "'") { quote = ''; } else { word += char; }
            index += 1;
            continue;
        }
        if (quote === '"') {
            if (char === '\\' && index + 1 < command.length) { word += command[index + 1]; index += 2; continue; }
            if (char === '"') { quote = ''; } else { word += char; }
            index += 1;
            continue;
        }
        if (char === "'" || char === '"') { quote = char; started = true; index += 1; continue; }
        if (char === '\\' && index + 1 < command.length) { word += command[index + 1]; started = true; index += 2; continue; }
        if (char === '<' && command[index + 1] === '<') {
            // Heredoc marker: <<EOF, <<'EOF', <<-EOF.
            let cursor = index + 2;
            if (command[cursor] === '-') cursor += 1;
            while (cursor < command.length && command[cursor] === ' ') cursor += 1;
            let delimiter = '';
            while (cursor < command.length && /[A-Za-z0-9_]/.test(command[cursor])) { delimiter += command[cursor]; cursor += 1; }
            flushWord();
            heredoc = delimiter || null;
            index = cursor;
            continue;
        }
        if (char === ';' || char === '|' || char === '&' || char === '\n') {
            flushCommand();
            index += 1;
            continue;
        }
        if (char === ' ' || char === '\t') { flushWord(); index += 1; continue; }
        word += char;
        started = true;
        index += 1;
    }
    flushCommand();
    return commands;
}

/** Leading `VAR=value` assignments of a simple command. */
function splitAssignments(argv) {
    const assignments = {};
    let index = 0;
    while (index < argv.length) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argv[index]);
        if (!match) break;
        assignments[match[1]] = match[2];
        index += 1;
    }
    return { assignments, rest: argv.slice(index) };
}

/** Skip `-R o/r`, `--repo o/r`, `--repo=o/r`, `-Ro/r`; return the next index. */
function skipRepo(argv, index, repo) {
    const arg = argv[index];
    if (arg === '-R' || arg === '--repo') {
        if (argv[index + 1] !== undefined) repo.value = argv[index + 1];
        return index + 2;
    }
    if (arg.startsWith('--repo=')) { repo.value = arg.slice(7); return index + 1; }
    if (arg.startsWith('-R=')) { repo.value = arg.slice(3); return index + 1; }
    if (arg.startsWith('-R') && arg.length > 2) { repo.value = arg.slice(2); return index + 1; }
    return -1;
}

/**
 * The merge commands of a shell command: `gh` (any global flags before `pr`),
 * `pr` (any more global flags), `merge`. Text inside quotes, heredocs or another
 * program's arguments never matches.
 */
function mergeCommands(command) {
    const found = [];
    for (const raw of simpleCommands(command)) {
        const { assignments, rest } = splitAssignments(raw);
        if (rest[0] !== 'gh') continue;
        const repo = { value: '' };
        let index = 1;
        let sawPr = false;
        while (index < rest.length) {
            const next = skipRepo(rest, index, repo);
            if (next >= 0) { index = next; continue; }
            const arg = rest[index];
            if (arg === 'pr') { sawPr = true; index += 1; break; }
            if (arg.charAt(0) === '-') { index += 1; continue; }
            break;
        }
        if (!sawPr) continue;
        let verb = '';
        while (index < rest.length) {
            const next = skipRepo(rest, index, repo);
            if (next >= 0) { index = next; continue; }
            const arg = rest[index];
            if (arg.charAt(0) === '-') { index += 1; continue; }
            verb = arg;
            break;
        }
        if (verb !== 'merge') continue;
        // Help for this command is not a merge.
        const own = rest.slice(rest.indexOf('pr') + 1);
        if (own.some((arg) => arg === '--help' || arg === '-h')) continue;
        // gh's own argv without the program name, which is what the shim sees too.
        found.push({ argv: rest.slice(1), assignments });
    }
    return found;
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
    const merges = mergeCommands(command);
    if (!merges.length) allow();
    // Guard OFF is inert in every case: no cwd PR, gh unreachable, xt missing
    // (CORE-2530 review, ruled). The hook still allows; the reminder is a post
    // concern and is unaffected.
    if (!guardEnabled(process.env)) allow();
    const cwd = (payload && payload.cwd) || process.cwd();
    for (const merge of merges) {
        // The hook never decides an override: it forwards every `VAR=value` prefix
        // and its own env to merge-check, which applies the role gate, the log and
        // the Journal rule in one place.
        const childEnv = { ...process.env, ...merge.assignments };
        const check = spawnSync('xt', ['identity', 'merge-check', '--gh-args', JSON.stringify(merge.argv), '--cwd', cwd, '--json'], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: GUARD_TIMEOUT_MS,
            env: childEnv,
        });
        if (check.error) {
            block([
                `merge blocked (xtrm-review-gate): the merge guard could not run (${check.error.message}).`,
                `Install xt on PATH, or turn the guard off with ${GUARD_ENV} (it is off by default).`,
            ].join('\n'));
        }
        let decision = null;
        try { decision = JSON.parse(check.stdout || 'null'); } catch (error) { decision = null; }
        if (check.status !== 0 || !decision || decision.allow !== true) {
            const detail = (decision && decision.message) || (check.stderr || '').trim() || (check.stdout || '').trim();
            block([
                detail || 'merge blocked (xtrm-review-gate): the guard refused this merge.',
                '',
                'Do not retry the merge. Get a review at the current head first, then merge.',
            ].join('\n'));
        }
    }
    allow();
}

function post(payload) {
    if (!isBash(payload)) allow();
    const command = commandOf(payload);
    if (!/\bgh\s+pr\s+create\b/.test(command)) allow();
    const response = JSON.stringify((payload && payload.tool_response) || {});
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
