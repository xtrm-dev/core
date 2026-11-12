# Lane scripts setup

The board helper lane (`board-audit/scripts/lane/`) runs read-only checks against one Jira project, one
Substrate project and one GitHub repository, and writes its state into one lane directory. The scripts
hold no instance values. Each value comes from an environment variable or from the pack config file,
through `project-management/scripts/pm_config.py` and the lane wrapper `lane/lanecfg.py`.

Resolution order for every setting:

1. The environment variable (`PM_*` or `JIRA_*`). For a structured setting, the variable holds JSON.
2. The key in the config file `$PM_CONFIG` (default `~/.config/xtrm/project-management.json`). The key
   is the variable name in lower case without `PM_`: `PM_LANE_DIR` -> `lane_dir`.
3. The default in the script, if there is one.

A required setting that is missing stops the script with its name. The shell scripts (`scheduler.sh`,
`cycle-run.sh`) read `PM_LANE_DIR` and `PM_TABELLONE_UNIT` from the environment only.

Jira access (`JIRA_SITE`, `JIRA_TOKEN_FILE`, `PM_OPERATOR_EMAIL`) is configured as described in
`project-management/references/setup.md`.

## Scalar settings

| Variable | Config key | Meaning | Used by |
|---|---|---|---|
| `PM_LANE_DIR` | `lane_dir` | Lane state directory: `events.log`, outbox, cursors, reports. `cycle/` below it holds the cycle state. | all |
| `PM_REPO_DIR` | `repo_dir` | Local checkout of the delivery repository. `gh`, `git` and `make deploy-status` run here. | cycle, deploy-check, wp-audit, heavy-stuck |
| `PM_REPO_SLUG` | `repo_slug` | `<owner>/<repo>` on GitHub. | heavy-stuck |
| `PM_REPO_NAME` | `repo_name` | Short repository name in comment text (`PR-link <name>#<n>`). | cycle, jiratext, wp-audit |
| `PM_JIRA_PROJECT` | `jira_project` | Jira project key. All key regexes are built from it. | most |
| `PM_SB_PREFIX` | `sb_prefix` | Substrate key prefix. | most |
| `PM_SB_PROJECT_ID` | `sb_project_id` | Substrate project id in `state.db`. Default `prj_<prefix in lower case>`. | cycle |
| `PM_SB_BIN` | `sb_bin` | Path of the `sb` CLI. Default: `sb` on `PATH`. | cycle, sbtext, probes, deploy-check |
| `PM_SB_SNAPSHOT` | `sb_snapshot` | JSON of `sb issue list --json` for the whole project; the caller refreshes it. | deep-dup-probe |
| `PM_EPIC` | `epic` | Project epic ref in Substrate (journal read by deploy-check; ignored as a row ref by the drift check). | cycle, deploy-check |
| `PM_CI_WORKFLOW` | `ci_workflow` | Name of the nightly CI workflow. | heavy-stuck |
| `PM_OPERATOR_ACCOUNT_ID` | `operator_account_id` | Operator's Jira account id. | router, cycle |
| `PM_OPERATOR_NAME` | `operator_name` | Operator's Jira display name. | router |
| `PM_JIRA_LABEL` | `jira_label` | Project label; used only to build a default `tabellone_jql`. | cycle |
| `PM_CUTOFF` | `cutoff` | Project cut-off, `YYYY-MM-DD HH:MM` (UTC). Rows and merges before it are ignored. | cycle |
| `PM_TABELLONE_JQL` | `tabellone_jql` | JQL of the Tabellone filter, verbatim. | cycle |
| `PM_PROD_PATH_REGEX` | `prod_path_regex` | Regex of repository paths and service names whose change is a production change (check 8). Default: generic schema/compose markers only. | cycle |
| `PM_EXCEPTIONS_EPIC` | `exceptions_epic` | Jira key whose comments record the no-window exceptions. Unset: no exceptions. | cycle |
| `PM_CONTAINER_PREFIX` | `container_prefix` | Common container-name prefix, stripped when a journal entry is matched. | deploy-check |
| `PM_BOT_INBOX` | `bot_inbox` | JSONL inbox of operator comments that mention the bot. | route-watch |
| `PM_ANSWERS_INBOX` | `answers_inbox` | JSONL inbox of Tabellone answers. | route-watch |
| `PM_LANE_HOLDER` | `lane_holder` | Substrate holder name for writes through post-guard. Default `board-lane`. | post-guard |
| `PM_LANE_WATCHDOG` | `lane_watchdog` | Optional module with `sync(unwatched, detail) -> str`, called by deadman to publish an unwatched lane. Unset: the alarm stays in `events.log`. | deadman |
| `PM_TABELLONE_UNIT` | (env only) | systemd user unit of the Tabellone sync. Default `tabellone-sync.service`. | scheduler.sh |
| `COORD_SOCK` | (env only) | Coordinator reply address printed by route-forward. | route-forward |

