import { Command } from 'commander';
import kleur from 'kleur';
import { doctorJiraIdentity, jiraIdentityPaths, setupJiraIdentity } from '../core/jira-identity.js';

export function createJiraCommand(): Command {
    const jira = new Command('jira').description('Jira agent identity: agents run acli and jira.py as the xtrm-bot account, not as the operator');

    jira
        .command('setup')
        .description('Create the bot acli profile from the token file, then install the acli shim (idempotent)')
        .option('--email <email>', 'Agent account email (required the first time)')
        .option('--site <site>', 'Atlassian site (default mercuryintel.atlassian.net)')
        .option('--token-file <path>', 'API token of the agent account (default ~/.secrets/atlassian-agent-token.txt, mode 600)')
        .action((opts: { email?: string; site?: string; tokenFile?: string }) => {
            try {
                const identity = setupJiraIdentity({ email: opts.email, site: opts.site, tokenFile: opts.tokenFile });
                console.log(kleur.green(`✓ Jira agent identity ready: ${identity.email} @ ${identity.site}`));
                console.log(kleur.dim(`  shim: ${jiraIdentityPaths().shimPath}  (rollback: remove it; operator override: XTRM_JIRA_AS=operator)`));
            } catch (error) {
                console.error(kleur.red(`✗ ${(error as Error).message}`));
                process.exit(1);
            }
        });

    jira
        .command('doctor')
        .description('Check the Jira agent identity pieces (read-only; exit 1 when any check fails)')
        .option('--json', 'Emit the checks as JSON', false)
        .action((opts: { json: boolean }) => {
            const checks = doctorJiraIdentity();
            if (opts.json) {
                console.log(JSON.stringify({ ok: checks.every(c => c.ok), checks }, null, 2));
            } else {
                for (const c of checks) console.log(`${c.ok ? kleur.green('✓') : kleur.red('✗')} ${c.name.padEnd(20)} ${kleur.dim(c.detail)}`);
            }
            if (!checks.every(c => c.ok)) process.exit(1);
        });

    return jira;
}
