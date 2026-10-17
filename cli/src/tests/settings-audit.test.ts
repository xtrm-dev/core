import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditSettings, type SettingsFinding } from '../core/settings-audit.js';
import { createDoctorCommand } from '../commands/doctor.js';

let home = '';
let projectRoot = '';

const kinds = (findings: SettingsFinding[]) => findings.map(f => f.kind);
const of = (findings: SettingsFinding[], kind: SettingsFinding['kind']) => findings.filter(f => f.kind === kind);

function hookEntry(command: string, matcher = '') {
    return { matcher, hooks: [{ type: 'command', command }] };
}

let previousAgentDir: string | undefined;

beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'xt-settings-audit-'));
    projectRoot = path.join(home, 'dev', 'demo');
    await fs.ensureDir(path.join(home, '.claude'));
    await fs.ensureDir(path.join(home, '.xtrm', 'hooks'));
    await fs.ensureDir(path.join(projectRoot, '.claude'));
    await fs.ensureDir(path.join(projectRoot, '.pi'));
    await fs.writeJson(path.join(home, '.claude', 'settings.json'), { hooks: {} });
    // CORE-2412: settings-audit prefers PI_AGENT_DIR over <home>/.pi/agent.
    // HOME-only sandboxing would read the suite sandbox instead of this
    // test's home, so keep the agent dir with the test home.
    previousAgentDir = process.env.PI_AGENT_DIR;
    process.env.PI_AGENT_DIR = path.join(home, '.pi', 'agent');
});

afterEach(async () => {
    await fs.remove(home);
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
});

