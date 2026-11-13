import { Command } from 'commander';
import kleur from 'kleur';
import prompts from 'prompts';
import {
    CLAUDE_ROUTE_BLOCK_KEY,
    CLAUDE_ROUTE_MODEL_PREFIX,
    buildClaudeRouteBlock,
    disableClaudeRoute,
    getClaudeRouteStatus,
    resolveClaudeRouteConfigLocation,
    resolveKnownSpecialistNames,
    writeClaudeRouteBlock,
    type ClaudeRouteStatus,
    type WriteOutcome,
} from '../core/claude-route.js';

/**
 * `xt claude-route` — the consent-gated writer for the operator's Claude Code
 * route switch (CORE-2632).
 *
 * It writes exactly one thing: the `claude_bridge` block in the specialists user
 * config that SPECIALISTS-4442 made the route selector. There is no
 * per-Specialist write, no wildcard, and no credential or billing action — the
 * route changes where turns run, and the operator's Claude subscription pays for
 * them, which is what the confirmation names.
 */

const BILLING_CONSENT_LINE =
    'Enabling this route runs the listed Specialists on Claude Code, billed to your Claude ' +
    'subscription (Anthropic plan quota or API usage).';

function collectSpecialist(value: string, previous: string[]): string[] {
    return [...previous, ...value.split(',').map(part => part.trim()).filter(part => part.length > 0)];
}

/** A real TTY on both streams; the refusal path reads this and nothing else. */
export function isInteractiveTty(): boolean {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

export async function confirmClaudeRouteEnable(
    message: string,
    opts: { yes?: boolean; isInteractiveTty?: () => boolean } = {},
): Promise<boolean> {
    if (opts.yes) return true;
    const interactive = opts.isInteractiveTty ?? isInteractiveTty;
    if (!interactive()) {
        console.error(kleur.red(
            '\n  ✗ Enabling the Claude Code route requires explicit confirmation.\n' +
            `  ${BILLING_CONSENT_LINE}\n` +
            '  Re-run interactively, or pass --yes to state that consent non-interactively.\n',
        ));
        return false;
    }
    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message,
        initial: false,
    });
    return Boolean(confirm);
}

function renderStatus(status: ClaudeRouteStatus, json: boolean, bridgeInstalled: string | null): void {
    if (json) {
        console.log(JSON.stringify({
            ok: status.error === null,
            command: 'claude-route status',
            path: status.path,
            source: status.source,
            present: status.present,
            enabled: status.enabled,
            listed_specialists: status.listedSpecialists,
            models: status.models,
            error: status.error,
            bridge_package_version: bridgeInstalled,
        }, null, 2));
        return;
    }

    console.log(`\n${kleur.bold('xt claude-route')}\n`);
    console.log(`  config: ${status.path} ${kleur.dim(`(${status.source})`)}`);
    if (status.error) {
        console.log(`  ${kleur.red('✗')} ${status.error}`);
    } else if (!status.present) {
        console.log(`  ${kleur.dim('○')} no ${CLAUDE_ROUTE_BLOCK_KEY} block — route not configured`);
    } else if (status.enabled) {
        console.log(`  ${kleur.green('✓')} route enabled`);
    } else {
        console.log(`  ${kleur.dim('○')} route disabled (${CLAUDE_ROUTE_BLOCK_KEY}.enabled = false)`);
    }
    if (status.listedSpecialists.length > 0) {
        console.log(`  listed Specialists (${status.listedSpecialists.length}):`);
        for (const name of status.listedSpecialists) {
            console.log(`    ${name} ${kleur.dim(`→ ${status.models[name] ?? 'no model'}`)}`);
        }
    } else if (status.present && status.error === null) {
        console.log(kleur.dim('  no Specialists listed — route is off for every Specialist'));
    }
    if (bridgeInstalled) {
        console.log(`  ${kleur.green('✓')} pi-claude-bridge installed (${bridgeInstalled})`);
    } else {
        console.log(`  ${kleur.yellow('○')} pi-claude-bridge not installed — run: pi install npm:pi-claude-bridge@0.12.0`);
    }
    console.log('');
}

/**
 * Report a degraded write and a legacy-path target. Both are operator-visible
 * facts about a write that did happen, so they warn instead of failing.
 */
function renderWriteNotes(write: WriteOutcome | null, source: ClaudeRouteStatus['source']): void {
    if (write && !write.atomic) {
        console.error(kleur.yellow(
            `  ○ write was not atomic (${write.fallbackError ?? 'rename failed'}) — the file was written directly`,
        ));
    }
    if (source === 'legacy') {
        console.error(kleur.yellow(
            '  ○ target is the legacy ~/.specialists/user.json, the file the Specialists loader reads today; ' +
            'migrate it to ~/.config/specialists/user.json before another tool creates that file',
        ));
    }
}

