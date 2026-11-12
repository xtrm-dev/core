import { Command } from 'commander';
import kleur from 'kleur';
import { installTrailerHook, removeTrailerHook, isTrailerHookInstalled, resolveHooksDir } from '../core/trailer-hooks.js';

export function createHooksCommand(): Command {
    const cmd = new Command('hooks').description('Git hook management (trailer chaining, etc.)');

    const install = cmd.command('install-trailers').description('Chain Substrate prepare-commit-msg into repo hooks');
    install.option('--repo <path>', 'Repository root (default cwd)');
    install.option('--remove', 'Remove the chained trailer hook', false);
    install.action(async (opts) => {
        const repoRoot = opts.repo ?? process.cwd();
        if (opts.remove) {
            const r = await removeTrailerHook(repoRoot);
            console.log(r.changed ? kleur.green('✓ removed') : kleur.dim(`  ${r.reason}`));
        } else {
            const r = await installTrailerHook(repoRoot);
            console.log(r.changed ? kleur.green('✓ installed') : kleur.dim(`  ${r.reason}`));
            console.log(kleur.dim(`  hooks dir: ${resolveHooksDir(repoRoot)}`));
        }
    });

    cmd.command('status').description('Show trailer hook installation status').option('--repo <path>', 'Repository root (default cwd)').action(async (opts) => {
        const repoRoot = opts.repo ?? process.cwd();
        const installed = isTrailerHookInstalled(repoRoot);
        console.log(installed ? kleur.green('✓ trailer hook installed') : kleur.yellow('⚠ trailer hook missing'));
        console.log(kleur.dim(`  hooks dir: ${resolveHooksDir(repoRoot)}`));
    });

    return cmd;
}
