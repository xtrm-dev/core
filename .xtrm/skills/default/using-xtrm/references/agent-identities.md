# GitHub App identities, review publication and the merge guard

Canonical operator procedure: `docs/github-apps-operator-runbook.md` in the core
repository. This reference is the agent-facing view: when to use which identity, what
each variable does, how to publish a review, what the merge guard refuses, and what a
failure means. Read the runbook before changing a host.

Anything here can drift; live `xt identity --help` wins.

## The three identities

| Role | App | What it may do | Why it cannot exceed that |
|---|---|---|---|
| `reviewer` | `xtrm-reviewer` | post a formal review, comment, read diffs and reviews | `Contents: read`, so GitHub lets it neither push nor merge |
| `worker` | `xtrm-worker` | push `xt/*` branches, open PRs, comment | `Contents: write`, so GitHub *does* let it merge; only the client-side checks below refuse |
| `coordinator` | `xtrm-coord` | answer `@xtrm-coord` mentions, comment, read | `Contents: read`, so GitHub lets it neither push nor merge |

Only the reviewer App is in use today. Worker and coordinator sessions still act
as the operator: nothing breaks, nothing is attributed either. Read the two
unbuilt rows as design intent. Pushing needs `Contents: write`, and on private
repositories GitHub cannot restrict which refs an App pushes (the Free plan
refuses branch protection and rulesets), so nothing on GitHub holds the worker to
`xt/*`. Nothing on the host does either: the `gh` shim intercepts `gh`, not
`git push`, and no alarm on bot pushes exists yet. The row states the intended
design, not an enforced limit.

## When to reach for an identity

- A review must appear as `xtrm-reviewer[bot]` and be pinned to a head SHA.
- A merge must be refused because no review exists at the current head.
- A launch refused with "the xtrm-reviewer App is not installed for <owner>".
- `xt identity doctor` says an App is "not configured" although `app.json` exists.
- `xt identity doctor` says "identities not configured": there is no role map.
- Someone asks where the variables live, what `XTRM_MERGE_GUARD` does, or how to
  add the worker and coordinator Apps.

## The rule that decides everything

A launched session gets an App credential only when **all three** hold:

1. `~/.xtrm/config/identity-role-map.json` exists and parses — without it the
   host has no identities at all, and every launch keeps the operator login;
2. `~/.xtrm/identities/github-apps/<slug>/app.json` exists and parses, and
3. its `installations` map has an entry for the **owner of the repository** the
   session works in.

Otherwise the session keeps the operator identity. A launch that named a role
prints one line saying why it got no credential; a plain launch prints nothing.
The role map is the most likely thing to be missing: `xt identity doctor` then
reports "identities not configured (no role map at …)", and `xt identity setup`
is the fix. An explicit reviewer launch is the exception: if the App is
configured but not installed for that owner, the launch is **refused**, because a
reviewer falling back to the operator login defeats the App.

## Roles and how a name resolves

| Session | Role |
|---|---|
| plain `xt pi` / `xt claude` / `xt codex` | `worker`; no credential until the worker App exists, so the operator identity today |
| `--role pr-reviewer`, `--role seconder` | `reviewer` (from the role map) |
| `--role reviewer` | `reviewer` |
| `--role coordinator` | `coordinator`; the operator identity until that App exists |
| supervisor launch with `XTRM_SPECIALIST_DEFAULT` | that role, only under `SPECIALISTS_JOB_ID` or `XTRM_SUPERVISOR_LAUNCH` |
| unknown name in an interactive launch | no identity, one stderr note, operator identity |
| unknown name in a supervisor launch with a map | refused before any worktree |
| explicit `reviewer` with the App configured but not installed for the owner | refused before any worktree |
| no role map on the host | no identity at all, "identities not configured" |

