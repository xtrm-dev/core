import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CLAUDE_ROUTE_BLOCK_KEY,
    resolveKnownSpecialistNames,
    ClaudeRouteBlockSchema,
    buildClaudeRouteBlock,
    disableClaudeRoute,
    getClaudeRouteStatus,
    readClaudeRouteBlock,
    resolveClaudeRouteConfigLocation,
    validateClaudeRouteBlock,
    writeClaudeRouteBlock,
    type ClaudeRouteConfigLocation,
} from '../core/claude-route.js';

let tmpRoot = '';
const savedEnv: Record<string, string | undefined> = {};

function location(filePath: string, source: ClaudeRouteConfigLocation['source'] = 'config-home'): ClaudeRouteConfigLocation {
    return { path: filePath, exists: fs.existsSync(filePath), source };
}

function userConfigPath(name = 'config'): string {
    return path.join(tmpRoot, name, 'specialists', 'user.json');
}

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-claude-route-'));
    for (const key of ['HOME', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
});

afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.removeSync(tmpRoot);
});

describe('resolveClaudeRouteConfigLocation', () => {
    it('prefers XDG_CONFIG_HOME when set, exactly like the specialists loader', () => {
        const resolved = resolveClaudeRouteConfigLocation(
            { XDG_CONFIG_HOME: '/xdg', HOME: '/home/operator' },
            '/home/operator',
            () => false,
        );
        expect(resolved).toEqual({ path: '/xdg/specialists/user.json', exists: false, source: 'xdg' });
    });

    it('uses an existing ~/.config file', () => {
        const configHome = '/home/operator/.config/specialists/user.json';
        const resolved = resolveClaudeRouteConfigLocation({ HOME: '/home/operator' }, '/home/operator', candidate => candidate === configHome);
        expect(resolved).toEqual({ path: configHome, exists: true, source: 'config-home' });
    });

    it('falls back to an existing legacy ~/.specialists file so a write never shadows it', () => {
        const legacy = '/home/operator/.specialists/user.json';
        const resolved = resolveClaudeRouteConfigLocation({ HOME: '/home/operator' }, '/home/operator', candidate => candidate === legacy);
        expect(resolved).toEqual({ path: legacy, exists: true, source: 'legacy' });
    });

    it('targets the canonical ~/.config path when nothing exists', () => {
        const resolved = resolveClaudeRouteConfigLocation({ HOME: '/home/operator' }, '/home/operator', () => false);
        expect(resolved.path).toBe('/home/operator/.config/specialists/user.json');
        expect(resolved.source).toBe('config-home');
    });
});

describe('claude route schema', () => {
    it('accepts an explicit allow list whose names all resolve to bridged models', () => {
        const result = validateClaudeRouteBlock({
            enabled: true,
            default_model: 'claude-bridge/claude-opus-4-5',
            specialists: ['worker', 'reviewer'],
            models: { worker: 'claude-bridge/claude-sonnet-4-5' },
        });
        expect(result.ok).toBe(true);
    });

    it('rejects a wildcard entry', () => {
        const result = validateClaudeRouteBlock({ enabled: true, specialists: ['*'], default_model: 'claude-bridge/x' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/kebab-case/);
    });

    it('rejects a glob, a path and an empty name', () => {
        for (const name of ['a*', 'a/b', '', 'Worker', 'worker_1']) {
            expect(validateClaudeRouteBlock({ specialists: [name], default_model: 'claude-bridge/x' }).ok).toBe(false);
        }
    });

    it('rejects a model outside the claude-bridge provider', () => {
        const result = validateClaudeRouteBlock({ specialists: ['worker'], default_model: 'anthropic/claude-opus-4-5' });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/claude-bridge\//);
    });

    it('rejects a listed Specialist with no model anywhere', () => {
        const result = validateClaudeRouteBlock({ specialists: ['worker'] });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/no bridge model/);
    });

    it('rejects unknown keys and a non-boolean enabled', () => {
        expect(validateClaudeRouteBlock({ enabled: 'yes' }).ok).toBe(false);
        expect(validateClaudeRouteBlock({ enabled: true, extra: 1 }).ok).toBe(false);
    });

    it('treats an empty allow list as valid but routes nothing', () => {
        const parsed = ClaudeRouteBlockSchema.parse({ enabled: true, specialists: [] });
        expect(parsed.specialists).toEqual([]);
    });
});

