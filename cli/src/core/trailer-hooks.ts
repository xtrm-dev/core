import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TRAILER_HOOK_MARKER = '# xtrm-trailer-hook (CORE-2570)';

export function resolveHooksDir(repoRoot: string): string {
    const result = spawnSync('git', ['-C', repoRoot, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
    const configured = (result.stdout ?? '').trim();
    if (result.status === 0 && configured) {
        return path.isAbsolute(configured) ? configured : path.join(repoRoot, configured);
    }
    return path.join(repoRoot, '.git', 'hooks');
}

function resolveSubstrateHookScript(): string | null {
    const candidates: string[] = [];
    // Installed substrate package (npm global / local)
    const npmRoots = [
        process.env.npm_config_prefix ? path.join(process.env.npm_config_prefix, 'lib', 'node_modules', '@jaggerxtrm', 'substrate', 'hooks', 'prepare-commit-msg.ts') : null,
        path.join(process.env.HOME ?? '', '.nvm', 'versions', 'node', process.version, 'lib', 'node_modules', '@jaggerxtrm', 'substrate', 'hooks', 'prepare-commit-msg.ts'),
    ].filter(Boolean) as string[];
    candidates.push(...npmRoots);
    // Local dev checkout (this repo's sibling)
    candidates.push(path.resolve(process.cwd(), '..', '..', 'xtrm', 'packages', 'substrate', 'hooks', 'prepare-commit-msg.ts'));
    for (const c of candidates) {
        try {
            if (require('node:fs').existsSync(c)) return c;
        } catch { /* ignore */ }
    }
    return null;
}

export function isTrailerHookInstalled(repoRoot: string): boolean {
    const hooksDir = resolveHooksDir(repoRoot);
    const hookPath = path.join(hooksDir, 'prepare-commit-msg');
    if (!fs.existsSync(hookPath)) return false;
    const content = fs.readFileSync(hookPath, 'utf8');
    return content.includes(TRAILER_HOOK_MARKER);
}

export async function installTrailerHook(repoRoot: string): Promise<{ changed: boolean; reason?: string }> {
    const hooksDir = resolveHooksDir(repoRoot);
    await fs.ensureDir(hooksDir);
    const hookPath = path.join(hooksDir, 'prepare-commit-msg');
    const backupPath = path.join(hooksDir, '.prepare-commit-msg.xtrm-backup');

    let original = '';
    if (await fs.pathExists(hookPath)) {
        original = await fs.readFile(hookPath, 'utf8');
        if (original.includes(TRAILER_HOOK_MARKER)) {
            return { changed: false, reason: 'already installed' };
        }
        // Save backup only if not already saved
        if (!(await fs.pathExists(backupPath))) {
            await fs.writeFile(backupPath, original, 'utf8');
        }
    } else {
        original = '#!/bin/sh\n';
        await fs.writeFile(hookPath, original, 'utf8');
        await fs.chmod(hookPath, 0o755);
        if (!(await fs.pathExists(backupPath))) {
            await fs.writeFile(backupPath, '', 'utf8');
        }
    }

    const substrateScript = resolveSubstrateHookScript();
    const callLine = substrateScript
        ? `node "${substrateScript}" "$1"`
        : `# substrate hook not found; no-op (XTRM-684 pending)`;

    const addition = `\n${TRAILER_HOOK_MARKER}\n${callLine}\n`;
    await fs.appendFile(hookPath, addition, 'utf8');
    try { await fs.chmod(hookPath, 0o755); } catch { /* ignore */ }
    return { changed: true };
}

export async function removeTrailerHook(repoRoot: string): Promise<{ changed: boolean; reason?: string }> {
    const hooksDir = resolveHooksDir(repoRoot);
    const hookPath = path.join(hooksDir, 'prepare-commit-msg');
    const backupPath = path.join(hooksDir, '.prepare-commit-msg.xtrm-backup');
    if (!(await fs.pathExists(hookPath))) {
        return { changed: false, reason: 'no hook file' };
    }
    const content = await fs.readFile(hookPath, 'utf8');
    if (!content.includes(TRAILER_HOOK_MARKER)) {
        return { changed: false, reason: 'not installed' };
    }
    // Restore from backup if available, else strip the added block
    if (await fs.pathExists(backupPath)) {
        const backup = await fs.readFile(backupPath, 'utf8');
        await fs.writeFile(hookPath, backup, 'utf8');
        await fs.remove(backupPath);
        return { changed: true };
    }
    // Fallback: strip everything from marker onward
    const idx = content.indexOf(TRAILER_HOOK_MARKER);
    const before = content.slice(0, idx).replace(/\n+$/, '\n');
    await fs.writeFile(hookPath, before, 'utf8');
    return { changed: true };
}

export async function setWorktreeIssue(repoRoot: string, issueRef: string): Promise<void> {
    // Enable extensions.worktreeConfig if needed
    spawnSync('git', ['-C', repoRoot, 'config', 'extensions.worktreeConfig', 'true'], { stdio: 'ignore' });
    spawnSync('git', ['-C', repoRoot, 'config', '--worktree', 'xtrm.issue', issueRef], { stdio: 'ignore' });
}
