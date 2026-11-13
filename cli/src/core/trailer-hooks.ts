import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSetupTs } from './substrate.js';

/**
 * Chains Substrate's `prepare-commit-msg` (the XTRM-Issue trailer adapter,
 * XTRM-684) into a repository's effective hooks dir, and writes the
 * per-worktree `xtrm.issue` binding the launcher and the specialists lease use.
 *
 * Three rules make this safe to run by default from `xt init` and `xt update`:
 * the chain never replaces a repo hook, it is idempotent, and it refuses to
 * install a marker when the substrate hook entry cannot be resolved — a green
 * status over an inert hook is the failure this module exists to avoid.
 */

export const TRAILER_HOOK_MARKER = '# xtrm-trailer-hook (CORE-2570)';
/** Present in the block only when `install` created the hook file itself, so
 * `--remove` deletes it instead of leaving a zero-byte executable behind. */
export const TRAILER_HOOK_CREATED = '# xtrm-created-hook-file';

export type TrailerHookStatus = 'installed' | 'missing' | 'inert';

/**
 * The repo's effective hooks dir: `git rev-parse --git-path hooks` already
 * handles a linked worktree (`.git` is a file there), `GIT_DIR`,
 * `core.hooksPath` (absolute, relative or `~`-prefixed). The result is
 * relative to the repo's cwd for a linked worktree, so resolve it against
 * `repoRoot` — never hand-roll `.git/hooks`, which cannot exist in a worktree.
 */
export function resolveHooksDir(repoRoot: string): string {
    const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8', stdio: 'pipe' });
    const reported = (result.stdout ?? '').trim();
    if (result.status === 0 && reported) {
        // `--git-path` answers relative to the repository's top level.
        return path.resolve(repoRoot, reported);
    }
    return path.join(repoRoot, '.git', 'hooks');
}

/**
 * The substrate hook entry, derived from the one authoritative source resolver
 * (`resolveSetupTs`, which honours `XTRM_SUBSTRATE_DIR`, `XTRM_SUBSTRATE_SETUP`
 * and `npm root -g`). Two layouts count: a source checkout carries
 * `hooks/prepare-commit-msg.ts`, a published package carries the compiled
 * `dist/hooks/prepare-commit-msg.js`.
 */
export function resolveSubstrateHookEntry(): string | null {
    const setup = resolveSetupTs();
    if (!setup) return null;
    const normalized = setup.replaceAll('\\', '/');
    // <root>/integrations/setup.ts, or <root>/dist/integrations/setup.js
    const root = normalized.endsWith('/dist/integrations/setup.js')
        ? normalized.slice(0, -'/dist/integrations/setup.js'.length)
        : normalized.endsWith('/integrations/setup.ts')
            ? normalized.slice(0, -'/integrations/setup.ts'.length)
            : null;
    if (!root) return null;
    for (const candidate of [
        path.join(root, 'hooks', 'prepare-commit-msg.ts'),
        path.join(root, 'dist', 'hooks', 'prepare-commit-msg.js'),
    ]) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch { /* next */ }
    }
    return null;
}

function hookPathFor(repoRoot: string): string {
    return path.join(resolveHooksDir(repoRoot), 'prepare-commit-msg');
}

/** The exact block this module appends; `--remove` strips it verbatim. */
function chainBlock(entry: string, createdFile: boolean): string {
    const lines = ['', TRAILER_HOOK_MARKER];
    if (createdFile) lines.push(TRAILER_HOOK_CREATED);
    // Fail-open: a substrate hook that exits non-zero must never abort a commit.
    lines.push(`node "${entry}" "$1" >/dev/null 2>&1 || true`);
    return `${lines.join('\n')}\n`;
}

export function readHooksState(repoRoot: string): { status: TrailerHookStatus; hookPath: string; entry: string | null } {
    const hookPath = hookPathFor(repoRoot);
    let content: string;
    try {
        content = fs.readFileSync(hookPath, 'utf8');
    } catch {
        return { status: 'missing', hookPath, entry: null };
    }
    if (!content.includes(TRAILER_HOOK_MARKER)) return { status: 'missing', hookPath, entry: null };
    // The marker alone is not enough: the call it guards must name a file that
    // exists, or the chain is inert and swallowing every trailer.
    const call = content.split('\n').find((line) => line.startsWith('node "') && line.includes('prepare-commit-msg'));
    if (!call) return { status: 'inert', hookPath, entry: null };
    const entry = call.slice('node "'.length, call.indexOf('"', 'node "'.length));
    try {
        return fs.existsSync(entry) ? { status: 'installed', hookPath, entry } : { status: 'inert', hookPath, entry };
    } catch {
        return { status: 'inert', hookPath, entry };
    }
}

export function isTrailerHookInstalled(repoRoot: string): boolean {
    return readHooksState(repoRoot).status === 'installed';
}

