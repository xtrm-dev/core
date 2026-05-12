import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { findManagedRepos, scanXtrmRepos } from '../core/repo-discovery.js';

describe('scanXtrmRepos', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-scan-'));
    });

    afterEach(async () => {
        await fs.remove(tmpRoot);
    });

    it('splits repos into managed (has registry) and incomplete (no registry)', async () => {
        const managedRepo = path.join(tmpRoot, 'managed');
        const incompleteRepo = path.join(tmpRoot, 'incomplete');
        await fs.ensureDir(path.join(managedRepo, '.xtrm'));
        await fs.writeJson(path.join(managedRepo, '.xtrm', 'registry.json'), { assets: {} });
        await fs.ensureDir(path.join(incompleteRepo, '.xtrm'));
        // intentionally no registry.json

        const scan = await scanXtrmRepos(tmpRoot);

        expect(scan.managed).toEqual([managedRepo]);
        expect(scan.incomplete).toEqual([incompleteRepo]);
    });

    it('returns empty lists when no .xtrm/ exists under root', async () => {
        await fs.ensureDir(path.join(tmpRoot, 'plain-repo'));

        const scan = await scanXtrmRepos(tmpRoot);

        expect(scan.managed).toEqual([]);
        expect(scan.incomplete).toEqual([]);
    });

    it('skips .git and node_modules subdirs', async () => {
        const buriedManaged = path.join(tmpRoot, 'a', 'node_modules', 'fake-pkg');
        await fs.ensureDir(path.join(buriedManaged, '.xtrm'));
        await fs.writeJson(path.join(buriedManaged, '.xtrm', 'registry.json'), { assets: {} });
        const buriedIncomplete = path.join(tmpRoot, 'b', '.git', 'worktrees', 'w');
        await fs.ensureDir(path.join(buriedIncomplete, '.xtrm'));

        const scan = await scanXtrmRepos(tmpRoot);

        expect(scan.managed).toEqual([]);
        expect(scan.incomplete).toEqual([]);
    });

    it('skips .worktrees/* (specialists worktree provisioning) — xtrm-ny61', async () => {
        // Top-level real repo (managed)
        const realRepo = path.join(tmpRoot, 'real-repo');
        await fs.ensureDir(path.join(realRepo, '.xtrm'));
        await fs.writeJson(path.join(realRepo, '.xtrm', 'registry.json'), { assets: {} });
        // Specialists-style transient worktree under .worktrees/
        const transient = path.join(realRepo, '.worktrees', 'unitAI-foo', 'unitAI-foo-executor');
        await fs.ensureDir(path.join(transient, '.xtrm'));
        await fs.writeJson(path.join(transient, '.xtrm', 'registry.json'), { assets: {} });

        const scan = await scanXtrmRepos(tmpRoot);

        expect(scan.managed).toEqual([realRepo]);
        expect(scan.managed).not.toContain(transient);
        expect(scan.incomplete).toEqual([]);
    });

    it('skips worktrees/* (xt-claude / xt-pi worktree path) — xtrm-ny61', async () => {
        const realRepo = path.join(tmpRoot, 'xt-repo');
        await fs.ensureDir(path.join(realRepo, '.xtrm'));
        await fs.writeJson(path.join(realRepo, '.xtrm', 'registry.json'), { assets: {} });
        // xt-claude-style transient worktree under .xtrm/worktrees/
        const transient = path.join(realRepo, '.xtrm', 'worktrees', 'xt-claude-xyz');
        await fs.ensureDir(path.join(transient, '.xtrm'));

        const scan = await scanXtrmRepos(tmpRoot);

        expect(scan.managed).toEqual([realRepo]);
        expect(scan.managed).not.toContain(transient);
        expect(scan.incomplete).toEqual([]);
    });

    it('discovers multiple managed + incomplete repos at varying depths', async () => {
        const m1 = path.join(tmpRoot, 'a', 'm1');
        const m2 = path.join(tmpRoot, 'b', 'deep', 'm2');
        const i1 = path.join(tmpRoot, 'a', 'i1');
        await fs.ensureDir(path.join(m1, '.xtrm'));
        await fs.writeJson(path.join(m1, '.xtrm', 'registry.json'), { assets: {} });
        await fs.ensureDir(path.join(m2, '.xtrm'));
        await fs.writeJson(path.join(m2, '.xtrm', 'registry.json'), { assets: {} });
        await fs.ensureDir(path.join(i1, '.xtrm'));

        const scan = await scanXtrmRepos(tmpRoot);

        expect(scan.managed).toEqual([m1, m2].sort());
        expect(scan.incomplete).toEqual([i1]);
    });

    it('findManagedRepos still returns only the managed list (backward-compatible)', async () => {
        const m = path.join(tmpRoot, 'm');
        const i = path.join(tmpRoot, 'i');
        await fs.ensureDir(path.join(m, '.xtrm'));
        await fs.writeJson(path.join(m, '.xtrm', 'registry.json'), { assets: {} });
        await fs.ensureDir(path.join(i, '.xtrm'));

        const result = await findManagedRepos(tmpRoot);

        expect(result).toEqual([m]);
        expect(result).not.toContain(i);
    });
});
