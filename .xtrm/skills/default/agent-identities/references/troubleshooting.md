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
3. `appId` is missing, empty, or neither a string nor a number. A JSON `null` is
   not enough.

The key is not part of this message. An absent `keyPath` falls back to
`~/.secrets/github-apps/<slug>.pem`; a `.pem` that does not exist, or one with
mode 644, still gives `ok app …`. The doctor's `app <slug>` row names the key
path and its mode, and the mint is where a bad mode is refused: "the App private
key … is mode 644; it must be 600".

`xt identity doctor --json` prints the failing check with the resolved path.

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

## "the PR names no Substrate Issue in a marker …" (merge guard) and "the PR carries no xtrm marker …" (review-post)

Two refusals, two rules. Both take the Issue only from the PR's marker: a branch
name such as `fix/UTF-8-parser` is never read as a ref.

- **Merge guard** (`gh pr merge` through the shim): with no `issue=` in the
  marker it denies "the PR names no Substrate Issue in a marker, so the guard
  refuses even an approval at the current head…" and names the line-2 marker as
  the fix; a PARTIAL review gets "…, so a PARTIAL review cannot be accepted". Several markers naming different Issues are
  denied as "the PR body carries N xtrm markers naming different Issues (A, B);
  leave exactly one". Fix: add
  `<!-- xtrm issue=<REF> holder=<holder> run=<id> -->` to the PR body.
- **`review-post`** collects only markers that carry `issue=`, so such a body is
  refused: "PR #N carries no xtrm marker in its body (<!-- xtrm issue=<REF>
  holder=<holder> run=<id> -->); refusing to post an unattributable review". A
  marker with `issue=` but no `holder=` is refused too: "PR #N has an xtrm marker
  without holder=, so an own-PR review cannot be excluded; ask the opener to add
  holder= to the marker".

A marker whose ref Substrate does not know is refused at merge time: "the marker
names <REF>, and Substrate has no such Issue; fix the marker before merging". A
Substrate outage allows the merge with a warning instead (CORE-2590), and
`XTRM_MERGE_GUARD_OFFLINE=1` forces that same path.

## "Journal receipt failed: sb exited 1"

Two causes seen: the `--result` payload used a field Substrate does not accept
(only `summary|attempted|outcome|completed|validation|findings|artifactRefs|receiptRefs|provenanceRefs`),
or `sb` was an older binary on a trimmed `PATH`. The review and the merge still
happened; only the receipt was lost, so re-record it with
`xt identity merge-record` or re-post the review.

## A review posted as the operator instead of `<slug>[bot]`

The shim was not used. The cause seen on 2026-11-10 was the pane `PATH`: a
launched tmux pane inherited the tmux **server's** PATH, so `gh` resolved to the
real binary instead of the `~/.local/bin/gh` shim. The launcher now forwards a
PATH to every session and window it creates (#891, merged 4de65af8), but only for
panes created after it: a pane opened earlier keeps the server PATH. The
forwarded value is the launcher's PATH with the shim directory (`~/.local/bin`)
placed first, empty segments dropped and duplicates removed, so the shim wins
even when the launcher's own PATH lacks it.

Check in the session that would post: `command -v gh` must print
`~/.local/bin/gh`. If it prints anything else, relaunch the pane.

`xt identity doctor`'s `PATH`-order row evaluates the launcher's `PATH`, not the
pane's, so it cannot see a tmux server PATH that lacks the shim directory.
Observed live before the fix: a review posted as the operator and GitHub
downgraded `--approve` to `COMMENTED`.

## The guard allows a merge that should be refused

Check `XTRM_MERGE_GUARD`. Launched sessions get `on` by default; a plain shell
does not. The launcher forwards an inherited value explicitly, so an `off` set in
a coordinator's shell reaches its workers as `off` rather than being re-defaulted.
`xt identity doctor` does not report the flag.

## `xt identity setup` changed my real home

`xt identity setup` writes `~/.local/bin/gh`, the role map and the routing
reminder. When testing it, run it with `HOME=<temp dir>`. If it ran against the
real home by accident, remove those three paths and re-run it deliberately.

## Reviews are invisible on GitHub

Look for a review, not a comment: `gh api repos/<o>/<r>/pulls/<n>/reviews`. A
`gh pr comment` is a conversation comment and carries no state, so the guard will
not see it.
