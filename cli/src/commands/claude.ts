import { Command } from 'commander';
import kleur from 'kleur';
import { execSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { resolveMainProjectRoot } from '../utils/repo-root.js';
import { t } from '../utils/theme.js';
import { runClaudeRuntimeSyncPhase } from '../core/claude-runtime-sync.js';
import { launchWorktreeSession } from '../utils/worktree-session.js';
import { confirmDestructiveAction } from '../utils/confirmation.js';
import { inventoryDeps, renderBootstrapPlan } from '../core/machine-bootstrap.js';

function getProjectSettingsPath(repoRoot: string): string {
    return path.join(repoRoot, '.claude', 'settings.json');
}

function hasXtrmHookWiring(settingsPath: string): boolean {
    if (!fs.existsSync(settingsPath)) return false;

    try {
        const data = fs.readJsonSync(settingsPath) as {
            hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
        };

        const groups = Object.values(data.hooks ?? {});
        for (const wrappers of groups) {
            for (const wrapper of wrappers) {
                for (const hook of wrapper.hooks ?? []) {
                    if (typeof hook.command === 'string' && hook.command.includes('.xtrm/hooks/')) {
                        return true;
                    }
                }
            }
        }
        return false;
    } catch {
        return false;
    }
}

export function createClaudeCommand(): Command {
    const cmd = new Command('claude')
        .description('Launch a Claude session in a sandboxed worktree, or manage Claude hook wiring')
        .argument('[name]', 'Optional session name — used as xt/<name> branch (random if omitted)')
        .option('--role <name>', 'Launch claude as a specialist role (resolved via `sp view <name>`); mirrors xt pi --role — creates a tmux session (or runs in current pane inside $TMUX) with @agent_task metadata')
        .option('--bead <id>', 'Bind a bead to the session and auto-populate its assignee as claude/<slug> from runtime-origin. With --role it renders the tracked task as the initial user prompt (mutually exclusive with --prompt there); without --role it is metadata only — @agent_bead pane option + XTMUX_AGENT_BEAD — and combines freely with --prompt')
        .option('--prompt <text>', 'Use <text> as the initial user prompt. A leading /<skill-name> is the supported way to load a skill on turn 1')
        .option('--no-attach', 'Create tmux session detached; print `session_name:pane_id` on stdout and exit (default: attach)')
        .option('--json', 'With --no-attach: emit one xtrm.command-outcome.v1 JSON object instead of human launch output')
        .option('--model <name>', 'Forward `--model <name>` to claude; with --role, overrides specialist.execution.model')
        .option('--thinking <level>', 'Warn-and-drop — claude has no --thinking flag; set thinking on the underlying model config instead')
        .option('--skill <name-or-path>', 'Load an additional skill at startup (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
        .option('--new-session', 'Inside $TMUX: force a fresh tmux session instead of running in the current pane (default outside $TMUX)')
        .option('--ns', 'Alias for --new-session')
        .option('--parent <target>', 'With --role: override @agent_parent_session on the target pane (target = tmux session name, id, or #{session_id})')
        .option('--child', 'With --role: explicit form of the auto-behavior — @agent_parent_session = current pane\'s session_id')
        .option('--reuse', 'With --role + --new-session (or outside $TMUX): if a session named role-<slug>[-<bead>] already exists, attach to it instead of auto-suffixing a fresh one')
        .option('--subordinate', 'Canonical subordinate-coordinator launch: implies --new-session --no-attach and parents the child to the current session. Requires --role; still gets its own worktree and branch')
        .option('--base <ref>', 'Start the worktree branch at <ref> (e.g. origin/stable for hotfixes). Default: fresh origin/<default>, fetched first (CORE-2340)')
        .allowExcessArguments(true)
        .allowUnknownOption(true)
        .addHelpText('after', `
Passthrough:
  Everything after \`--\` is forwarded verbatim to the claude runtime, with or
  without --role. xt-owned flags (--session-dir, --name, --system-prompt,
  --append-system-prompt, --skill) are rejected; batch-mode flags (--print,
  --list-models, --export, --mode) are dropped with a warning.

Examples:
  $ xt claude demo --no-attach --prompt 'inspect the failing build' --model claude-opus-4-8
  $ xt claude worker --no-attach --prompt '/multiplexing leggi /tmp/brief.txt e seguilo'
  $ xt claude worker --no-attach --bead xyz --prompt 'work this bead'   # bead as pane metadata
  $ xt claude worker --prompt 'audit the auth flow' -- --add-dir ~/notes
  $ xt claude coord --role chain-coordinator --bead xyz --subordinate   # subordinate coordinator (P0-05)
  $ xt claude --role reviewer --bead xyz -- --add-dir ~/notes
  $ xt claude --role chain-coordinator --model claude-opus-4-8
  $ xt claude --role reviewer --prompt 'review the auth changes in cli/src/auth/'
  $ xt claude --role planner                          # skills-only prime; pane idles
`)
        .action(async (name: string | undefined, opts: {
            role?: string;
            bead?: string;
            prompt?: string;
            attach?: boolean;
            json?: boolean;
            model?: string;
            thinking?: string;
            skill?: string[];
            newSession?: boolean;
            ns?: boolean;
            parent?: string;
            child?: boolean;
            reuse?: boolean;
            subordinate?: boolean;
            base?: string;
        }) => {
            // claude has no --thinking flag; if the operator was explicit,
            // warn and continue (specialist.execution.thinking_level from
            // sp view is silently dropped for claude in buildRoleTmuxPlan).
            if (opts.thinking) {
                console.error(kleur.yellow(
                    `  ⚠ xt claude --thinking: claude has no --thinking flag; ignoring '${opts.thinking}'. Configure thinking on the model itself.`,
                ));
            }
            const dashIdx = process.argv.indexOf('--');
            const passthrough = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];
            await launchWorktreeSession({
                runtime: 'claude',
                name,
                role: opts.role,
                bead: opts.bead,
                prompt: opts.prompt,
                attach: opts.attach,
                json: Boolean(opts.json),
                model: opts.model,
                thinking: opts.thinking,
                skills: opts.skill,
                newSession: Boolean(opts.newSession || opts.ns),
                parent: opts.parent,
                child: Boolean(opts.child),
                reuse: Boolean(opts.reuse),
                subordinate: Boolean(opts.subordinate),
                base: opts.base,
                passthrough,
            });
        });

    cmd.command('install')
        .description('Repair Claude settings hook wiring from .xtrm/config/hooks.json')
        .option('--dry-run', 'Preview without making changes', false)
        .option('-y, --yes', 'Skip confirmation prompt', false)
        .action(async (opts: { dryRun: boolean; yes: boolean }) => {
            if (!opts.dryRun) {
                const confirmed = await confirmDestructiveAction({
                    yes: opts.yes,
                    message: 'Sync Claude hooks into settings.json?',
                    initial: true,
                });
                if (!confirmed) {
                    console.log(kleur.dim('  Cancelled\n'));
                    return;
                }
            }

            const repoRoot = resolveMainProjectRoot(process.cwd());
            await runClaudeRuntimeSyncPhase({ repoRoot, dryRun: opts.dryRun, isGlobal: false });
        });

    cmd.command('reload')
        .alias('reinstall')
        .description('[deprecated] Use xt claude install (planned removal: v0.13.0)')
        .option('-y, --yes', 'Skip confirmation prompt', false)
        .action(async (opts: { yes: boolean }) => {
            console.error('xt claude reload/reinstall is deprecated — use: xt claude install (planned removal: v0.13.0)');
            const confirmed = await confirmDestructiveAction({
                yes: opts.yes,
                message: 'Re-sync Claude hooks into settings.json?',
                initial: true,
            });
            if (!confirmed) {
                console.log(kleur.dim('  Cancelled\n'));
                return;
            }

            const repoRoot = resolveMainProjectRoot(process.cwd());
            await runClaudeRuntimeSyncPhase({ repoRoot, dryRun: false, isGlobal: false });
        });

    cmd.command('status')
        .description('Show Claude CLI version and .xtrm hook wiring status')
        .action(async () => {
            console.log(t.bold('\n  Claude Code Status\n'));

            try {
                const version = execSync('claude --version', { encoding: 'utf8', stdio: 'pipe' }).trim();
                console.log(t.success(`  ✓ claude CLI: ${version}`));
            } catch {
                console.log(kleur.red('  ✗ claude CLI not found'));
                console.log('');
                return;
            }

            const repoRoot = resolveMainProjectRoot(process.cwd());
            const settingsPath = getProjectSettingsPath(repoRoot);
            if (hasXtrmHookWiring(settingsPath)) {
                console.log(t.success(`  ✓ Claude hooks wired (${settingsPath})`));
            } else {
                console.log(kleur.yellow('  ⚠ .xtrm hook wiring missing — run: xt claude install'));
            }

            try {
                execSync('bd --version', { stdio: 'ignore' });
                console.log(t.success('  ✓ beads (bd) available'));
            } catch {
                console.log(kleur.dim('  ○ beads (bd) not installed'));
            }

            console.log('');
        });

    cmd.command('doctor')
        .description('[deprecated] Use xt doctor for runtime diagnosis (planned removal: v0.13.0)')
        .action(async () => {
            console.error('xt claude doctor is deprecated — use: xt doctor (planned removal: v0.13.0)');
            console.log(t.bold('\n  Claude Code Doctor\n'));

            let allOk = true;

            try {
                execSync('claude --version', { stdio: 'ignore' });
                console.log(t.success('  ✓ claude CLI available'));
            } catch {
                console.log(kleur.red('  ✗ claude CLI not found — install Claude Code'));
                allOk = false;
            }

            const repoRoot = resolveMainProjectRoot(process.cwd());
            const settingsPath = getProjectSettingsPath(repoRoot);
            if (hasXtrmHookWiring(settingsPath)) {
                console.log(t.success('  ✓ .xtrm hooks are wired in .claude/settings.json'));
            } else {
                console.log(kleur.yellow('  ⚠ .xtrm hooks not wired — run: xt claude install'));
                allOk = false;
            }

            // Managed dependencies — unified inventory
            const plan = inventoryDeps();
            renderBootstrapPlan(plan);

            if (!plan.allRequiredPresent) allOk = false;

            console.log('');
            if (allOk) {
                console.log(t.boldGreen('  ✓ All checks passed\n'));
            } else {
                console.log(kleur.yellow('  ⚠ Some checks failed — see above\n'));
            }
        });

    return cmd;
}
