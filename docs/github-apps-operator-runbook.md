# GitHub Apps operator runbook: xtrm-reviewer, xtrm-coord, xtrm-worker

The operator creates three GitHub Apps by hand. This runbook is the whole procedure: what to create, which permissions, where to install, where the keys go, and which GitHub claims are verified and which are not. It does not mint tokens, wrap `gh` or route mentions; those are later phases of CORE-2524.

Budget about an hour for three Apps. No step needs a public endpoint, a runner or GitHub Actions.

## Before you start

- The three Apps replace one shared identity for agent GitHub work. Each App is a distinct `[bot]` actor, so a review by `xtrm-reviewer[bot]` cannot be mistaken for the operator's own review.
- The agent name is not a GitHub account. The App supplies the actor; the header supplies the session. CORE-2524 defines the header **per surface**, and the App does not change that:
  - **GitHub reviews and comments** keep line 1 as the review line and extend the line-2 marker:

    ```
    Review by <role> (<model>) at head <sha12>

    <!-- agent=<holder> run=<id> activation=<activation id> -->
    ```

    `activation=` is present only when a specialist activation produced the post. The pre-post lint (specialists #508) is what rejects a post without the marker; until that phase lands, the marker is written by the wrapper.
  - **Jira comments** use the one-line form on the first line: `[agent:<holder> | run:<id>]`.

  The App's bot slug is never part of the header: two posts from the same App in the same run must differ only by their body.
- Do not create keys, tokens or App passwords in this runbook beyond the App private key. Nothing in this document is a secret.

## The five facts this runbook relies on

Each fact below is either confirmed with a source or explicitly marked unverified.

### 1. Installation scope across accounts: the Apps must be public, not private

A private App "can only be installed on the account that owns the app". A public App can be installed on any account you control, and public does not mean listed in the GitHub Marketplace: the install link is a separate surface.

Consequence: register the Apps under `Jaggerxtrm` with visibility **Any account**, then install them on `mercuryintelligence`, `xtrm-dev` and `Jaggerxtrm`. A private App cannot cover those three accounts.

State "Any account" plainly: it means **anyone holding the install link can install the App on their own account**. It does not mean "only accounts you control".

What a stranger's installation does and does not expose:
- It grants the stranger's account nothing. They receive an installation of your App on *their* repositories; your key stays yours and the App acts on their repositories only when *someone with the key* mints a token for **that installation**.
- It exposes your App's name and public listing to them, and it puts an installation id you did not create into the world.
- It does not expose any repository you own. An installation's token can only reach the repositories that installation selected.

Therefore token minting is only ever given a **recorded** installation id: the three from `~/.xtrm/identities/github-apps/<slug>/app.json`. A token minted for an installation id discovered at runtime is a capability leak, and later phases must read the id from that file, never from a listing call.

- Source: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private>
- Source: <https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app> ("Any account: You can install this GitHub App on any account you control.")
- Source: <https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app> (install link form `https://github.com/apps/APP-NAME/installations/new`; Marketplace listing is optional)
- Live: `Jaggerxtrm` is a user account; `gh api /orgs/mercuryintelligence/memberships/Jaggerxtrm` and `gh api /orgs/xtrm-dev/memberships/Jaggerxtrm` both return `"role": "admin"`, `"state": "active"`; both organizations are on the Free plan.

### 2. Permissions: merging needs `Contents: write`, and nothing else does

The REST documentation states the required permission set per endpoint:

| Operation | Endpoint | Required permission |
|---|---|---|
| Merge a pull request | `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` | **Contents** (write) |
| Submit a review | `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | **Pull requests** (write) |
| Comment on an issue or pull request | `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` | **Issues** (write) or **Pull requests** (write) |
| List issue and pull request comments | `GET /repos/{owner}/{repo}/issues/comments` | **Issues** (read) or **Pull requests** (read) |

- Source: <https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request>
- Source: <https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request>
- Source: <https://docs.github.com/en/rest/issues/comments#create-an-issue-comment>
- Source: <https://docs.github.com/en/rest/issues/comments#list-issue-comments>

Consequence: exactly one role may hold `Contents: write`, and that role can merge. This is why `xtrm-reviewer` and `xtrm-coord` are built without it, and why the separate release App stays deferred: with no protection rule available on Free-plan private repositories, `Contents: write` is the merge permission, and a role that has it can merge whatever it can push.

### 3. Do App approvals count toward required reviews? Unverified

GitHub documents the counting rule as "approved by the required number of reviewers with write permissions", and offers an optional rule requiring approval "from someone other than the last person to push". Neither statement says whether an App installation's approval counts as one of those required approvals.

- Source (the rule, silent on bots): <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>

Marked unverified, not assumed. Verify it once, after the Apps exist, on a throwaway **public** repository (Free-plan private repositories carry no protection rules, so the test must be public):

1. Create a public throwaway repository and a ruleset on `main` requiring 1 approval.
2. Push a branch as `xtrm-worker` and open a pull request.
3. Submit a review as `xtrm-reviewer`.
4. Read the pull request state. If it becomes `APPROVED` and mergeable, App approvals count. If it stays `REVIEW_REQUIRED`, they do not. Record the observation on CORE-2524.

Nothing in the runbook depends on the answer. GitHub's approval arithmetic is not the guard this design relies on: the merge guard reads the reviewer App's review directly. That guard is deferred with **CORE-2530**, so **nothing enforces it yet**.

Which repositories can carry a rule today, verified live:
- `xtrm-dev/core` (`main`) and `xtrm-dev/specialists` (`master`) are **public** and return a branch-protection object: 0 required status checks, 0 required approvals, signed commits required.
- `mercuryintelligence/mercury` is public and unprotected; `xtrm-dev/xtrm` is private and GitHub refuses branch protection there on the Free plan.
- No repository has a ruleset yet (`GET /repos/{owner}/{repo}/rulesets` → `[]`).

So the test in this section is possible on the public repositories, and impossible on the private ones. If the answer turns out to be "App approvals do not count", a protection rule added later must keep a human approval in the required set.

### 4. An App can be @-mentioned, but the event is an ordinary comment event

A GitHub App has a bot user and is mentioned by slug: Dependabot is the documented precedent, answering `@dependabot rebase` and similar commands in pull request comments.

There is no mention event. GitHub delivers the ordinary comment event to the App when the App subscribes to it and its webhooks are active:

| What was written | Event | Activity type |
|---|---|---|
| Comment on a pull request or issue (including the conversation tab) | `issue_comment` | `created` |
| Inline review comment | `pull_request_review_comment` | `created` |

The App receives events only for repositories where it is installed, and only for events it subscribed to. It must find its own mention in the comment body; GitHub does not filter for it.

- Source: <https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands>
- Source: <https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment>
- Source: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps>

### 5. How a mention reaches XTRM with no public endpoint and Actions locked: polling

Webhooks need a reachable server: "the webhook URL is the address of a web server that will receive the webhook event payloads". Neither machine in this programme has public ingress: the workstation (the machine that runs `xt`, this runbook and the agent sessions) is behind NAT, and the server host is reachable only over the operator's ssh. `xtrm-dev` CI is billing-locked with no runners, so an Actions-based poller is unavailable too.

Two machines, one decision. Pick one place for the key and the poller and record the choice in `app.json`:

| Placement | Key lives | Poller runs | Trade-off |
|---|---|---|---|
| **Workstation** (recommended) | `~/.secrets/github-apps/<slug>.pem` on the workstation | systemd user timer on the workstation | Keys stay on the machine where `xt` runs and where commits are made; the poller stops when the workstation sleeps, so answers arrive after resume |
| **Server host** | the same path on the server host | systemd timer on the server host | Always on, but the key now lives on a second machine and every consumer on the workstation needs an ssh hop to mint a token |

Both are supported. Do not split them: a key on one machine with a poller on the other needs a second hop for every poll and doubles the place a key can leak. Whichever you pick, `app.json` carries `keyPath` and `pollerHost`.

Recommended inbound path: **polling by a local reconciler**, not webhooks.

1. A timer on the machine chosen above (systemd user timer or cron, one entry) mints a `xtrm-coord` installation token for the **recorded** installation id, valid 1 hour, and calls
   `GET /repos/{owner}/{repo}/issues/comments?since=<last run>&per_page=100`
   for each repository in scope, plus `GET /repos/{owner}/{repo}/pulls/{n}/comments` when inline threads matter.
2. The poller keeps `@xtrm-coord` comments whose author is a person, keyed by comment id, in a small state file so a re-run never answers twice.
3. Each new mention becomes one routing request to the coordinator (a Substrate Journal entry on the programme Issue, or a message to the coordinator session), carrying the repository, pull request number, comment id and body.
4. The answer is posted back as the App with the run header, as a reply on the same pull request.

What this depends on: the App installed on the three accounts with **Issues: read** (plus **Pull requests: read** if inline review comments are polled), the App key and App ID on this host, the timer, and the dedupe state file. Latency equals the poll interval; five minutes is a reasonable starting point.

State this plainly to anyone who expects an instant reaction: with no public webhook endpoint and Actions locked, a mention is answered when the poller next runs, not when it is written. An instant, push-style response is not available in this setup.

- Source: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps> (webhook URL must be a web server; webhooks may be turned off for an app that will only authenticate)
- Source: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation> (installation access tokens, 1 hour)

## The three Apps

Repository permissions only. Every App also needs `Metadata: read`, which GitHub requires for every App, cannot be removed once set, and is requested on the registration form like any other permission; it is listed once here and not repeated per App.

| App | Purpose | Permissions | Subscribed events | May never |
|---|---|---|---|---|
| `xtrm-reviewer` | Formal reviews and review comments at a head SHA | Contents: read, Pull requests: write, Issues: write | none (webhooks inactive) | push, merge, hold `Contents: write` |
| `xtrm-coord` | Answer and route `@xtrm-coord` mentions on pull requests | Contents: read, Issues: write, Pull requests: write | none (webhooks inactive) | merge, push, review-approve a change it did not analyse |
| `xtrm-worker` | Push `xt/*` branches, open pull requests, comment | Contents: write, Pull requests: write, Issues: write | none (webhooks inactive) | merge, push outside `xt/*`, act on `master` or `stable` |

Notes on the permission choices:

- `Contents: read` lets the reviewer and the coordinator read files and diffs without any write path to the repository.
- `Issues: write` is the cheapest way to comment on a pull request's conversation tab; `Pull requests: write` also covers it and is needed for review threads and review submission.
- `xtrm-worker` is the only App with `Contents: write`, therefore the only one that can merge. On **private** repositories nothing on GitHub can stop it: the Free plan refuses branch protection, rulesets and push rules there, so the `xt/*` limit is **client-side only** — the identity shim and the pre-push hook refuse any ref outside `xt/*`, and an audit alarm reports every bot push or merge to `master` or `stable`. Treat that as a reporting control, not a prevention control.
- On **public** repositories the same limit can be enforced by GitHub: a ruleset can restrict which refs may be pushed or merged, and rulesets are available on public repositories without a paid plan. That is the direction for the public repositories, not a claim that it exists today (no repository has a ruleset yet).
- The merge guard that would refuse a merge without the reviewer App's review is deferred with **CORE-2530**; no App and no rule enforces it in this phase.

## Create each App

Repeat for `xtrm-reviewer`, `xtrm-coord` and `xtrm-worker`. Use the exact names: the slug in comments derives from them.

1. Open <https://github.com/settings/apps/new>. Register as `Jaggerxtrm`, not as an organization, so the same App can be installed on all three accounts.
2. Under "GitHub App name", enter the name. The slug appears under it; confirm it is `xtrm-reviewer`, `xtrm-coord` or `xtrm-worker`.
3. Under "Homepage URL", enter <https://github.com/xtrm-dev/core>.
4. Leave "Callback URL", "Setup URL" and "Request user authorization (OAuth) during installation" empty. These Apps act as themselves, never on behalf of a user.
5. Deselect **Active** under "Webhook". No public endpoint exists, so a webhook would only accumulate failed deliveries. The subscribing App can be enabled later without re-registering.
6. Under "Permissions", set exactly the values in the table above and leave every other permission at **No access**.
7. Under "Where can this GitHub App be installed?", select **Any account**.
8. Click **Create GitHub App**.
9. On the App page, record the **App ID** (top of the page). It is not a secret.
10. In the left sidebar, click **Credentials**, then **Key pairs**, then **New key**, then **Generate a private key**. A `.pem` file downloads once. Do not paste it anywhere; move it as described in "Store the key".
11. Leave **Client secrets** untouched: no user authorization flow is used.

## Install on the three accounts

The same App, three installations. Install once per account, on the repositories each account owns.

1. Open `https://github.com/apps/<slug>/installations/new` while signed in as `Jaggerxtrm`.
2. Choose the account: `Jaggerxtrm`, then repeat with `mercuryintelligence` and `xtrm-dev`. Each requires its own install because installations are per account.
3. Select **All repositories** unless a narrower selection is wanted; the App cannot see anything outside its installation either way.
4. Click **Install**.
5. Record the installation id from the address bar:
   `https://github.com/organizations/<org>/settings/installations/<installation_id>` (for the user account, `https://github.com/settings/installations/<installation_id>`).
6. Repeat from step 1 for the next account. The account picker appears because the App is public.

If the account does not appear in the picker, the App is private and must be changed to **Any account** in its settings. Adding repository permissions to an App already installed somewhere requires the owner of that account to approve the update; compare the requested permissions against this runbook before approving.

## Store the key and the identifiers

Secrets and non-secrets live apart.

1. Store the private key:

   ```bash
   install -d -m 700 ~/.secrets/github-apps
   install -m 600 ~/Downloads/<slug>.<date>.private-key.pem ~/.secrets/github-apps/<slug>.pem
   rm ~/Downloads/<slug>.<date>.private-key.pem
   ```

2. Verify mode `600` on the key and `700` on its directory:

   ```bash
   stat -c '%a %n' ~/.secrets/github-apps ~/.secrets/github-apps/*.pem
   ```

3. Record the non-secret identity data as JSON, one file per App, so nothing has to be rediscovered later:

   ```
   ~/.xtrm/identities/github-apps/<slug>/app.json
   ```

   Fields: `slug`, `appId`, `owner` (`Jaggerxtrm`), `keyPath`, and `installations` as a map of account to installation id (`Jaggerxtrm`, `mercuryintelligence`, `xtrm-dev`). No key material, no client secret, no token.

4. Do not put the key in a worktree, `/tmp`, a shell profile, a tmux environment or the Substrate store. Later phases read it by path; nothing prints it.

## Verification checklist

This runbook does not mint tokens, so most behavioural checks cannot pass at install time. The list is split by what makes each check possible.

### Part A — verified by the operator now, at install time

Each line is an observation on a GitHub page, not a token call.

- [ ] App appears at `https://github.com/apps/<slug>` with the intended name and slug.
- [ ] **App ID** recorded; `~/.xtrm/identities/github-apps/<slug>/app.json` exists with `slug`, `appId`, `keyPath`, `pollerHost` and the three installation ids.
- [ ] Key file at `~/.secrets/github-apps/<slug>.pem` with mode `600`, directory `700` (`stat -c '%a %n'`).
- [ ] The App's **Permissions** page shows exactly the set in the table above and no `Contents: write` on `xtrm-reviewer` or `xtrm-coord`.
- [ ] The App's page shows visibility **Any account**, and **Webhook** is inactive.
- [ ] The installation exists on all three accounts (`https://github.com/settings/installations` for the user, organization settings for the two orgs), each with its recorded installation id.
- [ ] The key is offered to no other process: no copy in a worktree, `/tmp`, shell profile or tmux environment.

### Part B — verified after the phase that adds token minting

`xt identity` (token minting, `gh` shim, git credential helper) is **Phase 3** of CORE-2524 for the reviewer and the coordinator; the worker App's wiring is **Phase 4**. Run these after those phases land, not before — until then there is no token and no way to act as the App.

- [ ] `xtrm-reviewer` (after Phase 3): a review on a test pull request appears as `xtrm-reviewer[bot]` and offers no way to push.
- [ ] `xtrm-coord` (after Phase 3): a comment written as `@xtrm-coord` is visible as a mention and the App can reply on the same pull request.
- [ ] `xtrm-worker` (after Phase 4): a test push to an `xt/*` branch and its pull request appear as `xtrm-worker[bot]`, and the client-side guard refuses the same App on `master`.
- [ ] Each App post carries the CORE-2524 header for its surface: line 1 review text plus the `agent=`/`run=`/`activation=` marker on GitHub, the one-line `[agent:… | run:…]` form in Jira.
- [ ] The fact from section 3 is checked on a throwaway **public** repository (rulesets and branch protection are unavailable on Free-plan private repositories) and recorded on CORE-2524.
- [ ] The merge guard is either in place (**CORE-2530**) or its absence is recorded; nothing enforces it before that issue lands.

## Deferred: the release App

The release App (merge, release, workflow dispatch) stays deferred. Merging needs `Contents: write`, which the worker App already holds, so a separate release identity adds no capability until a protection rule makes the distinction meaningful.

## Sources

- Installing and visibility: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private>, <https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app>, <https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app>
- Registration fields and permissions: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app>, <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app>
- Changing an existing App: <https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration>
- Private keys and installation tokens: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps>, <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation>
- Webhooks and their requirement for a reachable server: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps>
- Webhook events: <https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment>
- Required reviews: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
- REST permission sets: <https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request>, <https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request>, <https://docs.github.com/en/rest/issues/comments#create-an-issue-comment>
- Mention precedent: <https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands>
