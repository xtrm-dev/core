# Configuration: files, variables, roles

Canonical procedure: `docs/github-apps-operator-runbook.md` (core repository).
This file is the quick reference an agent needs in the moment.

## Files on a host

| Path | Mode | Purpose |
|---|---|---|
| `~/.xtrm/identities/github-apps/<slug>/app.json` | 700 dir | `{slug, appId, owner, keyPath, installations}`; `appId` may be a number |
| `~/.secrets/github-apps/<slug>.pem` | 600 file, 700 dir | the App private key; never copied, never pasted |
| `~/.xtrm/config/identity-role-map.json` | – | maps role names and specialist names to the three roles |
| `~/.local/bin/gh` | 755 | the `gh` shim; must come first on `PATH` |
| `${XDG_RUNTIME_DIR:-~/.xtrm/run}/xtrm/gh-tokens/<slug>-<account>.json` | 600 | installation-token cache, five-minute reuse skew |

`app.json` example:

```json
{
  "slug": "xtrm-reviewer",
  "appId": "5669067",
  "owner": "Jaggerxtrm",
  "keyPath": "/home/<user>/.secrets/github-apps/xtrm-reviewer.pem",
  "installations": {
    "Jaggerxtrm": 179891878,
    "mercuryintelligence": 179978963,
    "xtrm-dev": 180705821
  }
}
```

The `installations` map is the only thing that decides whether a session gets an
identity for a repository: the launcher looks up the **owner** of the origin.
A wrong or stale id fails at mint time with HTTP 404; a missing account fails
with "not installed for <owner>".

## Roles and how a name resolves

| Session | Role |
|---|---|
| plain `xt pi` / `xt claude` / `xt codex` | `worker` |
| `--role pr-reviewer`, `--role seconder` | `reviewer` (from the role map) |
| `--role reviewer` | `reviewer` |
| `--role coordinator` | `coordinator` |
| supervisor launch with `XTRM_SPECIALIST_DEFAULT` | that role, only under `SPECIALISTS_JOB_ID` or `XTRM_SUPERVISOR_LAUNCH` |
| unknown name in an interactive launch | no identity, one stderr note, operator identity |
| unknown name in a supervisor launch with a map | refused before any worktree |
| explicit `reviewer` with the App configured but not installed for the owner | refused before any worktree |

`xt identity role --json` prints `{role, source, holder}` and is the single source
of truth a launcher and the runtime both call.

## Variables

| Variable | Set by | Meaning |
|---|---|---|
| `SUBSTRATE_HOLDER` | launcher | who the agent is; also the git author name |
| `XTRM_ROLE` | launcher | `reviewer`, `worker` or `coordinator` |
| `XTRM_MERGE_GUARD` | launcher default `on` | `on`/`1`/`true`/`yes` gates `gh pr merge`; anything else leaves it off |
| `XTRM_MERGE_GUARD_OVERRIDE` | coordinator/operator, per command | reason string; the guard logs it and journals a decision |
| `XTRM_MERGE_GUARD_OFFLINE` | anyone | `1` skips the Substrate Issue check (planned, CORE-2590) |
| `XTRM_SPECIALIST_DEFAULT` | supervisor | role for a supervisor-launched activation |
| `XTRM_REVIEW_HEAD`, `XTRM_REVIEW_MODEL` | optional | cross-checks only; the review body's line 1 is authoritative |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n` | launcher | the git transport override; inherited entries are preserved and forwarded through tmux `-e` |

The guard is a client-side convenience plus the shim's enforcement. It does not
stop a process that calls the REST API directly; that limit is documented in
`.xtrm/skills/default/engineering-quality/references/review.md`.

## Commands

```bash
xt identity doctor            # role map, each App, each installation, the shim; exit 1 on a hard failure
xt identity setup             # installs the shim, role map and routing reminder; never overwrites
xt identity role --json       # the resolved role and its source
xt identity token --repo o/r  # operator shell only; never prints the reviewer token
xt identity review-post       # what the shim calls; not for agents to call by hand
xt identity merge-check --repo o/r --pr 12
xt identity merge-record --repo o/r --pr 12 --head <sha>
```

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
`<slug>[bot]`. Full detail: the runbook section "Turning on `xtrm-worker` and
`xtrm-coord` later".
