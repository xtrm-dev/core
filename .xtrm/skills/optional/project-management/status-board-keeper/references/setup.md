# Status board keeper: first-time setup

This file sets up the progress artifact ("Status board") and its sync for one project.
Shared variables (Jira site and token, operator, Substrate prefix, repo, state directory)
are defined in [../../project-management/references/setup.md](../../project-management/references/setup.md).
Set those first.

## What the artifact is

The Status board is one published web page per project. The page reads its data from a small
document store on the same site. The page itself is published once; after that, only the
store changes:

- `workers/<name>`: one doc per live worker (coordinator, xt pane, specialist, subagent).
- `schedule/<YYYY-MM-DD>`: the day's timeline. Jira window Tasks are written by the sync
  (`created_by: "sync-jira"`); handover, incident and report events are written by the keeper.
- `followups/<ref>`, `questions/*`, `answers/*`, `archive/*`: follow-ups, the operator's
  waiting list, operator answers, and archived workers.

`scripts/status_board_sync.py` is the mechanical writer (5-minute timer). The keeper subagent
(`SKILL.md`) is the hourly checker. Neither one republishes the page.

## 1. Create and publish the artifact

1. The operator creates a here.now site and publishes the page (`index.html`). The page must
   contain the coordinator blocks that describe each doc shape; the keeper reads those blocks
   from `/api/v1/publish/<site>/files/index.html`.
2. The operator enables the data API on the site with one collection, `docs`.
3. The operator stores the owner API key in a file readable only by the operator account
   (`chmod 600`). The default location is `~/.herenow/credentials`.
4. Record the site slug (the `<slug>` in `https://<slug>.here.now`) as `PM_STATUS_BOARD_SITE`.

## 2. Settings

Each setting is an environment variable, or a key in the pack config file
(`$PM_CONFIG`, default `~/.config/xtrm/project-management.json`). The config key is the
variable name in lower case without `PM_`.

Shared settings this skill reads: `JIRA_SITE` (full base URL), `JIRA_TOKEN_FILE`,
`PM_OPERATOR_EMAIL`, `PM_OPERATOR_ACCOUNT_ID`, `PM_JIRA_PROJECT`, `PM_SB_PREFIX`, `PM_EPIC`,
`PM_REPO_DIR`, `PM_REPO_SLUG`, `PM_REPO_NAME`, `PM_STATE_DIR`, `PM_CUSTOM_FIELDS`, and for answer routing
`PM_ROUTE_ROLES`, `PM_AGENT_HOST_INFO`, `PM_MATCH_DIRS`.

