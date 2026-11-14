#!/usr/bin/env python3
"""Check the project-management pack setup: tools on PATH, settings, token file.

Usage: pm_check.py [--skill project-management|board-audit|status-board-keeper|all] [--project NAME|all] [--all-settings]
       pm_check.py --hooks

Prints one line per setting the chosen skill(s) read: OK (with its source, env or config) or MISSING; with
--all-settings also every optional setting the setup docs name. Then this session's role (pm_role: role file, launch role, name,
or default) and the team: every live session of the project by role (manager, leads, board helper, workers/other),
with a warning when the live manager does not hold the claim on manager_issue. Values are not printed, so the output
is safe to paste. Exit 0 when every required setting is present, 1 otherwise.

--hooks reads ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json), reports each pack session hook as wired
or MISSING, and prints the settings.json snippet for the missing ones. It never edits the file. Exit 0 when all are
wired, 1 otherwise.
The settings and the config file are described in project-management/references/setup.md; a skill that adds a
setting adds its row to SETTINGS below and to its own setup reference.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import shutil
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402
import pm_role  # noqa: E402
import route_target  # noqa: E402

PM, BA, TK = "project-management", "board-audit", "status-board-keeper"
SKILLS = (PM, BA, TK)

# (name, structured, required_by, optional_for, meaning)
SETTINGS = [
    ("JIRA_SITE", False, (PM, BA, TK), (), "Jira base URL"),
    ("JIRA_TOKEN_FILE", False, (PM, BA, TK), (), "path to the operator's Atlassian API token file"),
    ("PM_OPERATOR_EMAIL", False, (PM, BA), (TK,), "operator Atlassian account email"),
    ("PM_OPERATOR_ACCOUNT_ID", False, (PM, BA), (TK,), "operator Atlassian account id (mentions)"),
    ("PM_OPERATOR_NAME", False, (BA,), (PM,), "operator display name in Jira"),
    ("PM_JIRA_PROJECT", False, (PM, BA, TK), (), "Jira project key"),
    ("PM_SB_PREFIX", False, (PM, BA, TK), (), "Substrate issue prefix"),
    ("PM_EPIC", False, (BA,), (PM, TK), "Substrate project epic ref"),
    ("PM_REPO_DIR", False, (PM, BA), (TK,), "local checkout of the delivery repo"),
    ("PM_REPO_SLUG", False, (PM, BA), (TK,), "GitHub owner/repo"),
    ("PM_REPO_NAME", False, (BA,), (PM, TK), "short repo name"),
    ("PM_LANE_DIR", False, (BA,), (PM,), "board lane state directory"),
    ("PM_STATE_DIR", False, (), (PM, BA, TK), "coordinator state directory"),
    ("PM_TIMEZONE", False, (), (PM, BA, TK), "IANA zone for window offsets"),
    ("PM_CI_WORKFLOW", False, (BA,), (), "CI workflow file name"),
    ("PM_JIRA_LABEL", False, (), (PM, BA), "project label on theme Epics"),
    ("PM_JIRA_BOARD_ID", False, (), (PM, BA), "Jira agile board id"),
    ("PM_SB_PROJECT_ID", False, (), (PM, BA), "Substrate project id (default prj_<prefix>)"),
    ("PM_DEPLOY_DIR", False, (), (PM,), "project deploy workspace"),
    ("PM_STATUS_BOARD_SITE", False, (TK,), (), "here.now site slug of the progress artifact"),
    ("PM_STATUS_BOARD_SELF_ISSUE", False, (TK,), (), "Substrate issue the Status board sync runs under"),
    ("PM_KNOWN_REPOS", True, (), (PM,), "repo names a <repo>#<n> may link"),
    ("PM_DONE_STATUSES", True, (), (PM, BA, TK), "board status names that mean done"),
    ("PM_ACTIVE_STATUSES", True, (BA,), (PM, TK), "board status names that mean being worked"),
    ("PM_OPEN_STATUSES", True, (BA,), (), "not-done status names the hygiene cycle accepts on an open window"),
    ("PM_TERMINAL_STATUSES", True, (), (PM, BA, TK), "board status names that end a row"),
    ("PM_PRODUCTION_STATUSES", True, (), (PM,), "statuses that claim production (TX-07)"),
    ("PM_TRANSITIONS", True, (), (PM, BA), "status name -> transition id"),
    ("PM_CUSTOM_FIELDS", True, (BA,), (PM, TK), "role -> customfield id"),
    ("PM_ENTITY_OPTIONS", True, (), (PM, BA), "Entity option name -> option id"),
    ("PM_HYGIENE_FILTERS", True, (BA,), (PM,), "saved filter role -> {id, name}"),
    ("PM_WAITING_PRODUCTION_STATUS", False, (BA,), (), "status for merged, not yet in production"),
    ("PM_DEFERRED_STATUS", False, (BA,), (), "status for deferred rows"),
    ("PM_PARKED_STATUSES", True, (BA,), (), "statuses the lane cycle treats as parked"),
    # Optional settings named in the setup docs: listed with --all-settings, never counted as missing.
    # project-management/references/setup.md
    ("PM_OPERATOR_NAMES", True, (), (PM, BA), "display names and first names that address the operator"),
    ("PM_OPERATOR_HANDLE", False, (), (PM, TK), "plain-text @handle that counts as asking the operator"),
    ("PM_ROUTE_ROLES", True, (), (PM, BA), "routing role -> session-name pattern (manager, lead, board_helper)"),
    ("PM_MATCH_DIRS", True, (), (PM, BA, TK), "extra directories that belong to the project"),
    ("PM_AGENT_HOST_INFO", False, (), (PM, BA), "xtrm agent host info file (default ~/.xtrm/run/agent-host.json)"),
    ("PM_OPERATOR_QUESTION_TURNS", False, (), (PM,), "operator-silent turns before the question reminder"),
    ("PM_QUESTION_OWNER", False, (), (PM,), "Status board questions/<owner> doc of this session"),
    ("PM_OPERATOR_INJECTED_PATTERNS", True, (), (PM,), "prompts that are not the operator"),
    ("PM_OPERATOR_QUESTION_REFS", True, (), (PM,), "Substrate refs whose operator blockers the hook watches"),
    ("PM_SB_BIN", False, (), (PM, BA, TK), "path of the sb CLI"),
    # project-management/references/setup.md, "Session hooks"
    ("PM_MANAGER_ISSUE", False, (), (PM,), "issue whose claim holder keeps the manager role in a handover (default epic)"),
    ("PM_CLAIM_TTL_MS", False, (), (PM,), "claim TTL the session hooks use, ms (default 3600000)"),
    ("PM_REFREAD_FILES", True, (), (PM,), "role -> reference files (pack-relative) read before a gated action"),
    ("PM_GATED_COMMANDS", True, (), (PM,), "Bash command regexes gated until the references are read"),
    ("PM_GATED_TOOLS", True, (), (PM,), "tool-name fnmatch patterns gated until the references are read"),
    ("PM_PENDING_MAX_AGE_S", False, (), (PM,), "max age of pending items the gate shows, s (default 3600)"),
    ("PM_POST_COMPACT_NUDGE", True, (), (PM,), "post-compact hook types a resume prompt into the pane (default false)"),
    ("PM_POST_COMPACT_NUDGE_TEXT", False, (), (PM,), "text of the post-compact nudge"),
    ("PM_POST_COMPACT_EXTRA", False, (), (PM,), "private text file appended to the post-compact resume steps"),
    ("PM_CHECKPOINT_THRESHOLDS", True, (), (PM,), "context fractions of the checkpoint warnings (default [0.70, 0.85])"),
    # board-audit/references/setup.md
    ("PM_JIRA_EPIC", False, (), (BA,), "Jira root epic of the project themes (readiness)"),
    ("PM_PR_SINCE", False, (), (BA,), "earliest PR date of the readiness snapshot"),
    ("PM_AUDIT_MODEL", False, (), (BA,), "provider/model of the AgentRun judge"),
    ("PM_BLOCKED_STATUSES", True, (), (BA,), "status names that mean Blocked"),
    ("PM_WINDOW_KEYS", True, (), (BA,), "pinned sample rows of the audit"),
    ("PM_PLAN_PREDECESSORS", True, (), (BA,), "declared window order"),
    ("PM_DAY_PREDECESSORS", True, (), (BA,), "declared window order per day"),
    ("PM_WINDOW_BANDS", True, (), (BA,), "UTC bands some windows must fall inside"),
    ("PM_STALE_PR_CONTROL", False, (), (BA,), "PR number the selftest expects to be stale"),
    ("PM_O1W_PINNED_CONTROL", False, (), (BA,), "Jira key pinned as the hygiene O1w control"),
    # board-audit/references/setup-lane.md
    ("PM_SB_SNAPSHOT", False, (), (BA,), "sb issue list snapshot for the deep duplicate probe"),
    ("PM_CUTOFF", False, (), (BA,), "project cut-off, YYYY-MM-DD HH:MM UTC"),
    ("PM_STATUS_BOARD_JQL", False, (), (BA,), "JQL of the Status board filter"),
    ("PM_PROD_PATH_REGEX", False, (), (BA,), "paths whose change is a production change"),
    ("PM_EXCEPTIONS_EPIC", False, (), (BA,), "Jira key holding the no-window exceptions"),
    ("PM_CONTAINER_PREFIX", False, (), (BA,), "container-name prefix stripped by deploy-check"),
    ("PM_BOT_INBOX", False, (), (BA, TK), "bot inbox JSONL (default <state_dir>/xtrm-bot-watch/inbox.jsonl)"),
    ("PM_ANSWERS_INBOX", False, (), (BA, TK), "Status board answers inbox (default <status board state>/answers-inbox.jsonl)"),
    ("PM_LANE_HOLDER", False, (), (BA,), "Substrate holder of the lane's post-guard writes"),
    ("PM_LANE_WATCHDOG", False, (), (BA,), "module that publishes an unwatched lane"),
    ("PM_STATUS_BOARD_UNIT", False, (), (BA, TK), "systemd user unit of the Status board sync"),
    ("PM_THEME_EPICS", True, (), (BA,), "theme epics (cycle re-parent count)"),
    ("PM_EXPECTED_OPEN", True, (), (BA,), "rows expected to stay open"),
    ("PM_CYCLE_CONTROLS", True, (), (BA,), "cycle control refs"),
    ("PM_GATE_REPOS", True, (), (BA,), "gate label short name -> owner/repo"),
    ("PM_CONTAINER_ALIASES", True, (), (BA,), "container -> refs or words (deploy-check)"),
    ("PM_CONTAINER_PATHS", True, (), (BA,), "repo path prefixes -> containers (wp-audit)"),
    ("PM_WP_KNOWN_BINDING", True, (), (BA,), "wp-audit required control"),
    ("PM_ROUTE_CONTROL_CASES", True, (), (BA,), "real operator comments for route-controls"),
    # status-board-keeper/references/setup.md
    ("PM_STATUS_BOARD_KEY_FILE", False, (), (TK, PM), "here.now owner key file"),
    ("PM_STATUS_BOARD_STATE_DIR", False, (), (TK, BA), "Status board sync state (default <state_dir>/status_board)"),
    ("PM_STATUS_BOARD_FILE_ONLY", True, (), (TK,), "roles or session names that get answers as inbox lines only"),
    ("PM_STATUS_BOARD_ANSWER_SEED_AT", False, (), (TK,), "route only answers at or after this stamp"),
    ("PM_STATUS_BOARD_STATUS_OVERRIDES", True, (), (TK,), "Jira status -> page status"),
    ("PM_EXTRA_REF_PREFIXES", True, (), (TK,), "other issue-key prefixes in event refs"),
]
TOOLS = ("sb", "xt", "gh", "tmux", "xtmux", "python3")
# Pack session hooks: (file in project-management/hooks/, settings.json event, matcher or None, arguments).
HOOKS = [
    ("post_compact.py", "SessionStart", "compact", "--mode compact"),
    ("post_compact.py", "SessionStart", "startup", "--mode startup"),
    ("action_gate.py", "SessionStart", None, "--event start"),
    ("action_gate.py", "PreToolUse", "Bash|Agent|.*specialist_dispatch", "--event pre"),
    ("action_gate.py", "PostToolUse", "Read", "--event post"),
    ("checkpoint_warn.py", "PostToolUse", "*", ""),
    ("checkpoint_warn.py", "UserPromptSubmit", None, ""),
    ("operator-questions.py", "UserPromptSubmit", None, "--event prompt"),
    ("operator-questions.py", "Stop", None, "--event stop"),
]
# Per-project state that two projects must never share: they would overwrite each other.
UNIQUE_KEYS = ("lane_dir", "state_dir", "status_board_state_dir", "status_board_site", "repo_dir")


def source(name: str, structured: bool):
    """('env'|'config', None) when set, (None, None) when missing, (None, error) when unreadable."""
    try:
        value = pm_config.get_data(name) if structured else pm_config.get(name)
    except (ValueError, json.JSONDecodeError) as exc:
        return None, f"unreadable ({type(exc).__name__})"
    if value in (None, "", [], {}):
        return None, None
    return ("env" if os.environ.get(name) else "config"), None


def check_settings(chosen, all_settings: bool) -> int:
    missing = 0
    for name, structured, req, opt, meaning in SETTINGS:
        need = [s for s in chosen if s in req]
        want = [s for s in chosen if s in opt]
        if not need and not want:
            continue
        src, err = source(name, structured)
        if src is None:
            if need:
                missing += 1
                print(f"MISSING {name:<32} required by {', '.join(need)}: {meaning}" + (f" [{err}]" if err else ""))
            elif all_settings:
                print(f"unset   {name:<32} optional: {meaning}" + (f" [{err}]" if err else ""))
            continue
        if need or all_settings:
            print(f"OK      {name:<32} ({src})")

    token = pm_config.path("JIRA_TOKEN_FILE")
    if token is not None:
        if not token.is_file():
            missing += 1
            print("MISSING token file at JIRA_TOKEN_FILE does not exist or is not a file")
        elif token.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            print("WARN    token file is readable by group or others; run chmod 600 on it")
    return missing


def clashes() -> int:
    """Count per-project state shared by two projects."""
    raw = pm_config.raw_config()
    defaults = raw.get("defaults") or {}
    found = 0
    for key in UNIQUE_KEYS:
        seen: dict[str, str] = {}
        for name in pm_config.project_names():
            value = {**defaults, **raw["projects"][name]}.get(key)
            if value in (None, ""):
                continue
            value = str(pathlib.Path(str(value)).expanduser()) if key.endswith("_dir") else str(value)
            if value in seen:
                found += 1
                print(f"CLASH   {key} is the same for {seen[value]} and {name}: their runs would overwrite each other")
            else:
                seen[value] = name
    return found


def role_line() -> tuple[str, str]:
    """This session's role by pm_role and where it came from: file, launch, name or default."""
    return pm_role.current_source()