`xt identity role --json` prints `{role, source, holder}` from the role map. The
launcher resolves the same map in-process through `resolveAgentRole`; the `gh` shim
calls `xt identity role --json`. Both use the one rule. A supervised Specialist gets the
same identity environment from `xt identity env --json` (holder, role, git author and
`GIT_CONFIG_*` only), so a `pr-reviewer` activation resolves to the reviewer role.

## Files on a host

| Path | Mode | Purpose |
|---|---|---|
| `~/.xtrm/identities/github-apps/<slug>/app.json` | 700 dir | `{slug, appId, owner, keyPath, installations}`; `appId` as a JSON string |
| `~/.secrets/github-apps/<slug>.pem` | 600 file, 700 dir | the App private key; `keyPath` defaults to this |
| `~/.xtrm/config/identity-role-map.json` | – | maps role names and specialist names to the three roles |
| `~/.local/bin/gh` | 755 | the `gh` shim; must come first on `PATH` |
| `${XDG_RUNTIME_DIR:-~/.xtrm/run}/xtrm/gh-tokens/<slug>-<account>.json` | 600 | installation-token cache, five-minute reuse skew |

`app.json` example (the ids are placeholders: take yours from the App and its
installation pages; they are not secrets, but they are host facts, not skill
content):

```json
{
  "slug": "xtrm-reviewer",
  "appId": "<app-id>",
  "owner": "<account>",
  "keyPath": "/home/<user>/.secrets/github-apps/xtrm-reviewer.pem",
  "installations": {
    "<account>": "<installation-id>",
    "<second-account>": "<installation-id>"
  }
}
```

`appId` is a string or a number: `readAppConfig` converts a number to its decimal
string, so a hand-written `"appId": 123456` works.

The `installations` map is the only thing that decides whether a session gets an
identity for a repository: the launcher looks up the **owner** of the origin.
A wrong or stale id fails at mint time with HTTP 404; a missing account fails
with "not installed for <owner>".

## Variables

| Variable | Set by | Meaning |
|---|---|---|
| `SUBSTRATE_HOLDER` | launcher | who the agent is; also the git author name |
| `XTRM_ROLE` | launcher | `reviewer`, `worker` or `coordinator`, exported only when that role's App is configured **and** installed for the repository owner; today that means the reviewer role |
| `XTRM_MERGE_GUARD` | launcher, default `on` | `on`/`1`/`true`/`yes` gates `gh pr merge`, anything else leaves it off; an inherited value is forwarded explicitly, so a coordinator's `off` reaches its workers |
| `XTRM_MERGE_GUARD_OVERRIDE` | coordinator/operator, per command | reason string; the guard logs it and journals a decision |
| `XTRM_MERGE_GUARD_OFFLINE` | anyone (unsigned), per command | `1`/`true`/`on`/`yes` forces the Issue-existence check to `unknown`, so the merge is allowed with one warning from the shim and the hook |
| `XTRM_SPECIALIST_DEFAULT` | supervisor | role for a supervisor-launched activation |
| `XTRM_REVIEW_HEAD`, `XTRM_REVIEW_MODEL` | optional | cross-checks only; the review body's line 1 is authoritative |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` | launcher | the git transport override; inherited entries are preserved and forwarded through tmux `-e` |

The guard is a client-side convenience plus the shim's enforcement. It does not
stop a process that calls the REST API directly; that limit is documented in
`references/review.md` under `engineering-quality`.

## Commands

```bash
xt identity doctor            # role map, each App, each installation, the shim; exit 1 on an invalid role map or a bad shim
xt identity setup             # creates the role map when absent, installs the shim and the routing reminder; refuses a foreign gh file
xt identity role --json       # the resolved role and its source (what the gh shim calls)
xt identity env --json        # the identity env a launched session/subagent gets
xt identity token --repo o/r  # mints this session's own role token; --role only widens an operator shell; never the reviewer token
xt identity review-post       # what the shim calls; not for agents to call by hand
xt identity merge-check --repo o/r --pr 12
xt identity merge-record --repo o/r --pr 12 --head <sha>
```