| Variable / config key | Required | Meaning |
|---|---|---|
| `PM_STATUS_BOARD_SITE` / `status_board_site` | yes | here.now site slug of the artifact |
| `PM_STATUS_BOARD_SELF_ISSUE` / `status_board_self_issue` | yes | Substrate issue the sync runs under; its workers doc is `workers/<issue>-status-board-sync` |
| `PM_STATUS_BOARD_KEY_FILE` / `status_board_key_file` | no | here.now owner key file (default `~/.herenow/credentials`) |
| `PM_STATUS_BOARD_STATE_DIR` / `status_board_state_dir` | no | sync state, drift report, answers inbox (default `$PM_STATE_DIR/status_board`; the unprefixed `STATUS_BOARD_STATE_DIR` is no longer read) |
| `PM_ANSWERS_INBOX` / `answers_inbox` | no | the answers inbox the sync appends to and the lane router reads (default `<status_board_state_dir>/answers-inbox.jsonl`; one path for both ends) |
| `PM_BOT_INBOX` / `bot_inbox` | no | the bot watcher's inbox; the sync reads the bot account id from `config.json` in the same directory (default `$PM_STATE_DIR/xtrm-bot-watch/inbox.jsonl`; replaces the env `XTRM_BOT_WATCH_DIR`) |
| `PM_STATUS_BOARD_UNIT` / `status_board_unit` | no | systemd user unit of this sync; the lane scheduler checks its health (default `status-board-sync.service`) |
| `PM_OPERATOR_HANDLE` / `operator_handle` | no | plain-text mention (`@<handle>`) that counts as asking the operator (default `operator`; how it relates to `operator_name` and `operator_names`: project-management/references/setup.md) |
| `PM_EXTRA_REF_PREFIXES` / `extra_ref_prefixes` | no | JSON list of other issue-key prefixes that may appear in event refs |
| `PM_STATUS_BOARD_FILE_ONLY` / `status_board_file_only` | no | JSON list of roles (`manager`, `lead`, `board_helper`) or session names whose answers are delivered as inbox lines only, never keystrokes |
| `PM_STATUS_BOARD_ANSWER_SEED_AT` / `status_board_answer_seed_at` | no | route only answers at or after this `YYYY-MM-DDTHH:MMZ` stamp (empty: all) |
| `PM_STATUS_BOARD_STATUS_OVERRIDES` / `status_board_status_overrides` | no | JSON object: Jira status name -> page status, applied before the category map |
| `PM_CUSTOM_FIELDS` / `custom_fields` | no | `window_start` / `window_end` field ids, used when `/rest/api/3/field` has no "Window start"/"Window end" field |
| `PM_SB_BIN` / `sb_bin` | no | path to `sb` (default: `sb` on `PATH`) |

Answer routing needs no address table. An answer goes to the live session that owns the question (the
`questions/<owner>` doc: a lead's session name, or `manager`), else to the one live `manager`; both are resolved at
delivery time from the xtrm agent host (project-management/references/setup.md, "Routing roles"). With no live
target the inbox line records `FAILED-no-route` and the lane router still reads it. The sync's own workers doc
reports to the live manager.

The Jira project must have two datetime fields named "Window start" and "Window end", and
window Tasks must carry the label `window`. The operator's waiting list uses the label
`op-waiting`.

## 3. Example config fragment

Placeholder values only. Merge into the pack config file:

```json
{
  "jira_project": "PROJ",
  "sb_prefix": "SB",
  "epic": "SB-100",
  "repo_name": "example-repo",
  "repo_slug": "example-org/example-repo",
  "repo_dir": "~/projects/example-repo",
  "state_dir": "~/.local/state/pm/example",
  "operator_account_id": "<jira-account-id>",
  "operator_handle": "jane",
  "custom_fields": {"window_start": "customfield_10001", "window_end": "customfield_10002"},
  "status_board_site": "example-site-1234",
  "status_board_self_issue": "SB-101",
  "status_board_file_only": ["manager"],
  "status_board_unit": "status-board-sync.service",
  "status_board_answer_seed_at": "",
  "status_board_status_overrides": {"Deferred": "blocked", "Won't Do": "blocked"}
}
```

`JIRA_SITE` (for example `https://example.atlassian.net`) and `JIRA_TOKEN_FILE` are set as
described in the shared setup file.

## 4. Run the sync once and verify

1. Run a dry run. It plans every write and sends nothing:

   ```bash
   python3 status-board-keeper/scripts/status_board_sync.py --dry
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
   With one project, a plain unit `status-board-sync.timer` will do (`journalctl --user -u status-board-sync`).
   With several projects, use one template instance per project, so each sync reads its own profile and
   writes its own state:

   ```ini
   # ~/.config/systemd/user/status-board-sync@.service (plus a matching status-board-sync@.timer)
   [Service]
   Type=oneshot
   Environment=PM_PROJECT=%i
   ExecStart=/usr/bin/python3 <pack>/status-board-keeper/scripts/status_board_sync.py
   ```

   `systemctl --user enable --now status-board-sync@alpha.timer`; set `status_board_unit` to
   `status-board-sync@alpha.service` in that project's profile so the lane's health check reads the right unit.

Tests (no network): `python3 -m unittest status-board-keeper/scripts/test_status_board_sync.py`.
