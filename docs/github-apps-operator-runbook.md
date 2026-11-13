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

### 5. How a mention reaches XTRM: polling by default, a webhook is an option

Webhooks need a reachable server: "the webhook URL is the address of a web server that will receive the webhook event payloads". Which machine can be that server decides which inbound path exists.

Verified live:

- The **workstation** has no ingress: it sits behind NAT and publishes no port to the internet. It can poll outbound; it cannot host a webhook receiver or an Actions runner.
- The **server host** does have public ingress: public IPv4 `159.195.49.110` on `eth0` (`ip -4 addr show eth0`), and the `infra-traefik` container publishes `0.0.0.0:80` and `0.0.0.0:443` (`docker ps`). It is a production host that already carries routes.
- `xtrm-dev` CI is billing-locked with no runners, so an Actions-based poller is unavailable on either machine.

A webhook receiver is therefore technically possible on the server behind Traefik, and an instant mention is not ruled out by the infrastructure. It is a choice with a cost, not the default. Two options:

#### Option A — polling (starting recommendation)

No new public surface. A local reconciler asks GitHub for new comments and answers them. Latency equals the poll interval; five minutes is a reasonable starting point.

1. A timer on the chosen machine (systemd user timer or cron, one entry) mints a `xtrm-coord` installation token for the **recorded** installation id, valid 1 hour, and calls
   `GET /repos/{owner}/{repo}/issues/comments?since=<last run>&per_page=100`
   for each repository in scope, plus `GET /repos/{owner}/{repo}/pulls/{n}/comments` when inline threads matter.
2. The poller keeps `@xtrm-coord` comments whose author is a person, keyed by comment id, in a small state file, so a re-run never answers twice.
3. Each new mention becomes one routing request to the coordinator (a Substrate Journal entry on the programme Issue, or a message to the coordinator session), carrying the repository, pull request number, comment id and body.
4. The answer is posted back as the App with the run header, as a reply on the same pull request.

Depends on: the App installed on the three accounts with **Issues: read** (plus **Pull requests: read** if inline review comments are polled), the App key and App ID on the chosen machine, the timer, and the dedupe state file.

With this option an instant answer is unavailable **by choice**: the mention is answered when the poller next runs, not when it is written.

#### Option B — webhook behind Traefik on the server (an option, needs a ruling)

Near-instant delivery: GitHub posts the event to a URL whose TLS the Traefik entrypoint already terminates. It also adds a public route to a production host, so it is not a free upgrade of Option A. An operator ruling comes first. The build then needs all of:

- **A webhook secret with HMAC verification.** GitHub signs every delivery in `X-Hub-Signature-256`; a receiver on a public route that does not verify the signature accepts forged posts. The secret is a new operator secret, stored beside the App key, never in a worktree.
- **A Traefik route owned by the infra repository.** The route is configuration in the repo that owns `infra-traefik` and is reviewed like any other production change. Nothing in this runbook creates it, and no such route exists today.
- **Its own process and resource limit.** A separate service with memory and CPU limits, a restart policy and its own log destination; never a shared container with the coordinator.
- **Replay and dedupe handling.** Delivery ids recorded the way Option A records comment ids, because GitHub retries deliveries.
- **Webhooks switched on for the App**, with `issue_comment` (and, if wanted, `pull_request_review_comment`) subscribed; that changes the registration described below.

Option B is a possibility, not an existing design: this runbook neither describes a Traefik route nor assumes one. Record the choice as `inbound` in `app.json` (`polling` or `webhook`).

- Source: <https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps> (webhook URL must be a web server; webhooks may be turned off for an app that will only authenticate)
- Source: <https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation> (installation access tokens, 1 hour)
- Source: <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries> (`X-Hub-Signature-256`, HMAC verification)

## Where the key and the poller live

Two machines, one decision. Pick one place for the key and the poller, and record the choice in `app.json`:

| Placement | Key lives | Poller runs | Trade-off |
|---|---|---|---|
| **Workstation** (recommended) | `~/.secrets/github-apps/<slug>.pem` on the workstation | systemd user timer on the workstation | Keys stay on the machine where `xt` runs and where commits are made; the poller stops when the workstation sleeps, so answers arrive after resume |
| **Server host** | the same path on the server host | systemd timer on the server host | Always on, but the key now lives on a second machine, and every consumer on the workstation needs an ssh hop to mint a token |

