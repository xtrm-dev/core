# Setting up board-audit from zero

board-audit holds no instance values. Every Jira site, project key, repository, path and status name
is a setting. The shared settings (names, lookup order, config file location) are defined in
[`../../project-management/references/setup.md`](../../project-management/references/setup.md); this
file lists what board-audit needs on top of them. The lane scripts (`scripts/lane/`) have their own
page: [`setup-lane.md`](setup-lane.md).

Lookup order for every setting (`project-management/scripts/pm_config.py`):

1. the environment variable (`PM_*`, `JIRA_*`);
2. the JSON config file at `$PM_CONFIG` (default `~/.config/xtrm/project-management.json`), keyed by
   the variable name in lower case without the `PM_` prefix (`PM_JIRA_PROJECT` -> `jira_project`,
   `JIRA_SITE` -> `jira_site`);
3. the script's default, where it has one.

A structured setting (list or object) given as an environment variable holds JSON. A required setting
that is missing stops the script with its name.

## 1. Prerequisites

| Tool | Used by | Check |
|---|---|---|
| Python 3.11+ | every script | `python3 --version` |
| Node.js and `@parcha/agentrun-pi` | `run-audit.sh`, `run-readiness.sh` (the judged runs) | `ls "$(npm root -g)/@parcha/agentrun-pi/dist/cli.js"`; export `AGENTRUN_PI_ROOT` to that root |
| pi model registry | the AgentRun runner config (`scripts/agentrun-config-stock.mjs`) | `~/.pi/agent/models.json` or `PI_MODELS_PATH`; the model in `PM_AUDIT_MODEL` must exist in it |
| Jira API token | every Jira read | a file that holds the token; its path in `JIRA_TOKEN_FILE` |
| `gh`, authenticated | PR reads (facts, readiness, cycle drift) | `gh auth status`; read access to `PM_REPO_SLUG` |
| `git` checkout of the project repository | ancestry and path facts | `PM_REPO_DIR`, with `origin/master` and `origin/stable` |
| `sb` (Substrate CLI) and `sqlite3` | Substrate refs, journal, contract creation dates | `sb issue ready`; `~/.xtrm/state.db` readable |

## 2. Settings per script family

| Family | Scripts | Required | Optional |
|---|---|---|---|
| Audit | `scripts/run-audit.sh`, `scripts/facts.py`, `scripts/aggregate.py` | `AGENTRUN_PI_ROOT`, `JIRA_SITE`, `PM_OPERATOR_EMAIL`, `PM_JIRA_PROJECT`, `PM_SB_PREFIX`, `PM_REPO_SLUG`, `custom_fields`, `terminal_statuses` | `JIRA_TOKEN_FILE` (default `~/.secrets/atlassian-api-token.txt`), `PM_REPO_DIR` (default: current directory, or `--repo`), `PM_STATE_DIR` (default `~/.local/state`; receipts in `<state>/board-audit`), `PM_AUDIT_MODEL`, `blocked_statuses` (default `["Blocked"]`), `window_keys`, `plan_predecessors`, `day_predecessors`, `halt_band_utc`, `stale_pr_control` |
| Readiness | `scripts/readiness/run-readiness.sh`, `readiness_facts.py`, `aggregate_readiness.py` | `AGENTRUN_PI_ROOT`, `READINESS_OUT`, the Jira settings of `project-management/scripts/jira.py`, `PM_JIRA_PROJECT`, `PM_JIRA_EPIC`, `PM_SB_PREFIX`, `PM_SB_PROJECT_ID`, `PM_REPO_SLUG`, `PM_REPO_NAME`, `PM_PR_SINCE`, `custom_fields`, `terminal_statuses` | `READINESS_METHOD2`, `readiness_extra_epics`, `other_repos`, `readiness_controls` (without it the selftest proves nothing and says SKIP) |
| Cycle | `scripts/cycle/hygiene_cycle.py` | the Jira settings of `jira.py`, `PM_JIRA_PROJECT`, `PM_EPIC`, `PM_REPO_SLUG`, `PM_LANE_DIR` (writes `CYCLE-HYGIENE.json` there), `custom_fields`, `done_statuses`, `open_statuses` | none. `--check-names` needs no setting |
| Lane | `scripts/lane/*` | see [`setup-lane.md`](setup-lane.md) | |

Run `readiness_facts.py` and `run-readiness.sh` from inside the `PM_REPO_DIR` checkout: the git facts
are read from the current directory.

## 3. Keys

