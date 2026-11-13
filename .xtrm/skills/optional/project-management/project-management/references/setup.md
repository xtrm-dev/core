# Setup: the project-management pack

This is the canonical setup reference for the whole pack (`project-management`, `board-audit`, `status-board-keeper`). The pack holds no instance
data. Every value that names a Jira tenant, a project, a repository, a person or a host path is a **setting**. Do this setup once per project host,
then run `scripts/pm_check.py`.

Skill-specific details extend this file:
- `board-audit/references/setup.md` (board audit and sequencing) and `board-audit/references/setup-lane.md` (the board helper lane scripts).
- `status-board-keeper/references/setup.md` (the progress artifact and its sync).

## 1. What the pack needs

| Need | Used for | Check |
|---|---|---|
| `sb` (Substrate CLI) | contracts, journal, claims; `state.db` read by `post-guard.py` | `sb --help` |
| `xt` (xtrm CLI) | worker launch, worktrees, `xt jira setup` (agent identity) | `xt --help` |
| `gh` (GitHub CLI), logged in | PRs, merges, `window-lineage.py` | `gh auth status` |
| `tmux` | coordinator and worker windows | `tmux -V` |
| `python3` 3.10 or later | every script in the pack | `python3 --version` |
| Jira Cloud API token of the operator | `scripts/jira.py` (all Jira reads and writes) | `pm_check.py` checks the file |
| Optional: agent identity `~/.xtrm/identities/atlassian-agent/identity.json` | agent processes write as a bot account | `xt jira doctor` |

## 2. How a setting is read

`scripts/pm_config.py` resolves each setting in this order:
1. the environment variable (the name in the table below);
2. the JSON config file `$PM_CONFIG` (default `~/.config/xtrm/project-management.json`, or `$XDG_CONFIG_HOME/xtrm/project-management.json`).
   The key is the variable name in lower case without the `PM_` prefix: `PM_LANE_DIR` -> `lane_dir`, `JIRA_SITE` -> `jira_site`;
3. the default the script passes, when it has one.

A structured setting (list or object) is JSON: in the config file as a JSON value, in the environment as a JSON string. A required setting that is
missing stops the script with its name and a pointer to this file.

### Several projects

One operator can run several projects with the pack at once. Put them in one config file as profiles; a project's
keys override `defaults`, and values that do not differ (your identity, the token file, the Jira site) sit in
`defaults` once:

```json
{
  "defaults": {"jira_site": "https://example.atlassian.net", "operator_email": "you@example.com",
               "jira_token_file": "~/.secrets/atlassian-api-token.txt"},
  "projects": {
    "alpha": {"jira_project": "ALPHA", "sb_prefix": "AL", "repo_dir": "~/projects/alpha",
              "lane_dir": "~/.local/state/pm/alpha/lane", "state_dir": "~/.local/state/pm/alpha"},
    "beta":  {"jira_project": "BETA", "sb_prefix": "BE", "repo_dir": "~/projects/beta",
              "lane_dir": "~/.local/state/pm/beta/lane", "state_dir": "~/.local/state/pm/beta",
              "jira_site": "https://other.atlassian.net"}
  }
}
```

A script picks its project in this order, and never guesses:
1. `PM_PROJECT=<name>` in its environment;
2. the current directory inside a project's `repo_dir` (or one of its `match_dirs`); the deepest match wins, so a
   worker in a worktree under the repo gets that project with nothing set;
3. the only project in the file;
4. otherwise it stops and names the projects. A wrong guess would write to another project's board.

Rules:
- Every coordinator launch, timer, cron line and lane scheduler sets `PM_PROJECT` explicitly. Do not rely on the
  directory for anything that runs outside the repo (the lane runs in its lane dir).
- Each project has its own `lane_dir`, `state_dir`, `status_board_state_dir` and `status_board_site`. `pm_check.py`
  reports a `CLASH` when two projects share one: their runs would overwrite each other.
- Check all of them with `python3 scripts/pm_check.py --project all`; one with `--project <name>`.
- Shell scripts read a setting with `python3 scripts/pm_config.py get NAME [DEFAULT]`, and the chosen project with
  `python3 scripts/pm_config.py project`.
- A flat config (no `projects` key) is one project and needs no `PM_PROJECT`; turn it into a profile when you add
  the second project.

### Routing roles

