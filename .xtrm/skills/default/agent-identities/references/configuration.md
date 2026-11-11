# Configuration: files, variables, roles

Canonical procedure: `docs/github-apps-operator-runbook.md` (core repository).
This file is the quick reference an agent needs in the moment.

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
launcher resolves the same map in-process through `resolveAgentRole` (it does not
shell out to the command); the `gh` shim calls `xt identity role --json`. Both use
the one rule.

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
`.xtrm/skills/default/engineering-quality/references/review.md`.

## Commands

```bash
xt identity doctor            # role map, each App, each installation, the shim; exit 1 on an invalid role map or a bad shim
xt identity setup             # creates the role map when absent, installs the shim and the routing reminder; refuses a foreign gh file, rewrites its own shim
xt identity role --json       # the resolved role and its source (what the gh shim calls)
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
existing role map and an existing xtrm shim is rewritten in place; only a `gh`
file that is not the xtrm shim stops it.

## Verifying a review landed

```bash
gh api repos/<o>/<r>/pulls/<n>/reviews \
  | jq '[.[] | {id, login: .user.login, state, commit_id, html_url}]'
```

Expect `xtrm-reviewer[bot]`, the reviewed `commit_id`, and `APPROVED`,
`COMMENT` or `CHANGES_REQUESTED`. The body's line 1 names the role, the model and
the head; line 2 is the hidden marker `<!-- agent=… run=… issue=… -->`.

## Adding the worker and coordinator Apps

Four steps each, no code change: create the App with its permission set, install
it on every account whose repositories agents touch, write `app.json` and the
600-mode key, then verify with `xt identity doctor` and one real action seen as
`<slug>[bot]`. Full detail: the runbook's "Create each App", "Install on the
three accounts" and "Store the key and the identifiers" sections, and "Turning on
`xtrm-worker` and `xtrm-coord` later" for the same four steps when the two Apps
are built.