Both placements are supported. If Option B (webhook) is chosen, the receiver must run where the public ingress is — the server host — so the key and the poller follow it. Do not split them: a key on one machine with a poller on the other needs a second hop for every poll and doubles the number of places a key can leak. Whichever you pick, `app.json` carries `keyPath` and `pollerHost`.

## The three Apps

Repository permissions only. Every App also needs `Metadata: read`, which GitHub requires for every App, cannot be removed once set, and is requested on the registration form like any other permission; it is listed once here and not repeated per App.

| App | Purpose | Permissions | Subscribed events | May never |
|---|---|---|---|---|
| `xtrm-reviewer` | Formal reviews and review comments at a head SHA | Contents: read, Pull requests: write, Issues: write | none (webhooks inactive) | push, merge, hold `Contents: write` |
| `xtrm-coord` | Answer and route `@xtrm-coord` mentions on pull requests | Contents: read, Issues: write, Pull requests: write | none for Option A; `issue_comment` for Option B | merge, push, review-approve a change it did not analyse |
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
5. Leave **Active** deselected under "Webhook" for now. This follows from choosing Option A (polling); it is not a claim that no endpoint could exist, because the server host does have public ingress behind Traefik. An active webhook with no receiver at its URL would only accumulate failed deliveries. It can be enabled later without re-registering the App, which is what Option B requires.
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

## Turning on `xtrm-worker` and `xtrm-coord` later

The reviewer App is live; the other two are not, so worker and coordinator sessions still act as the
operator. Doing them later takes the same four steps, once per App, and nothing in the code changes:

1. **Create the App** exactly as in "Create each App" above, with the permissions from the table
   (`xtrm-worker`: Contents write, Pull requests write, Issues write; `xtrm-coord`: Contents read,
   Pull requests write, Issues write).
2. **Install it** on every account whose repositories the agents touch — `Jaggerxtrm`,
   `mercuryintelligence`, `xtrm-dev`. "All repositories" is the simplest choice. An App that is not
   installed on the repository's owner is not a partial identity: `xt identity doctor` reports it, and
   an explicit reviewer launch is refused rather than falling back to the operator (the launcher rule).
3. **Store the key and the identifiers** as in "Store the key and the identifiers":
   `~/.xtrm/identities/github-apps/<slug>/app.json` with `slug`, `appId`, `owner`, `keyPath` and
   `installations` (account to installation id), and the `.pem` at `~/.secrets/github-apps/<slug>.pem`
   with mode `600`. A numeric `appId` is accepted as written in JSON.
4. **Verify**: `xt identity doctor --json` must show `app <slug> ok: true` and an `installation <slug>`
   row naming every account, and `xt identity role --json` inside a launched session must report the
   role the launch asked for. Then one real push (worker) or one real mention answer (coordinator),
   checked as `<slug>[bot]` in the GitHub UI.

Where the role comes from: a plain `xt claude|pi|codex` session is a worker; `--role <specialist>`
resolves through `~/.xtrm/config/identity-role-map.json` (`pr-reviewer` and `seconder` map to
`reviewer`); a supervisor launch uses `XTRM_SPECIALIST_DEFAULT`. With no App for that role the launch
prints one line and keeps the operator identity — nothing breaks, nothing is attributed either.

Live finding (2026-11-10): the reviewer App was installed on `Jaggerxtrm` and `mercuryintelligence`
but **not** on `xtrm-dev`, and its `app.json` still listed a dead `xtrm-dev` installation id. Both
mistakes are silent at review time and fatal at mint time (HTTP 404, or "not installed for xtrm-dev").
Check the `installations` map against `GET /app/installations` before trusting it.

### Who sets `XTRM_MERGE_GUARD`

Today: the person or launcher that starts the session, per shell. It is not written anywhere yet, and
the guard is **off** unless it is set:

```bash
XTRM_MERGE_GUARD=on xt pi --role worker          # per launch
export XTRM_MERGE_GUARD=on                       # per shell, before launching agents
```

