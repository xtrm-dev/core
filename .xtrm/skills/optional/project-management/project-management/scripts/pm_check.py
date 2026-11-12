#!/usr/bin/env python3
"""Check the project-management pack setup: tools on PATH, settings, token file.

Usage: pm_check.py [--skill project-management|board-audit|tabellone-keeper|all] [--all-settings]

Prints one line per setting the chosen skill(s) read: OK (with its source, env or config) or MISSING. Values are
not printed, so the output is safe to paste. Exit 0 when every required setting is present, 1 otherwise.
The settings and the config file are described in project-management/references/setup.md; a skill that adds a
setting adds its row to SETTINGS below and to its own setup reference.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402

PM, BA, TK = "project-management", "board-audit", "tabellone-keeper"
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
    ("PM_TABELLONE_SITE", False, (TK,), (), "here.now site slug of the progress artifact"),
    ("PM_TABELLONE_SELF_ISSUE", False, (TK,), (), "Substrate issue the Tabellone sync runs under"),
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
]
TOOLS = ("sb", "xt", "gh", "tmux", "python3")


def source(name: str, structured: bool):
    """('env'|'config', None) when set, (None, None) when missing, (None, error) when unreadable."""
    try:
        value = pm_config.get_data(name) if structured else pm_config.get(name)
    except (ValueError, json.JSONDecodeError) as exc:
        return None, f"unreadable ({type(exc).__name__})"
    if value in (None, "", [], {}):
        return None, None
    return ("env" if os.environ.get(name) else "config"), None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--skill", choices=(*SKILLS, "all"), default="all")
    ap.add_argument("--all-settings", action="store_true", help="also list optional settings that are set")
    a = ap.parse_args()
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
                print(f"MISSING {name:<24} required by {', '.join(need)}: {meaning}" + (f" [{err}]" if err else ""))
            elif a.all_settings:
                print(f"unset   {name:<24} optional: {meaning}" + (f" [{err}]" if err else ""))
            continue
        if need or a.all_settings:
            print(f"OK      {name:<24} ({src})")

    token = pm_config.path("JIRA_TOKEN_FILE")
    if token is not None:
        if not token.is_file():
            missing += 1
            print(f"MISSING token file at JIRA_TOKEN_FILE does not exist or is not a file")
        elif token.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            print("WARN    token file is readable by group or others; run chmod 600 on it")

    print(f"result  {'ready' if not missing else f'{missing} required setting(s) missing'} for {', '.join(chosen)}"
          " (see project-management/references/setup.md)")
    return 0 if not missing else 1


if __name__ == "__main__":
    sys.exit(main())
