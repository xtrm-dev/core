import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    ensureCodexTrustProfile,
    findCodexSession,
    readCodexWorktreeSession,
    removeCodexTrustProfile,
    writeCodexWorktreeSession,
} from '../core/codex-session.js';

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) fs.removeSync(root);
});

describe('Codex thread persistence', () => {
    it('finds the newest fresh session for the exact worktree cwd', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-sessions-'));
        roots.push(root);
        const nested = path.join(root, '2026', '08', '02');
        fs.ensureDirSync(nested);
        const cwd = '/srv/project/.xtrm/worktrees/project-xt-codex-demo';
        const line = (id: string, timestamp: string, valueCwd: string) => JSON.stringify({
            type: 'session_meta',
            payload: { session_id: id, id, timestamp, cwd: valueCwd, cli_version: '0.146.0' },
        });
        fs.writeFileSync(path.join(nested, 'wrong.jsonl'), `${line(
            '019fc3bc-fb7a-7ae0-9536-125624bf726a',
            '2026-08-02T18:29:31.000Z',
            '/srv/other',
        )}\n`);
        fs.writeFileSync(path.join(nested, 'match.jsonl'), `${line(
            '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            '2026-08-02T18:29:30.106Z',
            cwd,
        )}\n`);

        expect(findCodexSession({
            sessionsRoot: root,
            cwd,
            launchedAfterMs: Date.parse('2026-08-02T18:29:29.000Z'),
        })).toMatchObject({
            threadId: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            cliVersion: '0.146.0',
        });
    });

    it('persists and validates an explicit UUID for deterministic resume', () => {
        const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-worktree-'));
        roots.push(worktree);
        const session = {
            runtime: 'codex' as const,
            launchedAt: '2026-08-02T18:29:29.000Z',
            threadId: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            safetyProfile: 'codex-yolo' as const,
            profileName: 'xtrm-0123456789abcdef',
            profilePath: path.join(worktree, 'codex-home', 'xtrm-0123456789abcdef.config.toml'),
        };

        expect(writeCodexWorktreeSession(worktree, session)).toBe(true);
        expect(readCodexWorktreeSession(worktree)).toEqual(session);
        expect(fs.readJsonSync(path.join(worktree, '.xtrm', 'session-meta.json'))).toEqual(session);
    });

    it('CORE-2728 M6c: the record carries exactly one bead — string kept, junk dropped', () => {
        const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-bead-'));
        roots.push(worktree);
        const base = {
            runtime: 'codex' as const,
            launchedAt: '2026-08-02T18:29:29.000Z',
            threadId: '019fc3bc-fb7a-7ae0-9536-125624bf726b',
            safetyProfile: 'codex-yolo' as const,
            profileName: 'xtrm-0123456789abcdef',
            profilePath: path.join(worktree, 'codex-home', 'xtrm-0123456789abcdef.config.toml'),
        };
        fs.ensureDirSync(path.join(worktree, '.xtrm'));
        const write = (extra: Record<string, unknown>): void => {
            fs.writeJsonSync(path.join(worktree, '.xtrm', 'session-meta.json'), { ...base, ...extra });
        };
        write({ bead: ' CORE-2728 ' });
        expect(readCodexWorktreeSession(worktree)).toMatchObject({ bead: 'CORE-2728' });
        // A non-string, an empty and a null value are all ABSENT, never carried.
        // The ref SHAPE is enforced by the attach-side reader before `sb` runs.
        for (const junk of [2728, '', '   ', null]) {
            write({ bead: junk });
            const read = readCodexWorktreeSession(worktree);
            expect(read).not.toBeNull();
            expect(read).not.toHaveProperty('bead');
            // No unrelated field from the file survives the validated read either.
            expect(read).not.toHaveProperty('extra');
        }
    });

    it('creates an isolated trust profile without touching the base config', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-profile-'));
        roots.push(root);
        const codexHome = path.join(root, 'codex-home');
        const worktree = path.join(root, 'repo', '.xtrm', 'worktrees', 'repo-xt-codex-demo');
        fs.ensureDirSync(codexHome);
        fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\n');

        const profile = ensureCodexTrustProfile(codexHome, worktree);

        expect(profile.name).toMatch(/^xtrm-[0-9a-f]{16}$/);
        expect(profile.path).toBe(path.join(codexHome, `${profile.name}.config.toml`));
        expect(fs.readFileSync(profile.path, 'utf8')).toBe(
            `[projects.${JSON.stringify(worktree)}]\ntrust_level = "trusted"\n`,
        );
        expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe('model = "gpt-5.6-sol"\n');
        expect(ensureCodexTrustProfile(codexHome, worktree)).toEqual(profile);
        expect(removeCodexTrustProfile(profile, worktree)).toBe(true);
        expect(fs.existsSync(profile.path)).toBe(false);
    });

    it('refuses to replace or remove a foreign profile collision', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-profile-'));
        roots.push(root);
        const codexHome = path.join(root, 'codex-home');
        const worktree = path.join(root, 'repo', '.xtrm', 'worktrees', 'repo-xt-codex-demo');
        const initial = ensureCodexTrustProfile(codexHome, worktree);
        fs.writeFileSync(initial.path, 'foreign = true\n');

        expect(() => ensureCodexTrustProfile(codexHome, worktree)).toThrow('refusing to replace');
        expect(removeCodexTrustProfile(initial, worktree)).toBe(false);
        expect(fs.readFileSync(initial.path, 'utf8')).toBe('foreign = true\n');
    });

    it('rejects missing, malformed, and non-Codex metadata', () => {
        const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-codex-worktree-'));
        roots.push(worktree);
        expect(readCodexWorktreeSession(worktree)).toBeNull();

        fs.ensureDirSync(path.join(worktree, '.xtrm'));
        fs.writeJsonSync(path.join(worktree, '.xtrm', 'session-meta.json'), {
            runtime: 'pi',
            launchedAt: '2026-08-02T18:29:29.000Z',
        });
        expect(readCodexWorktreeSession(worktree)).toBeNull();
    });
});