Messages that must reach a person-in-charge (the board helper forwarding operator comments to the lead coordinator,
the lane's alarms) are addressed by role, never by a stored address: a stored address goes stale the day its
session ends. The role is in the session name, set once at launch:

| Role | Default pattern | Launch it as |
|---|---|---|
| `lead` | `*-lead-coord` | `xt claude <day>-lead-coord` (for example `thu13-lead-coord`); the next day's lead takes the next name |
| `board_helper` | `*board-helper*` | `xt pi board-helper` (or `<project>-board-helper`) |

`scripts/route_target.py <role>` resolves a role at send time against the live sessions of the xtrm agent host
(`GET /v1/sessions`), keeps those of this project (same `repo_slug`, or cwd inside `repo_dir`/`match_dirs`), and
prints the one match's address, the name `SendMessage` takes. No match or several is an error, never a guess;
the lane's dead-man switch raises `ALARM ROUTE-TARGET` every pass until exactly one session holds each role.
`python3 scripts/route_target.py --all` and `pm_check.py` print the current routes.

Change the patterns per project with `route_roles` (for example while sessions launched before this convention
still run: `{"lead": "*wed11-coord", "board_helper": "*r8ux"}`), and set them back once the roles are relaunched.
`COORD_SOCK` in the environment still overrides the lead's address by hand.

## 3. Settings

Required by: **PM** = project-management scripts (`jira.py`, `post-guard.py`, `window-lineage.py`), **BA** = board-audit, **TK** =
status-board-keeper. "doc" = named in the doctrine text only (an agent reads it; no script needs it).

### Scalars

| Variable | Config key | Meaning | Required by | Example (placeholder) |
|---|---|---|---|---|
| `JIRA_SITE` | `jira_site` | Jira base URL, no trailing slash | PM, BA, TK | `https://example-tenant.atlassian.net` |
| `JIRA_TOKEN_FILE` | `jira_token_file` | path to the file holding the operator's Atlassian API token | PM, BA, TK | `~/.secrets/atlassian-api-token.txt` |
| `PM_OPERATOR_EMAIL` | `operator_email` | operator's Atlassian account email (the token's account) | PM, BA | `operator@example.com` |
| `PM_OPERATOR_ACCOUNT_ID` | `operator_account_id` | operator's Atlassian account id; target of every `@operator` mention | PM, BA | `000000000000000000000001` |
| `PM_OPERATOR_NAME` | `operator_name` | operator's Jira display name (mention text, comment author match) | BA (PM optional, default `operator`) | `Jane Operator` |
| `PM_JIRA_PROJECT` | `jira_project` | Jira project key of the board | PM, BA, TK | `PROJ` |
| `PM_JIRA_BOARD_ID` | `jira_board_id` | Jira agile board id (sprints) | doc | `1` |
| `PM_JIRA_LABEL` | `jira_label` | project label on theme Epics | doc, BA | `proj-project` |
| `PM_SB_PREFIX` | `sb_prefix` | Substrate issue prefix of the project | PM, BA, TK | `PRJ` |
| `PM_SB_PROJECT_ID` | `sb_project_id` | Substrate project id (default `prj_<prefix in lower case>`) | optional | `prj_prj` |
| `PM_EPIC` | `epic` | Substrate ref of the project epic | BA, doc | `PRJ-100` |
| `PM_REPO_DIR` | `repo_dir` | local checkout of the delivery repository; its parent holds sibling checkouts | PM, BA | `~/projects/example/app` |
| `PM_REPO_SLUG` | `repo_slug` | GitHub `owner/repo` of the delivery repository | PM, BA | `example-org/app` |
| `PM_REPO_NAME` | `repo_name` | short repo name (`<name>#<n>`, service-registry path); default: the slug's repo part | BA (PM optional) | `app` |
| `PM_LANE_DIR` | `lane_dir` | board helper lane state (events, cursors, reports, gate script) | BA, doc | `~/.cache/proj-board` |
| `PM_STATE_DIR` | `state_dir` | coordinator state: handovers, reports, evidence, review worktrees | TK default, doc | `~/.cache/proj-coord` |
| `PM_DEPLOY_DIR` | `deploy_dir` | the project's deploy workspace (AgentRun pilot set) | doc | `~/deploy/proj` |
| `PM_TIMEZONE` | `timezone` | IANA zone the window fields are written in | BA, TK, doc | `Europe/Paris` |
| `PM_CI_WORKFLOW` | `ci_workflow` | CI workflow file of the delivery repo | BA | `ci.yml` |
| `PM_OPERATOR_QUESTION_TURNS` | `operator_question_turns` | operator-silent turns before the operator-question reminder (default `5`, `0` = hook off). The hook acts only for a session whose cwd is inside `repo_dir`/`match_dirs`, or with `PM_PROJECT` set; addressing names come from `operator_names`/`operator_handle` | hook | `5` |
| `PM_COORDINATOR_PATTERN` | `coordinator_pattern` | regex a coordinator's session name matches (default `-coord(-[0-9]{1,2})?$`) | hook | `-coord(-[0-9]{1,2})?$` |
| `PM_QUESTION_OWNER` | `question_owner` | Status board `questions/<owner>` doc of this session (default: from the session name and `status_board_owner_addr`) | hook, CLI | `proj-coord` |
| `PM_CONFIG` | (none) | path of the config file itself | optional | `~/.config/xtrm/project-management.json` |

