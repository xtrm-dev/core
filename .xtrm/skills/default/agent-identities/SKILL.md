---
name: agent-identities
description: Configure and operate the GitHub App identities that let XTRM agents act as themselves (xtrm-reviewer, xtrm-worker, xtrm-coord): create and install the Apps, store app.json and the key, resolve a role, verify with xt identity doctor, read a pinned review, and diagnose the failures that look like "not configured". Use when an agent must post a formal review, push as a bot, answer a mention, when a role refuses to launch, or when someone asks how the identities are set up.
---

# Agent identities (GitHub Apps)

The canonical, operator-facing procedure is
`docs/github-apps-operator-runbook.md` in the core repository. This skill is the
agent-facing entry point: when to use which identity, what each variable does, how
to verify, and what a failure means. Read the runbook before changing a host.

## The three identities

| Role | App | What it may do | What it may never do |
|---|---|---|---|
| `reviewer` | `xtrm-reviewer` | post a formal review, comment, read diffs and reviews | push, merge, close a PR, hold `Contents: write` |
| `worker` | `xtrm-worker` | push `xt/*` branches, open PRs, comment | merge, push outside `xt/*`, act on `master`/`stable` |
| `coordinator` | `xtrm-coord` | answer `@xtrm-coord` mentions, comment, read | push, merge, approve a change it did not analyse |

Only the reviewer App exists today (installed on `Jaggerxtrm`,
`mercuryintelligence`, `xtrm-dev`). Workers and coordinators still act as the
operator: nothing breaks, nothing is attributed either.

## When to reach for this skill

- A review must appear as `xtrm-reviewer[bot]` and be pinned to a head SHA.
- A merge must be refused because no review exists at the current head.
- A launch refused with "the xtrm-reviewer App is not installed for <owner>".
- `xt identity doctor` says an App is "not configured" although `app.json` exists.
- Someone asks where the variables live, what `XTRM_MERGE_GUARD` does, or how to
  add the worker and coordinator Apps.

## The rule that decides everything

The launcher exports an identity only when **both** are true:

1. `~/.xtrm/identities/github-apps/<slug>/app.json` exists and parses, and
2. its `installations` map has an entry for the **owner of the repository** the
   session works in.

Otherwise the session keeps the operator identity and prints one line saying why.
An explicit reviewer launch is the exception: if the App is configured but not
installed for that owner, the launch is **refused**, because a reviewer falling
back to the operator login defeats the App.

## Start here

- `references/configuration.md` — files, variables, roles, and the exact
  verification commands.
- `references/troubleshooting.md` — the failures seen in practice, what each
  message means, and the fix.
- `docs/github-apps-operator-runbook.md` — creating an App, permissions,
  installations, the live findings.

## Do not

- Do not hand a token to an agent, paste a `.pem`, or print `xt identity token`
  output. The reviewer token is minted only inside `review-post`.
- Do not run `xt identity setup` or `xt identity doctor` against the real `$HOME`
  while testing: point `HOME` at a temp directory.
- Do not claim a review is posted without the printed `commit_id` matching the
  reviewed head, or a merge is guarded when `XTRM_MERGE_GUARD` is off.