The doctor's `app <slug>` row carries the key path and its mode
(`mode missing`, `mode 644`). A key that group or other can read is reported
there but does not fail the doctor; the mint refuses it: "the App private key …
is mode 644; it must be 600". Absent `keyPath`, the default
`~/.secrets/github-apps/<slug>.pem` is used. `xt identity setup` keeps an
existing role map and rewrites an existing xtrm shim in place; only a `gh`
file that is not the xtrm shim stops it.

## Review publication: one formal review at the head

A pull request is reviewed by one **formal review**, never a conversation comment:
a comment carries no commit and no review state, so nothing can check which head was
reviewed and no guard can tell an approval from a remark.

```bash
gh pr review <pr> --repo <owner/repo> \
  --comment | --approve | --request-changes \
  --body-file <findings>
```

Verdict mapping: `PASS` → `--approve`, `PARTIAL` → `--comment`,
`FAIL` → `--request-changes`.

The model writes **findings only**. The `gh` shim prepends the header
`Review by <role> (<model>) at head <sha12>` and the hidden marker from the process
identity, sets `commit_id` to the reviewed head, refuses a head that moved after the
review was prepared, and refuses a review of a PR the same holder opened. Never author
the header yourself: attribution is not typed in.

Verify the post by reading it back:

```bash
gh pr view <pr> --repo <owner/repo> --json reviews \
  -q '.reviews[-1] | {login: .user.login, state, commit_id}'
```

Expect `<slug>[bot]`, the reviewed `commit_id`, and `APPROVED`/`COMMENT`/
`CHANGES_REQUESTED`. A `gh pr comment` is invisible to the guard.

## The PR marker and the Issue link

Every PR body carries one hidden marker on line 2:

```text
<!-- xtrm issue=<REF> holder=<holder> run=<runtime session id> -->
```

- `issue=` is the only source the merge guard and `review-post` accept. Several markers
  naming different Issues are refused; leave exactly one.
- `holder=` lets the shim refuse an own-PR review.
- `run=` is the worker's **own runtime session id**: `PI_SESSION_ID` in Pi, the Claude
  session id in Claude. It is never `XTRM_SESSION_ID` or `XTRM_PARENT_SESSION_ID`: those
  are tmux **session** ids shared by every window, so they cannot attribute a run.
  `gh pr create` refuses such a marker before the pull request exists; read the correct
  value with `echo $PI_SESSION_ID` in a Pi worker.
- A marker inside a fenced code block or a quote does not count — the same parser the
  merge guard uses rejects paste noise.

When `gh pr create` succeeds, the shim reads that marker or, failing it, the title and
branch against the project prefixes, and attaches the PR to the one distinct Issue it
finds. The attach is fail-open and ordered: T1 (the PR is the outcome) then T2 (commit
evidence). Two different refs or none warn and skip; guessing would attach durable
evidence to the wrong Issue. The `sb` verbs, the gate codes and the close gate belong to
the `using-substrate` skill; they need substrate `>= 0.2.7`, and a create still succeeds
without them.

## The merge guard

`gh pr merge` through the shim is the check. It allows a merge only when the reviewer
App's **latest** review is `APPROVED` and pinned to the PR's **current head**, or is a
`COMMENT` (PARTIAL) with a valid coordinator decision entry for that head.

Refusals are fail-closed: no review, a review at an older head, an active
`CHANGES_REQUESTED`, an unresolvable Issue (marker malformed, ambiguous, or absent from
Substrate), or GitHub/the App unreachable.

- **On by default for launched sessions.** The launcher exports `XTRM_MERGE_GUARD=on`;
  a plain shell does not. `xt identity doctor` does not report the flag.
- **One escape hatch:** `XTRM_MERGE_GUARD_OVERRIDE=<reason>`, honoured only for the
  coordinator role and the operator identity. Each use writes a log line and a Journal
  decision.