| Key (env name) | Meaning |
|---|---|
| `jira_site` (`JIRA_SITE`) | `https://<tenant>.atlassian.net`; Jira links are `$JIRA_SITE/browse/<KEY>` |
| `operator_email` (`PM_OPERATOR_EMAIL`) | the Jira account the token belongs to |
| `jira_project` (`PM_JIRA_PROJECT`) | the Jira project key of the board |
| `jira_epic` (`PM_JIRA_EPIC`) | the Jira root epic whose linked epics are the project themes (readiness) |
| `jira_label` (`PM_JIRA_LABEL`) | the label that marks project rows (prose rules only) |
| `sb_prefix` (`PM_SB_PREFIX`) | the Substrate ref prefix, as in `<PREFIX>-123` |
| `sb_project_id` (`PM_SB_PROJECT_ID`) | the Substrate project id (`sb export project --project ...`) |
| `epic` (`PM_EPIC`) | the Substrate project root issue; its journal timeline is the drift source |
| `repo_slug` / `repo_name` / `repo_dir` | GitHub `owner/name`, the short name used in `PR-link <name>#<n>` comments, the local checkout |
| `state_dir` (`PM_STATE_DIR`) | the root for run receipts, outside every repository |
| `lane_dir` (`PM_LANE_DIR`) | this lane's scratch directory (cursors, cycle reports) |
| `timezone` (`PM_TIMEZONE`) | the time zone Jira renders slot times in |
| `pr_since` (`PM_PR_SINCE`) | the earliest PR creation date the readiness snapshot lists (`YYYY-MM-DD`) |
| `audit_model` (`PM_AUDIT_MODEL`) | `provider/model` of the AgentRun judge (env only; read by the `.mjs` runner) |
| `custom_fields` | `{"start_date", "window_start", "window_end"}`: Jira custom field ids |
| `terminal_statuses` | statuses that close a window (facts S0, readiness `not_applicable`), in rubric order |
| `blocked_statuses` | statuses that mean Blocked (facts S5) |
| `done_statuses`, `open_statuses` | drift verdicts in the cycle: a closure needs a done status, a merged PR a done or active one |
| `o1w_pinned_control` (`PM_O1W_PINNED_CONTROL`) | optional Jira key the hygiene cycle pins as the O1w positive control; a PASS then proves the query, auth and field mapping |
| `window_keys` | the pinned sample rows `run-audit.sh` reads when no day is given |
| `plan_predecessors`, `day_predecessors` | declared window order: `{key: [keys]}` and `{"YYYY-MM-DD": {key: [keys]}}` |
| `halt_band_utc` | `["HH:MM", "HH:MM"]`: the only band an ingestor window may use (default `21:17`-`21:55`) |
| `stale_pr_control` | a PR number merged 7 or more days ago; the selftest checks it is classed stale |
| `readiness_extra_epics` | epics read by the readiness snapshot besides the ones linked from `jira_epic` |
| `other_repos` | sibling repository names a ticket can point to (readiness R3) |
| `readiness_controls` | live controls for `readiness_facts.py selftest`; shape in the script's `selftest` |
| `hygiene_filters` | `{name: filter id}` of the board's saved hygiene filters (prose only) |

## 4. Example config

Placeholder values. Replace each one; do not commit the result.

```json
{
  "jira_site": "https://example.atlassian.net",
  "jira_token_file": "~/.secrets/atlassian-api-token.txt",
  "operator_email": "operator@example.com",
  "jira_project": "PROJ",
  "jira_epic": "PROJ-1",
  "jira_label": "proj-project",
  "sb_prefix": "PRJ",
  "sb_project_id": "prj_example",
  "epic": "PRJ-100",
  "repo_slug": "example-org/example-repo",
  "repo_name": "example-repo",
  "repo_dir": "~/src/example-repo",
  "state_dir": "~/.local/state",
  "lane_dir": "~/.local/state/lanes/PRJ-200",
  "timezone": "Europe/Paris",
  "pr_since": "2026-01-01",
  "custom_fields": {"start_date": "customfield_10015", "window_start": "customfield_10100",
                    "window_end": "customfield_10101"},
  "terminal_statuses": ["Done", "Won't Do", "Cancelled", "Closed"],
  "blocked_statuses": ["Blocked"],
  "done_statuses": ["Done", "Won't Do", "Cancelled"],
  "open_statuses": ["To Do", "In Progress", "Waiting Production", "In Review"],
  "window_keys": ["PROJ-10", "PROJ-11"],
  "plan_predecessors": {"PROJ-11": ["PROJ-10"]},
  "day_predecessors": {"2026-01-15": {"PROJ-11": ["PROJ-10"]}},
  "other_repos": ["infra"],
  "readiness_extra_epics": [],
  "readiness_controls": [
    {"name": "positive: PROJ-20 ties #123 merged on master", "key": "PROJ-20", "pr_on_master": 123},
    {"name": "negative: PROJ-21 is not BUILT", "key": "PROJ-21", "oracle_not": "BUILT"}
  ]
}
```

A `JIRA_*` name keeps its prefix in the file: `JIRA_TOKEN_FILE` -> `jira_token_file`.

## 5. First run

1. Run `python3 scripts/check.py`. It must print `LITERAL GUARD: PASS` and `SELFTEST: PASS`.
2. Run `python3 scripts/facts.py --day <YYYY-MM-DD> --out /tmp/input.json`. A missing setting stops it
   with the setting's name.
3. Run `scripts/run-audit.sh 3 <YYYY-MM-DD>`. The receipts path is printed at the end.
4. Run `python3 scripts/cycle/hygiene_cycle.py --check-names`, then without the flag. Exit 3 means a
   control failed; the numbers are then not measurements.
