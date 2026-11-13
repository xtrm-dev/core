import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const promptsMock = vi.hoisted(() => vi.fn());
const bridgeStatusMock = vi.hoisted(() => vi.fn());
const knownSpecialistsMock = vi.hoisted(() => vi.fn());

vi.mock('prompts', () => ({ default: promptsMock }));
vi.mock('../core/pi-runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/pi-runtime.js')>();
    return { ...actual, getPiClaudeBridgeInstallStatus: bridgeStatusMock };
});

vi.mock('../core/claude-route.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/claude-route.js')>();
    return { ...actual, resolveKnownSpecialistNames: knownSpecialistsMock };
});

import { createClaudeRouteCommand } from '../commands/claude-route.js';
import { CLAUDE_ROUTE_BLOCK_KEY } from '../core/claude-route.js';

let tmpRoot = '';
const savedEnv: Record<string, string | undefined> = {};
let savedExitCode: typeof process.exitCode;

/**
 * Drive the real `isInteractiveTty()` predicate through the streams it reads, so
 * the non-TTY refusal is exercised as shipped instead of through an env hatch.
 */
const savedTty: Array<{ stream: NodeJS.WriteStream | NodeJS.ReadStream; descriptor?: PropertyDescriptor }> = [];

function setInteractive(value: boolean): void {
    for (const stream of [process.stdin, process.stdout]) {
        if (!savedTty.some(saved => saved.stream === stream)) {
            savedTty.push({ stream, descriptor: Object.getOwnPropertyDescriptor(stream, 'isTTY') });
        }
        Object.defineProperty(stream, 'isTTY', { value, configurable: true });
    }
}

function restoreTty(): void {
    for (const { stream, descriptor } of savedTty.splice(0)) {
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else delete (stream as { isTTY?: boolean }).isTTY;
    }
}

function configPath(): string {
    return path.join(tmpRoot, '.config', 'specialists', 'user.json');
}

function readConfig(): Record<string, any> {
    return fs.readJsonSync(configPath()) as Record<string, any>;
}

async function run(args: string[]): Promise<{ logs: string[]; errors: string[] }> {
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
        logs.push(values.map(String).join(' '));
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
        errors.push(values.map(String).join(' '));
    });
    try {
        await createClaudeRouteCommand().parseAsync(['node', 'xt-claude-route-test', ...args]);
        return { logs, errors };
    } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    }
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-claude-route-cli-'));
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    for (const key of ['HOME', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = tmpRoot;
    promptsMock.mockReset();
    bridgeStatusMock.mockReset();
    bridgeStatusMock.mockResolvedValue(null);
    knownSpecialistsMock.mockReset();
    knownSpecialistsMock.mockReturnValue(null);
    setInteractive(true);
});

afterEach(() => {
    process.exitCode = savedExitCode;
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.removeSync(tmpRoot);
    restoreTty();
    vi.restoreAllMocks();
});