def check_routes() -> int:
    """Print the team (every live session of the project, by role) and the single-holder roles.

    Routes are reported, not counted: a role may be legitimately unstaffed while you set up."""
    try:
        live = route_target.sessions()
    except route_target.RouteError as exc:
        print(f"WARN    routes not checked: {exc}")
        return 0
    route_target.print_team(route_target.team(live))
    for role in route_target.SINGLE_ROLES:
        try:
            rec = route_target.resolve(role, live)
        except route_target.RouteError as exc:
            print(f"WARN    route {role}: {exc}")
            continue
        print(f"route   {role:<24} -> {rec['address']}")
        if role == "manager":
            check_manager_claim(rec)
    return 0


def check_manager_claim(rec: dict) -> None:
    """Warn when the live manager is not the holder of the claim on manager_issue (default: the epic)."""
    ref = pm_config.get("PM_MANAGER_ISSUE") or pm_config.get("PM_EPIC")
    if not ref:
        return
    holder = route_target.claim_holder(ref)
    if holder is None:
        print(f"WARN    manager claim: no live claim on {ref} (or sb unreadable); the manager claims it at start")
    elif holder not in (rec.get("address"), rec.get("name")):
        print(f"WARN    manager claim: {ref} is held by {holder}, not by the live manager {rec.get('address')}")
    else:
        print(f"OK      manager claim on {ref} held by the live manager")