- **Substrate outage:** the Issue-existence check degrades to a warning, so an approved
  merge is not blocked by an outage. `XTRM_MERGE_GUARD_OFFLINE=1` forces that path.

The guard is a client-side check, not a GitHub rule: an App token with unrestricted
scope can still merge through the REST API, and a process that calls the API directly
bypasses it.

## Verifying a review landed

```bash
gh api repos/<owner>/<repo>/pulls/<n>/reviews \
  | jq '[.[] | {id, login: .user.login, state, commit_id, html_url}]'
```

Expect `xtrm-reviewer[bot]`, the reviewed `commit_id`, and `APPROVED`,
`COMMENT` or `CHANGES_REQUESTED`. The body's line 1 names the role, the model and
the head.

## Adding the worker and coordinator Apps

Four steps each, no code change: create the App with its permission set, install
it on every account whose repositories agents touch, write `app.json` and the
600-mode key, then verify with `xt identity doctor` and one real action seen as
`<slug>[bot]`. Full detail: the runbook's "Create each App", "Install on the
three accounts" and "Store the key and the identifiers" sections, and "Turning on
`xtrm-worker` and `xtrm-coord` later".

## Troubleshooting: the failures seen in practice

Read the message before the fix: most of these are correct refusals, not bugs.

### "identities not configured (no role map at …)"

`~/.xtrm/config/identity-role-map.json` is absent: the launcher falls back to the
built-in default map but exports no credential, so no App is consulted at all. This is
the most likely reason a session has no identity while `app.json` and its installation
are correct. `xt identity setup` writes the map (it keeps an existing one); the doctor
then reports the `role map` row with its path and version.

### "app <slug>: not configured; the operator creates it (runbook)"

`readAppConfig` returned null, for exactly three reasons:

1. `app.json` is missing, is not valid JSON, or is not a JSON object.
2. the `slug` inside the file does not match the directory name.
3. `appId` is missing, empty, or neither a string nor a number. A JSON `null` is
   not enough.

The key is not part of this message. An absent `keyPath` falls back to
`~/.secrets/github-apps/<slug>.pem`; a `.pem` that does not exist, or one with
mode 644, still gives `ok app …`. The doctor's `app <slug>` row names the key
path and its mode, and the mint is where a bad mode is refused: "the App private
key … is mode 644; it must be 600". `xt identity doctor --json` prints the failing
check with the resolved path.

### "token mint refused (HTTP 404)"

The installation id in `app.json` does not exist any more, or the App is not
installed on that account. Read the live truth instead of trusting the file:

```bash
# with an App JWT, never printed:
curl -s -H "Authorization: Bearer $APP_JWT" https://api.github.com/app/installations
```

Compare `id` per `account.login`. Observed live once: an account still listed a
dead installation id while the App's current installation had a different one.

### "role reviewer: the xtrm-reviewer App is not installed for <owner>; refusing to launch a reviewer with the operator identity"

The App is configured but its installation does not cover that repository's
owner. Install it there (`https://github.com/apps/xtrm-reviewer/installations/new`).
The refusal is deliberate: a reviewer that silently acts as the operator is worse
than no review.

### "refusing own-PR review: PR #N was opened by holder <h>"

The PR's marker names the same holder as the reviewing session. Either the
agent is reviewing its own PR (correct refusal), or the marker was copied from a
template. Fix the marker (`holder=operator` for an operator-opened PR).

### "the flag requests APPROVE, the body's verdict line says COMMENT"

The verdict comes from the body, and the flag must agree. Write the body's single
`- Verdict: PASS|PARTIAL|FAIL` line at column 0, then pass the matching flag.

### "the latest review … is at <sha>, not at the current head <sha>"

Correct refusal: a push landed after the review. Get a review at the new head.
If it happened immediately after a push, GitHub's REST may still report the old
head for a moment; re-run the check a second later before believing it.

