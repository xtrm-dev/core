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

Messages that must reach a person-in-charge (operator comments the board helper forwards, Status board answers,
the lane's alarms) are addressed by role, never by a stored address: a stored address goes stale the day its
session ends. A session has one role, `manager`, `lead`, `board_helper` or `worker`, resolved by one module,
`scripts/pm_role.py`, for every consumer (`route_target.py`, the session hooks, `pm_check.py`):
1. **The role file:** a one-word `.pm-role` in the session's worktree root, an explicit override. Needed only when the
   launch does not say the role: a session launched under the shared `project-manager` role, or one from before the
   role split. Write it with `python3 <pack>/project-management/scripts/pm_session.py init --role <role> --dir <worktree>`
   (`references/launching.md`, "Session kit").
2. **Else the launch role:** the specialist role of `xt claude|pi --role <name>`, which the session sees as
   `XTMUX_AGENT_ROLE` and the agent host reports as the session's `role`. Defaults: `manager` -> manager, `lead` -> lead,
   `board-audit-runner` (or `board-helper`) -> board_helper; the `launch_roles` setting adds or changes entries
   (`{"chief": "manager"}`). A role not listed (`project-manager`, `worker`) says nothing, so a coordinator launched
   under one keeps its name-pattern role.
3. **Else the session name** against the `route_roles` patterns (defaults below).
4. **Else `worker`.**

`<pack>` is the pack directory, for example `~/.xtrm/skills/optional/project-management`. Check a session with
`pm_role.py show [--dir <worktree>] [--name <session name>] [--launch-role <role>]`; it prints the role and its source
(`file`, `launch`, `name`, `default`). `pm_session.py show` prints the same line with the rest of the session kit.

| Role | Default name pattern (fallback) | Live sessions |
|---|---|---|
| `manager` | `*-manager`, optionally `-<n>` (`proj-manager`, `proj-manager-2`) | exactly one, except during a handover |
| `lead` | `*-lead`, optionally `-<n>`; legacy `*-coord` | several, one per epic and area |
| `board_helper` | `*board-helper*` | exactly one |

Without a role file or a mapped launch role, a session whose name matches a pattern takes that role: launch a
worker so named with `--role worker`. While two managers are live (a handover, `references/handover.md`), the one holding the claim on
`manager_issue` (default: the epic) keeps the role until it releases the claim.

`scripts/route_target.py` resolves roles at send time against the live sessions of the xtrm agent host
(`GET /v1/sessions`, info file `agent_host_info`) and keeps those of this project (same `repo_slug`, or cwd inside
`repo_dir`/`match_dirs`):
- `route_target.py manager` (or `board_helper`) prints the one match's address, the name `SendMessage` takes. No
  match or several is an error, never a guess. `route_target.py lead` is an error when several leads are live, which
  is normal: a caller that needs one lead names it.
- `route_target.py --team` prints every live session of the project by role: manager, leads, board helper,
  workers/other. `pm_check.py` prints the same team.
- `route_target.py --all` prints the manager and the board helper, and lists the live leads.

Who gets what:
- The board helper alone decides where an operator comment goes. `board-audit/scripts/lane/route-forward.py` only
  prints a default target, the live `manager`; `--to <name>` sends it to a named live session instead (a lead).
  The old `COORD_SOCK` environment override is removed; `--to` replaces it.
- A Status board answer goes to the live session that owns the question (its `questions/<owner>` doc), else to the
  live `manager` (`status-board-keeper/references/setup.md`).
- The lane's dead-man switch raises `ALARM ROUTE-TARGET manager|board_helper` every pass until exactly one live
  session holds each of those two roles. Leads are not checked.

Change the patterns per project with `route_roles` (for example while sessions launched before the role file still
run: `{"manager": "*day11-coord", "board_helper": "*x8yz"}`), and set them back once the roles are relaunched. A role
file and a mapped launch role always win over the patterns.

### Common goal

Every session of a project serves one common goal beyond its own issue (SKILL.md rule 56). The pack does not hold the
goal's text; it points at where it lives and `pm_session.py show|goal` prints the pointers, which the post-compact hook
repeats for the manager and the leads:
- `goal_doc`: the goal document, relative to `repo_dir` (for example a PRD); its opening paragraph is quoted.
- `epic`: the project's Substrate epic; its SUCCESS is shown with `pm_session.py goal`.
- `jira_epic`: the Jira epic the operator reads.
- `goal_refs`: any further pointers (a roadmap URL, a second document).

Use one of each. When the project has several stale epics, the manager writes one current Substrate epic and one
current Jira epic from the goal document, sets them here, and relates or closes the old ones.

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
| `PM_OPERATOR_NAME` | `operator_name` | operator's Jira display name: the comment author the lane matches, and the plain mention text `jira.py` writes | BA (PM optional, default `operator`) | `Jane Operator` |
| `PM_OPERATOR_HANDLE` | `operator_handle` | the plain-text `@<handle>` in a Jira comment that counts as asking the operator (Status board waiting list), and a name the question hook treats as addressing the operator (default `operator`) | optional (TK, hook) | `jane` |
| `PM_JIRA_PROJECT` | `jira_project` | Jira project key of the board | PM, BA, TK | `PROJ` |
| `PM_JIRA_BOARD_ID` | `jira_board_id` | Jira agile board id (sprints) | doc | `1` |
| `PM_JIRA_LABEL` | `jira_label` | project label on theme Epics | doc, BA | `proj-project` |
| `PM_SB_PREFIX` | `sb_prefix` | Substrate issue prefix of the project | PM, BA, TK | `SB` |
| `PM_SB_PROJECT_ID` | `sb_project_id` | Substrate project id (default `prj_<prefix in lower case>`) | optional | `prj_sb` |
| `PM_EPIC` | `epic` | Substrate ref of the project epic; part of the common goal | BA, hooks, doc | `SB-100` |
| `PM_JIRA_EPIC` | `jira_epic` | Jira key of the project's epic; part of the common goal (board-audit also reads it) | BA, hooks | `PROJ-1` |
| `PM_GOAL_DOC` | `goal_doc` | the common goal's document, relative to `repo_dir` or absolute (for example a PRD) | hooks, doc | `docs/product/PRD.md` |
| `PM_REPO_DIR` | `repo_dir` | local checkout of the delivery repository; its parent holds sibling checkouts | PM, BA | `~/projects/example-repo` |
| `PM_REPO_SLUG` | `repo_slug` | GitHub `owner/repo` of the delivery repository | PM, BA | `example-org/example-repo` |
| `PM_REPO_NAME` | `repo_name` | short repo name (`<name>#<n>`, service-registry path); default: the slug's repo part | BA (PM optional) | `example-repo` |
| `PM_LANE_DIR` | `lane_dir` | board helper lane state (events, cursors, reports, gate script) | BA, doc | `~/.local/state/pm/example/lane` |
| `PM_STATE_DIR` | `state_dir` | coordinator state: handovers, reports, evidence, review worktrees; root of the Status board state, the bot inbox and the operator-question cache (default `~/.xtrm/product/<repo_name>`) | optional (PM, TK) | `~/.local/state/pm/example` |
| `PM_DEPLOY_DIR` | `deploy_dir` | the project's deploy workspace (AgentRun pilot set) | doc | `~/deploy/example` |
| `PM_TIMEZONE` | `timezone` | IANA zone the window fields are written in | BA, TK, doc | `Europe/Paris` |
| `PM_CI_WORKFLOW` | `ci_workflow` | CI workflow file of the delivery repo | BA | `ci.yml` |
| `PM_OPERATOR_QUESTION_TURNS` | `operator_question_turns` | operator-silent turns before the operator-question reminder (default `5`, `0` = hook off). The hook acts only for a session whose cwd is inside `repo_dir`/`match_dirs`, or with `PM_PROJECT` set; addressing names come from `operator_names`/`operator_handle` | hook | `5` |
| `PM_QUESTION_OWNER` | `question_owner` | Status board `questions/<owner>` doc of this session (default: `manager` for the manager, so its successor inherits the doc; else the session name without its `<repo>-xt-<runtime>-` prefix, e.g. `SB-120-api-lead`) | hook, CLI | `SB-120-api-lead` |
| `PM_MANAGER_ISSUE` | `manager_issue` | Substrate issue whose claim holder keeps the manager role while two managers are live; the manager claims it (default: `epic`) | hooks, routing | `SB-100` |
| `PM_CLAIM_TTL_MS` | `claim_ttl_ms` | claim TTL the session hooks use and advise, in ms (default `3600000`) | hooks | `3600000` |
| `PM_PENDING_MAX_AGE_S` | `pending_max_age_s` | pending-message guard: only items younger than this many seconds are shown (default `3600`) | hooks | `3600` |
| `PM_POST_COMPACT_NUDGE_TEXT` | `post_compact_nudge_text` | the prompt the post-compact hook types into the pane when `post_compact_nudge` is true | hooks | `/project-management continue with the goal` |
| `PM_POST_COMPACT_EXTRA` | `post_compact_extra` | path of a private text file appended to the post-compact resume steps: the project's own fleet rules | hooks | `~/.config/xtrm/pm-extra.txt` |
| `PM_CONFIG` | (none) | path of the config file itself | optional | `~/.config/xtrm/project-management.json` |

### Structured (JSON)

| Variable | Config key | Shape | Meaning | Used by |
|---|---|---|---|---|
| `PM_CUSTOM_FIELDS` | `custom_fields` | `{role: "customfield_<n>"}` | per-tenant field ids; roles `window_start`, `window_end`, `start_date`, `entity`, `sprint` | BA, TK, doc |
| `PM_TRANSITIONS` | `transitions` | `{status name: "id"}` | the board's transition ids, from a live read (`jira.md`) | doc, BA |
| `PM_DONE_STATUSES` | `done_statuses` | `[name]` | status names that mean done | PM (TX-07 fallback), BA, TK |
| `PM_ACTIVE_STATUSES` | `active_statuses` | `[name]` | status names that mean being worked | BA, TK |
| `PM_OPEN_STATUSES` | `open_statuses` | `[name]` | every not-done status an open window may hold (hygiene cycle) | BA |
| `PM_ROUTE_ROLES` | `route_roles` | `{role: pattern or [pattern]}` | name fallback for roles when a session has no role file (defaults `manager: *-manager[-<n>]`, `lead: *-lead[-<n>]` and `*-coord[-<n>]`, `board_helper: *board-helper*`); a role named here replaces its default | PM, BA (lane), TK, hooks |
| `PM_REFREAD_FILES` | `refread_files` | `{role: [path]}` | reference files, relative to the pack, a session of that role reads before a gated action (default `manager` and `lead`: `project-management/references/manager.md`, `lead.md`, `launching.md`) | hooks |
| `PM_GATED_COMMANDS` | `gated_commands` | `[regex]` | Bash commands blocked until the references are read and the pending check passes (default: `gh pr merge`, `xt claude` or `xt pi` launches, `sb issue attest`) | hooks |
| `PM_GATED_TOOLS` | `gated_tools` | `[fnmatch]` | tool names gated the same way (default `Agent`, `*specialist_dispatch`) | hooks |
| `PM_POST_COMPACT_NUDGE` | `post_compact_nudge` | bool | the post-compact hook also types `post_compact_nudge_text` into `$TMUX_PANE` (default `false`) | hooks |
| `PM_CHECKPOINT_THRESHOLDS` | `checkpoint_thresholds` | `[fraction]` | context fractions of the EARLY and FINAL checkpoint warnings (default `[0.70, 0.85]`) | hooks |
| `PM_OPERATOR_NAMES` | `operator_names` | `[name]` | every name that identifies the operator: the lane matches comment authors against it (lower case), the question hook treats it as addressing the operator. Default `[operator_name]` | BA (lane), hook |
| `PM_GOAL_REFS` | `goal_refs` | `[text]` | further pointers to the common goal, printed as they are | hooks, doc |
| `PM_LAUNCH_ROLES` | `launch_roles` | `{launch role: role}` | launch role (specialist name) -> pack role, merged over the defaults (`manager`, `lead`, `board-audit-runner`, `board-helper`) | all |
| `PM_MATCH_DIRS` | `match_dirs` | `[path]` | extra directories that belong to the project (project choice, routing) | all |
| `PM_AGENT_HOST_INFO` | `agent_host_info` | path | the agent host's info file (default `~/.xtrm/run/agent-host.json`; env `XTRM_AGENT_HOST_URL` overrides the URL) | PM, BA (lane), TK |
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

How the three operator names relate: `operator_name` is the one Jira display name; `operator_names` widens it to
every name the operator is known by (defaults to `[operator_name]`); `operator_handle` is the short plain-text
`@handle` people type when they ask the operator in a comment. `operator_account_id` is what a real mention
targets.

The other skills add their own keys (for example `waiting_production_status`, `deferred_status`, `parked_statuses`,
`window_keys`, `window_bands`, `bot_inbox`, `answers_inbox`, the `status_board_*` keys); their setup files list them.
`pm_check.py --all-settings` lists every setting the setup files name, set or unset.

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
  "sb_prefix": "SB",
  "sb_project_id": "prj_sb",
  "epic": "SB-100",
  "repo_dir": "~/projects/example-repo",
  "repo_slug": "example-org/example-repo",
  "repo_name": "example-repo",
  "lane_dir": "~/.local/state/pm/example/lane",
  "state_dir": "~/.local/state/pm/example",
  "deploy_dir": "~/deploy/example",
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
  "operator_names": ["Jane Operator", "Jane"],
  "operator_handle": "jane",
  "status_board_site": "example-slug",
  "status_board_self_issue": "SB-101"
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
python3 .../project-management/scripts/pm_check.py --hooks                                          # session hooks in settings.json
```

The check prints the config file it read, each tool, how many pack session hooks are wired, each setting as
`OK (env|config)` or `MISSING ... required by <skill>` (with `--all-settings` also every optional one, `unset` or `OK`),
this session's role and its source (`file`, `name`, `default`), then the team: every live session of the project by
role, the manager and board helper routes, and a `WARN manager claim` when the live manager does not hold the claim on
`manager_issue`. Values are not printed. `pm_check.py --hooks` checks only the session hooks ("8. Session hooks"). Exit 0 means every required setting of the chosen
skills is present and the token file exists. Then make one read:
`python3 .../scripts/jira.py GET /rest/api/3/myself` must print `HTTP 200` and the operator's account id.

`scripts/jira.py` commands (its docstring has the guards):

| Command | Does | Who |
|---|---|---|
| `jira.py GET <path>` | one read | anyone |
| `jira.py POST\|PUT <path> <json-file>` | one write, through the write guards | anyone; comments refused here |
| `jira.py transition <KEY> "<status>"`, `transition-by-id <KEY> <id>` | move a row, re-read to prove it | anyone |
| `jira.py link <BLOCKER> <BLOCKED> [type]` | a Blocks link with the sides named | anyone |
| `post-guard.py <KEY> <text-file> --run <WORD> [--mention-first]` | the one comment write path | the board helper for `@operator` comments |
| `jira.py attach <KEY> <file> --board-helper` | attach one file (multipart `POST /rest/api/3/issue/<KEY>/attachments`, header `X-Atlassian-Token: no-check`, 10 MB cap, credential scan of text files); refused without the flag unless run inside post-guard (`POST_GUARD_ACTIVE=1`), event `AT-01` | the board helper only |

## 7. First read of a new board

Before the first Jira write, build the board profile (`references/jira.md`, "Read the board first") and write what it found into the config:
`transitions`, `done_statuses`, `active_statuses`, `terminal_statuses`, `custom_fields`, `entity_options`, `hygiene_filters`. Journal the profile once as a
`finding` on the project epic.

## 8. Session hooks

The pack ships four Claude Code hooks in `project-management/hooks/`. The operator wires them in `~/.claude/settings.json`
(or `$CLAUDE_CONFIG_DIR/settings.json`); the pack never edits that file. Each hook resolves the session role with
`scripts/pm_role.py` ("Routing roles") and reads its settings through `pm_config.py`.

| Hook | Events | Does |
|---|---|---|
| `post_compact.py` | `SessionStart` (`compact`, `startup`) | prints the role's resume steps, then the text of `post_compact_extra`; types `post_compact_nudge_text` into the pane when `post_compact_nudge` is true |
| `action_gate.py` | `SessionStart`, `PreToolUse` (`Bash\|Agent\|.*specialist_dispatch`), `PostToolUse` (`Read`) | blocks the `gated_commands` and `gated_tools` until the session has read its `refread_files` (reset at start and after compaction), and runs the pending-message guard |
| `checkpoint_warn.py` | `PostToolUse` (`*`), `UserPromptSubmit` | warns at each `checkpoint_thresholds` fraction of the context window and asks for one structured `handoff` entry (`references/continuity.md`) |
| `operator-questions.py` | `UserPromptSubmit`, `Stop` | the operator-question reminder (SKILL.md rule 15) |

The pending-message guard: before a gated action, the items pending for this session (routed operator comments not
yet delivered, open operator questions it owns), younger than `pending_max_age_s`, are shown once in a deny. A retry
with the same set of items passes.

Behaviour outside a project: with no project configured for the session (no config, or the cwd outside every
`repo_dir`/`match_dirs` and no `PM_PROJECT`), every hook is silent. With an ambiguous project (several match and no
`PM_PROJECT`), each hook fails open: the action proceeds and the hook prints one warning that names the projects. A
role with no `refread_files` entry (a worker, by default) is not gated. Pi sessions do not run Claude Code hooks.

Wire them with this block (replace `<pack>` with the pack directory; merge it with the hooks you already have):

```json
{
  "hooks": {
    "SessionStart": [
      {"matcher": "compact", "hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/post_compact.py --mode compact"}]},
      {"matcher": "startup", "hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/post_compact.py --mode startup"}]},
      {"hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/action_gate.py --event start"}]}
    ],
    "PreToolUse": [
      {"matcher": "Bash|Agent|.*specialist_dispatch", "hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/action_gate.py --event pre"}]}
    ],
    "PostToolUse": [
      {"matcher": "Read", "hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/action_gate.py --event post"}]},
      {"matcher": "*", "hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/checkpoint_warn.py"}]}
    ],
    "UserPromptSubmit": [
      {"hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/checkpoint_warn.py"},
                 {"type": "command", "command": "python3 <pack>/project-management/hooks/operator-questions.py --event prompt"}]}
    ],
    "Stop": [
      {"hooks": [{"type": "command", "command": "python3 <pack>/project-management/hooks/operator-questions.py --event stop"}]}
    ]
  }
}
```

Verify with `python3 <pack>/project-management/scripts/pm_check.py --hooks`: one line per hook, `OK` or `MISSING`, and
this block with your real pack path for the missing ones. Hooks load at session start: open `/hooks` once or restart
the session.
