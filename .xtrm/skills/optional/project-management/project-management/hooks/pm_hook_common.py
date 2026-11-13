"""Shared plumbing for the project-management session hooks (post_compact, action_gate, checkpoint_warn).

- Settings come from scripts/pm_config.py (env > config file > default). A config error never crashes a hook: the
  setting helpers below fall back to the default.
- The role comes from scripts/pm_role.py (role file `.pm-role`, else route_roles name patterns, else worker). Only
  the manager and the leads are acted on.
- Project scope: a hook acts only in a session of a configured project (see project_scope).
- Errors are appended to $XDG_STATE_HOME/xtrm-pm-hooks/errors.log (default ~/.local/state; PM_HOOK_STATE_DIR overrides); hooks fail open.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import sys
from datetime import datetime, timezone

HOOKS = pathlib.Path(__file__).resolve().parent
SCRIPTS = HOOKS.parent / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
import pm_config  # noqa: E402
import pm_role  # noqa: E402

GATED_ROLES = ("manager", "lead")
REF_RE = re.compile(r"^[A-Z][A-Z0-9]*-[0-9]+$")
DEFAULT_REFREAD = [
    "project-management/references/manager.md",
    "project-management/references/lead.md",
    "project-management/references/launching.md",
]
DEFAULT_CLAIM_TTL_MS = 3600000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cache_dir() -> pathlib.Path:
    explicit = os.environ.get("PM_HOOK_STATE_DIR")
    if explicit:
        return pathlib.Path(explicit).expanduser()
    base = os.environ.get("XDG_STATE_HOME") or str(pathlib.Path.home() / ".local" / "state")
    return pathlib.Path(base) / "xtrm-pm-hooks"


def log_error(hook: str, where: str, exc) -> None:
    try:
        d = cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "errors.log", "a", encoding="utf-8") as fh:
            fh.write("%s %s (%s) error: %r\n" % (utc_now(), hook, where, exc))
    except Exception:
        pass


def read_payload() -> dict:
    """The hook JSON on stdin; {} when there is none (run by hand on a terminal) or it is empty."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return {}
        raw = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    data = json.loads(raw) if raw.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("hook payload is not a JSON object")
    return data


# ---------------------------------------------------------------- settings (never raise on a config error)
def setting(name: str, default=None):
    try:
        value = pm_config.get(name, None)
    except SystemExit:
        value = None
    return default if value in (None, "") else value


def setting_data(name: str, default=None):
    try:
        value = pm_config.get_data(name, None)
    except (SystemExit, ValueError):
        value = None
    return default if value is None else value


def setting_bool(name: str, default: bool = False) -> bool:
    value = setting(name, None)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def setting_int(name: str, default: int) -> int:
    try:
        return int(setting(name, default))
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- scope, role, identity
def project_scope(cwd: str) -> tuple[str, str]:
    """Is this session inside a configured project?

    ('ok', project or '')  the config selects a project for ``cwd`` (PM_PROJECT, or cwd inside a project's
                           repo_dir/match_dirs; a flat config without dirs applies everywhere). PM_PROJECT is set
                           for the rest of the process so pm_config resolves the same project.
    ('none', '')           no config, or cwd outside every project: the hook stays silent.
    ('error', message)     unreadable config, unknown PM_PROJECT, or cwd inside several projects.
    """
    try:
        raw = pm_config.raw_config()
    except SystemExit as exc:
        return "error", str(exc)
    if not raw:
        return "none", ""
    try:
        here = pathlib.Path(cwd or os.getcwd()).resolve()
    except OSError:
        here = pathlib.Path(cwd or "/")
    projects = raw.get("projects")
    explicit = os.environ.get("PM_PROJECT")
    if not projects:
        dirs = [d for d in [raw.get("repo_dir"), *(raw.get("match_dirs") or [])] if d]
        if explicit or not dirs:
            return "ok", ""
        return ("ok", "") if any(pm_config._under(here, d) >= 0 for d in dirs) else ("none", "")
    if explicit:
        if explicit in projects:
            return "ok", explicit
        return "error", "PM_PROJECT=%s is not in %s" % (explicit, pm_config.config_path())
    defaults = raw.get("defaults") or {}
    best, best_len, tied = None, -1, set()
    for name, prof in projects.items():
        merged = {**defaults, **(prof or {})}
        for d in [merged.get("repo_dir"), *(merged.get("match_dirs") or [])]:
            n = pm_config._under(here, d) if d else -1
            if n > best_len:
                best, best_len, tied = name, n, {name}
            elif n == best_len and n >= 0:
                tied.add(name)
    if len(tied) > 1:
        return "error", "the current directory belongs to several projects (%s); set PM_PROJECT" % ", ".join(sorted(tied))
    if best is None:
        return "none", ""
    os.environ["PM_PROJECT"] = best
    return "ok", best


def role() -> str:
    """This session's role: pm_role.current() (role file, else name patterns, else worker)."""
    return pm_role.current()


def project_dir(cwd: str = "") -> str:
    return os.environ.get("CLAUDE_PROJECT_DIR") or cwd or os.getcwd()


def session_names(cwd: str = "") -> list[str]:
    """Names this session answers to: holder, session name, worktree directory name."""
    names = [os.environ.get("SUBSTRATE_HOLDER"), os.environ.get("XTRM_SESSION_NAME"),
             os.path.basename(project_dir(cwd).rstrip("/"))]
    return [n for n in names if n]


def holder() -> str:
    return os.environ.get("SUBSTRATE_HOLDER") or "<your holder>"


def claim_ttl_ms() -> int:
    ttl = setting_int("PM_CLAIM_TTL_MS", DEFAULT_CLAIM_TTL_MS)
    return ttl if ttl > 0 else DEFAULT_CLAIM_TTL_MS


def bound_ref(cwd: str = "") -> str | None:
    """The issue this worktree is bound to: SUBSTRATE_ISSUE_REF, else the first line of .substrate-issue in the
    current directory or the worktree root."""
    ref = (os.environ.get("SUBSTRATE_ISSUE_REF") or "").strip()
    if ref:
        return ref
    here = pathlib.Path(cwd or os.getcwd())
    candidates = [here / ".substrate-issue"]
    root = pm_role.worktree_root(here)
    if root is not None:
        candidates.append(root / ".substrate-issue")
    for f in candidates:
        try:
            line = f.read_text().splitlines()[0].strip()
        except (OSError, IndexError):
            continue
        if line:
            return line
    return None


def manager_ref() -> tuple[str | None, str]:
    """(ref, source) for an unbound manager: manager_issue (PM_MANAGER_ISSUE), else epic (PM_EPIC)."""
    for name, key in (("PM_MANAGER_ISSUE", "manager_issue"), ("PM_EPIC", "epic")):
        value = str(setting(name, "") or "").strip()
        if value and REF_RE.match(value):
            return value, "%s (%s)" % (key, name)
    return None, ""


def refread_files(for_role: str) -> list[str]:
    """Reference files a role must Read in full: setting refread_files ({role: [paths]} or one list for every role).
    Relative paths resolve against the pack root (pm_config.PACK_ROOT)."""
    conf = setting_data("PM_REFREAD_FILES", None)
    if isinstance(conf, dict):
        paths = conf.get(for_role, DEFAULT_REFREAD)
    elif isinstance(conf, list):
        paths = conf
    else:
        paths = DEFAULT_REFREAD
    if isinstance(paths, str):
        paths = [paths]
    out = []
    for p in paths or []:
        q = pathlib.Path(os.path.expanduser(str(p)))
        out.append(str(q if q.is_absolute() else pm_config.PACK_ROOT / q))
    return out