## Structured settings (config file)

| Config key | Shape | Used by |
|---|---|---|
| `custom_fields` | `{"window_start", "window_end", "start_date": "customfield_<n>"}` | cycle, due-check, collect-drift-evidence |
| `waiting_production_status`, `active_statuses`, `deferred_status`, `parked_statuses` | str, [str], str, [str] (shared keys, see project-management/references/setup.md) | cycle, drift-groups, wp-audit |
| `hygiene_filters` | `{"open_without_dates" / "overdue" / "next_48h": {"id": saved-filter id, "name": str}}`. The id is also the counts key in the cycle report. | cycle, cycle-run.sh, cycle-digest |
| `operator_names` | `[str]`, lower case. Default: `[operator_name]`. | route-jira |
| `theme_epics` | `[jira-key]` | cycle (re-parent count) |
| `drift_exclude_epics`, `drift_exclude_umbrellas`, `drift_exclude_outside` | `{jira-key: substrate-ref}` | cycle (drift A exclusions) |
| `expected_open` | `{jira-key: reason}` | cycle |
| `pr_bindings` | `{"<pr>": [[jira-key, why]]}` | cycle (check 2b) |
| `no_window_exceptions` | `{"<pr>": [jira-key, why]}` | cycle (check 2b) |
| `cycle_controls` | `{"readonly_control_ref", "lane_control_ref", "deep_probe_control", "deep_probe_control_expect"}` | cycle |
| `r2` | `{"issue", "posts_dir", "state", "watermark", "log_glob", "control": {"posted_batch", "posted_comment", "absent_batch"}}`. Unset: check 6 reports "not configured". | cycle |
| `gate_repos` | `{"<short-name>": "<owner>/<repo>"}` for `gate:<short-name>-<pr>` labels | cycle, wp-audit |
| `container_aliases` | `{container: [lower-case refs or words]}` | deploy-check |
| `deploy_planned_tokens` | `[lower-case refs or words]` that mark a planned stop | deploy-check |
| `container_paths` | ordered `[{"prefixes": [str], "match": regex (optional), "containers": [str]}]`, first match wins | wp-audit |
| `wp_known_binding` | `[jira-key, pr-number]`: a merged PR whose body declares `Jira binding: <key>` | wp-audit (required control) |
| `wp_reference_keys` | `[jira-key]` re-classed and printed each audit | wp-audit |
| `route_control_cases` | `[[jira-key, comment-id, "decision" or "info", why]]`: real operator comments | route-controls |

Example fragment (placeholder values):

```json
{
  "lane_dir": "~/.local/state/board-lane",
  "repo_dir": "~/src/example-service",
  "repo_slug": "example-org/example-service",
  "repo_name": "example-service",
  "jira_project": "PROJ",
  "sb_prefix": "SB",
  "epic": "SB-100",
  "ci_workflow": "Tests",
  "operator_account_id": "000000000000000000000000",
  "operator_name": "Example Operator",
  "cutoff": "2026-01-05 09:00",
  "tabellone_jql": "project = PROJ AND (labels = proj-project OR labels = window) AND statusCategory != Done",
  "custom_fields": {"window_start": "customfield_10001", "window_end": "customfield_10002", "start_date": "customfield_10003"},
  "waiting_production_status": "Waiting Production",
  "active_statuses": ["To Do", "In Progress"],
  "deferred_status": "Deferred",
  "parked_statuses": ["Deferred", "Blocked"],
  "hygiene_filters": {"open_without_dates": {"id": "10100", "name": "PROJ · Open without dates"},
                      "overdue": {"id": "10101", "name": "PROJ · Overdue, not done"},
                      "next_48h": {"id": "10102", "name": "PROJ · Next 48 hours"}},
  "exceptions_epic": "PROJ-1",
  "cycle_controls": {"readonly_control_ref": "SB-200", "lane_control_ref": "SB-201",
                     "deep_probe_control": "SB-202", "deep_probe_control_expect": "PROJ-2"},
  "container_paths": [{"prefixes": ["api/"], "containers": ["svc-api"]},
                      {"prefixes": ["workers/"], "match": "ingest", "containers": ["svc-ingestor"]}],
  "wp_known_binding": ["PROJ-3", 42],
  "route_control_cases": [["PROJ-4", "10001", "decision", "operator question still open"]],
  "bot_inbox": "~/.local/state/xtrm-bot-watch/inbox.jsonl",
  "answers_inbox": "~/.local/state/tabellone/answers-inbox.jsonl",
  "sb_snapshot": "~/.local/state/board-lane/sb-all.json"
}
```

