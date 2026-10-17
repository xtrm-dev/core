import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySettingsFixes, auditSettings, type SettingsFinding } from '../core/settings-audit.js';

// xtrm-tzzud: `xt doctor settings --fix`. The audit stays read-only; this
// covers the one mutating entry point — what it removes, what it refuses to
// touch, and that it never writes without a backup.

const PKG = 'npm:@jaggerxtrm/pi-extensions';

let home = '';
let projectRoot = '';
let agentDir = '';

const of = (findings: SettingsFinding[], kind: SettingsFinding['kind']) => findings.filter(f => f.kind === kind);
const readPi = (root: string) => fs.readJson(path.join(root, '.pi', 'settings.json')) as Promise<Record<string, unknown>>;

async function auditProject() {
    return auditSettings({ scope: 'project', projectRoot, home });
}

let previousAgentDir: string | undefined;

beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'xt-settings-fix-'));
    projectRoot = path.join(home, 'dev', 'demo');
    agentDir = path.join(home, '.pi', 'agent');
    await fs.ensureDir(agentDir);
    await fs.ensureDir(path.join(projectRoot, '.pi'));
    await fs.writeJson(path.join(agentDir, 'settings.json'), { packages: [PKG] });
    // CORE-2412: auditSettings prefers PI_AGENT_DIR over <home>/.pi/agent.
    previousAgentDir = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = agentDir;
});

afterEach(async () => {
    await fs.remove(home);
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
});

describe('applySettingsFixes', () => {
    it('removes the project package entry the global settings already declare', async () => {
        await fs.writeJson(path.join(projectRoot, '.pi', 'settings.json'), { packages: [PKG, 'npm:other'] });

        const outcome = await applySettingsFixes(await auditProject(), { apply: true, home });

        expect(outcome.changed).toBe(true);
        expect(outcome.applied).toHaveLength(1);
        expect((await readPi(projectRoot)).packages).toEqual(['npm:other']);
    });

    it('writes nothing without --apply, but still reports what it would remove', async () => {
        await fs.writeJson(path.join(projectRoot, '.pi', 'settings.json'), { packages: [PKG] });

        const outcome = await applySettingsFixes(await auditProject(), { apply: false, home });

        expect(outcome.changed).toBe(false);
        expect(outcome.applied).toHaveLength(0);
        expect(outcome.planned.filter(f => f.fix)).toHaveLength(1);
        // Untouched on disk.
        expect((await readPi(projectRoot)).packages).toEqual([PKG]);
    });

    it('backs the file up before writing, and the backup still holds the original', async () => {
        const original = { packages: [PKG] };
        await fs.writeJson(path.join(projectRoot, '.pi', 'settings.json'), original);

        const outcome = await applySettingsFixes(await auditProject(), { apply: true, home, stamp: 'stamp' });

        const backup = outcome.applied[0]?.backup ?? '';
        expect(backup.startsWith(path.join(home, '.xtrm', 'migration-backups'))).toBe(true);
        expect(await fs.readJson(backup)).toEqual(original);
    });

    it('drops a retired xtrm skills pointer but preserves a dangling path xt does not own', async () => {
        await fs.writeJson(path.join(projectRoot, '.pi', 'settings.json'), {
            skills: ['../.xtrm/skills/active', '../my-own-skills'],
        });

        const outcome = await applySettingsFixes(await auditProject(), { apply: true, home });

        expect(of(outcome.planned, 'dangling-reference')).toHaveLength(2);
        expect((await readPi(projectRoot)).skills).toEqual(['../my-own-skills']);
    });

    it('leaves hook findings alone — they belong to xt update --apply, not to --fix', async () => {
        await fs.ensureDir(path.join(projectRoot, '.claude'));
        await fs.writeJson(path.join(projectRoot, '.claude', 'settings.json'), {
            hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${path.join(home, 'gone.mjs')}"` }] }] },
        });

        const outcome = await applySettingsFixes(await auditProject(), { apply: true, home });

        expect(of(outcome.planned, 'dead-hook-command')).toHaveLength(1);
        expect(of(outcome.planned, 'dead-hook-command').every(f => !f.fix)).toBe(true);
        expect(outcome.applied).toHaveLength(0);
    });

    it('reports, rather than throws, when the file changes to garbage between audit and apply', async () => {
        const settingsFile = path.join(projectRoot, '.pi', 'settings.json');
        await fs.writeJson(settingsFile, { packages: [PKG] });
        const outcome = await auditProject();
        await fs.writeFile(settingsFile, '{ not json');

        const applied = await applySettingsFixes(outcome, { apply: true, home });

        expect(applied.applied).toHaveLength(0);
        expect(applied.failed.map(f => f.error).join()).toContain('vanished or became unparseable');
    });
});
