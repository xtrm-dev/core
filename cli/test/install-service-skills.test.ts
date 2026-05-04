import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fsExtra from 'fs-extra';
import { mergeSettingsHooks, installSkills, installGitHooks } from '../src/commands/install-service-skills.js';
import { ensureAgentsSkillsSymlink } from '../src/core/skills-scaffold.js';

// __dirname in vitest context = cli/test/
const REPO_ROOT = path.resolve(__dirname, '../..');
const ACTUAL_SKILLS_ROOT = path.join(REPO_ROOT, '.xtrm', 'skills');
const ACTUAL_SERVICE_SKILLS_ASSETS = path.join(REPO_ROOT, '.xtrm', 'skills', 'default', 'service-skills-set');

describe('mergeSettingsHooks', () => {
    it('adds all three hooks to empty settings', () => {
        const { result, added, skipped } = mergeSettingsHooks({});
        const hooks = result.hooks as Record<string, unknown>;
        expect(added).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse']);
        expect(skipped).toEqual([]);
        expect(hooks).toHaveProperty('SessionStart');
        expect(hooks).toHaveProperty('PreToolUse');
        expect(hooks).toHaveProperty('PostToolUse');
    });

    it('preserves existing keys and appends missing hook entries', () => {
        const existing = { hooks: { SessionStart: [{ custom: true }] } };
        const { result, added, skipped } = mergeSettingsHooks(existing);
        const hooks = result.hooks as Record<string, unknown[]>;

        expect(skipped).toEqual([]);
        expect(added).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse']);
        expect(hooks.SessionStart).toEqual(expect.arrayContaining([{ custom: true }]));
    });

    it('preserves non-hook keys in settings', () => {
        const existing = { apiKey: 'abc', permissions: { allow: [] } };
        const { result } = mergeSettingsHooks(existing);
        expect(result.apiKey).toBe('abc');
        expect(result.permissions).toEqual({ allow: [] });
    });
});

describe('installSkills', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(tmpdir(), 'jaggers-test-'));
        await fsExtra.ensureDir(path.join(tmpDir, '.xtrm', 'skills'));
        await fsExtra.copy(ACTUAL_SKILLS_ROOT, path.join(tmpDir, '.xtrm', 'skills'));
        await ensureAgentsSkillsSymlink(tmpDir);
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('verifies trinity skills are reachable through active .claude/skills view', async () => {
        const results = await installSkills(tmpDir, ACTUAL_SKILLS_ROOT);

        for (const { skill, status } of results) {
            expect(status).toBe('active');
            expect(await fsExtra.pathExists(path.join(tmpDir, '.claude', 'skills', skill, 'SKILL.md'))).toBe(true);
        }
    });

    it('fails when active runtime view is missing a trinity skill', async () => {
        await fsExtra.remove(path.join(tmpDir, '.xtrm', 'skills', 'active', 'using-service-skills'));

        await expect(installSkills(tmpDir, ACTUAL_SKILLS_ROOT)).rejects.toThrow(/using-service-skills/);
    });
});

describe('installGitHooks', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await mkdtemp(path.join(tmpdir(), 'jaggers-test-'));
        await fsExtra.mkdirp(path.join(tmpDir, '.git', 'hooks'));
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('creates .githooks/pre-commit with doc-reminder snippet', async () => {
        await installGitHooks(tmpDir, ACTUAL_SERVICE_SKILLS_ASSETS);
        const content = await fsExtra.readFile(path.join(tmpDir, '.githooks', 'pre-commit'), 'utf8');
        expect(content).toContain('# [jaggers] doc-reminder');
        expect(content).toContain('.claude/git-hooks/doc_reminder.py');
    });

    it('creates .githooks/pre-push with skill-staleness snippet', async () => {
        await installGitHooks(tmpDir, ACTUAL_SERVICE_SKILLS_ASSETS);
        const content = await fsExtra.readFile(path.join(tmpDir, '.githooks', 'pre-push'), 'utf8');
        expect(content).toContain('# [jaggers] skill-staleness');
        expect(content).toContain('.claude/git-hooks/skill_staleness.py');
    });

    it('copies hook scripts into .claude/git-hooks/', async () => {
        await installGitHooks(tmpDir, ACTUAL_SERVICE_SKILLS_ASSETS);
        expect(await fsExtra.pathExists(path.join(tmpDir, '.claude', 'git-hooks', 'doc_reminder.py'))).toBe(true);
        expect(await fsExtra.pathExists(path.join(tmpDir, '.claude', 'git-hooks', 'skill_staleness.py'))).toBe(true);
    });

    it('activates hooks in .git/hooks/', async () => {
        await installGitHooks(tmpDir, ACTUAL_SERVICE_SKILLS_ASSETS);
        expect(await fsExtra.pathExists(path.join(tmpDir, '.git', 'hooks', 'pre-commit'))).toBe(true);
        expect(await fsExtra.pathExists(path.join(tmpDir, '.git', 'hooks', 'pre-push'))).toBe(true);
    });

    it('is idempotent — does not duplicate snippets on re-run', async () => {
        await installGitHooks(tmpDir, ACTUAL_SERVICE_SKILLS_ASSETS);
        await installGitHooks(tmpDir, ACTUAL_SERVICE_SKILLS_ASSETS);
        const content = await fsExtra.readFile(path.join(tmpDir, '.githooks', 'pre-commit'), 'utf8');
        const count = (content.match(/# \[jaggers\] doc-reminder/g) ?? []).length;
        expect(count).toBe(1);
    });

    it('chains hooks into configured core.hooksPath when beads owns hooks path', async () => {
        spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
        spawnSync('git', ['config', 'core.hooksPath', '.beads/hooks'], { cwd: tmpDir, stdio: 'pipe' });

        await installGitHooks(tmpDir, ACTUAL_SERVICE_SKILLS_ASSETS);

        const beadsPreCommit = path.join(tmpDir, '.beads', 'hooks', 'pre-commit');
        const beadsPrePush = path.join(tmpDir, '.beads', 'hooks', 'pre-push');
        expect(await fsExtra.pathExists(beadsPreCommit)).toBe(true);
        expect(await fsExtra.pathExists(beadsPrePush)).toBe(true);

        const preCommitContent = await fsExtra.readFile(beadsPreCommit, 'utf8');
        const prePushContent = await fsExtra.readFile(beadsPrePush, 'utf8');
        expect(preCommitContent).toContain('# [jaggers] chain-githooks');
        expect(prePushContent).toContain('# [jaggers] chain-githooks');
        expect(preCommitContent).toContain(path.join(tmpDir, '.githooks', 'pre-commit'));
        expect(prePushContent).toContain(path.join(tmpDir, '.githooks', 'pre-push'));
    });
});
