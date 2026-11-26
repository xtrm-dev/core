import os from 'node:os';
import path from 'node:path';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    assignIssueToRuntime,
    runtimeAssigneeFromOrigin,
    shouldAutoAssignIssue,
} from '../utils/worktree-session.js';

const sandboxes: string[] = [];

interface FakeOptions {
    assignee?: string;
    /** Instance id the faked `agent.ready` row carries. Empty means never readied. */
    instanceId?: string;
    /** Return an empty journal page for this many calls before the ready row lands. */
    readyAfterCalls?: number;
    /** `createdAtMs` for the faked row, relative to now. Negative = before the wait began. */
    readyOffsetMs?: number;
    updateFails?: boolean;
    /** Omit the `xtmux` fake so the command cannot be resolved at all. */
    withoutXtmux?: boolean;
}

interface FakeHandles {
    /** bd argv capture, one JSON array per line. */
    capture: string;
    /** Number of `xtmux log query` calls the run made. */
    xtmuxCalls: () => number;
}

async function withFakeCommands(
    options: FakeOptions,
    run: (handles: FakeHandles) => Promise<void>,
): Promise<void> {
    const root = path.join(os.tmpdir(), `xt-assignee-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const bin = path.join(root, 'bin');
    const capture = path.join(root, 'updates.jsonl');
    const calls = path.join(root, 'xtmux-calls');
    mkdirSync(bin, { recursive: true });
    sandboxes.push(root);

    // Absolute-node shebangs, not `#!/usr/bin/env node`: PATH below is the fake
    // bin dir and nothing else, so `withoutXtmux` genuinely means "xtmux is
    // unresolvable" rather than "unresolvable unless some ambient dir has one" —
    // node's own bin dir ships an xtmux, which an inherited PATH would leak in.
    writeFileSync(path.join(bin, 'bd'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'show') {
  process.stdout.write(JSON.stringify([{ assignee: process.env.TEST_BD_ASSIGNEE || undefined }]));
  process.exit(0);
}
if (args[0] === 'update') {
  fs.appendFileSync(process.env.TEST_BD_CAPTURE, JSON.stringify(args) + '\\n');
  process.exit(process.env.TEST_BD_UPDATE_FAIL === '1' ? 1 : 0);
}
process.exit(2);
`);
    chmodSync(path.join(bin, 'bd'), 0o755);

    // Stands in for `xtmux log query --type agent.ready --pane %7 --json`. Counts
    // its own calls so a test can assert the wait actually polled rather than
    // resolving on the first read. Deliberately absent under `withoutXtmux` —
    // that is the whole point of that case.
    if (!options.withoutXtmux) {
        writeFileSync(path.join(bin, 'xtmux'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'log' || args[1] !== 'query') process.exit(2);
if (!args.includes('agent.ready') || !args.includes('%7')) process.exit(2);

const counter = process.env.TEST_XTMUX_CALLS;
const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(seen + 1));

const instanceId = process.env.TEST_READY_INSTANCE || '';
const readyAfter = Number(process.env.TEST_READY_AFTER_CALLS || '0');
if (!instanceId || seen < readyAfter) {
  process.stdout.write('[]');
  process.exit(0);
}
process.stdout.write(JSON.stringify([{
  createdAtMs: Date.now() + Number(process.env.TEST_READY_OFFSET_MS || '0'),
  type: 'agent.ready',
  paneId: '%7',
  instanceId,
}]));
`);
        chmodSync(path.join(bin, 'xtmux'), 0o755);
    }

    const previous = {
        path: process.env.PATH,
        capture: process.env.TEST_BD_CAPTURE,
        assignee: process.env.TEST_BD_ASSIGNEE,
        instance: process.env.TEST_READY_INSTANCE,
        readyAfter: process.env.TEST_READY_AFTER_CALLS,
        readyOffset: process.env.TEST_READY_OFFSET_MS,
        xtmuxCalls: process.env.TEST_XTMUX_CALLS,
        updateFail: process.env.TEST_BD_UPDATE_FAIL,
    };
    process.env.PATH = bin;
    process.env.TEST_BD_CAPTURE = capture;
    process.env.TEST_BD_ASSIGNEE = options.assignee ?? '';
    process.env.TEST_READY_INSTANCE = options.instanceId ?? '';
    process.env.TEST_READY_AFTER_CALLS = String(options.readyAfterCalls ?? 0);
    process.env.TEST_READY_OFFSET_MS = String(options.readyOffsetMs ?? 0);
    process.env.TEST_XTMUX_CALLS = calls;
    process.env.TEST_BD_UPDATE_FAIL = options.updateFails ? '1' : '0';
    try {
        await run({
            capture,
            xtmuxCalls: () => {
                try {
                    return Number(readFileSync(calls, 'utf8'));
                } catch {
                    return 0;
                }
            },
        });
    } finally {
        const restore = (key: string, value: string | undefined): void => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        };
        restore('PATH', previous.path);
        restore('TEST_BD_CAPTURE', previous.capture);
        restore('TEST_BD_ASSIGNEE', previous.assignee);
        restore('TEST_READY_INSTANCE', previous.instance);
        restore('TEST_READY_AFTER_CALLS', previous.readyAfter);
        restore('TEST_READY_OFFSET_MS', previous.readyOffset);
        restore('TEST_XTMUX_CALLS', previous.xtmuxCalls);
        restore('TEST_BD_UPDATE_FAIL', previous.updateFail);
    }
}

