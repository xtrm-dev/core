import { Command } from 'commander';
import kleur from 'kleur';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runReceipt } from '../core/sb-receipt.js';

import { SUBSTRATE_HOLDER_VAR, XTRM_AGENT_NAME_VAR } from '../core/dispatcher-identity.js';
import { buildGitIdentityEnv, resolveGitEmail } from '../core/git-identity.js';
import {
    DEFAULT_API_BASE,
    appInstallationSummary,
    fileMode,
    githubAppPaths,
    githubRequest,
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
    explainAgentRole,
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
import { resolveLaunchIdentity, roleMapConfigured } from '../core/launch-identity.js';
import {
    eventForFlags,
    eventForOutcome,
    parseIssueMarker,
    postReview,
    reviewReceiptArgs,
    sha12,
    ReviewRefused,
    type ReviewVerdict,
} from '../core/review-posting.js';
import { applyOverride, mergeCheck, mergeGuardEnabled, recordMerge, MERGE_GUARD_ENV_VAR, OVERRIDE_ENV_VAR, type MergeDecision } from '../core/merge-guard.js';
import { isSafeIssueRef } from '../core/review-posting.js';
import { installRoutingReminder } from '../core/reviewer-routing.js';
import { parseInvocation } from '../core/gh-argv.js';

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
            // CORE-2606: the visible review attribution reads it, so `eval "$(xt
            // identity env)"` in a launched session must not drop it. Absent stays
            // absent: a session without one falls back to the holder at review time.
            ...((env[XTRM_AGENT_NAME_VAR] ?? '').trim() ? { [XTRM_AGENT_NAME_VAR]: (env[XTRM_AGENT_NAME_VAR] ?? '').trim() } : {}),
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

/**
 * The refusal the guard would produce when GitHub or the App cannot be read.
 * Built here so the override path still runs: an unreachable App is exactly the
 * case the override exists for (CORE-2528 rev 4 R3).
 */
async function unreachableRefusal(repo: string, pr: number, detail: string): Promise<MergeDecision> {
    if (!repoOwner(repo)) fail(`'${repo}' is not an owner/name repository slug`);
    // No token, no GitHub read: calling mergeCheck here would hang on the network
    // exactly when the App is unavailable, which is the case the override exists
    // for (CORE-2528 delta M6).
    return {
        allow: false,
        reason: `cannot mint the reviewer token: ${detail}; the guard fails closed`,
        repo,
        pr,
        unreachable: true,
        message: `merge refused for ${repo}#${pr}: cannot mint the reviewer token (${detail}). Set ${OVERRIDE_ENV_VAR} to override as coordinator/operator, or turn the guard off with ${MERGE_GUARD_ENV_VAR}.`,
    };
}

async function reviewerTokenFor(repo: string, map: RoleMap): Promise<{ token: string; slug: string; account: string }> {
    const account = repoOwner(repo);
    if (!account) fail(`'${repo}' is not an owner/name repository slug`);
    const slug = appSlugForRole('reviewer', map);
    const minted = await mintInstallationToken({ slug, account }, appDeps());
    return { token: minted.token, slug, account };
}

interface GhTarget {
    verb: string | null;
    repo: string;
    pr: number;
    head: string;
    forwarded: string[];
    assignments: Record<string, string>;
    error?: string;
}

function realGh(): string {
    return (process.env.XTRM_REAL_GH ?? '').trim() || 'gh';
}

function ghView(args: string[], cwd: string): { ok: boolean; data?: Record<string, unknown> } {
    const result = spawnSync(realGh(), args, {
        encoding: 'utf8',
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        env: process.env,
    });
    if (result.error || result.status !== 0) return { ok: false };
    try {
        const data = JSON.parse(result.stdout) as Record<string, unknown>;
        return { ok: true, data };
    } catch {
        return { ok: false };
    }
}

function prFromView(data: Record<string, unknown> | undefined): { repo: string; pr: number; head: string } | null {
    if (!data) return null;
    const url = typeof data.url === 'string' ? data.url : '';
    const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url);
    if (match) return { repo: match[1], pr: Number(match[2]), head: typeof data.headRefOid === 'string' ? data.headRefOid : '' };
    const pr = Number(data.number);
    return Number.isInteger(pr) && pr > 0 ? { repo: '', pr, head: typeof data.headRefOid === 'string' ? data.headRefOid : '' } : null;
}