export function createClaudeRouteCommand(): Command {
    const cmd = new Command('claude-route')
        .description('Inspect, enable or disable the operator Claude Code route switch (claude_bridge in ~/.config/specialists/user.json)');

    cmd
        .command('status')
        .description('Report whether the route is enabled and which Specialists it lists (read-only)')
        .option('--json', 'Emit machine-readable JSON', false)
        .action(async (opts: { json?: boolean }) => {
            const { getPiClaudeBridgeInstallStatus } = await import('../core/pi-runtime.js');
            const bridge = await getPiClaudeBridgeInstallStatus().catch(() => null);
            const status = getClaudeRouteStatus();
            renderStatus(status, Boolean(opts.json), bridge?.installedVersion ?? null);
            if (status.error) process.exitCode = 1;
        });

    cmd
        .command('enable')
        .description('Write claude_bridge.enabled with an explicit Specialist allow list (consent required)')
        .option('--specialist <name>', 'Specialist to route (repeatable, comma-separated; kebab-case, no wildcard)', collectSpecialist, [] as string[])
        .option('--model <model>', `Bridged model for every listed Specialist (${CLAUDE_ROUTE_MODEL_PREFIX}...)`)
        .option('--default-model <model>', `Machine-wide default model (${CLAUDE_ROUTE_MODEL_PREFIX}...); defaults to --model`)
        .option('--yes', 'State consent non-interactively (required without a TTY)', false)
        .option('--json', 'Emit machine-readable JSON', false)
        .action(async (opts: {
            specialist: string[];
            model?: string;
            defaultModel?: string;
            yes?: boolean;
            json?: boolean;
        }) => {
            if (opts.specialist.length === 0) {
                console.error(kleur.red('  ✗ --specialist is required: the allow list is explicit, never a wildcard'));
                process.exitCode = 1;
                return;
            }
            if (!opts.model && !opts.defaultModel) {
                console.error(kleur.red(`  ✗ --model is required and must be a ${CLAUDE_ROUTE_MODEL_PREFIX}... model`));
                process.exitCode = 1;
                return;
            }
            const model = (opts.model ?? opts.defaultModel) as string;
            const built = buildClaudeRouteBlock({
                specialists: opts.specialist,
                model,
                defaultModel: opts.defaultModel,
            });
            if (!built.ok) {
                console.error(kleur.red(`  ✗ ${built.error}`));
                process.exitCode = 1;
                return;
            }

            const names = built.block.specialists ?? [];
            const known = resolveKnownSpecialistNames();
            const unknown = known ? names.filter(name => !known.has(name)) : [];
            if (unknown.length > 0) {
                console.error(kleur.yellow(
                    `  ○ not a known Specialist in this install: ${unknown.join(', ')} — the route will not match ` +
                    'a typo until that name exists',
                ));
            }
            const consentMessage =
                `${BILLING_CONSENT_LINE}\n  Route these Specialists: ${names.join(', ')} → ` +
                `${names.map(name => built.block.models?.[name] ?? built.block.default_model).join(', ')}`;

            const consented = await confirmClaudeRouteEnable(consentMessage, { yes: opts.yes });
            if (!consented) {
                if (opts.json) {
                    console.log(JSON.stringify({ ok: false, command: 'claude-route enable', error: 'consent_required' }, null, 2));
                } else {
                    console.error(kleur.red('  ✗ no consent recorded — the route was not changed'));
                }
                process.exitCode = 1;
                return;
            }

            const location = resolveClaudeRouteConfigLocation();
            const written = writeClaudeRouteBlock(built.block, location);
            if (!written.ok) {
                if (opts.json) console.log(JSON.stringify({ ok: false, command: 'claude-route enable', error: written.error }, null, 2));
                else console.error(kleur.red(`  ✗ ${written.error}`));
                process.exitCode = 1;
                return;
            }

            renderWriteNotes(written.result.write, written.result.source);
            if (opts.json) {
                console.log(JSON.stringify({
                    ok: true,
                    command: 'claude-route enable',
                    path: written.result.path,
                    source: written.result.source,
                    listed_specialists: names,
                    models: written.result.block.models ?? {},
                    default_model: written.result.block.default_model,
                    atomic: written.result.write.atomic,
                }, null, 2));
                return;
            }
            console.log(`\n  ${kleur.green('✓')} route enabled in ${written.result.path}`);
            console.log(`    ${names.length} Specialist(s): ${names.join(', ')}`);
            console.log(`    ${CLAUDE_ROUTE_BLOCK_KEY}.enabled = true`);
            console.log('');
        });

    cmd
        .command('disable')
        .description('Turn the route off (enabled:false, allow list kept); --purge removes the block')
        .option('--purge', `Remove the ${CLAUDE_ROUTE_BLOCK_KEY} key entirely instead of setting enabled:false`, false)
        .option('--json', 'Emit machine-readable JSON', false)
        .action((opts: { purge?: boolean; json?: boolean }) => {
            const location = resolveClaudeRouteConfigLocation();
            const result = disableClaudeRoute(location, { purge: Boolean(opts.purge) });
            if (!result.ok) {
                if (opts.json) console.log(JSON.stringify({ ok: false, command: 'claude-route disable', error: result.error }, null, 2));
                else console.error(kleur.red(`  ✗ ${result.error}`));
                process.exitCode = 1;
                return;
            }
            renderWriteNotes(result.write, result.source);
            if (opts.json) {
                console.log(JSON.stringify({
                    ok: true,
                    command: 'claude-route disable',
                    path: result.path,
                    source: result.source,
                    outcome: result.outcome,
                    atomic: result.write?.atomic ?? null,
                }, null, 2));
                return;
            }
            if (result.outcome === 'absent') {
                console.log(`\n  ${kleur.dim('○')} no ${CLAUDE_ROUTE_BLOCK_KEY} block in ${result.path} — nothing to disable\n`);
                return;
            }
            if (result.outcome === 'purged') {
                console.log(`\n  ${kleur.green('✓')} removed ${CLAUDE_ROUTE_BLOCK_KEY} from ${result.path}`);
                console.log(kleur.dim('    an absent block restores per-definition flags — verify no definition carries execution.claude_bridge'));
                console.log('');
                return;
            }
            console.log(`\n  ${kleur.green('✓')} route disabled in ${result.path} (${CLAUDE_ROUTE_BLOCK_KEY}.enabled = false)`);
            console.log(kleur.dim('    allow list kept so no definition flag can route work implicitly'));
            console.log('');
        });

    return cmd;
}
