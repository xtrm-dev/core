import { Command } from 'commander';
import kleur from 'kleur';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { SUBSTRATE_HOLDER_VAR } from '../core/dispatcher-identity.js';
import { buildGitIdentityEnv, resolveGitEmail } from '../core/git-identity.js';
import {
    DEFAULT_API_BASE,
    appInstallationSummary,
    fileMode,
    githubAppPaths,
    mintInstallationToken,
    readAppConfig,
    repoOwner,
    GitHubAppError,
    type GitHubAppDeps,
} from '../core/github-apps.js';
import {
    DEFAULT_ROLE_MAP,
    ROLE_ENV_VAR,
    ROLE_MAP_VERSION,
    appSlugForRole,
    loadRoleMap,
    processAgentRole,
    resolveAgentRole,
    roleMapPath,
    type AgentRole,
    type RoleMap,
} from '../core/identity-roles.js';
import {
    buildGitTransportEnv,
    credentialAppFor,
    credentialResponse,
    parseCredentialRequest,
} from '../core/git-transport.js';
import { ghShimStatus, installGhShim } from '../core/gh-shim.js';
import { resolveAgentRunId } from '../core/agent-run-id.js';
import {
    eventForFlags,
    eventForOutcome,
    parseIssueMarker,
    postReview,
    reviewJournalArgs,
    sha12,
    ReviewRefused,
    type ReviewVerdict,
} from '../core/review-posting.js';
import { applyOverride, mergeCheck, recordMerge } from '../core/merge-guard.js';
import { installRoutingReminder } from '../core/reviewer-routing.js';

export interface IdentityEnvReport {
    holder: string | null;
    role: AgentRole | null;
    env: Record<string, string>;
}

/**
 * The identity environment for the CURRENT process (CORE-2525, CORE-2528).
 * One shared helper for launchers and the specialists supervisor: what an agent
 * session must carry so its commits name the agent and its git transport uses
 * the role App instead of the operator's ssh key.
 */
export function readIdentityEnv(
    env: NodeJS.ProcessEnv = process.env,
    cwd: string = process.cwd(),
    appDeps: GitHubAppDeps = {},
): IdentityEnvReport {
    const holder = (env[SUBSTRATE_HOLDER_VAR] ?? '').trim() || null;
    if (!holder) return { holder: null, role: null, env: {} };
    const map = loadRoleMap({ home: appDeps.home });
    const role = processAgentRole(env, map);
    return {
        holder,
        role,
        env: {
            ...buildGitIdentityEnv({ holder, email: resolveGitEmail({ cwd }) }),
            ...(role ? { [ROLE_ENV_VAR]: role } : {}),
            ...buildGitTransportEnv({ role, map: map ?? DEFAULT_ROLE_MAP, deps: appDeps }),
        },
    };
}

function fail(message: string): never {
    process.stderr.write(`xt identity: ${message}\n`);
    process.exit(1);
}

function emit(value: unknown, json: boolean): void {
    if (json) {
        console.log(JSON.stringify(value, null, 2));
        return;
    }
    for (const line of String(value).split('\n')) console.log(line);
}

function appDeps(): GitHubAppDeps {
    return { apiBase: DEFAULT_API_BASE };
}

function effectiveRole(env: NodeJS.ProcessEnv = process.env): { role: AgentRole | null; map: RoleMap | null } {
    const map = loadRoleMap();
    return { role: processAgentRole(env, map), map };
}

async function reviewerTokenFor(repo: string, map: RoleMap): Promise<{ token: string; slug: string; account: string }> {
    const account = repoOwner(repo);
    if (!account) fail(`'${repo}' is not an owner/name repository slug`);
    const slug = appSlugForRole('reviewer', map);
    const minted = await mintInstallationToken({ slug, account }, appDeps());
    return { token: minted.token, slug, account };
}