/**
 * Resolve a gh argv to the PR it acts on (CORE-2530 review). The target rules are
 * the ones the merged shim uses: an explicit number, branch or URL wins; only a
 * command with no target falls back to the cwd PR; flag values are never targets.
 */
export function resolveGhTarget(argvText: string, cwd: string): GhTarget {
    let argv: string[];
    try {
        const parsed = JSON.parse(argvText);
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            return { verb: null, repo: '', pr: 0, head: '', forwarded: [], assignments: {}, error: 'the argv must be a JSON array of strings' };
        }
        argv = parsed as string[];
    } catch (error) {
        return { verb: null, repo: '', pr: 0, head: '', forwarded: [], assignments: {}, error: `cannot parse --argv: ${(error as Error).message}` };
    }
    const inv = parseInvocation(argv, { fallbackVerb: 'merge' });
    const base = { verb: inv.verb, forwarded: inv.forwarded, assignments: inv.assignments };
    let repo = inv.repo;
    if (!repo && inv.pr) {
        // A bare number: the repository is the one at cwd, exactly as gh needs.
        const view = ghView(['repo', 'view', '--json', 'nameWithOwner'], cwd);
        if (view.ok && typeof view.data?.nameWithOwner === 'string') repo = view.data.nameWithOwner;
    }
    if (inv.pr) {
        let head = '';
        if (repo) {
            const view = ghView(['pr', 'view', String(inv.pr), '--repo', repo, '--json', 'headRefOid'], cwd);
            if (view.ok && typeof view.data?.headRefOid === 'string') head = view.data.headRefOid;
        }
        return { ...base, repo, pr: inv.pr, head };
    }
    if (inv.target && /[$`]/.test(inv.target)) {
        return { ...base, repo: inv.repo, pr: 0, head: '', error: `cannot resolve '${inv.target}' statically (an unexpanded variable or command substitution); pass an explicit PR number` };
    }
    if (inv.target) {
        // A branch: look the PR up in the named repository, never in the cwd.
        if (!inv.repo) return { ...base, repo: '', pr: 0, head: '', error: `cannot resolve branch '${inv.target}' without --repo` };
        const view = ghView(['pr', 'view', inv.target, '--repo', inv.repo, '--json', 'number,headRefOid'], cwd);
        if (!view.ok) return { ...base, repo: inv.repo, pr: 0, head: '', error: `cannot resolve '${inv.target}' to a pull request in ${inv.repo}` };
        const number = Number(view.data?.number);
        const head = typeof view.data?.headRefOid === 'string' ? view.data.headRefOid : '';
        return { ...base, repo: inv.repo, pr: Number.isInteger(number) ? number : 0, head };
    }
    const here = prFromView(ghView(['pr', 'view', '--json', 'number,url,headRefOid'], cwd).data);
    if (!here) return { ...base, repo: inv.repo, pr: 0, head: '', error: 'no pull request matches this command and the current directory has none' };
    return { ...base, repo: inv.repo || here.repo, pr: here.pr, head: here.head };
}

export { resolveSbBinary, sbJsonError } from '../core/sb-receipt.js';

/** Run one `sb` receipt; never throws, and names the binary and its reason. */
export function runSb(args: string[]): { ok: boolean; error?: string } {
    return runReceipt(args);
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
        .command('role')
        .description('Print the role this process resolves to, and why (used by the gh shim)')
        .option('--json', 'Emit JSON', false)
        .action((opts: { json: boolean }) => {
            const map = loadRoleMap();
            if (!map) fail('the role map is invalid; every role is unresolved');
            const { role, source } = explainAgentRole(process.env, map);
            const holder = (process.env[SUBSTRATE_HOLDER_VAR] ?? '').trim() || null;
            if (opts.json) {
                console.log(JSON.stringify({ role, source, holder }, null, 2));
            } else {
                console.log(`${role ?? '(no credential)'} (${source})`);
            }
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
            const env = process.env;
            const inAgentTree = Boolean((env[SUBSTRATE_HOLDER_VAR] ?? '').trim() || (env[ROLE_ENV_VAR] ?? '').trim());
            const own = processAgentRole(env, map);
            const requested = (opts.role ?? '').trim();
            let role: AgentRole | null;
            if (requested) {
                const resolved = resolveAgentRole(requested, map);
                if (!resolved) {
                    fail(`--role ${requested} is neither an agent role nor a mapped specialist; refusing to mint any token`);
                }
                // --role is an operator-shell convenience only: inside an agent
                // tree it cannot escalate beyond the process's own role.
                if (inAgentTree && resolved !== own) {
                    fail(`this ${own ?? 'unresolved'} session may not mint a ${resolved} token; --role only widens an operator shell`);
                }
                role = resolved;
            } else {
                role = own;
            }
            if (!role) fail('no role for this process (operator session, or a role the map does not name)');
            if (role === 'reviewer') {
                fail('the reviewer token is minted only by the review-post path (gh pr review -> xt identity review-post), never by hand');
            }
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
            const resolved = effectiveRole();
            const role = resolved.map ? processAgentRole(process.env, resolved.map) : null;
            if (!role) {
                // One line, on stderr: git reads stdout for the answer and a silent
                // helper looks like a broken environment.
                process.stderr.write('xt identity credential: this session has no role, so no App credential is offered\n');
                return;
            }
            if (role === 'reviewer') {
                // The reviewer reviews; it never pushes. Answering would hand the
                // reviewer App's token to a git operation it must not perform.
                process.stderr.write('xt identity credential: the reviewer role does not push; no credential is offered\n');
                return;
            }
            let text = '';
            try {
                text = readFileSync(0, 'utf8');
            } catch {
                return;
            }
            const request = parseCredentialRequest(text);
            const app = credentialAppFor(request, role, resolved.map ?? DEFAULT_ROLE_MAP);
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
        .description('Post one formal review: head, model and verdict come from the body (called by the gh shim)')
        .requiredOption('--repo <owner/name>', 'Repository (the shim passes it; cwd is only a fallback)')
        .requiredOption('--pr <number>', 'Pull request number')
        .option('-b, --body <text>', 'The review body: line 1 header, findings, one verdict line')
        .option('--body-file <file>', 'Read the review body from a file')
        .option('--head <sha>', 'Cross-check only: must agree with line 1 (default: $XTRM_REVIEW_HEAD)')
        .option('--verdict <outcome>', 'Cross-check only: must agree with the body\'s verdict line')
        .option('--approve', 'Cross-check: must agree with a PASS body', false)
        .option('--request-changes', 'Cross-check: must agree with a FAIL body', false)
        .option('--comment', 'Cross-check: must agree with a PARTIAL body', false)
        .option('--model <model>', 'Cross-check only: must agree with line 1 (default: $XTRM_REVIEW_MODEL)')
        .option('--json', 'Emit JSON', false)
        .action(async (opts: {
            repo: string; pr: string; body?: string; bodyFile?: string; head?: string;
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
            let body = opts.body ?? '';
            if (opts.bodyFile) {
                try {
                    body = readFileSync(opts.bodyFile, 'utf8');
                } catch (error) {
                    fail(`cannot read --body-file: ${(error as Error).message}`);
                }
            }
            if (!body.trim()) {
                fail('an empty review body is refused: line 1 must be "Review by <role> (<model>) at head <sha12>" and the body needs exactly one "- Verdict:" line');
            }
            const flagVerdict: ReviewVerdict | null = opts.verdict
                ? eventForOutcome(opts.verdict)
                : eventForFlags({ approve: opts.approve, requestChanges: opts.requestChanges, comment: opts.comment });
            if (opts.verdict && !flagVerdict) fail(`--verdict ${opts.verdict} is not PASS, PARTIAL or FAIL`);
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
                    body,
                    holder,
                    role: 'reviewer',
                    runId: resolveAgentRunId(),
                    activationId: (process.env.SUBSTRATE_ACTIVATION_ID ?? '').trim() || null,
                    expectedHead: (opts.head ?? process.env.XTRM_REVIEW_HEAD ?? '').trim() || null,
                    expectedVerdict: flagVerdict,
                    expectedModel: (opts.model ?? process.env.XTRM_REVIEW_MODEL ?? '').trim() || null,
                }, { token, slug: appSlugForRole('reviewer', map), apiBase: DEFAULT_API_BASE });
                let journaled: { ok: boolean; error?: string } | null = null;
                if (posted.issueRef) journaled = runSb(reviewReceiptArgs(posted, { repo: opts.repo, pr, body, holder, runId: resolveAgentRunId() }, posted.issueRef, appSlugForRole('reviewer', map)));
                const out = {
                    url: posted.url,
                    id: posted.id,
                    commit_id: posted.head,
                    state: posted.state,
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
                    console.log(`review posted: ${posted.url}`);
                    console.log(`id ${posted.id}  state ${posted.state}  commit_id ${posted.head}`);
                    console.log(`verdict ${posted.verdict} at head ${sha12(posted.head)}${posted.issueRef ? `, Issue ${posted.issueRef}` : ''}`);
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
        .command('resolve-gh')
        .description('Resolve a gh argv to the repository, PR and head it acts on (used by the gh shim and the gate hook)')
        .requiredOption('--argv <json>', 'The gh argv as a JSON array, e.g. ["pr","merge","5"]')
        .option('--cwd <dir>', 'Directory for the cwd-PR fallback', process.cwd())
        .option('--json', 'Emit JSON (always, kept for symmetry)', false)
        .action((opts: { argv: string; cwd: string }) => {
            const resolved = resolveGhTarget(opts.argv, opts.cwd);
            console.log(JSON.stringify(resolved));
            if (resolved.error || !resolved.pr || !resolved.repo) process.exit(1);
        });

    identity
        .command('merge-check')
        .description('Allow or refuse a merge: the reviewer App\'s latest review must be at the current head')
        .option('--repo <owner/name>', 'Repository (with --pr)')
        .option('--pr <number>', 'Pull request number (with --repo)')
        .option('--gh-args <json>', 'A gh argv as a JSON array; the target is resolved the way gh resolves it')
        .option('--cwd <dir>', 'Directory for the cwd-PR fallback', process.cwd())
        .option('--json', 'Emit JSON', false)
        .action(async (opts: { repo?: string; pr?: string; ghArgs?: string; cwd: string; json: boolean }) => {
            let repo = (opts.repo ?? '').trim();
            let pr = Number(opts.pr ?? 0);
            if (opts.ghArgs) {
                const resolved = resolveGhTarget(opts.ghArgs, opts.cwd);
                if (resolved.error) fail(resolved.error);
                repo = resolved.repo;
                pr = resolved.pr;
            }
            if (!repo || !Number.isInteger(pr) || pr <= 0) {
                fail('pass --repo and --pr, or --gh-args \'["pr","merge","5"]\'');
            }
            const { map } = effectiveRole();
            if (!map) fail('the role map is invalid; the guard fails closed');
            // One source of truth: mergeCheck owns the flag. The CLI only decides
            // whether a token is needed, so removing the guard's early return turns
            // the guard-off test red (CORE-2528 batch 5, item 5).
            const guardOn = mergeGuardEnabled();
            let token = '';
            let unreachable: string | null = null;
            if (guardOn) {
                try {
                    token = (await reviewerTokenFor(repo, map)).token;
                } catch (error) {
                    unreachable = error instanceof GitHubAppError ? error.message : (error as Error).message;
                }
            }
            const deps = {
                token,
                apiBase: DEFAULT_API_BASE,
                reviewerSlug: appSlugForRole('reviewer', map),
                roleMap: map,
                // Passed explicitly: the guard reads its flags and the Issue-existence
                // check from this environment, and runs `sb` from the caller's cwd.
                env: process.env,
                cwd: opts.cwd,
            };
            // The override must be reachable exactly when the token cannot be
            // minted, so applyOverride runs on the unreachable refusal too.
            let decision = unreachable
                ? await unreachableRefusal(repo, pr, unreachable)
                : await mergeCheck({ repo, pr }, deps);
            if (!decision.allow && (process.env[OVERRIDE_ENV_VAR] ?? '').trim()) {
                // The override log and the receipt need the head even when the App was
                // unreachable and the decision carries none.
                if (!decision.head) {
                    const argv = opts.ghArgs ?? JSON.stringify(['pr', 'merge', '--repo', repo, String(pr)]);
                    const resolved = await resolveGhTarget(argv, opts.cwd ?? process.cwd());
                    if (resolved.head) decision = { ...decision, head: resolved.head };
                }
                // The head refusal lives in applyOverride, AFTER the role gate: a
                // worker must still be told it may not override, whatever the head.
                decision = await applyOverride(decision, deps);
            }
            if (opts.json) {
                console.log(JSON.stringify(decision, null, 2));
            } else if (decision.allow) {
                console.log(decision.message);
                if (decision.override) {
                    if (!decision.override.journaled) {
                        console.log(kleur.yellow(`warning: the override was not journaled${decision.override.error ? `: ${decision.override.error}` : ''}`));
                    }
                }
            } else {
                process.stderr.write(`${decision.message}\n`);
                // A refused override must say so on the agent's stderr, not only in
                // the reason field the agent never sees (CORE-2528 delta L11).
                if ((process.env[OVERRIDE_ENV_VAR] ?? '').trim() && /override refused/.test(decision.reason)) {
                    process.stderr.write(`${decision.reason}\n`);
                }
            }
            process.exit(decision.allow ? 0 : 1);
        });

    identity
        .command('merge-record')
        .description('Append the github-merge Journal ref after a merge (called by the gh shim)')
        .requiredOption('--repo <owner/name>', 'Repository')
        .requiredOption('--pr <number>', 'Pull request number')
        .requiredOption('--head <sha>', 'Merged head')
        .option('--issue <ref>', 'Issue ref (default: the PR body marker)')
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
            if (!isSafeIssueRef(issueRef)) fail(`'${issueRef}' is not a Substrate ref; refusing to journal the merge`);
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
            if (!roleMapConfigured(home)) {
                // No role map: identities are not configured on this host, so a launch
                // keeps the operator identity. One line, not a warning per App.
                checks.push({
                    check: 'identities',
                    ok: true,
                    detail: `identities not configured (no role map at ${roleMapPath(home)}); launches keep the operator identity`,
                    hard: false,
                });
            }
            // With no role map the next check would contradict the identities line.
            if (roleMapConfigured(home)) {
                checks.push({
                    check: 'role map',
                    ok: map !== null,
                    detail: map
                        ? `${roleMapPath(home)} (version ${ROLE_MAP_VERSION})`
                        : `${roleMapPath(home)} is invalid; launches keep the operator identity and print a warning`,
                    // A broken role map is a hard failure, as on base: every launch silently
                    // falls back to the operator identity otherwise.
                    hard: !map,
                });
            }
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
    const pull = await githubRequest<{ body?: string | null }>(
        { method: 'GET', path: `/repos/${repo}/pulls/${pr}` },
        { token, apiBase: DEFAULT_API_BASE },
    );
    // The marker is the only Issue source; a branch ref such as `fix/UTF-8-parser`
    // used to become a fake Issue here (CORE-2590).
    const marker = parseIssueMarker(pull.data.body ?? '');
    return { issueRef: marker?.issue };
}