export interface InstallOutcome {
    changed: boolean;
    /** Machine-readable why, for `hooks status` and the init/update summaries. */
    reason: 'installed' | 'already-installed' | 'substrate-hook-unresolved';
    hookPath: string;
    entry: string | null;
}

export async function installTrailerHook(repoRoot: string): Promise<InstallOutcome> {
    const hookPath = hookPathFor(repoRoot);
    const entry = resolveSubstrateHookEntry();
    if (!entry) {
        // Refuse loudly: writing the marker with no call is the inert state.
        return { changed: false, reason: 'substrate-hook-unresolved', hookPath, entry: null };
    }
    const state = readHooksState(repoRoot);
    if (state.status === 'installed' && state.entry === entry) {
        return { changed: false, reason: 'already-installed', hookPath, entry };
    }
    if (state.status === 'inert') {
        // A stale or unresolvable chain: strip the old block, then append the
        // resolved one, keeping any repo content that sits around it.
        await stripChain(hookPath);
    } else if (state.status === 'missing' && fs.existsSync(hookPath)) {
        // A repo hook with no chain yet: append, never overwrite.
        await fs.appendFile(hookPath, chainBlock(entry, false), 'utf8');
        await fs.chmod(hookPath, 0o755).catch(() => undefined);
        return { changed: true, reason: 'installed', hookPath, entry };
    } else {
        await fs.ensureDir(path.dirname(hookPath));
        await fs.writeFile(hookPath, `#!/bin/sh\n${chainBlock(entry, true)}`, 'utf8');
        await fs.chmod(hookPath, 0o755).catch(() => undefined);
        return { changed: true, reason: 'installed', hookPath, entry };
    }
    await fs.appendFile(hookPath, chainBlock(entry, false), 'utf8');
    await fs.chmod(hookPath, 0o755).catch(() => undefined);
    return { changed: true, reason: 'installed', hookPath, entry };
}

/** Remove the chain block in place, leaving everything around it untouched. */
async function stripChain(hookPath: string): Promise<void> {
    const content = await fs.readFile(hookPath, 'utf8');
    const lines = content.split('\n');
    const kept: string[] = [];
    let createdByUs = false;
    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] === TRAILER_HOOK_MARKER) {
            if (lines[i + 1] === TRAILER_HOOK_CREATED) {
                createdByUs = true;
                i += 1;
            }
            // Drop the call line that follows the marker.
            if ((lines[i + 1] ?? '').startsWith('node "')) i += 1;
            // And the blank separator this module wrote before the marker.
            if (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
            continue;
        }
        kept.push(lines[i]);
    }
    const body = kept.join('\n');
    const onlyShebang = body.trim() === '#!/bin/sh' || body.trim() === '';
    if (createdByUs && onlyShebang) {
        await fs.remove(hookPath);
        return;
    }
    await fs.writeFile(hookPath, body, 'utf8');
}

export async function removeTrailerHook(repoRoot: string): Promise<{ changed: boolean; reason: string }> {
    const { status, hookPath } = readHooksState(repoRoot);
    if (status === 'missing') return { changed: false, reason: 'not installed' };
    // Always strip the block: a snapshot restore would discard edits the
    // operator made to their own hook while the chain was in place.
    await stripChain(hookPath);
    return { changed: true, reason: 'removed' };
}

/**
 * The doctor's one line for this component. `inert` is the state that used to
 * read as healthy: the marker is present but the call names nothing.
 */
export function trailerHookVerdict(repoRoot: string): { status: TrailerHookStatus; message: string } {
    const { status, hookPath, entry } = readHooksState(repoRoot);
    if (status === 'installed') return { status, message: `Substrate trailer hook installed (${hookPath})` };
    if (status === 'inert') {
        return { status, message: `Substrate trailer hook is inert (${hookPath} calls ${entry ?? 'nothing'}); run: xt hooks install-trailers` };
    }
    return { status, message: `Substrate trailer hook missing in ${resolveHooksDir(repoRoot)}; run: xt hooks install-trailers` };
}

/** Write the per-worktree Issue binding the launcher and the lease read. */
export function setWorktreeIssue(repoRoot: string, issueRef: string): { ok: boolean; error?: string } {
    const enable = spawnSync('git', ['-C', repoRoot, 'config', 'extensions.worktreeConfig', 'true'], { encoding: 'utf8', stdio: 'pipe' });
    if (enable.status !== 0) return { ok: false, error: (enable.stderr ?? '').trim() || 'could not enable extensions.worktreeConfig' };
    const write = spawnSync('git', ['-C', repoRoot, 'config', '--worktree', 'xtrm.issue', issueRef], { encoding: 'utf8', stdio: 'pipe' });
    if (write.status !== 0) return { ok: false, error: (write.stderr ?? '').trim() || 'could not write xtrm.issue' };
    return { ok: true };
}