def settings_json() -> pathlib.Path:
    base = os.environ.get("CLAUDE_CONFIG_DIR")
    return (pathlib.Path(base).expanduser() if base else pathlib.Path.home() / ".claude") / "settings.json"


def hook_command(name: str, args: str, pack=None) -> str:
    pack = pack or pm_config.PACK_ROOT
    return f"python3 {pack}/project-management/hooks/{name}" + (f" {args}" if args else "")


def wired_hooks(settings: dict) -> list[bool]:
    """For each HOOKS entry: does a command under its event mention the hook file (and its arguments)?"""
    events = (settings.get("hooks") or {}) if isinstance(settings, dict) else {}
    out = []
    for name, event, _matcher, args in HOOKS:
        commands = []
        for group in events.get(event) or []:
            if not isinstance(group, dict):
                continue
            commands += [str(h.get("command") or "") for h in group.get("hooks") or [] if isinstance(h, dict)]
        out.append(any(name in c and (not args or args in c) for c in commands))
    return out


def hooks_snippet(entries, pack=None) -> dict:
    """The settings.json `hooks` block for `entries` (HOOKS rows), grouped by event and matcher."""
    block: dict = {}
    for name, event, matcher, args in entries:
        groups = block.setdefault(event, [])
        group = next((g for g in groups if g.get("matcher") == matcher), None)
        if group is None:
            group = {"matcher": matcher} if matcher else {}
            group["hooks"] = []
            groups.append(group)
        group["hooks"].append({"type": "command", "command": hook_command(name, args, pack)})
    return {"hooks": block}


