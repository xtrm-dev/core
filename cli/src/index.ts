import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import kleur from 'kleur';

// __dirname is available in CJS output (tsup target: cjs)
declare const __dirname: string;
let version = '0.0.0';
try { version = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version; } catch { /* fallback */ }

import { createClaudeCommand } from './commands/claude.js';
import { createPiCommand } from './commands/pi.js';
import { createCodexCommand } from './commands/codex.js';
import { runProjectInit } from './commands/init.js';
import { createStatusCommand } from './commands/status.js';
import { createResetCommand } from './commands/reset.js';
import { createHelpCommand } from './commands/help.js';
import { createCleanCommand } from './commands/clean.js';
import { createEndCommand } from './commands/end.js';
import { createWorktreeCommand } from './commands/worktree.js';
import { createAttachCommand } from './commands/attach.js';
import { createDocsCommand } from './commands/docs.js';
import { createMergeCommand } from './commands/merge.js';
import { createDebugCommand } from './commands/debug.js';
import { createReportCommand } from './commands/report.js';
import { createSkillsCommand } from './commands/skills.js';
import { createClaudeSyncCommand } from './commands/claude-sync.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createBootstrapCommand } from './commands/bootstrap.js';
import { createUpdateCommand } from './commands/update.js';
import { createReleaseCommand } from './commands/release.js';
import { createSpecCommand } from './commands/spec.js';
import { createMigrateCommand } from './commands/migrate.js';
import { createVersionCommand } from './commands/version.js';
import { createTopologyCommand } from './commands/topology.js';
import { printBanner } from './utils/banner.js';

const program = new Command();

program
    .name('xtrm')
    .description('Agent infrastructure layer for runtimes, skills, hooks, extensions, and packages')
    .version(version);

// Add exit override for cleaner unknown command error
program.exitOverride((err) => {
    if (err.code === 'commander.unknownCommand') {
        console.error(kleur.red(`\n✗ Unknown command. Run 'xtrm --help'\n`));
        process.exit(1);
    }
    // Preserve exit code for help (0) and version (0); default to 1 for real errors
    process.exit(err.exitCode ?? 1);
});

// Main commands
program.addCommand(createClaudeCommand());
program.addCommand(createPiCommand());
program.addCommand(createCodexCommand());
program
    .command('init')
    .description('First-time xtrm bootstrap: machine → Claude → Pi → project')
    .option('--dry-run', 'Preview changes without making any modifications', false)
    .option('-y, --yes', 'Skip confirmation prompts', false)
    .option('--global', 'Install tooling to user-global scope instead of project-local', false)
    .option('--prune', 'Remove plugin-era artifacts (Claude plugin cache, stale settings keys)', false)
    .option('--sb-project <id>', 'Link this checkout to an existing Substrate project during init')
    .option('--sb-create-project <prefix:name>', 'Create a Substrate project and link it during init')
    .option('--substrate-dir <path>', 'Authorized local @xtrm/substrate checkout for sb provision and integration enrollment')
    .action(async (opts) => {
        await runProjectInit(opts);
    });
program.addCommand(createStatusCommand());
program.addCommand(createResetCommand());
program.addCommand(createCleanCommand());
program.addCommand(createEndCommand());
program.addCommand(createWorktreeCommand());
program.addCommand(createTopologyCommand());
program.addCommand(createAttachCommand());
program.addCommand(createDocsCommand());
program.addCommand(createMergeCommand());
program.addCommand(createDebugCommand());
program.addCommand(createReportCommand());
program.addCommand(createSkillsCommand());
program.addCommand(createClaudeSyncCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createBootstrapCommand());
program.addCommand(createUpdateCommand());
program.addCommand(createReleaseCommand());
program.addCommand(createSpecCommand());
program.addCommand(createMigrateCommand());
program.addCommand(createVersionCommand());
program.addCommand(createHelpCommand());

// Default action: show help
program
    .action(async () => {
        program.help();
    });

// Global error handlers
process.on('uncaughtException', (err) => {
    if ((err as any).code?.startsWith('commander.')) {
        return;
    }
    console.error(kleur.red(`\n✗ ${err.message}\n`));
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error(kleur.red(`\n✗ ${String(reason)}\n`));
    process.exit(1);
});

// Show the banner only for first-time setup (never for help/version output).
const isHelpOrVersion = process.argv.some(a => a === '--help' || a === '-h' || a === '--version' || a === '-V');
const isSetupCommand = process.argv[2] === 'init';

(async () => {
    if (!isHelpOrVersion && isSetupCommand) {
        await printBanner(version);
    }
    program.parseAsync(process.argv);
})();