describe('auditSettings', () => {
    it('reports a hook registered more than once in one file, with its true multiplicity', async () => {
        const command = 'CLAUDE_HOOK_EVENT=Stop bash "/opt/hooks/agent state.sh" done';
        await fs.writeJson(path.join(home, '.claude', 'settings.json'), {
            hooks: { Stop: [hookEntry(command), hookEntry(command), hookEntry(command)] },
        });

        const outcome = await auditSettings({ scope: 'home', home });
        const duplicates = of(outcome.planned, 'duplicate-registration');

        expect(duplicates).toHaveLength(1);
        expect(duplicates[0].evidence).toContain('3×');
        // The command contains a space: the event must still be recovered exactly.
        expect(duplicates[0].subject.startsWith('Stop ')).toBe(true);
    });

    it('flags a hook command whose script is gone, and leaves a live one alone', async () => {
        const live = path.join(home, '.xtrm', 'hooks', 'live.mjs');
        await fs.writeFile(live, '// live');
        await fs.writeJson(path.join(home, '.claude', 'settings.json'), {
            hooks: {
                Stop: [hookEntry(`node "${live}"`)],
                SessionStart: [hookEntry(`node "${path.join(home, '.xtrm', 'hooks', 'gone.mjs')}"`)],
            },
        });

        const dead = of((await auditSettings({ scope: 'home', home })).planned, 'dead-hook-command');

        expect(dead).toHaveLength(1);
        expect(dead[0].evidence).toContain('gone.mjs');
    });

    it('reports retired keys, dangling path entries, and legacy paths on the Pi surface', async () => {
        await fs.ensureDir(path.join(home, '.pi'));
        await fs.writeJson(path.join(home, '.pi', 'settings.json'), {
            xtrmExternalCompact: true,
            // One value, two findings: the path resolves nowhere AND names a
            // retired skills pack. A stale per-runtime active/* path would do
            // the same, but check:layout-guards bans that literal in source.
            skills: ['../.xtrm/skills/local-legacy'],
            packages: ['npm:@jaggerxtrm/pi-extensions'],
        });

        const outcome = await auditSettings({ scope: 'home', home });

        expect(kinds(outcome.planned)).toContain('orphaned-key');
        expect(kinds(outcome.planned)).toContain('dangling-reference');
        expect(kinds(outcome.planned)).toContain('legacy-path');
        // npm: ids are never resolved — an audit must not hit the registry.
        expect(of(outcome.planned, 'dangling-reference')).toHaveLength(1);
    });

    it('proves project registrations the global block already covers, and preserves foreign ones', async () => {
        const hookBody = '// shared hook body';
        await fs.writeFile(path.join(home, '.xtrm', 'hooks', 'quality.mjs'), hookBody);
        await fs.ensureDir(path.join(projectRoot, '.xtrm', 'hooks'));
        await fs.writeFile(path.join(projectRoot, '.xtrm', 'hooks', 'quality.mjs'), hookBody);

        const globalCommand = `node "${path.join(home, '.xtrm', 'hooks', 'quality.mjs')}"`;
        const projectCommand = `node "${path.join(projectRoot, '.xtrm', 'hooks', 'quality.mjs')}"`;
        await fs.writeJson(path.join(home, '.claude', 'settings.json'), {
            hooks: { PostToolUse: [hookEntry(globalCommand, 'Edit')] },
        });
        await fs.writeJson(path.join(projectRoot, '.claude', 'settings.json'), {
            hooks: {
                PostToolUse: [hookEntry(projectCommand, 'Edit')],
                Stop: [hookEntry('node /usr/local/bin/somebody-elses-hook.mjs')],
            },
        });

        const outcome = await auditSettings({ scope: 'project', projectRoot, home });

        expect(of(outcome.planned, 'duplicate-of-global')).toHaveLength(1);
        expect(outcome.preserved.map(p => p.classification)).toContain('foreign');
    });

    it('reports project Pi entries the global Pi settings already declare', async () => {
        await fs.ensureDir(path.join(home, '.pi', 'agent'));
        await fs.writeJson(path.join(home, '.pi', 'agent', 'settings.json'), {
            packages: ['npm:@jaggerxtrm/pi-extensions'],
        });
        await fs.writeJson(path.join(projectRoot, '.pi', 'settings.json'), {
            packages: ['npm:@jaggerxtrm/pi-extensions'],
        });

        const outcome = await auditSettings({ scope: 'project', projectRoot, home });
        const duplicates = of(outcome.planned, 'duplicate-of-global');

        expect(duplicates).toHaveLength(1);
        expect(duplicates[0].subject).toContain('@jaggerxtrm/pi-extensions');
    });

    it('is read-only: every scanned file is byte-identical afterwards', async () => {
        const settingsPath = path.join(home, '.claude', 'settings.json');
        await fs.writeJson(settingsPath, {
            hooks: { Stop: [hookEntry('node /nope/missing.mjs'), hookEntry('node /nope/missing.mjs')] },
        });
        const before = await fs.readFile(settingsPath, 'utf8');

        const outcome = await auditSettings({ scope: 'all', projectRoot, home });

        expect(outcome.changed).toBe(false);
        expect(outcome.applied).toEqual([]);
        expect(outcome.planned.length).toBeGreaterThan(0);
        expect(await fs.readFile(settingsPath, 'utf8')).toBe(before);
    });

    it('emits the ReconciliationOutcome envelope even when there is nothing to report', async () => {
        const outcome = await auditSettings({ scope: 'home', home });

        expect(outcome.schema).toBe('ReconciliationOutcome/1');
        expect(outcome.planned).toEqual([]);
        expect(outcome.failed).toEqual([]);
        expect(outcome.scanned).toContain(path.join(home, '.claude', 'settings.json'));
    });

    it('records an unparseable settings file as a failure instead of throwing', async () => {
        await fs.writeFile(path.join(home, '.claude', 'settings.json'), '{ not json');

        const outcome = await auditSettings({ scope: 'home', home });

        expect(outcome.failed).toHaveLength(1);
        expect(outcome.failed[0].file).toContain('.claude/settings.json');
    });
});

describe('xt doctor settings', () => {
    // `doctor` and `doctor settings` both declare --json; commander resolves the
    // flag onto the parent, so the subcommand has to read both. Without that,
    // --json silently prints the human table instead.
    it('honours --json even though the parent command declares the same flag', async () => {
        const previousHome = process.env.HOME;
        const previousExitCode = process.exitCode;
        process.env.HOME = home;
        const lines: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            lines.push(args.map(String).join(' '));
        });

        try {
            await createDoctorCommand().parseAsync(['settings', '--scope', 'home', '--json'], { from: 'user' });
        } finally {
            log.mockRestore();
            process.env.HOME = previousHome;
            process.exitCode = previousExitCode;
        }

        const parsed = JSON.parse(lines.join('\n'));
        expect(parsed.schema).toBe('ReconciliationOutcome/1');
        expect(parsed.changed).toBe(false);
    });
});