### "the PR names no Substrate Issue in a marker …" / "the PR carries no xtrm marker …"

Two refusals, two rules. Both take the Issue only from the PR's marker: a branch
name such as `fix/UTF-8-parser` is never read as a ref.

- **Merge guard** (`gh pr merge` through the shim): with no `issue=` in the marker it
  denies "the PR names no Substrate Issue in a marker, so the guard refuses even an
  approval at the current head…" and names the marker as the fix; a PARTIAL review gets
  "…, so a PARTIAL review cannot be accepted". Several markers naming different Issues
  are denied as "the PR body carries N xtrm markers naming different Issues (A, B);
  leave exactly one".
- **`review-post`** collects only markers that carry `issue=`, so such a body is
  refused: "PR #N carries no xtrm marker in its body …; refusing to post an
  unattributable review". A marker with `issue=` but no `holder=` is refused too.

A marker whose ref Substrate does not know is refused at merge time: "the marker
names <REF>, and Substrate has no such Issue; fix the marker before merging". A
Substrate outage allows the merge with a warning instead; `XTRM_MERGE_GUARD_OFFLINE=1`
forces that path.

### "refusing to create the pull request: run=$1 is a tmux session id"

`run=` is the runtime session id, not a tmux id: `PI_SESSION_ID` for Pi, the Claude
session id for Claude. `XTRM_SESSION_ID` and `XTRM_PARENT_SESSION_ID` are tmux session
ids that every window shares, so they cannot attribute a run. `gh pr create` refuses
the marker before the PR exists. Read the correct value with `echo $PI_SESSION_ID` in a
Pi worker.

### "Journal receipt failed: sb exited 1"

Two causes seen: the `--result` payload used a field Substrate does not accept
(only `summary|attempted|outcome|completed|validation|findings|artifactRefs|receiptRefs|provenanceRefs`),
or `sb` was an older binary on a trimmed `PATH`. The review and the merge still
happened; only the receipt was lost, so re-record it with
`xt identity merge-record` or re-post the review.

### A review posted as the operator instead of `<slug>[bot]`

The shim was not used. The cause seen on 2026-11-10 was the pane `PATH`: a
launched tmux pane inherited the tmux **server's** PATH, so `gh` resolved to the
real binary instead of the `~/.local/bin/gh` shim. The launcher now forwards a
PATH to every session and window it creates, but only for panes created after it:
a pane opened earlier keeps the server PATH. The forwarded value is the
launcher's PATH with the shim directory (`~/.local/bin`) placed first, empty
segments dropped and duplicates removed.

Check in the session that would post: `command -v gh` must print
`~/.local/bin/gh`. If it prints anything else, relaunch the pane.
`xt identity doctor`'s `PATH`-order row evaluates the launcher's `PATH`, not the
pane's, so it cannot see a tmux server PATH that lacks the shim directory.

### The guard allows a merge that should be refused

Check `XTRM_MERGE_GUARD`. Launched sessions get `on` by default; a plain shell
does not. The launcher forwards an inherited value explicitly, so an `off` set in
a coordinator's shell reaches its workers as `off` rather than being re-defaulted.

### `xt identity setup` changed my real home

`xt identity setup` writes `~/.local/bin/gh`, the role map and the routing
reminder. When testing it, run it with `HOME=<temp dir>`. If it ran against the
real home by accident, remove those three paths and re-run it deliberately.

## Do not

- Do not hand a token to an agent, paste a `.pem`, or print `xt identity token`
  output. The reviewer token is never printed: `review-post`, `merge-check` and
  `merge-record` mint it inside the command.
- Do not run `xt identity setup` or `xt identity doctor` against the real `$HOME`
  while testing: point `HOME` at a temp directory.
- Do not claim a review is posted without the printed `commit_id` matching the
  reviewed head, or a merge is guarded when `XTRM_MERGE_GUARD` is off.
