import { Command } from 'commander';

function section(title: string, lines: string[]): string {
    return [title, ...lines, ''].join('\n');
}

export function createHelpCommand(): Command {
    return new Command('help')
        .description('Show rich CLI help in a plain text format')
        .action(async () => {
            const blocks: string[] = [];

            blocks.push(section('XTRM CLI', [
                '  xtrm and xt are equivalent commands.',
                '  Use xt for short workflow commands (xt claude, xt pi, xt end).',
            ]));

            blocks.push(section('USAGE', [
                '  xtrm <command> [subcommand] [options]',
                '  xt <command> [subcommand] [options]',
            ]));

            blocks.push(section('CORE WORKFLOW', [
                '  1) Start a runtime session in a worktree:',
                '     xt claude [name]   or   xt pi [name]',
                '  2) Do your work in that worktree/branch.',
                '  3) If the session closes unexpectedly, re-attach:',
                '     xt attach [slug]',
                '  4) Publish that worktree with:',
                '     xt end',
                '  5) Optional follow-up operators:',
                '     xt memory update   (refresh .xtrm/memory.md from bd memories + repo state)',
                '     xt merge           (drain queued xt/* PRs oldest-first after CI passes)',
                '  6) Manage old worktrees when needed:',
                '     xt worktree list | xt worktree doctor | xt worktree clean',
            ]));

            blocks.push(section('PRIMARY COMMANDS', [
                '  xtrm init [options]',
                '    Bootstrap xtrm in this project with a phased installer:',
                '      1. Preflight     — inventory system state (no mutations)',
                '      2. Plan          — show what will change',
                '      3. Confirm       — single gate before all mutations',
                '      4. Machine       — install system tools (bd, dolt, bv, pi, pnpm)',
                '      5. Claude        — .xtrm/hooks wiring into .claude/settings.json',
                '      6. Pi            — extensions + packages sync',
                '      7. Project       — bd init, GitNexus index, AGENTS.md/CLAUDE.md',
                '      8. Verify        — unified outcome summary',
                '    Options: --dry-run, --yes/-y, --global',
                '',
                '  xtrm update [--apply] [--repo <path>] [--root <dir>] [--json]',
                '    Refresh xtrm-managed files for one repo or many.',
                '    Default is dry-run for the current repo; --apply writes changes.',
                '    --repo targets one repo; --root discovers repos with .xtrm/registry.json.',
                '',
                '  xtrm status [--json]',
                '    Show pending changes for detected environments.',
                '',
                '  xtrm clean [options]',
                '    Remove orphaned hooks/skills and stale hook wiring entries.',
                '    Options: --dry-run, --hooks-only, --skills-only, --yes/-y',
                '',
                '  xtrm docs --help',
                '    Documentation inspection and drift-check submenu.',
                '    Subcommands: show, list, cross-check',
                '',
                '  xtrm docs cross-check [--days <n>] [--json]',
                '    Validate docs against recent PR activity and closed bd issues.',
                '',
                '  xtrm memory update [--dry-run] [--no-beads]',
                '    Run memory-processor specialist to synthesize bd memories into .xtrm/memory.md.',
                '    --dry-run: classify and report without writing memory.md or pruning.',
                '',
                '  xtrm merge [--dry-run] [--yes/-y] [--no-beads]',
                '    Drain the xt worktree PR merge queue via the xt-merge specialist (FIFO, --rebase).',
                '    --dry-run: list queue and CI status without merging.',
                '',
                '  xtrm debug [options]',
                '    Stream xtrm event log (tool calls, gates, session/bd lifecycle).',
                '    Options: --follow, --all, --session <id>, --type <domain>, --json',
                '',
                '  xtrm reset [--yes/-y]',
                '    Clear saved CLI preferences.',
                '',
                '  xtrm doctor [--cwd <path>] [--json] [--check-drift]',
                '    Health check for xtrm-managed surfaces: CLAUDE.md fragments, Cat B',
                '    skills/hooks drift, runtime views, and duplicate canonical names.',
                '',
                '  xtrm release prepare [--major|--minor|--patch] [--from <ref>] [--to <ref>]',
                '    Draft the next release from xt reports via the changelog script surface.',
                '    Note: prepare currently depends on specialists issue unitAI-dnmcg to make',
                '    changelog drafting script-compatible.',
                '',
                '  xtrm release publish [--gh-release]',
                '    Publish an already-prepared release: create annotated tag, push commits/tags,',
                '    and optionally create a GitHub release.',
                '',
                '  xtrm claude-sync [options]',
                '    Sync managed CLAUDE.md fragments via XTRM-MANAGED:* sentinels.',
                '    Modes: --check (default, exit 1 on drift), --apply --accept-overwrite,',
                '           --list, --add <fragment>. Use --json on --check or --list for',
                '           machine-readable output. Templated fragments use --repo-name /',
                '           --repo-stats overrides.',
                '',
                '  xtrm help',
                '    Show this help page.',
            ]));

            blocks.push(section('RUNTIME COMMANDS', [
                '  xt claude [name]',
                '    Launch Claude in a sandboxed xt/<name> worktree.',
                '  xt claude install [--dry-run] [--yes/-y]',
                '    Install/refresh .xtrm hook wiring in Claude settings.json.',
                '  xt claude status | xt claude doctor | xt claude reload',
                '',
                '  xt pi [name]',
                '    Launch Pi in a sandboxed xt/<name> worktree.',
                '  xt pi setup',
                '    Interactive first-time setup.',
                '  xt pi status | xt pi doctor | xt pi reload [--yes/-y]',
            ]));

            blocks.push(section('WORKTREE COMMANDS', [
                '  xt attach [slug]',
                '    Re-attach to an existing worktree and resume the Claude or Pi session.',
                '    Picks the most recent worktree if no slug is given; shows a picker when',
                '    multiple exist. Resumes with --continue (claude) or -c (pi).',
                '',
                '  xt worktree list',
                '    List active xt/* worktrees with runtime, last activity, last commit, and',
                '    a ready-to-run resume hint.',
                '  xt worktree doctor',
                '    Diagnose nested/prunable/orphaned worktree state and show cleanup commands.',
                '  xt worktree clean [--orphans] [--dry-run] [--yes/-y]',
                '    Remove merged worktrees; with --orphans also prune stale metadata and orphan dirs.',
                '  xt worktree remove <name> [--yes/-y]',
                '    Remove a specific xt worktree by name or path.',
            ]));

            blocks.push(section('SESSION CLOSE', [
                '  xt end [options]',
                '    Rebase to origin/main, push, open PR, link issues, and optionally clean worktree.',
                '    Options: --draft, --keep, --yes/-y',
                '',
                '  xt memory update [--dry-run] [--no-beads]',
                '    Run memory-processor to synthesize .xtrm/memory.md from bd memories + repo state.',
                '',
                '  xt merge [--dry-run] [--yes/-y] [--no-beads]',
                '    Run xt-merge to drain queued xt/* PRs FIFO: CI gate → rebase merge → rebase cascade.',
            ]));

            blocks.push(section('NOTES', [
                '  - xtrm init uses a single confirmation before all mutations.',
                '  - Use --yes/-y to skip the confirmation gate.',
                '  - For command-level details, run: xtrm <command> --help',
                '  - For subcommand details, run: xtrm <command> <subcommand> --help',
                '  - For docs workflow details, run: xtrm docs --help',
            ]));

            process.stdout.write(blocks.join('\n'));
        });
}
