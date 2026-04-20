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

export async function ensureSkillsSymlink(
    linkPath: string,
    symlinkTarget: string,
    label: string,
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
            if (label === '.claude/skills') {
                console.log(kleur.yellow('  ⚠ .claude/skills is a runtime-managed read-only view; direct writes are unsupported.'));
                console.log(kleur.yellow('    Move custom skills to .xtrm/skills/default or .xtrm/skills/{optional,user}/packs/* and rebuild.'));
            }
            await fs.remove(linkPath);
            console.log(kleur.yellow(`  ⚠ ${label} was a real path — replaced with managed symlink`));
        }
    }
    await fs.mkdirp(path.dirname(linkPath));
    await fs.symlink(symlinkTarget, linkPath);
    console.log(`${kleur.green('  ✓')} ${label} → ${symlinkTarget}`);
}

export async function ensureAgentsSkillsSymlink(projectRoot: string): Promise<SkillsActivationResult> {
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
