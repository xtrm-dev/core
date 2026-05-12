import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { ensureBeadsSharedServerEnabled } from '../core/beads-shared-server.js';

describe('ensureBeadsSharedServerEnabled', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-shared-server-'));
    });

    afterEach(async () => {
        await fs.remove(tmpRoot);
    });

    it('returns not-applicable when .beads/ does not exist', async () => {
        const result = await ensureBeadsSharedServerEnabled(tmpRoot, true);
        expect(result).toEqual({ changed: false, state: 'not-applicable' });
    });

    it('returns updated (changed: true) on dry run when config is empty', async () => {
        await fs.ensureDir(path.join(tmpRoot, '.beads'));
        await fs.writeFile(path.join(tmpRoot, '.beads', 'config.yaml'), '');

        const result = await ensureBeadsSharedServerEnabled(tmpRoot, false);
        expect(result).toEqual({ changed: true, state: 'updated' });
    });

    it('handles comments-only config.yaml without crashing (yaml.parse returns null) — xtrm-16ec', async () => {
        await fs.ensureDir(path.join(tmpRoot, '.beads'));
        // Default fresh-bd-init config: all comments. yaml.parse returns null on this.
        await fs.writeFile(
            path.join(tmpRoot, '.beads', 'config.yaml'),
            '# Beads Configuration File\n# This file configures default behavior for all bd commands\n',
        );

        // Must NOT throw "Cannot read properties of null (reading 'dolt')".
        const result = await ensureBeadsSharedServerEnabled(tmpRoot, true);
        expect(result).toEqual({ changed: true, state: 'updated' });

        const written = await fs.readFile(path.join(tmpRoot, '.beads', 'config.yaml'), 'utf8');
        expect(written).toContain('shared-server: true');
    });

    it('handles scalar-string parse without crashing (defensive)', async () => {
        await fs.ensureDir(path.join(tmpRoot, '.beads'));
        await fs.writeFile(path.join(tmpRoot, '.beads', 'config.yaml'), 'just-a-string\n');

        const result = await ensureBeadsSharedServerEnabled(tmpRoot, true);
        expect(result.state).toBe('updated');
    });

    it('returns enabled when shared-server: true is already set', async () => {
        await fs.ensureDir(path.join(tmpRoot, '.beads'));
        await fs.writeFile(
            path.join(tmpRoot, '.beads', 'config.yaml'),
            'dolt:\n  shared-server: true\n',
        );

        const result = await ensureBeadsSharedServerEnabled(tmpRoot, false);
        expect(result).toEqual({ changed: false, state: 'enabled' });
    });

    it('preserves existing yaml content when applying the flag', async () => {
        await fs.ensureDir(path.join(tmpRoot, '.beads'));
        await fs.writeFile(
            path.join(tmpRoot, '.beads', 'config.yaml'),
            'issue-prefix: "myproj"\ndolt:\n  some-other: value\n',
        );

        const result = await ensureBeadsSharedServerEnabled(tmpRoot, true);
        expect(result).toEqual({ changed: true, state: 'updated' });

        const written = await fs.readFile(path.join(tmpRoot, '.beads', 'config.yaml'), 'utf8');
        expect(written).toContain('issue-prefix: myproj');
        expect(written).toContain('some-other: value');
        expect(written).toContain('shared-server: true');
    });
});