A session started without it merges unchecked and the hook passes the merge through. Recommended next
step (not implemented): have the launcher export `XTRM_MERGE_GUARD=on` for every agent session, so the
guard is on by construction and an operator turns it off deliberately rather than forgetting to turn it
on. That is a code change with its own Issue; until then, set it per launch and say so in every
handoff.

## What the code provides once an App exists (CORE-2528)

Without an App on disk, every token path fails closed with a message naming the missing file and no agent
picks up a credential. Two routes behave differently by design: the review route refuses (a review cannot be
postponed to the operator's login without lying about who reviewed), while the merge route is flag-gated and
OFF by default, so installing the shim cannot refuse every agent merge before the Apps exist.

### The shim is a guardrail, not a security boundary

A restricted role (the reviewer) reaches only an explicit **allowlist** of read routes through the shim —
`gh pr view|list|diff|checks|status|checkout|comment|review`, `gh issue view|list|comment|status`, `gh api`
through its GET-only verdict, `gh repo view`, `gh auth status`, `gh run view|list`, `gh search`, `gh status` —
plus the create path (`gh pr create`, `gh pr new`), which still applies the marker refusal and the Issue link.
Every other route is refused before the real `gh` runs, whatever it is spelled as: `gh pr edit|merge|close|
reopen|ready|lock|unlock|update-branch|revert`, `gh issue close|reopen|edit` (gh resolves a PR number through
`gh issue`), `gh issue create`, `gh alias set`, any unclassified command group, and an unknown first token
(a user alias or a gh extension). An `XTRM_ROLE` that the role map cannot resolve counts as restricted, so a
typo narrows rather than widens: `cli/src/core/gh-shim-routes.ts` holds the classification, and
`cli/src/tests/gh-shim-routes.test.ts` fails when gh grows a verb or a group that no class covers.

This is a guardrail for a cooperating agent's mistakes, **not** a security boundary. Any process can bypass it
by unsetting `SUBSTRATE_HOLDER` and `XTRM_ROLE`, calling `/usr/bin/gh` directly, or reordering `PATH`; every
pass-through then runs on the operator's own keyring token. The binding controls are on the GitHub side: App
permissions, branch protection, required reviews, and the repository rulesets. Read the shim as a way to keep an
honest agent inside its lane, never as enforcement against a hostile one.

Known limits, accepted rather than hidden:

- `SUBSTRATE_HOLDER`, `XTRM_ROLE`, `XTRM_MERGE_GUARD`, `XTRM_MERGE_GUARD_OVERRIDE` and the `<!-- xtrm … -->`
  marker all live in the agent's own environment, so that agent can change them; they are signed by nothing.
  This is the accepted same-unix-user limit, not a control. The shim's pass-through uses that process's own
  `gh` login, which is the operator login unless the App credential is configured. The controls are attribution on
  every review (agent/run marker plus a Journal receipt), refusal of a review of the holder's own PR, a
  refusal to review a PR that carries no marker at all, and a merge guard that reads GitHub's review state
  rather than the local declaration.
- `xt identity token --role` is honoured only in an operator shell outside an agent tree; inside an agent tree
  it may only name the process's own resolved role. The reviewer token is minted by the `review-post` path and,
  for reads only, by `merge-check` and `merge-record`; it is never printed. An unknown role name gets no credential.
- The reviewer's `gh api` restriction is an allowlist (a plain GET only: no method other than GET, no
  field/input flags, no graphql, no issues endpoint), not a complete sandbox: anything the shim passes through
  reaches the real `gh` with the operator's login, and `gh issue close` is not intercepted.
- The launcher appends the transport at the inherited `GIT_CONFIG_COUNT` (strictly digits, otherwise 0 with a
  note) and never removes an inherited entry. On the tmux `-e` paths it forwards the inherited
  `GIT_CONFIG_KEY_i`/`VALUE_i` entries as well: a pane does not inherit xt's environment, so a count without
  those keys makes every `git` command in the pane fail.
- For a reviewer launch the launcher forwards the operator's inherited `GIT_CONFIG_*` entries through the tmux
  `-e` flag, so those values appear in the pane's environment and in the `tmux` argv. Keep secrets out of
  `GIT_CONFIG_VALUE_*` in any shell that launches reviewers.