describe('xt claude-route enable', () => {
    it('refuses without a TTY and never prompts', async () => {
        setInteractive(false);
        const { errors } = await run([
            'enable',
            '--specialist', 'worker',
            '--model', 'claude-bridge/claude-sonnet-4-5',
        ]);
        expect(process.exitCode).toBe(1);
        expect(promptsMock).not.toHaveBeenCalled();
        expect(fs.existsSync(configPath())).toBe(false);
        expect(errors.join('\n')).toMatch(/requires explicit confirmation/);
        expect(errors.join('\n')).toMatch(/billed to your Claude subscription/);
    });

    it('writes nothing when the operator declines at the prompt', async () => {
        promptsMock.mockResolvedValue({});
        const { errors } = await run([
            'enable',
            '--specialist', 'worker',
            '--model', 'claude-bridge/claude-sonnet-4-5',
        ]);
        expect(process.exitCode).toBe(1);
        expect(fs.existsSync(configPath())).toBe(false);
        expect(errors.join('\n')).toMatch(/no consent recorded/);
    });

    it('warns about a Specialist name this install does not know', async () => {
        knownSpecialistsMock.mockReturnValue(new Set(['worker', 'reviewer']));
        const { errors } = await run([
            'enable', '--yes',
            '--specialist', 'worker,workr',
            '--model', 'claude-bridge/claude-sonnet-4-5',
        ]);
        expect(process.exitCode).toBe(0);
        expect(errors.join('\n')).toMatch(/not a known Specialist in this install: workr/);
        expect(readConfig()[CLAUDE_ROUTE_BLOCK_KEY].specialists).toEqual(['worker', 'workr']);
    });

    it('stays silent about names when no Specialists CLI is available', async () => {
        knownSpecialistsMock.mockReturnValue(null);
        const { errors } = await run([
            'enable', '--yes',
            '--specialist', 'worker',
            '--model', 'claude-bridge/claude-sonnet-4-5',
        ]);
        expect(process.exitCode).toBe(0);
        expect(errors.join('\n')).not.toMatch(/not a known Specialist/);
    });

    it('names the billing/subscription implication in the prompt', async () => {
        promptsMock.mockResolvedValue({ confirm: false });
        await run(['enable', '--specialist', 'worker', '--model', 'claude-bridge/claude-sonnet-4-5']);
        const asked = promptsMock.mock.calls[0]?.[0] as { message: string } | undefined;
        expect(asked?.message).toMatch(/billed to your Claude subscription/);
    });

    it('writes the allow-list block on consent', async () => {
        promptsMock.mockResolvedValue({ confirm: true });
        const { logs } = await run([
            'enable',
            '--specialist', 'worker,reviewer',
            '--model', 'claude-bridge/claude-sonnet-4-5',
        ]);
        expect(process.exitCode).toBe(0);
        const config = readConfig();
        expect(config[CLAUDE_ROUTE_BLOCK_KEY]).toEqual({
            enabled: true,
            default_model: 'claude-bridge/claude-sonnet-4-5',
            specialists: ['worker', 'reviewer'],
            models: {
                worker: 'claude-bridge/claude-sonnet-4-5',
                reviewer: 'claude-bridge/claude-sonnet-4-5',
            },
        });
        expect(logs.join('\n')).toMatch(/route enabled/);
    });

    it('accepts --yes as non-interactive consent without prompting', async () => {
        const { logs } = await run([
            'enable', '--yes',
            '--specialist', 'worker',
            '--model', 'claude-bridge/claude-sonnet-4-5',
            '--default-model', 'claude-bridge/claude-opus-4-5',
            '--json',
        ]);
        expect(promptsMock).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(0);
        const payload = JSON.parse(logs.join('\n')) as Record<string, unknown>;
        expect(payload).toMatchObject({
            ok: true,
            command: 'claude-route enable',
            listed_specialists: ['worker'],
            default_model: 'claude-bridge/claude-opus-4-5',
        });
        expect(readConfig()[CLAUDE_ROUTE_BLOCK_KEY].models).toEqual({ worker: 'claude-bridge/claude-sonnet-4-5' });
    });

    it('refuses an empty allow list', async () => {
        const { errors } = await run(['enable', '--model', 'claude-bridge/claude-sonnet-4-5']);
        expect(process.exitCode).toBe(1);
        expect(errors.join('\n')).toMatch(/--specialist is required/);
        expect(promptsMock).not.toHaveBeenCalled();
    });

    it('refuses a wildcard before asking for consent', async () => {
        const { errors } = await run(['enable', '--yes', '--specialist', '*', '--model', 'claude-bridge/claude-sonnet-4-5']);
        expect(process.exitCode).toBe(1);
        expect(errors.join('\n')).toMatch(/kebab-case/);
        expect(fs.existsSync(configPath())).toBe(false);
    });

    it('refuses a model outside the bridge provider', async () => {
        const { errors } = await run(['enable', '--yes', '--specialist', 'worker', '--model', 'anthropic/claude-opus-4-5']);
        expect(process.exitCode).toBe(1);
        expect(errors.join('\n')).toMatch(/claude-bridge\//);
    });
});

describe('xt claude-route disable', () => {
    it('sets enabled:false and keeps the list', async () => {
        await run(['enable', '--yes', '--specialist', 'worker', '--model', 'claude-bridge/claude-sonnet-4-5']);
        const { logs } = await run(['disable']);
        expect(process.exitCode).toBe(0);
        expect(readConfig()[CLAUDE_ROUTE_BLOCK_KEY].enabled).toBe(false);
        expect(readConfig()[CLAUDE_ROUTE_BLOCK_KEY].specialists).toEqual(['worker']);
        expect(logs.join('\n')).toMatch(/route disabled/);
    });

    it('removes the block with --purge', async () => {
        await run(['enable', '--yes', '--specialist', 'worker', '--model', 'claude-bridge/claude-sonnet-4-5']);
        const { logs } = await run(['disable', '--purge', '--json']);
        const payload = JSON.parse(logs.join('\n')) as Record<string, unknown>;
        expect(payload).toMatchObject({ ok: true, outcome: 'purged' });
        expect(readConfig()).not.toHaveProperty(CLAUDE_ROUTE_BLOCK_KEY);
    });

    it('refuses an invalid block without --purge and destroys nothing', async () => {
        fs.ensureDirSync(path.dirname(configPath()));
        fs.writeJsonSync(configPath(), { claude_bridge: { enabled: true, specialists: ['*'] }, other: 1 });
        const { errors } = await run(['disable']);
        expect(process.exitCode).toBe(1);
        expect(errors.join('\n')).toMatch(/disable --purge/);
        expect(readConfig()).toEqual({ claude_bridge: { enabled: true, specialists: ['*'] }, other: 1 });
    });

    it('purges an invalid block on request and reports the source in JSON', async () => {
        fs.ensureDirSync(path.dirname(configPath()));
        fs.writeJsonSync(configPath(), { claude_bridge: { enabled: true, specialists: ['*'] }, other: 1 });
        const { logs } = await run(['disable', '--purge', '--json']);
        expect(process.exitCode).toBe(0);
        const payload = JSON.parse(logs.join('\n')) as Record<string, unknown>;
        expect(payload).toMatchObject({ ok: true, outcome: 'purged', source: 'config-home' });
        expect(readConfig()).toEqual({ other: 1 });
    });

    it('warns when the effective config file is the legacy path', async () => {
        const legacy = path.join(tmpRoot, '.specialists', 'user.json');
        fs.ensureDirSync(path.dirname(legacy));
        fs.writeJsonSync(legacy, {});
        // No ~/.config file exists, so the loader reads legacy and the write must too.
        const { errors } = await run(['enable', '--yes', '--specialist', 'worker', '--model', 'claude-bridge/claude-sonnet-4-5']);
        expect(process.exitCode).toBe(0);
        expect(fs.existsSync(legacy)).toBe(true);
        expect(fs.existsSync(configPath())).toBe(false);
        expect(errors.join('\n')).toMatch(/legacy ~\/.specialists\/user.json/);
    });

    it('reports an absent block without failing', async () => {
        const { logs } = await run(['disable']);
        expect(process.exitCode).toBe(0);
        expect(logs.join('\n')).toMatch(/nothing to disable/);
    });
});

describe('xt claude-route status', () => {
    it('reports the configured route and the bridge package', async () => {
        await run(['enable', '--yes', '--specialist', 'worker', '--model', 'claude-bridge/claude-sonnet-4-5']);
        bridgeStatusMock.mockResolvedValue({ installedVersion: '0.12.0' });
        const { logs } = await run(['status', '--json']);
        const payload = JSON.parse(logs.join('\n')) as Record<string, unknown>;
        expect(payload).toMatchObject({
            ok: true,
            present: true,
            enabled: true,
            listed_specialists: ['worker'],
            models: { worker: 'claude-bridge/claude-sonnet-4-5' },
            bridge_package_version: '0.12.0',
        });
        expect(process.exitCode).toBe(0);
    });

    it('reports a malformed block as a failure with the schema error', async () => {
        fs.ensureDirSync(path.dirname(configPath()));
        fs.writeJsonSync(configPath(), { claude_bridge: { enabled: true, specialists: ['*'] } });
        const { logs } = await run(['status', '--json']);
        const payload = JSON.parse(logs.join('\n')) as Record<string, unknown>;
        expect(payload.ok).toBe(false);
        expect(String(payload.error)).toMatch(/kebab-case/);
        expect(process.exitCode).toBe(1);
    });

    it('reports an unconfigured route', async () => {
        const { logs } = await run(['status']);
        expect(logs.join('\n')).toMatch(/no claude_bridge block/);
        expect(process.exitCode).toBe(0);
    });
});
