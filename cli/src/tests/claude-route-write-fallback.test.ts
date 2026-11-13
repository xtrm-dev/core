/**
 * The degraded-write path, with `node:fs` mocked so the REAL catch block in
 * `writeUserConfig` runs. Stubbing the injected `write` seam would stub out the
 * exact function that carried the defect (a rename failure that wrote the file
 * and then threw), so this file mocks `renameSync` instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({ failRename: false, failDirectWrite: false, failTmpWrite: false }));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        default: actual,
        renameSync: (from: fs.PathLike, to: fs.PathLike) => {
            if (fsState.failRename) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
            return actual.renameSync(from, to);
        },
        writeFileSync: ((file: fs.PathOrFileDescriptor, data: string, options?: unknown) => {
            const isTemp = typeof file === 'string' && file.includes('.tmp.');
            if (fsState.failTmpWrite && isTemp) {
                throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            }
            if (fsState.failDirectWrite && typeof file === 'string' && !isTemp) {
                throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            }
            return (actual.writeFileSync as (f: unknown, d: unknown, o?: unknown) => void)(file, data, options);
        }) as typeof actual.writeFileSync,
    };
});

vi.mock('prompts', () => ({ default: vi.fn() }));

// Hermetic: the real lookup spawns `sp list --json`. This suite has no interest in
// the installed Specialists, so it must not depend on the host.
vi.mock('../core/claude-route.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/claude-route.js')>();
    return { ...actual, resolveKnownSpecialistNames: () => null };
});

import { createClaudeRouteCommand } from '../commands/claude-route.js';
import {
    CLAUDE_ROUTE_BLOCK_KEY,
    getClaudeRouteStatus,
    writeClaudeRouteBlock,
    type ClaudeRouteConfigLocation,
} from '../core/claude-route.js';

let tmpRoot = '';
const savedEnv: Record<string, string | undefined> = {};
let savedExitCode: typeof process.exitCode;

function configPath(): string {
    return path.join(tmpRoot, '.config', 'specialists', 'user.json');
}

function location(filePath: string): ClaudeRouteConfigLocation {
    return { path: filePath, exists: fs.existsSync(filePath), source: 'config-home' };
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-claude-route-fallback-'));
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    for (const key of ['HOME', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
    process.env.HOME = tmpRoot;
    delete process.env.XDG_CONFIG_HOME;
    fsState.failRename = false;
    fsState.failDirectWrite = false;
    fsState.failTmpWrite = false;
});

afterEach(() => {
    fsState.failRename = false;
    fsState.failDirectWrite = false;
    fsState.failTmpWrite = false;
    process.exitCode = savedExitCode;
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('writeClaudeRouteBlock when the rename fails', () => {
    it('still writes the file and reports the degradation instead of throwing', () => {
        fsState.failRename = true;
        const filePath = configPath();
        const written = writeClaudeRouteBlock({ enabled: true, default_model: 'claude-bridge/a' }, location(filePath));
        expect(written.ok).toBe(true);
        if (!written.ok) return;
        expect(written.result.write.atomic).toBe(false);
        expect(written.result.write.fallbackError).toMatch(/EXDEV/);
        expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toEqual({ claude_bridge: { enabled: true, default_model: 'claude-bridge/a' } });
        // No temp sibling survived.
        expect(fs.readdirSync(path.dirname(filePath))).toEqual(['user.json']);
    });

    it('fails loudly when the direct write fails too, because the file may be truncated', () => {
        fsState.failRename = true;
        fsState.failDirectWrite = true;
        const filePath = configPath();
        expect(() => writeClaudeRouteBlock({ enabled: true, default_model: 'claude-bridge/a' }, location(filePath)))
            .toThrow(/may be truncated/);
    });

    it('surfaces a temp-file write failure as a write failure, not as a rename problem', () => {
        const filePath = configPath();
        fsState.failTmpWrite = true;
        expect(() => writeClaudeRouteBlock({ enabled: true, default_model: 'claude-bridge/a' }, location(filePath)))
            .toThrow(/cannot write .*\.tmp\..*EACCES/);
        // The destination was never touched.
        expect(fs.existsSync(filePath)).toBe(false);
        expect(getClaudeRouteStatus(location(filePath)).present).toBe(false);
    });
});

describe('xt claude-route enable when the write degrades', () => {
    it('prints the non-atomic warning and exits 0', async () => {
        fsState.failRename = true;
        const errors: string[] = [];
        const logs: string[] = [];
        const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
            errors.push(args.map(String).join(' '));
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            logs.push(args.map(String).join(' '));
        });
        try {
            await createClaudeRouteCommand().parseAsync([
                'node', 'xt',
                'enable', '--yes',
                '--specialist', 'worker',
                '--model', 'claude-bridge/claude-sonnet-4-5',
            ]);
        } finally {
            errorSpy.mockRestore();
            logSpy.mockRestore();
        }
        expect(process.exitCode).toBe(0);
        expect(errors.join('\n')).toMatch(/write was not atomic/);
        expect(errors.join('\n')).toMatch(/EXDEV/);
        const config = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, any>;
        expect(config[CLAUDE_ROUTE_BLOCK_KEY].enabled).toBe(true);
        expect(logs.join('\n')).toMatch(/route enabled/);
    });
});