- The launcher exports `XTRM_ROLE` and the `GIT_CONFIG_*` transport only for a role whose App is configured on
  this host **and** installed for the repository owner. Every other launch — a role with no App, a repo with no
  installation, a worktree with no `github.com` origin — keeps the operator identity and does no transport
  rewrite. That is why a worker can still `git push` while only `xtrm-reviewer` exists.
- What no app can intercept: the shim rewrites `gh` only. An agent that keeps the operator identity can still
  push over ssh (`git@github.com:`), run `gh issue close` (not intercepted), or call the REST API directly with
  the operator's token. The launch guard narrows the mistake surface (role marker, transport, credential
  helper); it is not a sandbox, and the environment variables it sets are writable by the same unix user.
- Each guarded `gh` call — every route outside the read allowlist, plus `api` — costs one
  `xt identity role --json` lookup, measured at about 0.17 s. Read routes (`pr view|list|diff|checks|status|
  checkout|comment`, `issue view|list|comment|status`, `repo view`, `auth status`, `run view|list`, `search`)
  pay nothing: the choke point classifies the argv before it resolves a role.
- `XTRM_MERGE_GUARD` (unset = off; `on`, `1`, `true`, `yes` enable it) gates the merge check. With it off the
  shim passes `gh pr merge` through and prints one line saying the guard is off. With it on, an unreachable
  GitHub or App is still refusable by `XTRM_MERGE_GUARD_OVERRIDE` from the coordinator or the operator, and an
  override whose log and Journal receipt both fail is refused, not allowed. An override also needs a resolvable
  head: without one the guard refuses it, because the log line and the Journal receipt both name the commit and
  the merge would be otherwise unpinned. A worker or unmapped role is told it may not override whatever the head.
- A PR whose body carries no `<!-- xtrm issue=<REF> … -->` marker is refused even with an approval at the head:
  the refusal tells the agent to add the line-2 marker or to contact the operator.

### Environment variables

| Variable | Meaning | Values |
| --- | --- | --- |
| `SUBSTRATE_HOLDER` | Agent identity on Journal rows; also what makes a process an agent for the shim. | holder name; unset in an operator shell |
| `XTRM_ROLE` | Role the process acts as when the role map has no answer. | `reviewer`, `coordinator`, `worker` |
| `XTRM_MERGE_GUARD` | Gates the merge check. | unset = **off**; `on`, `1`, `true`, `yes` enable it |
| `XTRM_MERGE_GUARD_OVERRIDE` | Coordinator/operator override of a refused merge; needs a reason and a resolvable head. | reason text |
| `XTRM_MARKER_CHECK_TIMEOUT_MS` | Budget the `gh` shim gives `xt identity marker-check` before it kills the call and lets the `gh pr create`/`pr edit` proceed. | integer milliseconds, clamped **50–60000**, default **4000**; a non-numeric or non-positive value falls back to the default |

`XTRM_MARKER_CHECK_TIMEOUT_MS` exists because the marker check is fail-open: a slow or absent `xt` must never
block a write. Raising it trades a longer worst-case create for more tolerance of a slow `sb`/`xt`; lowering it
below the default makes a slow machine refuse less and proceed more. The value is clamped, so a stray entry in a
launch environment cannot turn the check into a long blocker.