def check_hooks() -> int:
    """Report each pack hook as wired or MISSING in settings.json; print the snippet for the missing. Never writes."""
    path = settings_json()
    try:
        settings = json.loads(path.read_text())
        print(f"settings {path}: present")
    except FileNotFoundError:
        settings = {}
        print(f"settings {path}: absent")
    except (OSError, ValueError) as exc:
        settings = {}
        print(f"settings {path}: UNREADABLE ({type(exc).__name__}); every hook counts as missing")
    missing = []
    for row, ok in zip(HOOKS, wired_hooks(settings)):
        name, event, matcher, args = row
        where = event + (f" [{matcher}]" if matcher else "")
        print(f"{'OK     ' if ok else 'MISSING'} hook {name:<22} {args or '(no args)':<16} {where}")
        if not ok:
            missing.append(row)
    if missing:
        print(f"result  {len(missing)} of {len(HOOKS)} hook(s) not wired; merge this into {path} (the pack never edits it):")
        print(json.dumps(hooks_snippet(missing), indent=2))
    else:
        print(f"result  all {len(HOOKS)} pack hooks wired")
    return 1 if missing else 0


def use_project(name: str | None) -> None:
    if name:
        os.environ["PM_PROJECT"] = name
    pm_config._CACHE = None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--skill", choices=(*SKILLS, "all"), default="all")
    ap.add_argument("--project", help="project to check (a name, or 'all'); default: the one pm_config would choose")
    ap.add_argument("--all-settings", action="store_true", help="also list optional settings that are set")
    ap.add_argument("--hooks", action="store_true", help="only check the pack session hooks in settings.json")
    a = ap.parse_args()
    if a.hooks:
        return check_hooks()
    chosen = SKILLS if a.skill == "all" else (a.skill,)

    cfg = pm_config.config_path()
    try:
        json.loads(cfg.read_text())
        print(f"config  {cfg}: present")
    except FileNotFoundError:
        print(f"config  {cfg}: absent (env vars only)")
    except (OSError, ValueError) as exc:
        print(f"config  {cfg}: UNREADABLE ({type(exc).__name__}); fix it before anything else")
        return 1

    for tool in TOOLS:
        print(f"tool    {tool:<24} {'OK' if shutil.which(tool) else 'MISSING'}")
    try:
        wired = wired_hooks(json.loads(settings_json().read_text()))
    except (OSError, ValueError):
        wired = [False] * len(HOOKS)
    print(f"hooks   {sum(wired)} of {len(HOOKS)} pack session hooks wired (details: --hooks)")

    names = pm_config.project_names()
    problems = 0
    if names:
        print(f"projects {', '.join(names)}")
        problems += clashes()
    targets = names if a.project == "all" and names else [a.project]
    for target in targets:
        use_project(target)
        if names:
            try:
                name, how = pm_config.select_project()
            except SystemExit as exc:
                print(f"MISSING project choice: {exc}")
                problems += 1
                continue
            print(f"project {name} ({how})")
        problems += check_settings(chosen, a.all_settings)
        role, how = role_line()
        print(f"role    this session: {role} ({how})")
        problems += check_routes()

    print(f"result  {'ready' if not problems else f'{problems} problem(s)'} for {', '.join(chosen)}"
          " (see project-management/references/setup.md)")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
