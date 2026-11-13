"""Instance settings for the project-management pack (project-management, board-audit, status-board-keeper).

Nothing instance-specific lives in the pack. Every script reads it here, in this order:
1. the environment variable (``PM_*`` or ``JIRA_*``, names in references/setup.md);
2. the JSON config file at ``$PM_CONFIG`` (default ``~/.config/xtrm/project-management.json``),
   keyed by the same name in lower case without the ``PM_`` prefix (``PM_LANE_DIR`` -> ``lane_dir``);
3. the default the caller passes.

The config file holds one project (flat keys) or several (``{"defaults": {...}, "projects": {name: {...}}}``;
a project's keys override ``defaults``). With several, the project is chosen by ``$PM_PROJECT``, else by the
current directory lying inside a project's ``repo_dir`` (or one of its ``match_dirs``), else by being the only
one; otherwise the script stops rather than guess, because a wrong guess writes to another project's board.

A required setting that is missing stops the script with the name and the setup reference.
Shell scripts read a setting with ``python3 pm_config.py get NAME`` and the chosen project with ``project``.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

PACK_ROOT = pathlib.Path(__file__).resolve().parents[2]
SETUP_DOC = "project-management/references/setup.md"


def config_path() -> pathlib.Path:
    explicit = os.environ.get("PM_CONFIG")
    if explicit:
        return pathlib.Path(explicit).expanduser()
    base = os.environ.get("XDG_CONFIG_HOME") or str(pathlib.Path.home() / ".config")
    return pathlib.Path(base) / "xtrm" / "project-management.json"


_RAW: dict | None = None
_CACHE: dict | None = None
_CHOICE: tuple[str | None, str] = (None, "single-project config")


def raw_config() -> dict:
    """The config file as written (all projects), or {} when absent."""
    global _RAW
    if _RAW is None:
        try:
            _RAW = json.loads(config_path().read_text())
        except FileNotFoundError:
            _RAW = {}
    return _RAW


def project_names() -> list[str]:
    return sorted((raw_config().get("projects") or {}).keys())


def _under(cwd: pathlib.Path, d) -> int:
    """Length of ``d`` when ``cwd`` lies inside it, else -1 (longest match wins)."""
    try:
        root = pathlib.Path(str(d)).expanduser().resolve()
        cwd.relative_to(root)
        return len(str(root))
    except (ValueError, OSError):
        return -1


def select_project() -> tuple[str | None, str]:
    """(project name, how it was chosen). Exits when several projects exist and none is chosen."""
    raw = raw_config()
    projects = raw.get("projects")
    if not projects:
        return None, "single-project config"
    defaults = raw.get("defaults") or {}
    name = os.environ.get("PM_PROJECT")
    if name:
        if name not in projects:
            sys.exit(f"pm_config: PM_PROJECT={name} is not in {config_path()} (projects: {', '.join(sorted(projects))})")
        return name, "PM_PROJECT"
    cwd = pathlib.Path.cwd().resolve()
    best, best_len = None, -1
    for pname, prof in projects.items():
        merged = {**defaults, **prof}
        for d in [merged.get("repo_dir"), *(merged.get("match_dirs") or [])]:
            n = _under(cwd, d) if d else -1
            if n > best_len:
                best, best_len = pname, n
    if best is not None:
        return best, f"current directory inside {best}'s repo_dir/match_dirs"
    if len(projects) == 1:
        return next(iter(projects)), "only project in the config"
    sys.exit(f"pm_config: {len(projects)} projects in {config_path()} and none chosen; set PM_PROJECT to one of "
             f"{', '.join(sorted(projects))} (or run inside its repo_dir); see {SETUP_DOC}")


def _file() -> dict:
    """The settings of the chosen project (defaults merged), or the flat single-project config."""
    global _CACHE, _CHOICE
    if _CACHE is None:
        raw = raw_config()
        if raw.get("projects"):
            _CHOICE = select_project()
            _CACHE = {**(raw.get("defaults") or {}), **raw["projects"][_CHOICE[0]]}
        else:
            _CHOICE = (None, "single-project config")
            _CACHE = raw
    return _CACHE


def project() -> str | None:
    """Name of the chosen project (None for a single-project flat config)."""
    _file()
    return _CHOICE[0]


def _key(name: str) -> str:
    return name[3:].lower() if name.startswith("PM_") else name.lower()


def get(name: str, default=None, *, required: bool = False):
    """Return a scalar setting: env var, then config file, then ``default``."""
    value = os.environ.get(name)
    if value not in (None, ""):
        return value
    value = _file().get(_key(name))
    if value not in (None, ""):
        return value
    if required and default is None:
        sys.exit(f"pm_config: {name} is not set (env var or '{_key(name)}' in {config_path()}); see {SETUP_DOC}")
    return default


def get_data(name: str, default=None, *, required: bool = False):
    """Return a structured setting (list or object). The env var, when set, holds JSON."""
    raw = os.environ.get(name)
    if raw:
        return json.loads(raw)
    value = _file().get(_key(name))
    if value is not None:
        return value
    if required and default is None:
        sys.exit(f"pm_config: {name} is not set ('{_key(name)}' in {config_path()}); see {SETUP_DOC}")
    return default


def path(name: str, default: str | None = None, *, required: bool = False) -> pathlib.Path:
    """Return a path setting with ``~`` expanded."""
    value = get(name, default, required=required)
    return pathlib.Path(str(value)).expanduser() if value is not None else None


def state_dir() -> pathlib.Path:
    """Coordinator state root, ``PM_STATE_DIR``; default ``~/.xtrm/product/<repo name>``."""
    name = get("PM_REPO_NAME") or str(get("PM_REPO_SLUG") or "").rsplit("/", 1)[-1] or "pm"
    return path("PM_STATE_DIR", "~/.xtrm/product/%s" % name)


def status_board_state_dir() -> pathlib.Path:
    """Status board sync state, ``PM_STATUS_BOARD_STATE_DIR``; default ``<state_dir>/status_board``."""
    return path("PM_STATUS_BOARD_STATE_DIR", str(state_dir() / "status_board"))


def answers_inbox() -> pathlib.Path:
    """The one Status board answers inbox: the sync appends to it, the lane router reads it.

    ``PM_ANSWERS_INBOX``; default ``<status_board_state_dir>/answers-inbox.jsonl``."""
    return path("PM_ANSWERS_INBOX", str(status_board_state_dir() / "answers-inbox.jsonl"))


def bot_inbox() -> pathlib.Path:
    """The one bot inbox: the bot watcher writes it, the lane router reads it, and the Status board sync reads the
    watcher's ``config.json`` beside it. ``PM_BOT_INBOX``; default ``<state_dir>/xtrm-bot-watch/inbox.jsonl``."""
    return path("PM_BOT_INBOX", str(state_dir() / "xtrm-bot-watch" / "inbox.jsonl"))


def skill_dir(skill: str) -> pathlib.Path:
    """Directory of a sibling skill in this pack (``board-audit``, ``status-board-keeper``, ``project-management``)."""
    return PACK_ROOT / skill


def jira_py() -> pathlib.Path:
    return skill_dir("project-management") / "scripts" / "jira.py"


if __name__ == "__main__":
    # python3 pm_config.py get NAME [DEFAULT]  |  python3 pm_config.py project
    args = sys.argv[1:]
    if args[:1] == ["project"]:
        print(project() or "")
    elif args[:1] == ["get"] and len(args) in (2, 3):
        value = get(args[1], args[2] if len(args) == 3 else None, required=len(args) == 2)
        print(pathlib.Path(str(value)).expanduser() if str(value).startswith("~") else value)
    else:
        sys.exit("usage: pm_config.py get NAME [DEFAULT] | pm_config.py project")