function runSb(args: string[]): { ok: boolean; error?: string } {
    const result = spawnSync('sb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status === 0) return { ok: true };
    return { ok: false, error: (result.stderr || '').trim() || `sb exited ${result.status}` };
}

export function createIdentityCommand(): Command {
    const identity = new Command('identity')
        .description('Agent identity: git author env, role App tokens, the gh shim, review posting and the merge guard');

    identity
        .command('env')
        .description('Print this agent session\'s identity env (git author + role), or nothing for an operator session')
        .option('--json', 'Emit {holder, role, env} as JSON', false)
        .action((opts: { json: boolean }) => {
            const report = readIdentityEnv();
            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }
            if (!report.holder) {
                // stdout must stay empty so `eval "$(xt identity env)"` is safe.
                process.stderr.write(`${kleur.dim('no agent identity: SUBSTRATE_HOLDER is unset (operator session)')}\n`);
                return;
            }
            for (const [key, value] of Object.entries(report.env)) console.log(`${key}=${value}`);
        });

    identity
        .command('role-map')
        .description('Show the role map in effect and the role this process resolves to')
        .option('--json', 'Emit JSON', false)
        .action((opts: { json: boolean }) => {
            const file = roleMapPath();
            const map = loadRoleMap();
            const role = processAgentRole(process.env, map);
            const report = {
                path: file,
                present: existsSync(file),
                valid: map !== null,
                version: map?.version ?? null,
                default: map?.default ?? null,
                specialists: map?.specialists ?? null,
                apps: map?.apps ?? null,
                resolvedRole: role,
            };
            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }
            if (!map) {
                console.log(kleur.red(`role map invalid at ${file}: every agent acts as no role (no App credential)`));
                return;
            }
            console.log(`role map: ${file}${report.present ? '' : ' (absent, using defaults)'}`);
            console.log(`default role: ${map.default}`);
            for (const [name, mapped] of Object.entries(map.specialists)) {
                console.log(`  ${name} -> ${mapped ?? '(no credential)'}`);
            }
            for (const [role2, slug] of Object.entries(map.apps)) console.log(`  app ${role2}: ${slug}`);
            console.log(`this process: ${role ?? 'operator (no App credential)'}`);
        });

    identity
        .command('token')
        .description('Mint (or reuse) a one-hour installation token for a role App on one repository')
        .requiredOption('--repo <owner/name>', 'Repository whose owner installation is used')
        .option('--role <role>', 'Role to act as (default: this process\'s resolved role)')
        .option('--json', 'Emit JSON', false)
        .action(async (opts: { repo: string; role?: string; json: boolean }) => {
            const { map } = effectiveRole();
            if (!map) fail('the role map is invalid; refusing to mint any token');
            const role = opts.role ? resolveAgentRole(opts.role, map) : processAgentRole(process.env, map);
            if (!role) fail('no role for this process (operator session or an unmapped role)');
            const account = repoOwner(opts.repo);
            if (!account) fail(`'${opts.repo}' is not an owner/name repository slug`);
            try {
                const minted = await mintInstallationToken({ slug: appSlugForRole(role, map), account }, appDeps());
                if (opts.json) {
                    console.log(JSON.stringify({ ...minted, token: minted.token }, null, 2));
                } else {
                    console.log(minted.token);
                }
            } catch (error) {
                fail(error instanceof GitHubAppError ? error.message : (error as Error).message);
            }
        });

    identity
        .command('credential')
        .description('git credential helper: answer only for this role\'s App (used via GIT_CONFIG_*)')
        .argument('<operation>', 'get | store | erase')
        .action(async (operation: string) => {
            const op = (operation ?? '').trim();
            if (op !== 'get') return; // store/erase: nothing to persist, the token is short-lived
            let text = '';
            try {
                text = readFileSync(0, 'utf8');
            } catch {
                return;
            }
            const request = parseCredentialRequest(text);
            const { role, map } = effectiveRole();
            const app = credentialAppFor(request, role, map ?? DEFAULT_ROLE_MAP);
            if (!app) return; // fail closed: no answer, so git has no credential rather than the operator's
            try {
                const minted = await mintInstallationToken(app, appDeps());
                process.stdout.write(credentialResponse(minted.token));
            } catch (error) {
                process.stderr.write(`xt identity credential: ${(error as Error).message}\n`);
            }
        });

    identity
        .command('review-post')
        .description('Post one formal review pinned to the reviewed head (called by the gh shim)')
        .requiredOption('--repo <owner/name>', 'Repository')
        .requiredOption('--pr <number>', 'Pull request number')
        .option('--head <sha>', 'Reviewed head (default: $XTRM_REVIEW_HEAD)')
        .option('-b, --body <text>', 'Review body (findings)')
        .option('--body-file <file>', 'Read the review body from a file')
        .option('--verdict <outcome>', 'PASS | PARTIAL | FAIL')
        .option('--approve', 'Same as --verdict PASS', false)
        .option('--request-changes', 'Same as --verdict FAIL', false)
        .option('--comment', 'Same as --verdict PARTIAL', false)
        .option('--model <model>', 'Model that produced the review (header line 1)')
        .option('--json', 'Emit JSON', false)
        .action(async (opts: {
            repo: string; pr: string; head?: string; body?: string; bodyFile?: string;
            verdict?: string; approve: boolean; requestChanges: boolean; comment: boolean;
            model?: string; json: boolean;
        }) => {
            const holder = (process.env[SUBSTRATE_HOLDER_VAR] ?? '').trim();
            if (!holder) fail('no agent identity: SUBSTRATE_HOLDER is unset, so a review cannot be attributed');
            const { role, map } = effectiveRole();
            if (!map) fail('the role map is invalid; refusing to post any review');
            if (role !== 'reviewer') fail(`the ${role ?? 'operator'} role may not post formal reviews; use the reviewer subagent or xt claude --role pr-reviewer`);
            const pr = Number(opts.pr);
            if (!Number.isInteger(pr) || pr <= 0) fail(`--pr ${opts.pr} is not a pull request number`);
            const head = (opts.head ?? process.env.XTRM_REVIEW_HEAD ?? '').trim();
            if (!/^[0-9a-f]{7,40}$/.test(head)) {
                fail('no reviewed head: pass --head or set XTRM_REVIEW_HEAD to the SHA the review read');
            }
            const verdict: ReviewVerdict | null = opts.verdict
                ? eventForOutcome(opts.verdict)
                : eventForFlags({ approve: opts.approve, requestChanges: opts.requestChanges, comment: opts.comment });
            if (!verdict) fail('choose exactly one of --verdict PASS|PARTIAL|FAIL, --approve, --request-changes, --comment');
            let findings = opts.body ?? '';
            if (opts.bodyFile) {
                try {
                    findings = readFileSync(opts.bodyFile, 'utf8');
                } catch (error) {
                    fail(`cannot read --body-file: ${(error as Error).message}`);
                }
            }
            if (!findings.trim()) fail('an empty review body is refused: pass -b/--body or --body-file');
            const model = (opts.model ?? process.env.XTRM_REVIEW_MODEL ?? 'unknown').trim();
            let token: string;
            try {
                token = (await reviewerTokenFor(opts.repo, map)).token;
            } catch (error) {
                fail(error instanceof GitHubAppError ? error.message : (error as Error).message);
            }
            try {
                const posted = await postReview({
                    repo: opts.repo,
                    pr,
                    head,
                    verdict,
                    findings,
                    role: 'reviewer',
                    model,
                    holder,
                    runId: resolveAgentRunId(),
                    activationId: (process.env.SUBSTRATE_ACTIVATION_ID ?? '').trim() || null,
                }, { token, slug: appSlugForRole('reviewer', map), apiBase: DEFAULT_API_BASE });
                let journaled: { ok: boolean; error?: string } | null = null;
                if (posted.issueRef) journaled = runSb(reviewJournalArgs(posted, {
                    repo: opts.repo, pr, head, verdict, findings, role: 'reviewer', model, holder, runId: resolveAgentRunId(),
                }, posted.issueRef));
                const out = {
                    url: posted.url,
                    id: posted.id,
                    verdict: posted.verdict,
                    head: posted.head,
                    issueRef: posted.issueRef,
                    dismissed: posted.dismissed,
                    warnings: posted.warnings,
                    journaled,
                };
                if (opts.json) {
                    console.log(JSON.stringify(out, null, 2));
                } else {
                    console.log(`${posted.verdict} review posted: ${posted.url}`);
                    console.log(`head ${sha12(posted.head)}${posted.issueRef ? `, Issue ${posted.issueRef}` : ''}`);
                    for (const id of posted.dismissed) console.log(`dismissed stale review ${id}`);
                    for (const warning of posted.warnings) console.log(kleur.yellow(`warning: ${warning}`));
                    if (journaled && !journaled.ok) console.log(kleur.yellow(`warning: Journal receipt failed: ${journaled.error}`));
                }
            } catch (error) {
                if (error instanceof ReviewRefused) fail(error.message);
                fail((error as Error).message);
            }
        });

    identity
        .command('merge-check')
        .description('Allow or refuse a merge: the reviewer App\'s latest review must be at the current head')
        .requiredOption('--repo <owner/name>', 'Repository')
        .requiredOption('--pr <number>', 'Pull request number')
        .option('--json', 'Emit JSON', false)
        .action(async (opts: { repo: string; pr: string; json: boolean }) => {
            const pr = Number(opts.pr);
            if (!Number.isInteger(pr) || pr <= 0) fail(`--pr ${opts.pr} is not a pull request number`);
            const { map } = effectiveRole();
            if (!map) fail('the role map is invalid; the guard fails closed');
            let token: string;
            try {
                token = (await reviewerTokenFor(opts.repo, map)).token;
            } catch (error) {
                fail(`cannot mint the reviewer token (${(error as Error).message}); the guard fails closed`);
            }
            const deps = {
                token,
                apiBase: DEFAULT_API_BASE,
                reviewerSlug: appSlugForRole('reviewer', map),
                roleMap: map,
            };
            let decision = await mergeCheck({ repo: opts.repo, pr }, deps);
            if (!decision.allow) decision = await applyOverride(decision, deps);
            if (opts.json) {
                console.log(JSON.stringify(decision, null, 2));
            } else if (decision.allow) {
                console.log(decision.message);
            } else {
                process.stderr.write(`${decision.message}\n`);
            }
            process.exit(decision.allow ? 0 : 1);
        });

    identity
        .command('merge-record')
        .description('Append the github-merge Journal ref after a merge (called by the gh shim)')
        .requiredOption('--repo <owner/name>', 'Repository')
        .requiredOption('--pr <number>', 'Pull request number')
        .requiredOption('--head <sha>', 'Merged head')
        .option('--issue <ref>', 'Issue ref (default: resolved from the PR body or branch)')
        .action(async (opts: { repo: string; pr: string; head: string; issue?: string }) => {
            const pr = Number(opts.pr);
            if (!Number.isInteger(pr) || pr <= 0) fail(`--pr ${opts.pr} is not a pull request number`);
            const { map } = effectiveRole();
            if (!map) fail('the role map is invalid');
            let issueRef = (opts.issue ?? '').trim();
            if (!issueRef) {
                let token = '';
                try {
                    token = (await reviewerTokenFor(opts.repo, map)).token;
                } catch (error) {
                    fail(`cannot mint the reviewer token: ${(error as Error).message}`);
                }
                const pull = await fetchPullBody(opts.repo, pr, token);
                issueRef = pull.issueRef ?? '';
            }
            if (!issueRef) fail('no Substrate Issue for this PR; cannot record the merge');
            const result = recordMerge({ repo: opts.repo, pr, head: opts.head, issueRef }, { token: '', apiBase: DEFAULT_API_BASE });
            if (!result.ok) fail(`Journal receipt failed: ${result.error}`);
            console.log(`recorded merge of ${opts.repo}#${pr} on ${issueRef}`);
        });

    identity
        .command('setup')
        .description('Install the gh shim and the role map (creates no App; the operator creates those)')
        .option('--bin-dir <dir>', 'Directory for the gh shim (default ~/.local/bin)')
        .option('--json', 'Emit JSON', false)
        .action((opts: { binDir?: string; json: boolean }) => {
            const home = os.homedir();
            const file = roleMapPath(home);
            let roleMapWritten = false;
            if (!existsSync(file)) {
                mkdirSync(path.dirname(file), { recursive: true });
                writeFileSync(file, `${JSON.stringify(DEFAULT_ROLE_MAP, null, 4)}\n`);
                roleMapWritten = true;
            }
            mkdirSync(githubAppPaths(home).identitiesDir, { recursive: true });
            const routing = installRoutingReminder(home);
            const shim = installGhShim({ home, binDir: opts.binDir });
            const report = {
                roleMap: { path: file, written: roleMapWritten },
                routingReminder: routing,
                ghShim: shim,
                apps: Object.entries(DEFAULT_ROLE_MAP.apps).map(([role, slug]) => ({
                    role,
                    slug,
                    configured: readAppConfig(slug, { home }) !== null,
                })),
            };
            if (opts.json) {
                console.log(JSON.stringify(report, null, 2));
            } else {
                console.log(`role map: ${file}${roleMapWritten ? ' (created)' : ' (kept)'}`);
                console.log(`routing reminder: ${routing.path}${routing.written ? ' (created)' : ' (kept)'}`);
                console.log(`gh shim: ${shim.ok ? shim.path : `NOT installed (${shim.reason})`}`);
                for (const warning of shim.warnings) console.log(kleur.yellow(`warning: ${warning}`));
                for (const app of report.apps) {
                    console.log(`app ${app.slug}: ${app.configured ? 'configured' : 'not configured (operator creates it)'}`);
                }
            }
            if (!shim.ok) process.exit(1);
        });

    identity
        .command('doctor')
        .description('Report App config, key permissions, role map and gh shim state (exit 1 on a hard failure)')
        .option('--json', 'Emit JSON', false)
        .action((opts: { json: boolean }) => {
            const home = os.homedir();
            const checks: Array<{ check: string; ok: boolean; detail: string; hard: boolean }> = [];
            const map = loadRoleMap();
            checks.push({
                check: 'role map',
                ok: map !== null,
                detail: map
                    ? `${roleMapPath(home)} (version ${ROLE_MAP_VERSION})`
                    : `${roleMapPath(home)} is invalid: every agent acts as no role`,
                hard: true,
            });
            for (const [role, slug] of Object.entries((map ?? DEFAULT_ROLE_MAP).apps)) {
                const config = readAppConfig(slug, { home });
                if (!config) {
                    checks.push({ check: `app ${slug}`, ok: false, detail: 'not configured; the operator creates it (runbook)', hard: false });
                    continue;
                }
                const keyMode = fileMode(config.keyPath);
                checks.push({
                    check: `app ${slug}`,
                    ok: true,
                    detail: `app ${config.appId}, key ${config.keyPath} mode ${keyMode === null ? 'missing' : keyMode.toString(8)}`,
                    hard: keyMode !== null ? (keyMode & 0o077) !== 0 : false,
                });
                checks.push({
                    check: `installation ${slug}`,
                    ok: Object.keys(config.installations).length > 0,
                    detail: Object.keys(config.installations).length
                        ? appInstallationSummary(config)
                        : 'no recorded installation for any account',
                    hard: false,
                });
                void role;
            }
            const shim = ghShimStatus({ home });
            checks.push({
                check: 'gh shim',
                ok: shim.installed && shim.current && shim.pathOrderOk,
                detail: !shim.installed
                    ? `${shim.path} is not the xtrm shim (run xt identity setup)`
                    : !shim.current
                        ? `${shim.path} is stale or embeds a different real gh (run xt identity setup)`
                        : !shim.pathOrderOk
                            ? `${path.dirname(shim.path)} must come before the real gh on PATH`
                            : `${shim.path} -> ${shim.realGh}`,
                hard: true,
            });
            if (opts.json) {
                console.log(JSON.stringify({ checks }, null, 2));
            } else {
                for (const check of checks) {
                    const mark = check.ok ? kleur.green('ok') : check.hard ? kleur.red('FAIL') : kleur.yellow('warn');
                    console.log(`${mark} ${check.check}: ${check.detail}`);
                }
            }
            process.exit(checks.some((check) => check.hard && !check.ok) ? 1 : 0);
        });

    return identity;
}

async function fetchPullBody(repo: string, pr: number, token: string): Promise<{ issueRef?: string }> {
    const { githubRequest } = await import('../core/github-apps.js');
    const pull = await githubRequest<{ body?: string | null; head?: { ref?: string } }>(
        { method: 'GET', path: `/repos/${repo}/pulls/${pr}` },
        { token, apiBase: DEFAULT_API_BASE },
    );
    const marker = parseIssueMarker(pull.data.body ?? '');
    if (marker?.issue) return { issueRef: marker.issue };
    const { issueRefFromBranch } = await import('../core/review-posting.js');
    return { issueRef: issueRefFromBranch(pull.data.head?.ref) ?? undefined };
}
