// CORE-2528: role resolution and the versioned role map. No file is read from
// disk except through the injected reader, so the fail-closed paths are exact.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_ROLE_MAP,
    ROLE_MAP_VERSION,
    appSlugForRole,
    loadRoleMap,
    parseRoleMap,
    processAgentRole,
    resolveAgentRole,
    roleMapPath,
} from '../core/identity-roles.js';

let home = '';
beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-rolemap-'));
});
afterEach(() => {
    fs.removeSync(home);
});

describe('parseRoleMap', () => {
    it('accepts the shipped default shape', () => {
        expect(parseRoleMap(DEFAULT_ROLE_MAP)).toEqual(DEFAULT_ROLE_MAP);
    });

    it('refuses another version, an invalid role and a null mapped role value', () => {
        expect(parseRoleMap({ ...DEFAULT_ROLE_MAP, version: ROLE_MAP_VERSION + 1 })).toBeNull();
        expect(parseRoleMap({ ...DEFAULT_ROLE_MAP, default: 'admin' })).toBeNull();
        expect(parseRoleMap({ ...DEFAULT_ROLE_MAP, specialists: { executor: 'admin' } })).toBeNull();
        expect(parseRoleMap({ ...DEFAULT_ROLE_MAP, apps: { reviewer: '' } })).toBeNull();
        expect(parseRoleMap(null)).toBeNull();
    });

    it('keeps an explicit null mapping (no credential) and partial apps overrides', () => {
        const map = parseRoleMap({ version: 1, default: 'worker', specialists: { reviewer: null }, apps: { reviewer: 'my-app' } });
        expect(map?.specialists.reviewer).toBeNull();
        expect(map?.apps.reviewer).toBe('my-app');
        expect(map?.apps.worker).toBe(DEFAULT_ROLE_MAP.apps.worker);
    });
});

describe('loadRoleMap', () => {
    it('uses the shipped defaults when no file exists', () => {
        expect(loadRoleMap({ home })).toEqual(DEFAULT_ROLE_MAP);
    });

    it('reads the file when present', () => {
        const file = roleMapPath(home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeJsonSync(file, { ...DEFAULT_ROLE_MAP, specialists: { seconder: 'reviewer', executor: 'worker' } });
        expect(loadRoleMap({ home })?.specialists.executor).toBe('worker');
    });

    it('fails closed on an unparsable or invalid file', () => {
        const file = roleMapPath(home);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json');
        expect(loadRoleMap({ home })).toBeNull();
        fs.writeJsonSync(file, { version: 99, default: 'worker' });
        expect(loadRoleMap({ home })).toBeNull();
    });
});

describe('resolveAgentRole', () => {
    it('maps the reviewer names and defaults everything else to worker', () => {
        expect(resolveAgentRole('reviewer')).toBe('reviewer');
        expect(resolveAgentRole('seconder')).toBe('reviewer');
        expect(resolveAgentRole('pr-reviewer')).toBe('reviewer');
        expect(resolveAgentRole('executor')).toBe('worker');
        expect(resolveAgentRole('some-new-specialist')).toBe('worker');
        expect(resolveAgentRole('coordinator')).toBe('coordinator');
    });

    it('treats no name as the default role and no map as no role', () => {
        expect(resolveAgentRole(null)).toBe('worker');
        expect(resolveAgentRole('  ')).toBe('worker');
        expect(resolveAgentRole('reviewer', null)).toBeNull();
    });

    it('honours an explicit null mapping as "no credential"', () => {
        const map = { ...DEFAULT_ROLE_MAP, specialists: { reviewer: null } };
        expect(resolveAgentRole('reviewer', map)).toBeNull();
    });
});

describe('processAgentRole', () => {
    it('is the operator outside an agent tree', () => {
        expect(processAgentRole({})).toBeNull();
        expect(processAgentRole({ SUBSTRATE_HOLDER: '' })).toBeNull();
    });

    it('is a worker for a plain agent session and the mapped role when XTRM_ROLE is set', () => {
        expect(processAgentRole({ SUBSTRATE_HOLDER: 'worker-a' })).toBe('worker');
        expect(processAgentRole({ SUBSTRATE_HOLDER: 'worker-a', XTRM_ROLE: 'pr-reviewer' })).toBe('reviewer');
        expect(processAgentRole({ XTRM_ROLE: 'reviewer' })).toBe('reviewer');
    });

    it('inherits the failure when the role map is invalid', () => {
        expect(processAgentRole({ SUBSTRATE_HOLDER: 'worker-a' }, null)).toBeNull();
    });
});

describe('appSlugForRole', () => {
    it('names the three Apps', () => {
        expect(appSlugForRole('reviewer')).toBe('xtrm-reviewer');
        expect(appSlugForRole('coordinator')).toBe('xtrm-coord');
        expect(appSlugForRole('worker')).toBe('xtrm-worker');
    });
});