## What each script needs

| Script | Settings beyond Jira access |
|---|---|
| `scheduler.sh` | env `PM_LANE_DIR`; runs the scripts below from its own directory |
| `cycle-run.sh`, `cycle/cycle.py` | `lane_dir`, `repo_dir`, `repo_name`, `jira_project`, `sb_prefix`, `epic`, `operator_account_id`, `cutoff`, `custom_fields`, `active_statuses`, `waiting_production_status`, `deferred_status`, `parked_statuses`, `hygiene_filters`; tables and controls listed above are optional but each unset table disables its exclusion or control |
| `cycle-digest.py` | `lane_dir`, `jira_project`, `hygiene_filters` |
| `deploy-check.py` | `lane_dir`, `repo_dir`, `epic`; optional `container_aliases`, `deploy_planned_tokens`, `container_prefix` |
| `wp-audit.py` | as cycle, plus `container_paths`, `wp_known_binding`; optional `wp_reference_keys`, `gate_repos` |
| `heavy-stuck.py` | `lane_dir`, `repo_dir`, `repo_slug`, `ci_workflow` |
| `due-check.py` | `lane_dir`, `jira_project`, `custom_fields` |
| `route-watch.py` | `lane_dir`, `bot_inbox`, `answers_inbox`, `operator_account_id`, `operator_name` |
| `route-jira.py` | as route-watch, plus `jira_project`; optional `operator_names` |
| `route-backlog.py`, `route-forward.py`, `mark-routed.py`, `mark-sent.py`, `oneshot.py`, `deadman.py` | `lane_dir` (deadman: optional `lane_watchdog`) |
| `route-controls.py` | as route-watch, plus `route_control_cases` |
| `post-guard.py` | `lane_dir`; optional `lane_holder` |
| `dup-probe.py` | `jira_project` |
| `deep-dup-probe.py` | `jira_project`, `sb_prefix`, `sb_snapshot`; optional `sb_bin` |
| `collect-drift-evidence.py` | `sb_prefix`, `custom_fields`; optional `sb_bin` |
| `drift-groups.py` | `lane_dir`, `active_statuses`, `waiting_production_status`, `deferred_status`, `parked_statuses` |
| `r46-apply.py` | Jira access only |
| `sbtext.py` | optional `sb_bin` |

## Running the lane

Start one scheduler and one dead-man switch per lane. Both append to `$PM_LANE_DIR/events.log`, which the
session monitor tails (`tail -n 0 -F "$PM_LANE_DIR/events.log"`, exactly one tail).

```bash
export PM_CONFIG=~/.config/xtrm/project-management.json
export PM_LANE_DIR=~/.local/state/board-lane
LANE_SCRIPTS=<pack>/board-audit/scripts/lane
mkdir -p "$PM_LANE_DIR/cycle"
cd "$PM_LANE_DIR"                      # deadman checks that the scheduler's cwd is the lane dir
nohup "$LANE_SCRIPTS/scheduler.sh" >/dev/null 2>&1 &
nohup python3 "$LANE_SCRIPTS/deadman.py" >/dev/null 2>&1 &
```

As a systemd user service, set the same environment and `WorkingDirectory`:

```ini
[Service]
Environment=PM_CONFIG=%h/.config/xtrm/project-management.json
Environment=PM_LANE_DIR=%h/.local/state/board-lane
WorkingDirectory=%h/.local/state/board-lane
ExecStart=<pack>/board-audit/scripts/lane/scheduler.sh
Restart=on-failure
```

Before arming the router, run `python3 "$LANE_SCRIPTS/route-controls.py"`. It must print
`ROUTE-CONTROLS PASS`. A one-off cycle without Jira writes: `CYCLE_NO_WRITES=1 "$LANE_SCRIPTS/cycle-run.sh"`.