describe('buildClaudeRouteBlock', () => {
    it('deduplicates, keeps order, and maps every name to the model', () => {
        const built = buildClaudeRouteBlock({
            specialists: ['worker', 'reviewer', 'worker'],
            model: 'claude-bridge/claude-sonnet-4-5',
        });
        expect(built.ok).toBe(true);
        if (!built.ok) return;
        expect(built.block.specialists).toEqual(['worker', 'reviewer']);
        expect(built.block.models).toEqual({
            worker: 'claude-bridge/claude-sonnet-4-5',
            reviewer: 'claude-bridge/claude-sonnet-4-5',
        });
        expect(built.block.enabled).toBe(true);
        expect(built.block.default_model).toBe('claude-bridge/claude-sonnet-4-5');
    });

    it('refuses to build a block from a wildcard request', () => {
        const built = buildClaudeRouteBlock({ specialists: ['*'], model: 'claude-bridge/claude-sonnet-4-5' });
        expect(built.ok).toBe(false);
    });
});

describe('readClaudeRouteBlock', () => {
    it('reports an absent file without an error', () => {
        const read = readClaudeRouteBlock(location(userConfigPath()));
        expect(read).toMatchObject({ present: false, block: null, error: null, listedNames: [] });
    });

    it('reports a file without the block as not configured', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify({ worker: { execution: { model: 'x' } } }));
        const read = readClaudeRouteBlock(location(filePath));
        expect(read.present).toBe(false);
        expect(read.block).toBeNull();
    });

    it('never throws on malformed JSON', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeFileSync(filePath, '{ not json');
        const read = readClaudeRouteBlock(location(filePath));
        expect(read.present).toBe(true);
        expect(read.block).toBeNull();
        expect(read.error).toMatch(/not valid JSON/);
    });

    it('surfaces the schema error and the names the block tried to list', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify({ claude_bridge: { enabled: true, specialists: ['*'] } }));
        const read = readClaudeRouteBlock(location(filePath));
        expect(read.block).toBeNull();
        expect(read.error).toMatch(/kebab-case/);
        expect(read.listedNames).toEqual(['*']);
    });
});

describe('writeClaudeRouteBlock', () => {
    it('creates the file and writes only the block', () => {
        const filePath = userConfigPath();
        const written = writeClaudeRouteBlock(
            { enabled: true, default_model: 'claude-bridge/a', specialists: ['worker'], models: { worker: 'claude-bridge/a' } },
            location(filePath),
        );
        expect(written.ok).toBe(true);
        const config = fs.readJsonSync(filePath) as Record<string, unknown>;
        expect(Object.keys(config)).toEqual([CLAUDE_ROUTE_BLOCK_KEY]);
        expect(fs.readdirSync(path.dirname(filePath))).toEqual(['user.json']);
    });

    it('preserves every other top-level key', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, { worker: { execution: { thinking_level: 'high' } }, _note: 'keep' });
        writeClaudeRouteBlock(
            { enabled: true, default_model: 'claude-bridge/a', specialists: ['worker'], models: { worker: 'claude-bridge/a' } },
            location(filePath),
        );
        const config = fs.readJsonSync(filePath) as Record<string, unknown>;
        expect(config.worker).toEqual({ execution: { thinking_level: 'high' } });
        expect(config._note).toBe('keep');
        expect(config.claude_bridge).toMatchObject({ enabled: true, specialists: ['worker'] });
    });

    it('refuses to overwrite a malformed file instead of destroying operator content', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeFileSync(filePath, '{ "worker": ');
        const written = writeClaudeRouteBlock({ enabled: true, default_model: 'claude-bridge/a' }, location(filePath));
        expect(written.ok).toBe(false);
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('{ "worker": ');
    });

    it('rejects an invalid block before touching the file', () => {
        const filePath = userConfigPath();
        const written = writeClaudeRouteBlock({ enabled: true, specialists: ['*'] }, location(filePath));
        expect(written.ok).toBe(false);
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('reports the write outcome of the real writer', () => {
        const filePath = userConfigPath();
        const written = writeClaudeRouteBlock({ enabled: true, default_model: 'claude-bridge/a' }, location(filePath));
        expect(written.ok).toBe(true);
        if (!written.ok) return;
        // The degraded path itself is covered in claude-route-write-fallback.test.ts,
        // where node:fs is mocked so the real catch block runs.
        expect(written.result.write).toEqual({ atomic: true, fallbackError: null });
    });

    it('writes to the legacy path when that is the file in effect', () => {
        const legacy = path.join(tmpRoot, '.specialists', 'user.json');
        fs.ensureDirSync(path.dirname(legacy));
        fs.writeJsonSync(legacy, {});
        const resolved = resolveClaudeRouteConfigLocation(
            { HOME: tmpRoot },
            tmpRoot,
            candidate => fs.existsSync(candidate),
        );
        expect(resolved.path).toBe(legacy);
        writeClaudeRouteBlock({ enabled: true, default_model: 'claude-bridge/a' }, resolved);
        expect((fs.readJsonSync(legacy) as Record<string, unknown>).claude_bridge).toMatchObject({ enabled: true });
        expect(fs.existsSync(path.join(tmpRoot, '.config', 'specialists', 'user.json'))).toBe(false);
    });
});

