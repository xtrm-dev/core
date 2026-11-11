/**
 * CORE-2626: the route table the `gh` shim consults for a restricted role.
 *
 * The shim used to gate PR-mutating verbs one by one (a denylist). That let the
 * same class of action through whenever it was spelled as a different route:
 * `gh issue close <PR#>` closes a pull request (gh resolves the number with
 * `issueOrPullRequest` and calls `PullRequestClose`), `gh pr lock|unlock|
 * update-branch` were ungated, an unknown `XTRM_ROLE` resolved to unrestricted,
 * and `gh pr new` skipped the create path (security read rev-890, review
 * 5865051160 on core#921).
 *
 * This module is the single classification. The shim inlines the two tables
 * (`ghShimSource`), so the running shim and this module cannot drift, and
 * `gh-shim-routes.test.ts` fails when gh gains a verb or a command group that no
 * class covers.
 *
 * Classes:
 *   read   - a restricted role may run it; it changes nothing on GitHub
 *   create - allowed for any agent role, through the create path (run= refusal
 *            and the Issue link), exactly like `gh pr create`
 *   write  - refused for a restricted role, before any route can exit
 *
 * Verified against `gh` 2.97.0 `--help` for every group below.
 */

/** What a route may do for a restricted (reviewer) role. */
export type RouteClass = 'read' | 'create' | 'write';

/**
 * `gh pr <verb>`. `revert` is a `write`, not a `create`: it opens a pull request
 * outside the marker/link path, so only an unrestricted role may use it.
 */
export const PR_ROUTES: Record<string, RouteClass> = {
    view: 'read',
    list: 'read',
    diff: 'read',
    checks: 'read',
    status: 'read',
    checkout: 'read',
    comment: 'read',
    review: 'read',
    create: 'create',
    new: 'create',
    merge: 'write',
    edit: 'write',
    close: 'write',
    reopen: 'write',
    ready: 'write',
    lock: 'write',
    unlock: 'write',
    'update-branch': 'write',
    revert: 'write',
};

/**
 * `gh issue <verb>`. `close`, `reopen` and `edit` are `write` even when the
 * number is a pull request: gh then calls the pull-request API (review 5865051160
 * finding 1), which is the bypass this table exists to close. There is no
 * `create` class here: the create path (run= refusal and the Issue link) is a
 * pull-request path, so creating an Issue stays a write for a restricted role.
 */
export const ISSUE_ROUTES: Record<string, RouteClass> = {
    view: 'read',
    list: 'read',
    comment: 'read',
    status: 'read',
    create: 'write',
    new: 'write',
    close: 'write',
    reopen: 'write',
    edit: 'write',
    delete: 'write',
    develop: 'write',
    lock: 'write',
    unlock: 'write',
    transfer: 'write',
};

/** Groups where the listed subcommands are read and everything else is a write. */
export const GROUP_ROUTES: Record<string, Record<string, RouteClass>> = {
    pr: PR_ROUTES,
    issue: ISSUE_ROUTES,
    repo: { view: 'read' },
    auth: { status: 'read' },
    run: { view: 'read', list: 'read' },
};

/** Groups that are read-only in their entirety. */
export const READ_GROUPS: string[] = ['search', 'status'];

/**
 * Groups refused wholesale for a restricted role. They are listed rather than
 * left to the unclassified default so the table is a total classification of
 * gh's surface: `gh-shim-routes.test.ts` fails when gh adds a group that is in
 * none of these lists, and a reviewer then gets a deliberate decision instead of
 * inheriting one. Several of these do write locally or remotely (`config`,
 * `extension`, `secret`, `variable`, `workflow`, `release`, `label`), and a
 * reviewer has no reason to run any of them.
 */
export const WRITE_GROUPS: string[] = [
    'browse', 'cache', 'codespace', 'config', 'extension', 'gist', 'gpg-key', 'label', 'org',
    'project', 'release', 'ruleset', 'secret', 'ssh-key', 'variable', 'workflow',
];

/**
 * `gh api` is read-class here on purpose: the shim then applies
 * `reviewerApiVerdict`, a GET-only allowlist that refuses graphql, /issues and
 * /merge (CORE-2528 batch 4). Without a role it passes straight through.
 */
export const API_GROUP = 'api';
