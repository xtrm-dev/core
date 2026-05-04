import path from 'path';
import fs from 'fs-extra';
import kleur from 'kleur';
import { rebuildAllRuntimeActiveViews } from './skills-materializer.js';
import { resolveSkillsRoot } from './skills-layout.js';
import { validateSkillsInvariants } from './skill-discovery.js';

export interface SkillsActivationResult {
    readonly activatedClaudeSkills: number;
    readonly activatedPiSkills: number;
}

interface EnsureSkillsSymlinkOptions {
    readonly force?: boolean;
}

async function collectFileSnapshot(rootDir: string): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>();

    async function walk(currentDir: string): Promise<void> {
        const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
        entries.sort((left, right) => left.name.localeCompare(right.name));

        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            const relativePath = path.relative(rootDir, entryPath);

            if (entry.isDirectory()) {
                await walk(entryPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            snapshot.set(relativePath, await fs.readFile(entryPath, 'utf8'));
        }
    }

    if (await fs.pathExists(rootDir)) {
        await walk(rootDir);
    }

    return snapshot;
}

async function backupManagedSkillsDirectory(linkPath: string): Promise<string> {
    const backupPath = `${linkPath}.bak-${new Date().toISOString().replace(/:/g, '-')}`;
    await fs.copy(linkPath, backupPath, { overwrite: true, errorOnExist: false, dereference: true });
    return backupPath;
}

function isSkillsMigrationForced(options: EnsureSkillsSymlinkOptions): boolean {
    return options.force || ['1', 'true', 'yes'].includes(String(process.env.XTRM_FORCE_SKILLS_MIGRATION ?? '').toLowerCase());
}

async function replaceRealDirectoryWithSymlink(
    linkPath: string,
    symlinkTarget: string,
    label: string,
    options: EnsureSkillsSymlinkOptions,
): Promise<void> {
    if (label === '.claude/skills') {
        console.log(kleur.yellow('  ⚠ .claude/skills is runtime-managed read-only view; direct writes unsupported.'));
        console.log(kleur.yellow('    Move custom skills to .xtrm/skills/user/ then rebuild.'));
    }

    const isForced = isSkillsMigrationForced(options);

    if (isForced) {
        const backupPath = await backupManagedSkillsDirectory(linkPath);
        console.log(kleur.yellow(`  ⚠ ${label} backed up to ${backupPath}`));
    }

    await fs.remove(linkPath);
    await fs.mkdirp(path.dirname(linkPath));
    await fs.symlink(symlinkTarget, linkPath);
    console.log(kleur.yellow(`  ⚠ ${label} real path replaced with managed symlink`));
}

export async function ensureSkillsSymlink(
    linkPath: string,
    symlinkTarget: string,
    label: string,
    options: EnsureSkillsSymlinkOptions = {},
): Promise<void> {
    const existing = await fs.lstat(linkPath).catch(() => null);
    if (existing) {
        if (existing.isSymbolicLink()) {
            const current = await fs.readlink(linkPath);
            if (current === symlinkTarget) {
                console.log(kleur.dim(`  ✓ ${label} symlink already in place`));
                return;
            }
            await fs.remove(linkPath);
        } else {
            const targetSnapshot = await collectFileSnapshot(path.resolve(path.dirname(linkPath), symlinkTarget));
            const existingSnapshot = await collectFileSnapshot(linkPath);
            const matchesManagedView = targetSnapshot.size === existingSnapshot.size && [...targetSnapshot.entries()].every(([relativePath, content]) => existingSnapshot.get(relativePath) === content);

            if (!matchesManagedView && !isSkillsMigrationForced(options)) {
                throw new Error(
                    `Refusing to replace existing ${label}. Backup existing files from ${label}, then re-run with --force. See docs/cat-b-distribution.md.`,
                );
            }

            await replaceRealDirectoryWithSymlink(linkPath, symlinkTarget, label, options);
            return;
        }
    }

    await fs.mkdirp(path.dirname(linkPath));
    await fs.symlink(symlinkTarget, linkPath);
    console.log(`${kleur.green('  ✓')} ${label} → ${symlinkTarget}`);
}

export async function ensureAgentsSkillsSymlink(projectRoot: string, options: EnsureSkillsSymlinkOptions = {}): Promise<SkillsActivationResult> {
    const skillsRoot = resolveSkillsRoot(projectRoot);
    if (!await fs.pathExists(path.join(skillsRoot, 'default'))) {
        return {
            activatedClaudeSkills: 0,
            activatedPiSkills: 0,
        };
    }

    const invariantViolations = await validateSkillsInvariants(skillsRoot);
    if (invariantViolations.length > 0) {
        const summary = invariantViolations.map(violation => `${violation.code}: ${violation.message}`).join('; ');
        throw new Error(`Skills invariants failed. ${summary}`);
    }

    const materializedViews = await rebuildAllRuntimeActiveViews(skillsRoot);
    const activatedClaudeSkills = materializedViews[0]?.discoveredSkillCount ?? 0;
    const activatedPiSkills = activatedClaudeSkills;

    await ensureSkillsSymlink(
        path.join(projectRoot, '.claude', 'skills'),
        path.join('..', '.xtrm', 'skills', 'active'),
        '.claude/skills',
        options,
    );

    const agentsSkillsPath = path.join(projectRoot, '.agents', 'skills');
    if (await fs.pathExists(agentsSkillsPath)) {
        console.log(kleur.dim('  ○ .agents/skills is deprecated; runtime skills are generated under .xtrm/skills/active'));
    }

    return {
        activatedClaudeSkills,
        activatedPiSkills,
    };
}