### Structured (JSON)

| Variable | Config key | Shape | Meaning | Used by |
|---|---|---|---|---|
| `PM_CUSTOM_FIELDS` | `custom_fields` | `{role: "customfield_<n>"}` | per-tenant field ids; roles `window_start`, `window_end`, `start_date`, `entity`, `sprint` | BA, TK, doc |
| `PM_TRANSITIONS` | `transitions` | `{status name: "id"}` | the board's transition ids, from a live read (`jira.md`) | doc, BA |
| `PM_DONE_STATUSES` | `done_statuses` | `[name]` | status names that mean done | PM (TX-07 fallback), BA, TK |
| `PM_ACTIVE_STATUSES` | `active_statuses` | `[name]` | status names that mean being worked | BA, TK |
| `PM_OPEN_STATUSES` | `open_statuses` | `[name]` | every not-done status an open window may hold (hygiene cycle) | BA |
| `PM_ROUTE_ROLES` | `route_roles` | `{role: pattern}` | session-name patterns for routing roles (defaults `lead: *-lead-coord`, `board_helper: *board-helper*`) | PM, BA (lane) |
| `PM_MATCH_DIRS` | `match_dirs` | `[path]` | extra directories that belong to the project (project choice, routing) | all |
| `PM_AGENT_HOST_INFO` | `agent_host_info` | path | the agent host's info file (default `~/.xtrm/run/agent-host.json`) | PM, BA (lane) |
| `PM_WAITING_PRODUCTION_STATUS` | `waiting_production_status` | name | status for merged, not yet in production | BA (lane) |
| `PM_OPERATOR_INJECTED_PATTERNS` | `operator_injected_patterns` | `[regex]` | extra prompts that are not the operator (your cron prompt prefix); built-in: cross-session, task-notification, delivery notice, system notification, Stop-hook feedback, goal check-ins, `[cron` | hook |
| `PM_OPERATOR_QUESTION_REFS` | `operator_question_refs` | `[ref]` | Substrate refs whose `for=operator` blockers the hook watches (default `[epic]`) | hook |
| `PM_DEFERRED_STATUS` | `deferred_status` | name | status for deferred rows | BA (lane) |
| `PM_PARKED_STATUSES` | `parked_statuses` | `[name]` | statuses the cycle excludes as parked | BA (lane) |
| `PM_TERMINAL_STATUSES` | `terminal_statuses` | `[name]` | status names that end a row (done, won't do, cancelled) | BA, TK |
| `PM_PRODUCTION_STATUSES` | `production_statuses` | `[name]` | statuses that claim the change runs in production (TX-07); default `done_statuses` + `Waiting Production` | PM |
| `PM_ENTITY_OPTIONS` | `entity_options` | `{option name: "id"}` | option ids of the Entity select field | doc, BA |
| `PM_HYGIENE_FILTERS` | `hygiene_filters` | `{role: {"id", "name"}}` | saved Jira filters the board helper runs (roles `open_without_dates`, `overdue`, `next_48h`) | doc, BA (lane) |
| `PM_KNOWN_REPOS` | `known_repos` | `[repo name]` | repos a `<repo>#<n>` in a comment may link (added to the sibling checkouts of `PM_REPO_DIR`) | PM |

The other skills add their own keys (for example `waiting_production_status`, `deferred_status`, `parked_statuses`, `operator_names`, `window_keys`, `halt_band_utc`, the `status_board_*` keys); their
setup files list them.

## 4. The config file

Location: `~/.config/xtrm/project-management.json` (override with `PM_CONFIG`). Keep it outside every repository. It holds **no secret**: the
token stays in its own file, named by `jira_token_file`.

Example with placeholder values (every key used by the three skills; replace each value):

```json
{
  "jira_site": "https://example-tenant.atlassian.net",
  "jira_token_file": "~/.secrets/atlassian-api-token.txt",
  "operator_email": "operator@example.com",
  "operator_account_id": "000000000000000000000001",
  "operator_name": "Jane Operator",
  "jira_project": "PROJ",
  "jira_board_id": "1",
  "jira_label": "proj-project",
  "sb_prefix": "PRJ",
  "sb_project_id": "prj_prj",
  "epic": "PRJ-100",
  "repo_dir": "~/projects/example/app",
  "repo_slug": "example-org/app",
  "repo_name": "app",
  "lane_dir": "~/.cache/proj-board",
  "state_dir": "~/.cache/proj-coord",
  "deploy_dir": "~/deploy/proj",
  "timezone": "Europe/Paris",
  "ci_workflow": "ci.yml",

  "custom_fields": {
    "window_start": "customfield_10100",
    "window_end": "customfield_10101",
    "entity": "customfield_10102",
    "start_date": "customfield_10015",
    "sprint": "customfield_10020"
  },
  "transitions": {
    "To Do": "11", "Ready": "44", "In Progress": "21", "In Review": "31", "Waiting Production": "43",
    "Blocked": "101", "Deferred": "41", "Done": "45", "Done with Follow-up": "42", "Won't Do": "111"
  },
  "done_statuses": ["Done", "Done with Follow-up"],
  "active_statuses": ["In Progress", "In Review"],
  "open_statuses": ["To Do", "In Progress", "In Review", "Waiting Production"],
  "terminal_statuses": ["Done", "Done with Follow-up", "Won't Do"],
  "production_statuses": ["Done", "Waiting Production"],
  "entity_options": {"Coordinator": "10020"},
  "hygiene_filters": {"open_without_dates": {"id": "10001", "name": "PROJ · Open without dates"},
                      "overdue": {"id": "10002", "name": "PROJ · Overdue, not done"},
                      "next_48h": {"id": "10003", "name": "PROJ · Next 48 hours"}},
  "known_repos": ["infra", "docs"],

  "_extensions": "--- keys below are owned by board-audit/references/setup.md, setup-lane.md and status-board-keeper/references/setup.md ---",
  "waiting_production_status": "Waiting Production",
  "deferred_status": "Deferred",
  "parked_statuses": ["Deferred"],
  "operator_names": ["Jane Operator"],
  "status_board_site": "example-slug",
  "status_board_self_issue": "PRJ-101"
}
```

<!-- EXTENSION POINT: board-audit and status-board-keeper setup files may document further keys here or in their own file. Keep this example
     in step with them: one key, one meaning, one owner. -->

## 5. Secrets

- The Jira API token lives in one file outside every repository (for example `~/.secrets/atlassian-api-token.txt`), mode `600`, owned by the
  operator account. `JIRA_TOKEN_FILE` names it; the config file never contains the token.
- The here.now owner key of the Status board follows the same rule (`status-board-keeper/references/setup.md`).
- `jira.py` reads the token on first use and never prints it; its SC-03 guard refuses a write whose body looks like a credential.
- An agent identity (`xt jira setup`) keeps its own token file; explicit `JIRA_EMAIL` / `JIRA_TOKEN_FILE` in the environment win over both
  identities.

## 6. Verify

```
python3 ~/.xtrm/skills/optional/project-management/project-management/scripts/pm_check.py            # all three skills
python3 .../project-management/scripts/pm_check.py --skill board-audit                              # one skill
python3 .../project-management/scripts/pm_check.py --all-settings                                   # optional settings too
```

The check prints the config file it read, each tool, and each setting as `OK (env|config)` or `MISSING ... required by <skill>`; values are not
printed. Exit 0 means every required setting of the chosen skills is present and the token file exists. Then make one read:
`python3 .../scripts/jira.py GET /rest/api/3/myself` must print `HTTP 200` and the operator's account id.

## 7. First read of a new board

Before the first Jira write, build the board profile (`references/jira.md`, "Read the board first") and write what it found into the config:
`transitions`, `done_statuses`, `active_statuses`, `terminal_statuses`, `custom_fields`, `entity_options`, `hygiene_filters`. Journal the profile once as a
`finding` on the project epic.
