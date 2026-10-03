import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// CORE-2339 guard regression tests: the single-process dispatcher must keep
// every block/allow decision the standalone hooks made, and keep the
// PostToolUse exit-code contract (exit 2 = blocking quality failure).

const HOOKS = path.resolve(__dirname, '../../../hooks');

interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

// XTRM-592: every dispatcher mode also reports to the XTRM agent host. These
// tests pin the checks, so presence is off: a host running on the test machine
// must never receive test frames (agent-host-claude-hooks.test.ts covers it).
const NO_AGENT_HOST = { XTRM_AGENT_HOST: '0' };

function runDispatcher(mode: string, payload: unknown, cwd: string, env: NodeJS.ProcessEnv = {}): RunResult {
    const result = spawnSync(process.execPath, [path.join(HOOKS, 'dispatch.mjs'), mode], {
        cwd,
        encoding: 'utf8',
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...NO_AGENT_HOST, ...env },
        timeout: 30000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function runStandalone(script: string, payload: unknown, cwd: string): RunResult {
    const result = spawnSync(process.execPath, [path.join(HOOKS, script)], {
        cwd,
        encoding: 'utf8',
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
        timeout: 10000,
    });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function makeWorktree(): Promise<{ worktreeRoot: string; outsideFile: string; insideFile: string }> {
    const base = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-'));
    const worktreeRoot = path.join(base, '.xtrm', 'worktrees', 'wt-test');
    await mkdir(worktreeRoot, { recursive: true });
    const insideFile = path.join(worktreeRoot, 'src.ts');
    await writeFile(insideFile, 'const a = 1;\n', 'utf8');
    const outsideFile = path.join(base, 'outside.md');
    await writeFile(outsideFile, 'x\n', 'utf8');
    return { worktreeRoot, outsideFile, insideFile };
}

describe('dispatch.mjs guard parity (CORE-2339)', () => {
    it('pre: blocks an Edit outside the worktree and matches the standalone hook byte-for-byte', async () => {
        const { worktreeRoot, outsideFile } = await makeWorktree();
        try {
            const payload = {
                session_id: 'dispatch-test',
                cwd: worktreeRoot,
                hook_event_name: 'PreToolUse',
                tool_name: 'Edit',
                tool_input: { file_path: outsideFile },
            };
            const viaDispatcher = runDispatcher('pre', payload, worktreeRoot);
            const viaStandalone = runStandalone('worktree-boundary.mjs', payload, worktreeRoot);

            expect(viaDispatcher.status).toBe(0);
            expect(viaDispatcher.stdout).toContain('"decision":"block"');
            expect(viaDispatcher.stdout).toContain('outside worktree boundary');
            expect(viaDispatcher.stdout).toBe(viaStandalone.stdout);
        } finally {
            await rm(worktreeRoot.split('/.xtrm')[0], { recursive: true, force: true });
        }
    });

    it('pre: allows an Edit inside the worktree', async () => {
        const { worktreeRoot, insideFile } = await makeWorktree();
        try {
            const result = runDispatcher('pre', {
                session_id: 'dispatch-test',
                cwd: worktreeRoot,
                hook_event_name: 'PreToolUse',
                tool_name: 'Edit',
                tool_input: { file_path: insideFile },
            }, worktreeRoot);
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
        } finally {
            await rm(worktreeRoot.split('/.xtrm')[0], { recursive: true, force: true });
        }
    });

    // XTRM-592: the PreToolUse matcher is empty (presence needs every tool), so the
    // guards must route by PRE_TOOLS themselves: a Read outside the worktree is not
    // an edit and gets no decision.
    it('pre: a non-guard tool gets no guard decision', async () => {
        const { worktreeRoot, outsideFile } = await makeWorktree();
        try {
            const result = runDispatcher('pre', {
                session_id: 'dispatch-test',
                cwd: worktreeRoot,
                hook_event_name: 'PreToolUse',
                tool_name: 'Read',
                tool_input: { file_path: outsideFile },
            }, worktreeRoot);
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
        } finally {
            await rm(worktreeRoot.split('/.xtrm')[0], { recursive: true, force: true });
        }
    });

    it('pre: blocks a raw Agent call only when the specialists workflow is active', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-agent-'));
        try {
            const blocked = runDispatcher('pre', {
                session_id: 'dispatch-test',
                cwd: temp,
                hook_event_name: 'PreToolUse',
                tool_name: 'Agent',
                system_prompt: '<skill name="using-specialists">do things</skill>',
                tool_input: { prompt: 'go' },
            }, temp);
            expect(blocked.status).toBe(0);
            expect(blocked.stdout).toContain('"decision":"block"');
            expect(blocked.stdout).toContain('specialists run');

            const allowed = runDispatcher('pre', {
                session_id: 'dispatch-test',
                cwd: temp,
                hook_event_name: 'PreToolUse',
                tool_name: 'Agent',
                system_prompt: 'plain prompt, no skill marker',
                tool_input: { prompt: 'go' },
            }, temp);
            expect(allowed.status).toBe(0);
            expect(allowed.stdout).toBe('');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('pre: unparseable stdin fails open (exit 0, no output)', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-bad-'));
        try {
            const result = runDispatcher('pre', 'this is not json', temp);
            expect(result.status).toBe(0);
            expect(result.stdout).toBe('');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('post: forwards the in-process quality gate exit code 2 for a file with blocking issues', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-post-'));
        try {
            const broken = path.join(temp, 'broken.ts');
            await writeFile(broken, 'const a = 1 as any;\ndebugger;\n', 'utf8');

            const result = runDispatcher('post', {
                session_id: 'dispatch-test',
                cwd: temp,
                hook_event_name: 'PostToolUse',
                tool_name: 'Edit',
                tool_input: { file_path: broken },
                tool_response: {},
            }, temp);

            expect(result.status).toBe(2);
            expect(result.stdout).toContain("'as any' usage");
            expect(result.stdout).toContain('debugger statement');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('post: spawns no quality child for non-source files and exits 0 quietly', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-md-'));
        try {
            const doc = path.join(temp, 'notes.md');
            await writeFile(doc, 'hello\n', 'utf8');

            const result = runDispatcher('post', {
                session_id: 'dispatch-test',
                cwd: temp,
                hook_event_name: 'PostToolUse',
                tool_name: 'Edit',
                tool_input: { file_path: doc },
                tool_response: {},
            }, temp);

            expect(result.status).toBe(0);
            expect(result.stdout).not.toContain('Quality Check');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('post: runs the JS quality gate in-process with identical content and exit code', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-parity-'));
        try {
            for (const [name, source, expected] of [
                ['clean.ts', 'const a = 1;\nexport default a;\n', 0],
                ['broken.ts', 'const a = 1 as any;\ndebugger;\n', 2],
            ] as const) {
                const file = path.join(temp, name);
                await writeFile(file, source, 'utf8');
                const payload = {
                    session_id: 'dispatch-test',
                    cwd: temp,
                    hook_event_name: 'PostToolUse',
                    tool_name: 'Edit',
                    tool_input: { file_path: file },
                    tool_response: {},
                };

                const viaStandalone = spawnSync(process.execPath, [path.join(HOOKS, 'quality-check.cjs')], {
                    cwd: temp, encoding: 'utf8', input: JSON.stringify(payload),
                    env: { ...process.env, CLAUDE_PROJECT_DIR: temp },
                });
                const viaDispatcher = runDispatcher('post', payload, temp);

                expect(viaDispatcher.status).toBe(expected);
                expect(viaDispatcher.status).toBe(viaStandalone.status);
                // Content must match exactly, but ORDER cannot: checkAll() runs
                // checkCommonIssues/checkNodePatterns under Promise.all, so
                // whichever finishes first prints first. That is true of the
                // standalone hook too, so byte-order equality was a flaky
                // assertion (it failed in CI and intermittently locally),
                // not a parity signal. Compare the line multiset instead.
                const lines = (text: string) => [...text.split('\n')].sort();
                expect(lines(viaDispatcher.stdout ?? '')).toEqual(lines(viaStandalone.stdout ?? ''));
            }
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('post: routes Python edits to the quality-check.py child', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-py-'));
        try {
            const file = path.join(temp, 'a.py');
            await writeFile(file, 'print("hi")\n', 'utf8');
            const result = runDispatcher('post', {
                session_id: 'dispatch-test',
                cwd: temp,
                hook_event_name: 'PostToolUse',
                tool_name: 'Edit',
                tool_input: { file_path: file },
                tool_response: {},
            }, temp);
            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Python Quality Check');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('post: logs the tool.call to .xtrm/debug.db (CORE-2339 review S6)', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-log-'));
        try {
            // logEvent anchors on the nearest .xtrm/ directory above cwd.
            await mkdir(path.join(temp, '.xtrm'), { recursive: true });
            const result = runDispatcher('post', {
                session_id: 'dispatch-log-test',
                cwd: temp,
                hook_event_name: 'PostToolUse',
                tool_name: 'Bash',
                tool_input: { command: 'echo hello' },
                tool_response: { stdout: 'hello' },
            }, temp);
            expect(result.status).toBe(0);

            const dbPath = path.join(temp, '.xtrm', 'debug.db');
            expect(existsSync(dbPath)).toBe(true);
            const { DatabaseSync } = await import('node:sqlite');
            const db = new DatabaseSync(dbPath);
            const row = db.prepare(
                "SELECT kind, tool_name, data FROM events WHERE kind = 'tool.call' LIMIT 1",
            ).get();
            db.close();
            expect(row).toBeTruthy();
            expect((row as Record<string, unknown>).tool_name).toBe('Bash');
            expect((row as Record<string, unknown>).data).toContain('echo hello');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('post: routes GitNexus enrichment for Serena symbol tools (CORE-2339 review S1)', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-serena-'));
        try {
            const result = runDispatcher('post', {
                session_id: 'dispatch-serena-test',
                cwd: temp,
                hook_event_name: 'PostToolUse',
                tool_name: 'mcp__serena__find_symbol',
                tool_input: { name_path_pattern: 'src/core/module.ts/MyClass' },
                tool_response: {},
            }, temp);
            // A repo without a .gitnexus index returns early and stays silent;
            // what matters is that the tool is routed (no crash, exit 0).
            expect(result.status).toBe(0);
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    // CORE-2339 execution review: both of these used to exit 0 with EMPTY
    // stderr, so a Python edit could be reported clean with no interpreter, and
    // a hook that never read its payload looked identical to a hook that ran.
    it('post: a missing python3 is reported, not silently treated as clean', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-no-python-'));
        try {
            const file = path.join(temp, 'bad.py');
            await writeFile(file, 'x: int = "bad"\n', 'utf8');
            const nodeDir = path.dirname(process.execPath);
            const result = spawnSync(process.execPath, [path.join(HOOKS, 'dispatch.mjs'), 'post'], {
                cwd: temp,
                encoding: 'utf8',
                input: JSON.stringify({
                    session_id: 'dispatch-test',
                    cwd: temp,
                    hook_event_name: 'PostToolUse',
                    tool_name: 'Edit',
                    tool_input: { file_path: file },
                    tool_response: {},
                }),
                // A PATH with node but no python3 reproduces ENOENT on the child.
                env: { ...process.env, PATH: nodeDir, CLAUDE_PROJECT_DIR: temp, ...NO_AGENT_HOST },
            });
            // Non-blocking (the old shell path exited 127), but visible.
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('could not start');
            expect(result.stderr).toContain('did NOT run');
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('pre: a stdin that never completes exits within the timeout and says so', async () => {
        const child = spawn(process.execPath, [path.join(HOOKS, 'dispatch.mjs'), 'pre'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...NO_AGENT_HOST },
        });
        child.stdin.on('error', () => { /* child exits first: EPIPE is expected */ });
        child.stdin.write('{"session_id":"x"}');
        // stdin deliberately left open: the stall deadline must fire.

        const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
            let buf = '';
            const timer = setTimeout(() => { child.kill(); resolve({ code: -1, stderr: buf }); }, 10000);
            child.stderr.on('data', (d) => { buf += String(d); });
            child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, stderr: buf }); });
        });

        expect(code).toBe(0);
        expect(stderr).toContain('stdin never completed');
    }, 20000);

    // XTRM-592: the Stop inbox reminder runs inside `dispatch.mjs event`. A failing
    // picker yields the reminder's own stderr diagnostic, which proves it ran in-process
    // without touching tmux (the picker fails before any pane option is read).
    it('event: Stop runs the inbox reminder in-process; other events stay silent', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-event-'));
        try {
            const env = { TMUX: '', TMUX_PANE: '%999999', XTMUX_PICKER: '/bin/false' };
            const stop = runDispatcher('event', {
                session_id: 'dispatch-test', cwd: temp, hook_event_name: 'Stop', stop_hook_active: false,
            }, temp, env);
            expect(stop.status).toBe(0);
            expect(stop.stdout).toBe('');
            expect(stop.stderr).toContain('xtmux inbox reminder unavailable: message-list failed');

            for (const hook_event_name of ['UserPromptSubmit', 'Notification', 'SubagentStop', 'SessionEnd']) {
                const other = runDispatcher('event', { session_id: 'dispatch-test', cwd: temp, hook_event_name }, temp, env);
                expect(other, hook_event_name).toMatchObject({ status: 0, stdout: '', stderr: '' });
            }
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });

    it('session: exits 0 on a plain project dir', async () => {
        const temp = await mkdtemp(path.join(tmpdir(), 'xtrm-dispatch-sess-'));
        try {
            const result = runDispatcher('session', {
                session_id: 'dispatch-test',
                cwd: temp,
                hook_event_name: 'SessionStart',
                source: 'startup',
            }, temp);
            expect(result.status).toBe(0);
        } finally {
            await rm(temp, { recursive: true, force: true });
        }
    });
});
