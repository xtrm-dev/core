"""Instance settings for the board helper lane scripts, read through the pack's pm_config.

Nothing project-specific lives in the lane scripts. Each value below comes from an environment
variable or from the pack config file (see board-audit/references/setup-lane.md). A required
value that is missing stops the script with its name.

Importing this module also puts project-management/scripts on sys.path, so `import jira` works.
"""
from __future__ import annotations

import pathlib
import re
import shutil
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS.parents[2] / "project-management" / "scripts"))
import pm_config  # noqa: E402


def lane() -> str:
    """Lane state directory (events.log, outbox, cursors, reports)."""
    return str(pm_config.path("PM_LANE_DIR", required=True))


def repo() -> str:
    """Local checkout of the delivery repository (gh and git run here)."""
    return str(pm_config.path("PM_REPO_DIR", required=True))


def repo_slug() -> str:
    return str(pm_config.get("PM_REPO_SLUG", required=True))


def repo_name() -> str:
    """Short repository name used in comment text, e.g. `PR-link <name>#<n>`."""
    return str(pm_config.get("PM_REPO_NAME", required=True))


def project() -> str:
    """Jira project key."""
    return str(pm_config.get("PM_JIRA_PROJECT", required=True))


def sb_prefix() -> str:
    """Substrate key prefix."""
    return str(pm_config.get("PM_SB_PREFIX", required=True))


def sb_project_id() -> str:
    """Substrate project id in state.db (issues.project_id)."""
    return str(pm_config.get("PM_SB_PROJECT_ID", "prj_" + sb_prefix().lower()))


def sb_bin() -> str:
    return str(pm_config.get("PM_SB_BIN", shutil.which("sb") or "sb"))


def epic() -> str:
    """Project epic ref in Substrate."""
    return str(pm_config.get("PM_EPIC", required=True))


def ci_workflow() -> str:
    return str(pm_config.get("PM_CI_WORKFLOW", required=True))


def operator_account_id() -> str:
    return str(pm_config.get("PM_OPERATOR_ACCOUNT_ID", required=True))


def operator_name() -> str:
    """Operator display name in Jira."""
    return str(pm_config.get("PM_OPERATOR_NAME", required=True))


def operator_names() -> set:
    """Lower-case display names that identify the operator's comments."""
    names = pm_config.get_data("PM_OPERATOR_NAMES", None)
    return {str(n).lower() for n in names} if names else {operator_name().lower()}


def custom_field(role: str) -> str:
    """customfield_<n> id for a role: window_start, window_end, start_date."""
    fields = pm_config.get_data("PM_CUSTOM_FIELDS", required=True)
    if role not in fields:
        sys.exit(f"lanecfg: custom_fields has no '{role}' entry; see board-audit/references/setup-lane.md")
    return fields[role]


def cf_num(role: str) -> str:
    """Numeric part of a custom field id, for JQL `cf[<n>]`."""
    return custom_field(role).rsplit("_", 1)[-1]


def statuses() -> dict:
    """Board status names, read from the flat keys the other skills share."""
    return {
        "waiting_production": pm_config.get("PM_WAITING_PRODUCTION_STATUS", required=True),
        "active": pm_config.get_data("PM_ACTIVE_STATUSES", required=True),
        "deferred": pm_config.get("PM_DEFERRED_STATUS", required=True),
        "parked": pm_config.get_data("PM_PARKED_STATUSES", required=True),
    }


def data(name: str, default=None, required: bool = False):
    return pm_config.get_data(name, default, required=required)


def get(name: str, default=None, required: bool = False):
    return pm_config.get(name, default, required=required)


def jira_key_re(group: bool = False) -> str:
    """Regex source for a Jira key of this project; with group=True the number is captured."""
    p = re.escape(project())
    return rf"{p}-(\d+)" if group else rf"{p}-\d+"


def sb_key_re(min_digits: int = 1, group: bool = False) -> str:
    """Regex source for a Substrate key of this project."""
    p = re.escape(sb_prefix())
    d = r"\d" + ("{%d,}" % min_digits if min_digits > 1 else "+")
    return rf"{p}-({d})" if group else rf"{p}-{d}"
