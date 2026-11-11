// CORE-2626: the parity guard for the gh shim's restricted-role route table.
//
// The shim refuses a restricted (reviewer) role every route it has not
// classified as read or create. That default is safe, but it is silent: a verb
// gh adds later, or a route this table forgets, would be refused for a reviewer
// with no test naming the decision. These assertions make the classification
// explicit and fail when gh's command surface outgrows it, so a new verb must be
// classified on purpose rather than inherited by accident.
//
// The verb and group lists below come from `gh` 2.97.0 `--help`. They are
// deliberately hardcoded: the point is that a human revisits them when gh
// changes, not that they track gh automatically.

import { describe, expect, it } from 'vitest';
import { ghShimSource } from '../core/gh-shim.js';
import {
    API_GROUP,
    GROUP_ROUTES,
    ISSUE_ROUTES,
    PR_ROUTES,
    READ_GROUPS,
    WRITE_GROUPS,
    type RouteClass,
} from '../core/gh-shim-routes.js';

/** `gh pr --help` on 2.97.0. */
const GH_PR_VERBS = [
    'checkout', 'checks', 'close', 'comment', 'create', 'diff', 'edit', 'list', 'lock', 'merge',
    'new', 'ready', 'reopen', 'revert', 'review', 'status', 'unlock', 'update-branch', 'view',
];

/** `gh issue --help` on 2.97.0. */
const GH_ISSUE_VERBS = [
    'close', 'comment', 'create', 'delete', 'develop', 'edit', 'list', 'lock', 'new', 'reopen',
    'status', 'transfer', 'unlock', 'view',
];

/** `gh --help` on 2.97.0, minus the shim's own handled groups. */
const GH_GROUPS = [
    'api', 'auth', 'browse', 'cache', 'codespace', 'config', 'extension', 'gist', 'gpg-key', 'issue',
    'label', 'org', 'pr', 'project', 'release', 'repo', 'ruleset', 'run', 'search', 'secret',
    'ssh-key', 'status', 'variable', 'workflow',
];

const CLASSES: RouteClass[] = ['read', 'create', 'write'];

describe('gh shim route table (CORE-2626)', () => {
    it('classifies every gh pr verb, and every class is one the shim understands', () => {
        const missing = GH_PR_VERBS.filter((verb) => !(verb in PR_ROUTES));
        expect(missing, `gh pr verbs with no class in PR_ROUTES: ${missing.join(', ')}`).toEqual([]);
        for (const [verb, cls] of Object.entries(PR_ROUTES)) {
            expect(CLASSES, `gh pr ${verb} has class ${cls}`).toContain(cls);
        }
    });

    it('classifies every gh issue verb', () => {
        const missing = GH_ISSUE_VERBS.filter((verb) => !(verb in ISSUE_ROUTES));
        expect(missing, `gh issue verbs with no class in ISSUE_ROUTES: ${missing.join(', ')}`).toEqual([]);
    });

    it('classifies every gh command group, so a new group must be classified too', () => {
        const unclassified = GH_GROUPS.filter(
            (group) => group !== API_GROUP
                && !(group in GROUP_ROUTES)
                && !READ_GROUPS.includes(group)
                && !WRITE_GROUPS.includes(group),
        );
        expect(
            unclassified,
            'gh groups with no table entry (unlisted groups are refused for a restricted role; list the read ones): '
            + unclassified.join(', '),
        ).toEqual([]);
    });

    it('keeps the reviewer allowlist exactly as reviewed', () => {
        // CORE-2626 review (rev-890) named this set. Widening it is a security
        // decision, so it must be a visible diff here, not a quiet table edit.
        const prReads = Object.entries(PR_ROUTES).filter(([, cls]) => cls === 'read').map(([verb]) => verb);
        const issueReads = Object.entries(ISSUE_ROUTES).filter(([, cls]) => cls === 'read').map(([verb]) => verb);
        expect(prReads.sort()).toEqual(['checkout', 'checks', 'comment', 'diff', 'list', 'review', 'status', 'view']);
        expect(issueReads.sort()).toEqual(['comment', 'list', 'status', 'view']);
        expect([...READ_GROUPS].sort()).toEqual(['search', 'status']);
        expect(Object.entries(GROUP_ROUTES.repo ?? {})).toEqual([['view', 'read']]);
        expect(Object.entries(GROUP_ROUTES.auth ?? {})).toEqual([['status', 'read']]);
        expect(Object.entries(GROUP_ROUTES.run ?? {}).sort()).toEqual([['list', 'read'], ['view', 'read']]);
    });

    it('refuses the PR-state routes, whichever group spells them', () => {
        // The bypasses the security read found: gh resolves a PR number through
        // gh issue too, so close|reopen|edit must be writes in BOTH groups.
        for (const verb of ['close', 'reopen', 'edit']) {
            expect(PR_ROUTES[verb], `gh pr ${verb}`).toBe('write');
            expect(ISSUE_ROUTES[verb], `gh issue ${verb} (also reaches a PR)`).toBe('write');
        }
        for (const verb of ['lock', 'unlock', 'update-branch', 'merge', 'ready']) {
            expect(PR_ROUTES[verb], `gh pr ${verb}`).toBe('write');
        }
    });

    it('treats each pull-request create spelling as the create path', () => {
        expect(PR_ROUTES.create).toBe('create');
        expect(PR_ROUTES.new, 'gh pr new is gh aliasing create').toBe('create');
        // revert opens a pull request outside the marker/link path: a write.
        expect(PR_ROUTES.revert).toBe('write');
        // The create path is a pull-request path; an Issue is not one.
        expect(ISSUE_ROUTES.create).toBe('write');
        expect(ISSUE_ROUTES.new).toBe('write');
    });

    it('inlines the same tables into the installed shim, so the two cannot drift', () => {
        const source = ghShimSource('/usr/bin/gh');
        expect(source).toContain(`const GROUP_ROUTES = ${JSON.stringify(GROUP_ROUTES)};`);
        expect(source).toContain(`const READ_GROUPS = ${JSON.stringify(READ_GROUPS)};`);
        expect(source).toContain(`const WRITE_GROUPS = ${JSON.stringify(WRITE_GROUPS)};`);
        expect(source).toContain(`const API_GROUP = ${JSON.stringify(API_GROUP)};`);
    });
});
