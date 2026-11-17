// CORE-2726: `xt identity dispatcher` — the true dispatcher for callers outside
// xt (the specialists MCP server, in-process activations) without copying the
// ancestor walk. Side-effect-free; exit 0 also when nothing resolves, non-zero
// only on a bad argument.
//
// This drives the built CLI (cli/dist/index.cjs, tracked and checked by CI),
// because the property is about the command's contract: its exit code, its JSON
// shape and its silence on stdout for anything but the answer.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '..', '..', 'dist', 'index.cjs');

interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
    json: Record<string, unknown> | null;
}

function runDispatcher(args: string[], extraEnv: NodeJS.ProcessEnv = {}): RunResult {
    // The test process's own identity must not decide the outcome.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['SUBSTRATE_HOLDER', 'XTRM_DISPATCHER_NAME', 'XTRM_DISPATCHER_ADDRESS', 'TMUX', 'TMUX_PANE']) delete env[key];
    Object.assign(env, extraEnv);
    const result = spawnSync(process.execPath, [CLI, 'identity', 'dispatcher', ...args], {
        encoding: 'utf8',
        env,
        timeout: 15_000,
        killSignal: 'SIGKILL',
    });
    const stdout = String(result.stdout ?? '');
    let json: Record<string, unknown> | null = null;
    try {
        json = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
        json = null;
    }
    return { status: result.status, stdout, stderr: String(result.stderr ?? ''), json };
}

const STALE_ENV = { XTRM_DISPATCHER_NAME: 'stale', XTRM_DISPATCHER_ADDRESS: 'uds:/run/cc/stale.sock' };

describe('xt identity dispatcher --json', () => {
    it('reports explicit input as source explicit, outranking the walk', () => {
        const result = runDispatcher(
            ['--participant', 'lead-a', '--address', 'activation:act:3bb0e173', '--json'],
            STALE_ENV,
        );
        expect(result.status).toBe(0);
        expect(result.json).toEqual({
            participant: 'lead-a',
            address: 'activation:act:3bb0e173',
            source: 'explicit',
            procStartChecked: false,
            skipped: [],
        });
    });

    it('accepts uds: on explicit input and keeps an unknown participant absent', () => {
        const result = runDispatcher(['--address', 'uds:/run/cc/42.sock', '--json'], STALE_ENV);
        expect(result.status).toBe(0);
        expect(result.json).toEqual({
            address: 'uds:/run/cc/42.sock',
            source: 'explicit',
            procStartChecked: false,
            skipped: [],
        });
        expect(result.json).not.toHaveProperty('participant');
        expect(result.json).not.toHaveProperty('name');
    });

    it('--no-inherit answers none even with a stale dispatcher env set, and exit stays 0', () => {
        const result = runDispatcher(['--pid', '1', '--no-inherit', '--json'], STALE_ENV);
        expect(result.status).toBe(0);
        expect(result.json).toEqual({ source: 'none', procStartChecked: false, skipped: [] });
        expect(result.json).not.toHaveProperty('address');
        expect(result.json).not.toHaveProperty('name');
    });

    it('without --no-inherit the inherited value is still reported', () => {
        const result = runDispatcher(['--pid', '1', '--json'], STALE_ENV);
        expect(result.status).toBe(0);
        expect(result.json).toEqual({
            name: 'stale',
            address: 'uds:/run/cc/stale.sock',
            source: 'inherited',
            procStartChecked: false,
            skipped: [],
        });
    });

    it('--pid is inclusive: pid 1 ends the walk without a probe and resolves nothing', () => {
        const result = runDispatcher(['--pid', '1', '--no-inherit', '--json']);
        expect(result.status).toBe(0);
        expect(result.json?.source).toBe('none');
        expect(result.json?.skipped).toEqual([]);
    });

    it('refuses a --pid that is not a process id', () => {
        const result = runDispatcher(['--pid', 'not-a-pid', '--json']);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/--pid not-a-pid is not a positive process id/);
    });

    it('refuses an explicit address outside the uds: and activation: schemes', () => {
        const result = runDispatcher(['--address', 'http://example/sock', '--json']);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(/is neither uds:<socket> nor activation:<id>/);
    });

    it('is side-effect-free: the plain form answers without a JSON parse and keeps exit 0', () => {
        const result = runDispatcher(['--pid', '1', '--no-inherit']);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/dispatcher source: none/);
    });
});
