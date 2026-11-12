"""Instance settings for the project-management pack (project-management, board-audit, tabellone-keeper).

Nothing instance-specific lives in the pack. Every script reads it here, in this order:
1. the environment variable (``PM_*`` or ``JIRA_*``, names in references/setup.md);
2. the JSON config file at ``$PM_CONFIG`` (default ``~/.config/xtrm/project-management.json``),
   keyed by the same name in lower case without the ``PM_`` prefix (``PM_LANE_DIR`` -> ``lane_dir``);
3. the default the caller passes.

A required setting that is missing stops the script with the name and the setup reference.
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


_CACHE: dict | None = None


def _file() -> dict:
    global _CACHE
    if _CACHE is None:
        try:
            _CACHE = json.loads(config_path().read_text())
        except FileNotFoundError:
            _CACHE = {}
    return _CACHE


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


def skill_dir(skill: str) -> pathlib.Path:
    """Directory of a sibling skill in this pack (``board-audit``, ``tabellone-keeper``, ``project-management``)."""
    return PACK_ROOT / skill


def jira_py() -> pathlib.Path:
    return skill_dir("project-management") / "scripts" / "jira.py"
