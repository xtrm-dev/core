import { Command } from 'commander';
import kleur from 'kleur';
import { SUBSTRATE_HOLDER_VAR } from '../core/dispatcher-identity.js';
import { buildGitIdentityEnv, resolveGitEmail } from '../core/git-identity.js';

export interface IdentityEnvReport {
    holder: string | null;
    env: Record<string, string>;
}

/**
 * The identity environment for the CURRENT process (CORE-2525).
 *
 * One shared helper, consumed by launchers and by the specialists supervisor:
 * `xt identity env --json` answers what an agent session must carry so its
 * commits name the agent. Read-only: it resolves from the environment and git,
 * never writes.
 */
export function readIdentityEnv(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
): IdentityEnvReport {
    const holder = (env[SUBSTRATE_HOLDER_VAR] ?? '').trim() || null;
    if (!holder) return { holder: null, env: {} };
    return { holder, env: buildGitIdentityEnv({ holder, email: resolveGitEmail({ cwd }) }) };
}

export function createIdentityCommand(): Command {
    const identity = new Command('identity')
        .description('Agent identity: the git author env an agent commit carries (no credential handling here yet)');

    identity
        .command('env')
        .description('Print the git author/committer env for this agent session (empty when SUBSTRATE_HOLDER is unset)')
        .option('--json', 'Emit {holder, env} as JSON', false)
        .action((opts: { json: boolean }) => {
            const report = readIdentityEnv();
            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }
            if (!report.holder) {
                console.log(kleur.dim('no agent identity: SUBSTRATE_HOLDER is unset (operator session)'));
                return;
            }
            for (const [key, value] of Object.entries(report.env)) console.log(`${key}=${value}`);
        });

    return identity;
}
