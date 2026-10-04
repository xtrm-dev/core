import { Command } from 'commander';

import { launchCodexWorktreeSession } from '../utils/codex-worktree-session.js';

export function createCodexCommand(): Command {
    return new Command('codex')
        .description('EXPERIMENTAL: launch Codex in an xt-owned worktree with persisted hook trust')
        .argument('[name]', 'Optional session name — used as xt/<name> branch (random if omitted)')
        .option('--role <name>', 'Launch Codex with a Specialists role')
        .option('--bead <id>', 'Bind a bead to the session; with --role, render it as the initial task')
        .option('--prompt <text>', 'Use text as the initial user prompt')
        .option('--model <name>', 'Forward --model to Codex')
        .option('--skill <name-or-path>', 'Invoke an additional $skill-name at startup (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
        .option('--no-attach', 'Create the tmux session detached')
        .option('--json', 'With --no-attach: emit one xtrm.command-outcome.v1 JSON object')
        .option('--yolo', 'Disable sandboxing and approval prompts (default)', true)
        .option('--no-yolo', 'Use workspace-write sandboxing with on-request approval')
        .option('--base <ref>', 'Start the worktree branch at <ref> (e.g. origin/stable for hotfixes). Default: fresh origin/<default>, fetched first (CORE-2340)')
        .allowExcessArguments(true)
        .allowUnknownOption(true)
        .addHelpText('after', `
Safety:
  The default --yolo profile emits --dangerously-bypass-approvals-and-sandbox.
  --no-yolo emits --sandbox workspace-write --ask-for-approval on-request.
  Both profiles preserve persisted hook trust. --dangerously-bypass-hook-trust is forbidden.

Status:
  This surface is EXPERIMENTAL until the K5 Codex parity promotion gate.
`)
        .action(async (name: string | undefined, opts: {
            role?: string;
            bead?: string;
            prompt?: string;
            model?: string;
            skill?: string[];
            attach?: boolean;
            json?: boolean;
            yolo?: boolean;
            base?: string;
        }, command: Command) => {
            const passthrough = command.args.slice(name === undefined ? 0 : 1);
            await launchCodexWorktreeSession({
                name,
                role: opts.role,
                bead: opts.bead,
                prompt: opts.prompt,
                model: opts.model,
                skills: opts.skill,
                attach: opts.attach,
                json: Boolean(opts.json),
                yolo: opts.yolo !== false,
                base: opts.base,
                passthrough,
            });
        });
}
