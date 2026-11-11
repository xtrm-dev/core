# Troubleshooting: the failures seen in practice

Each entry is a real message, what produced it, and the fix. Read the message
before the fix: most of these are correct refusals, not bugs.

## "identities not configured (no role map at …)"

`~/.xtrm/config/identity-role-map.json` is absent: the launcher falls back to the
built-in default map but exports no credential, so no App is consulted at all. This is the most likely reason a session has no
identity while `app.json` and its installation are correct. `xt identity setup`
writes the map (it keeps an existing one); `xt identity doctor` then reports the
`role map` row with its path and version.

## "app <slug>: not configured; the operator creates it (runbook)"

`readAppConfig` returned null, for exactly three reasons:

1. `app.json` is missing, is not valid JSON, or is not a JSON object.
2. the `slug` inside the file does not match the directory name.
3. `appId` is missing, empty, or not a string. A JSON `null` is not enough, and
   neither is a bare number on main.

The key is not part of this message. An absent `keyPath` falls back to
`~/.secrets/github-apps/<slug>.pem`; a `.pem` that does not exist, or one with
mode 644, still gives `ok app …`. The doctor's `app <slug>` row names the key
path and its mode, and the mint is where a bad mode is refused: "the App private
key … is mode 644; it must be 600".

`xt identity doctor --json` prints the failing check with the resolved path.

<!-- pending: #888 — a numeric appId becomes acceptable; amend cause 3 when #888 merges. -->

## "token mint refused (HTTP 404)"

The installation id in `app.json` does not exist any more, or the App is not
installed on that account. Read the live truth instead of trusting the file:

```bash
# with an App JWT, never printed:
curl -s -H "Authorization: Bearer $APP_JWT" https://api.github.com/app/installations
```

Compare `id` per `account.login`. Observed live once: an account still listed a
dead installation id while the App's current installation had a different one.

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

## "the PR names no resolvable Substrate Issue …" (merge guard) and "the PR carries no xtrm marker …" (review-post)

Two refusals, two rules:

- **Merge guard** (`gh pr merge` through the shim): the marker is preferred, and
  while no marker exists the guard reads an uppercase ref out of the branch
  name, so `xt/worker-CORE-2528-x` resolves while `xt/some-branch` and a
  lowercase ref do not. The refusal text is "the PR names no resolvable
  Substrate Issue, so the guard refuses even an approval at the current head".
  Fix: add `<!-- xtrm issue=<REF> holder=<holder> run=<id> -->` to the PR body.
- **`review-post`** is stricter: no marker at all is refused with "PR #N carries
  no xtrm marker in its body (<!-- xtrm issue=<REF> holder=<holder> run=<id> -->);
  refusing to post an unattributable review", and a marker without `holder=` is
  refused too. An Issue missing from the marker only costs the Journal entry: "no
  Substrate Issue ref in the PR body or branch; the review is not journaled".

<!-- pending: #890 — after it merges the marker is the only Issue source in merge-check, merge-record and review-post (branch derivation removed), the merge-guard text becomes "the PR names no Substrate Issue in a marker …", and a missing Issue is denied with "the marker names <REF>, and Substrate has no such Issue". Drop the branch sentence and requote, then remove this comment. -->

## "Journal receipt failed: sb exited 1"

Two causes seen: the `--result` payload used a field Substrate does not accept
(only `summary|attempted|outcome|completed|validation|findings|artifactRefs|receiptRefs|provenanceRefs`),
or `sb` was an older binary on a trimmed `PATH`. The review and the merge still
happened; only the receipt was lost, so re-record it with
`xt identity merge-record` or re-post the review.

<!-- pending: #888 — on main the merge receipt still sends `head` and `pr` in `--result`, so the first cause reproduces and re-recording fails the same way; #888 moves the SHA into the summary and the PR into `artifactRefs`. Recheck this entry when it merges. -->

## A review posted as the operator instead of `<slug>[bot]`

The shim was not used: `which gh` must resolve to `~/.local/bin/gh`. A launched
session gets the shim directory first on its pane `PATH` from the launcher
(CORE-2524.4), so this can only happen in a plain shell, an older launcher, or a
session created outside `xt`. `xt identity doctor`'s `PATH`-order row evaluates
the launcher's `PATH`, not the pane's. Observed live before the fix: a review
posted as the operator and GitHub downgraded `--approve` to `COMMENTED`.

## The guard allows a merge that should be refused

Check `XTRM_MERGE_GUARD`. Launched sessions get `on` by default; a plain shell
does not. `xt identity doctor` does not report the flag.

<!-- pending: #889 — on main the launcher exports no XTRM_MERGE_GUARD at all, so a launched session is off unless the operator exported it. Verify the first sentence after #889 merges. -->

## `xt identity setup` changed my real home

`xt identity setup` writes `~/.local/bin/gh`, the role map and the routing
reminder. When testing it, run it with `HOME=<temp dir>`. If it ran against the
real home by accident, remove those three paths and re-run it deliberately.

## Reviews are invisible on GitHub

Look for a review, not a comment: `gh api repos/<o>/<r>/pulls/<n>/reviews`. A
`gh pr comment` is a conversation comment and carries no state, so the guard will
not see it.
