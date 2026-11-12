# Tabellone keeper: first-time setup

This file sets up the progress artifact ("Tabellone") and its sync for one project.
Shared variables (Jira site and token, operator, Substrate prefix, repo, state directory)
are defined in [../../project-management/references/setup.md](../../project-management/references/setup.md).
Set those first.

## What the artifact is

The Tabellone is one published web page per project. The page reads its data from a small
document store on the same site. The page itself is published once; after that, only the
store changes:

- `workers/<name>`: one doc per live worker (coordinator, xt pane, specialist, subagent).
- `schedule/<YYYY-MM-DD>`: the day's timeline. Jira window Tasks are written by the sync
  (`created_by: "sync-jira"`); handover, incident and report events are written by the keeper.
- `followups/<ref>`, `questions/*`, `answers/*`, `archive/*`: follow-ups, the operator's
  waiting list, operator answers, and archived workers.

`scripts/tabellone_sync.py` is the mechanical writer (5-minute timer). The keeper subagent
(`SKILL.md`) is the hourly checker. Neither one republishes the page.

## 1. Create and publish the artifact

1. The operator creates a here.now site and publishes the page (`index.html`). The page must
   contain the coordinator blocks that describe each doc shape; the keeper reads those blocks
   from `/api/v1/publish/<site>/files/index.html`.
2. The operator enables the data API on the site with one collection, `docs`.
3. The operator stores the owner API key in a file readable only by the operator account
   (`chmod 600`). The default location is `~/.herenow/credentials`.
4. Record the site slug (the `<slug>` in `https://<slug>.here.now`) as `PM_TABELLONE_SITE`.

## 2. Settings

Each setting is an environment variable, or a key in the pack config file
(`$PM_CONFIG`, default `~/.config/xtrm/project-management.json`). The config key is the
variable name in lower case without `PM_`.

Shared settings this skill reads: `JIRA_SITE` (full base URL), `JIRA_TOKEN_FILE`,
`PM_OPERATOR_EMAIL`, `PM_OPERATOR_ACCOUNT_ID`, `PM_JIRA_PROJECT`, `PM_SB_PREFIX`, `PM_EPIC`,
`PM_REPO_DIR`, `PM_REPO_SLUG`, `PM_REPO_NAME`, `PM_STATE_DIR`, `PM_CUSTOM_FIELDS`.

| Variable / config key | Required | Meaning |
|---|---|---|
| `PM_TABELLONE_SITE` / `tabellone_site` | yes | here.now site slug of the artifact |
| `PM_TABELLONE_SELF_ISSUE` / `tabellone_self_issue` | yes | Substrate issue the sync runs under; its workers doc is `workers/<issue>-tabellone-sync` |
| `PM_TABELLONE_KEY_FILE` / `tabellone_key_file` | no | here.now owner key file (default `~/.herenow/credentials`) |
| `PM_TABELLONE_STATE_DIR` / `tabellone_state_dir` | no | sync state, drift report, answers inbox (default `$PM_STATE_DIR/tabellone`; env `TABELLONE_STATE_DIR` wins) |
| `PM_OPERATOR_HANDLE` / `operator_handle` | no | plain-text mention (`@<handle>`) that counts as asking the operator (default `operator`) |
| `PM_EXTRA_REF_PREFIXES` / `extra_ref_prefixes` | no | JSON list of other issue-key prefixes that may appear in event refs |
| `PM_TABELLONE_OWNER_ADDR` / `tabellone_owner_addr` | no | JSON object: questions owner name -> xt session address that receives routed answers |
| `PM_TABELLONE_FALLBACK_OWNER` / `tabellone_fallback_owner` | no | address for answers with no known owner; also `reportsTo` of the sync's own workers doc |
| `PM_TABELLONE_FILE_ONLY_OWNERS` / `tabellone_file_only_owners` | no | JSON list of addresses that get answers only as inbox lines, never keystrokes |
| `PM_TABELLONE_ANSWER_SEED_AT` / `tabellone_answer_seed_at` | no | route only answers at or after this `YYYY-MM-DDTHH:MMZ` stamp (empty: all) |
| `PM_TABELLONE_STATUS_OVERRIDES` / `tabellone_status_overrides` | no | JSON object: Jira status name -> page status, applied before the category map |
| `PM_CUSTOM_FIELDS` / `custom_fields` | no | `window_start` / `window_end` field ids, used when `/rest/api/3/field` has no "Window start"/"Window end" field |
| `PM_SB_BIN` / `sb_bin` | no | path to `sb` (default: `sb` on `PATH`) |

The Jira project must have two datetime fields named "Window start" and "Window end", and
window Tasks must carry the label `window`. The operator's waiting list uses the label
`op-waiting`.

## 3. Example config fragment

Placeholder values only. Merge into the pack config file:

```json
{
  "jira_project": "PROJ",
  "sb_prefix": "TASK",
  "epic": "TASK-100",
  "repo_name": "example-repo",
  "repo_slug": "example-org/example-repo",
  "repo_dir": "~/projects/example-repo",
  "state_dir": "~/.xtrm/product/example-repo",
  "operator_account_id": "<jira-account-id>",
  "operator_handle": "operator",
  "custom_fields": {"window_start": "customfield_10001", "window_end": "customfield_10002"},
  "tabellone_site": "example-site-1234",
  "tabellone_self_issue": "TASK-101",
  "tabellone_owner_addr": {"main-coord": "example-repo-xt-claude-main-coord"},
  "tabellone_fallback_owner": "example-repo-xt-claude-main-coord",
  "tabellone_file_only_owners": ["example-repo-xt-claude-main-coord"],
  "tabellone_answer_seed_at": "",
  "tabellone_status_overrides": {"Deferred": "blocked", "Won't Do": "blocked"}
}
```

`JIRA_SITE` (for example `https://example.atlassian.net`) and `JIRA_TOKEN_FILE` are set as
described in the shared setup file.

## 4. Run the sync once and verify

1. Run a dry run. It plans every write and sends nothing:

   ```bash
   python3 tabellone-keeper/scripts/tabellone_sync.py --dry
   ```

   Expected result: the JQL lines name your project, `window rows: N`, a workers summary and
   an `ASSERT-COUNT ... result=OK` line. A `pm_config: <NAME> is not set` exit names the
   missing setting.
2. The label writes and the retirement of old docs stay disabled until the file
   `<state dir>/waiting-armed` exists. Create it only after you have read the dry-run output.
3. Run the sync without `--dry`. It writes, reads back, and prints `RESULT OK` (exit 0).
   `ASSERT-FAIL` lines and exit 1 mean a hole in the schedule; fix the Jira data, not the page.
4. Open `https://<site>.here.now` and confirm that the workers and today's schedule show.
5. Install a 5-minute timer that runs the script without `--dry`. Its log is the place the keeper reads.
   With one project, a plain unit `tabellone-sync.timer` will do (`journalctl --user -u tabellone-sync`).
   With several projects, use one template instance per project, so each sync reads its own profile and
   writes its own state:

   ```ini
   # ~/.config/systemd/user/tabellone-sync@.service (plus a matching tabellone-sync@.timer)
   [Service]
   Type=oneshot
   Environment=PM_PROJECT=%i
   ExecStart=/usr/bin/python3 <pack>/tabellone-keeper/scripts/tabellone_sync.py
   ```

   `systemctl --user enable --now tabellone-sync@alpha.timer`; set `tabellone_unit` to
   `tabellone-sync@alpha.service` in that project's profile so the lane's health check reads the right unit.

Tests (no network): `python3 -m unittest tabellone-keeper/scripts/test_tabellone_sync.py`.