| Command | What it does |
| --- | --- |
| `xt identity doctor` | Reports role map validity, each App's `app.json` and key mode, recorded installations and the `gh` shim. Exit 1 on a hard failure (bad role map, missing/foreign/stale shim, key readable by group/other). |
| `xt identity setup` | Creates `~/.xtrm/config/identity-role-map.json` (when absent), installs the `gh` shim to `~/.local/bin/gh`, installs the reviewer routing reminder. Never creates an App. |
| `xt identity token --repo <owner/name> [--role <role>]` | Mints or reuses a one-hour installation token for this process's resolved role. `--role` is an operator-shell convenience: inside an agent tree it may only name that session's own role, an unknown name is refused, and the reviewer token is refused here (`review-post` and, for reads, `merge-check`/`merge-record` mint it). Prints the token by design (an agent that runs it puts the token in its transcript). The shim mints internally and never prints; `review-post` prints the review URL, id, `commit_id` and state, never a token. |
| `xt identity credential get` | The git credential helper answer: `username=x-access-token`, `password=<installation token>`. Answers only for `https://github.com/<owner>/…` and only for this role's App; otherwise it stays silent. |
| `xt identity review-post --repo <r> --pr <n> --body-file <file>` | One formal review. The body's line 1 (`Review by <role> (<model>) at head <sha12>`) supplies the head and model, and its single `- Verdict:` line supplies the event; a disagreeing flag or environment value is refused. The tool pins `commit_id`, adds the line-2 marker (agent, run, Issue) and prints url, id, `commit_id` and state. Called by the `gh` shim, so agents keep plain `gh pr review`. |
| `xt identity merge-check --repo <r> --pr <n>` | Allow or refuse a merge. Off unless `XTRM_MERGE_GUARD=on`. Refusal names the ways to get a review and the coordinator/operator override; an override whose log and Journal writes both fail is itself refused. |
| `xt identity merge-record` | Post-merge `github-merge` Journal ref, called by the shim after a successful `gh pr merge`. |
| `xt identity marker-check --argv <json>` | Refuses a `gh pr create` whose effective xtrm marker puts a tmux session id in `run=` (`$0`, `$1`, `$7` — what `XTRM_SESSION_ID` carries). Every window in one tmux session shares that value, so it attributes nothing; the refusal names `PI_SESSION_ID` (Pi) or the Claude session id. Called by the `gh` shim before the create runs, and fail-open: only a refusal blocks. |

Files the code reads (nothing else is authoritative):

- `~/.xtrm/identities/github-apps/<slug>/app.json` — `slug`, `appId`, `owner`, `installations` (account to id).
- `~/.secrets/github-apps/<slug>.pem` — the private key, mode `600`; its directory mode `700`.
- `~/.xtrm/config/identity-role-map.json` — role and specialist routing.
  - **Absent** means identities are not configured. Doctor prints one `identities not configured …` check
    (`ok: true`, not a hard failure) and exits `0` when every other check passes; a launch keeps the operator
    identity and exports nothing.
  - **Invalid** (unreadable or unparsable) is a hard doctor failure: the `role map` check is `ok: false` with
    `hard: true`, so doctor exits `1`. Every launch also warns on stderr, including one that names no role;
    nothing is exported and no launch is refused.
  - An interactive `--role` that maps to nothing launches as today and prints
    `role <name> has no identity mapping`; a case-only typo (`Reviewer`, `PR-Reviewer`) is refused with
    "did you mean" before any worktree. Only a supervisor-launched activation with no mapping, an invalid role
    name, or an explicit reviewer that cannot get its App is refused, and always before a worktree or branch
    exists.
  - An accepted name matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`: the first character is an ASCII letter or
    digit, the rest (up to 63) are ASCII letters, digits, `.`, `_` or `-`, so a name is at most 64 characters.
    Rejected: empty names, names starting with `_`, `.` or `-`, path separators (`a/b`, `../x`), option-like
    names (`--force`), whitespace, other punctuation and non-ASCII characters. This covers every `sp list`
    specialist name on this host.
- `~/.xtrm/config/reviewer-routing.md` — the text the review reminder prints. Operator-editable.

Token cache: `$XDG_RUNTIME_DIR/xtrm/gh-tokens/<slug>-<account>.json` (fallback `~/.xtrm/run/...`, created `0700`),
mode `600`, reused for 5 minutes before its expiry. The key must be mode `600` at mint time, not only when
`doctor` runs, and the cache directory is tightened to `0700` — if it cannot be, the mint fails rather than
writing a token into a readable directory (`writeCached` throws). Nothing prints or logs a token except the
`token` command above; `xt identity doctor` shows no key material. The override log honours `XDG_STATE_HOME`
(`$XDG_STATE_HOME/xtrm/merge-guard-override.log`, mode `600`).

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
- Webhook signatures: <https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries>
- Required reviews: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
- REST permission sets: <https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request>, <https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request>, <https://docs.github.com/en/rest/issues/comments#create-an-issue-comment>
- Mention precedent: <https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-pull-request-comment-commands>
