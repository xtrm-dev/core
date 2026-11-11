# Troubleshooting: the failures seen in practice

Each entry is a real message, what produced it, and the fix. Read the message
before the fix: most of these are correct refusals, not bugs.

## "app <slug>: not configured; the operator creates it (runbook)"

`readAppConfig` returned null. In order of likelihood:

1. `app.json` is missing or not valid JSON.
2. `slug` in the file does not match the directory name.
3. `appId` is missing or empty. A number is fine; a JSON `null` is not.
4. `keyPath` is absent, or the `.pem` it names does not exist.
5. The key or its directory is readable by group/other (must be 600 and 700).

`xt identity doctor --json` prints the failing check with the resolved path.

## "token mint refused (HTTP 404)"

The installation id in `app.json` does not exist any more, or the App is not
installed on that account. Read the live truth instead of trusting the file:

```bash
# with an App JWT, never printed:
curl -s -H "Authorization: Bearer $APP_JWT" https://api.github.com/app/installations
```

Compare `id` per `account.login`. Observed live: `xtrm-dev` was listed with a
dead id 162478053 while the real installation was 180705821.

## "role reviewer: the xtrm-reviewer App is not installed for <owner>; refusing to launch a reviewer with the operator identity"

The App is configured but its installation does not cover that repository's
owner. Install it there (`https://github.com/apps/xtrm-reviewer/installations/new`).
The refusal is deliberate: a reviewer that silently acts as the operator is worse
than no review.

## "refusing own-PR review: PR #N was opened by holder <h>"

The PR's line-2 marker names the same holder as the reviewing session. Either the
agent is reviewing its own PR (correct refusal), or the marker was copied from a
template. Fix the marker (`holder=operator` for an operator-opened PR).

## "the flag requests APPROVE, the body's verdict line says COMMENT"

The verdict comes from the body, and the flag must agree. Write the body's single
`- Verdict: PASS|PARTIAL|FAIL` line at column 0, then pass the matching flag.

## "the latest review … is at <sha>, not at the current head <sha>"

Correct refusal: a push landed after the review. Get a review at the new head.
If it happened immediately after a push, GitHub's REST may still report the old
head for a moment; re-run the check a second later before believing it.

## "the PR carries no resolvable Substrate Issue …"

The body marker is missing or malformed. Add
`<!-- xtrm issue=<REF> holder=<holder> run=<id> -->` to the PR body. Branch names
are not an Issue source.

## "Journal receipt failed: sb exited 1"

Two causes seen: the `--result` payload used a field Substrate does not accept
(only `summary|attempted|outcome|completed|validation|findings|artifactRefs|receiptRefs|provenanceRefs`),
or `sb` was an older binary on a trimmed `PATH`. The review and the merge still
happened; only the receipt was lost, so re-record it with
`xt identity merge-record` or re-post the review.

## A review posted as the operator instead of `<slug>[bot]`

The shim was not used: `which gh` must resolve to `~/.local/bin/gh`. A launched
session gets the shim directory first on its pane `PATH` from the launcher
(CORE-2524.4), so this can only happen in a plain shell, an older launcher, or a
session created outside `xt`. `xt identity doctor`'s `PATH`-order row evaluates
the launcher's `PATH`, not the pane's. Observed live before the fix: a review on
#888 posted as the operator and GitHub downgraded `--approve` to `COMMENTED`.

## The guard allows a merge that should be refused

Check `XTRM_MERGE_GUARD`: it is off unless set. Launched sessions get `on` by
default; a plain shell does not. `xt identity doctor` does not report the flag.

## `xt identity setup` changed my real home

`xt identity setup` writes `~/.local/bin/gh`, the role map and the routing
reminder. When testing it, run it with `HOME=<temp dir>`. If it ran against the
real home by accident, remove those three paths and re-run it deliberately.

## Reviews are invisible on GitHub

Look for a review, not a comment: `gh api repos/<o>/<r>/pulls/<n>/reviews`. A
`gh pr comment` is a conversation comment and carries no state, so the guard will
not see it.
