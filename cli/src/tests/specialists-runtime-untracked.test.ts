// CORE-2670: the Specialists runtime roots must never be tracked.
//
// `@jaggerxtrm/specialists` writes `.specialists/settlements/` (attestations) and
// `.specialists/interactions/` (pending message bodies) into the project it runs
// in. Both carry activation ids and payloads for one machine's run, so a worker
// that activates a Specialist sees them as untracked files and commits them unless
// .gitignore covers the roots. This suite fails if either root becomes tracked
// again, and proves the ignore rule rather than only the current absence.

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const RUNTIME_ROOTS = ['.specialists/settlements', '.specialists/interactions'] as const;

function git(args: string[], cwd: string): { status: number | null; stdout: string } {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: result.status, stdout: String(result.stdout ?? '') };
}

function repoRoot(): string | null {
    const probe = git(['rev-parse', '--show-toplevel'], process.cwd());
    return probe.status === 0 ? probe.stdout.trim() || null : null;
}

const root = repoRoot();

describe.skipIf(root === null)('Specialists runtime roots stay untracked (CORE-2670)', () => {
    it('tracks no file under a runtime root', () => {
        const listed = git(['ls-files', '--', ...RUNTIME_ROOTS], root as string);
        expect(listed.status, 'git ls-files must answer').toBe(0);
        expect(listed.stdout.trim(), 'tracked runtime files').toBe('');
    });

    it('ignores a file under each root, so a new shape cannot slip through', () => {
        // Paths that do not exist are fine: check-ignore answers from the rules.
        for (const sample of [
            '.specialists/settlements/act:x/att:x:1.json',
            '.specialists/interactions/act:x/msg:x.json',
        ]) {
            const ignored = git(['check-ignore', '-q', '--', sample], root as string);
            expect(ignored.status, `${sample} must be ignored`).toBe(0);
        }
    });

    it('still tracks the repo-local user override, which is deliberate config', () => {
        const listed = git(['ls-files', '--', '.specialists/user'], root as string);
        expect(listed.status).toBe(0);
        // Absent is fine (a repo without an override), tracked is fine, ignored is not.
        if (listed.stdout.trim()) {
            const ignored = git(['check-ignore', '-q', '--', listed.stdout.trim().split('\n')[0] as string], root as string);
            expect(ignored.status, 'a tracked user override must not be ignored').not.toBe(0);
        }
    });
});