afterEach(() => {
    vi.restoreAllMocks();
    while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

describe('runtime issue assignee', () => {
    it('uses the five-character runtime-origin short form for both runtimes', () => {
        expect(runtimeAssigneeFromOrigin('pi', 'd2e8cd02-03ce-4ac1-9b7f-b5114e6dbde6')).toBe('pi/d2e8c');
        expect(runtimeAssigneeFromOrigin('claude', 'xtrm://runtime/9y3mn')).toBe('claude/9y3mn');
    });

    it('preserves operator overrides but allows empty and prior runtime assignees', () => {
        expect(shouldAutoAssignIssue(undefined)).toBe(true);
        expect(shouldAutoAssignIssue('pi/4h2xk')).toBe(true);
        expect(shouldAutoAssignIssue('claude/9y3mn')).toBe(true);
        expect(shouldAutoAssignIssue('jaggerxtrm')).toBe(false);
    });
});

describe('assignIssueToRuntime', () => {
    it.each([
        ['pi' as const, '4h2xk-origin', 'pi/4h2xk'],
        ['claude' as const, '9y3mn-origin', 'claude/9y3mn'],
    ])('updates %s issue ownership from the readiness handshake', async (runtime, instanceId, expected) => {
        await withFakeCommands({ instanceId }, async ({ capture }) => {
            await assignIssueToRuntime('xtrm-test', runtime, '%7', process.cwd());
            const args = JSON.parse(readFileSync(capture, 'utf8').trim());
            expect(args).toEqual(['update', 'xtrm-test', `--assignee=${expected}`, '--json']);
        });
    });

    // The bug in core#508 (xtrm-wiy5n.4.18): pi registers its instance ~11s after
    // the pane is created, so anything that gives up early never assigns at all.
    it('assigns when the runtime registers late instead of on the first read', async () => {
        await withFakeCommands({ instanceId: '4h2xk-origin', readyAfterCalls: 4 }, async ({ capture, xtmuxCalls }) => {
            await assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd());
            expect(readFileSync(capture, 'utf8')).toContain('--assignee=pi/4h2xk');
            expect(xtmuxCalls()).toBeGreaterThan(4);
        });
    });

    it('updates a prior runtime assignee on restart', async () => {
        await withFakeCommands({ assignee: 'pi/old12', instanceId: 'new34-origin' }, async ({ capture }) => {
            await assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd());
            expect(readFileSync(capture, 'utf8')).toContain('--assignee=pi/new34');
        });
    });

    it('preserves an operator assignee override', async () => {
        await withFakeCommands({ assignee: 'operator', instanceId: 'new34-origin' }, async ({ capture }) => {
            await assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd());
            expect(() => readFileSync(capture, 'utf8')).toThrow();
        });
    });

    it('ignores a readiness row belonging to the pane previous occupant', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await withFakeCommands({ instanceId: 'old12-origin' }, async ({ capture }) => {
            await assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd(), { previousInstanceId: 'old12-origin', readyTimeoutMs: 0 });
            expect(() => readFileSync(capture, 'utf8')).toThrow();
        });
        expect(error).toHaveBeenCalledWith(expect.stringContaining('did not signal readiness'));
    });

    it('ignores a readiness row emitted before the wait began', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await withFakeCommands({ instanceId: '4h2xk-origin', readyOffsetMs: -60_000 }, async ({ capture }) => {
            await assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd(), { readyTimeoutMs: 0 });
            expect(() => readFileSync(capture, 'utf8')).toThrow();
        });
        expect(error).toHaveBeenCalledWith(expect.stringContaining('did not signal readiness'));
    });

    // A watermark captured before the runtime started must still accept a row the
    // runtime emitted during the launcher's own gap. readiness fires once per
    // occupation, so losing that row costs the whole assignment — the bug this
    // module exists to fix, reintroduced through the staleness guard.
    it('accepts a readiness row emitted before the call but after the launch watermark', async () => {
        await withFakeCommands({ instanceId: '4h2xk-origin', readyOffsetMs: -60_000 }, async ({ capture }) => {
            await assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd(), {
                readyAfterMs: Date.now() - 120_000,
            });
            expect(readFileSync(capture, 'utf8')).toContain('--assignee=pi/4h2xk');
        });
    });

    it('warns and continues when the runtime never signals readiness', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await withFakeCommands({ instanceId: '' }, async ({ capture }) => {
            await expect(assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd(), { readyTimeoutMs: 0 })).resolves.toBeUndefined();
            expect(() => readFileSync(capture, 'utf8')).toThrow();
        });
        expect(error).toHaveBeenCalledWith(expect.stringContaining('pi did not signal readiness'));
    });

    it('warns and continues when xtmux is not installed', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await withFakeCommands({ instanceId: '4h2xk-origin', withoutXtmux: true }, async ({ capture }) => {
            await expect(assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd())).resolves.toBeUndefined();
            expect(() => readFileSync(capture, 'utf8')).toThrow();
        });
        expect(error).toHaveBeenCalledWith(expect.stringContaining('xtmux unavailable'));
    });

    it('warns but does not abort when bd update fails', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await withFakeCommands({ instanceId: '4h2xk-origin', updateFails: true }, async () => {
            await expect(assignIssueToRuntime('xtrm-test', 'pi', '%7', process.cwd())).resolves.toBeUndefined();
        });
        expect(error).toHaveBeenCalledWith(expect.stringContaining('session launch continues'));
    });
});