describe('disableClaudeRoute', () => {
    it('sets enabled:false and keeps the allow list', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, {
            claude_bridge: { enabled: true, default_model: 'claude-bridge/a', specialists: ['worker'] },
        });
        const result = disableClaudeRoute(location(filePath));
        expect(result).toMatchObject({ ok: true, outcome: 'disabled' });
        const config = fs.readJsonSync(filePath) as { claude_bridge: { enabled: boolean; specialists: string[] } };
        expect(config.claude_bridge.enabled).toBe(false);
        expect(config.claude_bridge.specialists).toEqual(['worker']);
        expect(getClaudeRouteStatus(location(filePath)).enabled).toBe(false);
    });

    it('purges the block on request', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, { claude_bridge: { enabled: true, default_model: 'claude-bridge/a' }, other: 1 });
        const result = disableClaudeRoute(location(filePath), { purge: true });
        expect(result).toMatchObject({ ok: true, outcome: 'purged' });
        const config = fs.readJsonSync(filePath) as Record<string, unknown>;
        expect(config).not.toHaveProperty(CLAUDE_ROUTE_BLOCK_KEY);
        expect(config.other).toBe(1);
    });

    it('refuses to rewrite a block that does not validate, and points at --purge', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, { claude_bridge: { enabled: true, specialists: ['*'] }, other: 1 });
        const result = disableClaudeRoute(location(filePath));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/does not validate/);
        expect(result.error).toMatch(/disable --purge/);
        // Nothing was destroyed: core's mirror could be stale about validity.
        expect(fs.readJsonSync(filePath)).toEqual({ claude_bridge: { enabled: true, specialists: ['*'] }, other: 1 });
    });

    it('purges a block that does not validate', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, { claude_bridge: { enabled: true, specialists: ['*'] }, other: 1 });
        const result = disableClaudeRoute(location(filePath), { purge: true });
        expect(result).toMatchObject({ ok: true, outcome: 'purged' });
        expect(fs.readJsonSync(filePath)).toEqual({ other: 1 });
    });

    it('refuses to spread a non-object block value', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, { claude_bridge: 'off' });
        const result = disableClaudeRoute(location(filePath));
        expect(result.ok).toBe(false);
        expect((fs.readJsonSync(filePath) as Record<string, unknown>).claude_bridge).toBe('off');
    });

    it('reports absent when there is no block and writes nothing', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, { other: 1 });
        const before = fs.statSync(filePath).mtimeMs;
        const result = disableClaudeRoute(location(filePath));
        expect(result).toMatchObject({ ok: true, outcome: 'absent' });
        expect(fs.statSync(filePath).mtimeMs).toBe(before);
    });
});

describe('getClaudeRouteStatus', () => {
    it('projects the enabled route with its models', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeJsonSync(filePath, {
            claude_bridge: {
                enabled: true,
                default_model: 'claude-bridge/default',
                specialists: ['worker', 'reviewer'],
                models: { reviewer: 'claude-bridge/reviewer-model' },
            },
        });
        expect(getClaudeRouteStatus(location(filePath))).toMatchObject({
            present: true,
            enabled: true,
            error: null,
            listedSpecialists: ['worker', 'reviewer'],
            models: { worker: 'claude-bridge/default', reviewer: 'claude-bridge/reviewer-model' },
        });
    });

    it('reports a malformed block as off with the error', () => {
        const filePath = userConfigPath();
        fs.ensureDirSync(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify({ claude_bridge: { enabled: 'yes' } }));
        const status = getClaudeRouteStatus(location(filePath));
        expect(status.enabled).toBe(false);
        expect(status.error).toMatch(/invalid claude_bridge block/);
    });
});

describe('resolveKnownSpecialistNames', () => {
    const run = (stdout: string, status: number | null = 0) => () => ({ status, stdout });

    it('reads the names of the JSON array the CLI prints', () => {
        const names = resolveKnownSpecialistNames(run(JSON.stringify([{ name: 'worker' }, { name: 'reviewer' }])));
        expect(names).toEqual(new Set(['worker', 'reviewer']));
    });

    it('returns null when the CLI fails', () => {
        expect(resolveKnownSpecialistNames(run('[]', 1))).toBeNull();
        expect(resolveKnownSpecialistNames(run('[]', null))).toBeNull();
    });

    it('returns null for a shape it does not understand', () => {
        expect(resolveKnownSpecialistNames(run(JSON.stringify({ specialists: [{ name: 'worker' }] })))).toBeNull();
        expect(resolveKnownSpecialistNames(run('not json'))).toBeNull();
        expect(resolveKnownSpecialistNames(run('[]'))).toBeNull();
        expect(resolveKnownSpecialistNames(run(JSON.stringify([{ notName: 1 }])))).toBeNull();
    });
});
