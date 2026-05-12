import fs from 'fs-extra';
import path from 'node:path';

// Skipped during recursive scan:
// - .git, node_modules: standard.
// - .worktrees: specialists' worktree provisioning path (e.g. <repo>/.worktrees/<bead>/<role>).
// - worktrees: xt-claude / xt-pi worktree path (e.g. <repo>/.xtrm/worktrees/<name>).
//   Both contain transient checkouts that inherit their parent's .xtrm/, so descending
//   into them over-reports the same repo many times in `xt update --root` sweeps.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.worktrees', 'worktrees']);
const XTRM_DIR = '.xtrm';
const REGISTRY_MARKER = path.join(XTRM_DIR, 'registry.json');

/**
 * Result of a recursive scan under a root directory.
 *
 * - `managed`: repos with both `.xtrm/` and `.xtrm/registry.json`. Ready for
 *   the normal update flow.
 * - `incomplete`: repos with `.xtrm/` but no `.xtrm/registry.json`. Partial
 *   installs, mid-migration, or corrupted scaffolds. Operators should be
 *   made aware so they can run `xt init` or `xt install` to repair.
 */
export interface XtrmRepoScan {
    managed: string[];
    incomplete: string[];
}

/**
 * Backward-compatible: returns only the managed-repo list (same as previous
 * behavior). New callers that need visibility into partial installs should
 * use `scanXtrmRepos` instead.
 */
export async function findManagedRepos(rootDir: string): Promise<string[]> {
    const scan = await scanXtrmRepos(rootDir);
    return scan.managed;
}

/**
 * Walk `rootDir` and discover every directory that contains a `.xtrm/`
 * folder. Split into `managed` (has `registry.json`) and `incomplete`
 * (does not). Sorted alphabetically within each group.
 */
export async function scanXtrmRepos(rootDir: string): Promise<XtrmRepoScan> {
    const managed = new Set<string>();
    const incomplete = new Set<string>();
    await walk(rootDir, managed, incomplete);
    return {
        managed: [...managed].sort(),
        incomplete: [...incomplete].sort(),
    };
}

async function walk(currentDir: string, managed: Set<string>, incomplete: Set<string>): Promise<void> {
    const xtrmPath = path.join(currentDir, XTRM_DIR);
    if (await fs.pathExists(xtrmPath)) {
        const registryPath = path.join(currentDir, REGISTRY_MARKER);
        if (await fs.pathExists(registryPath)) {
            managed.add(currentDir);
        } else {
            incomplete.add(currentDir);
        }
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [] as Array<{ isDirectory(): boolean; name: string }>);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(currentDir, entry.name), managed, incomplete);
    }
}
