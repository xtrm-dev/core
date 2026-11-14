#!/usr/bin/env python3
"""Session role for the project-management pack: manager, lead, board_helper or worker.

One resolver for every consumer (route_target.py and the pack hooks), so they can never disagree.
Resolution order:
1. The role file: a one-word `.pm-role` in the session's worktree root. An explicit override, for a session launched
   under a role that does not say what it is (`python3 pm_role.py set <role>`, or `pm_session.py init`).
2. The launch role: the specialist role the session was launched with (`xt claude|pi --role <name>`), read from
   XTMUX_AGENT_ROLE in the session and from the agent host's session record, mapped by `launch_roles` (defaults
   below). `--role manager` or `--role lead` therefore needs no role file.
3. The session name against the project's `route_roles` patterns (a pattern or a list per role; defaults below).
4. worker.

The claim is not a role source (a new manager holds none at start, and a lapsed lease would drop the role); it only
breaks a tie between two live managers, in route_target.py.

CLI: pm_role.py show [--dir D] [--name N] [--launch-role R] | pm_role.py set <role> [--dir D] | pm_role.py clear [--dir D]
"""
from __future__ import annotations

import fnmatch
import os
import pathlib
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402

ROLES = ("manager", "lead", "board_helper", "worker")
ROLE_FILE = ".pm-role"
# Name fallback. `-<n>` (1-2 digits) covers a relaunch of the same name; legacy `*-coord` sessions are leads unless a
# project's route_roles names its manager (for example {"manager": "*wed11-coord"}).
DEFAULT_PATTERNS = {
    "manager": ["*-manager", "*-manager-[0-9]", "*-manager-[0-9][0-9]"],
    "lead": ["*-lead", "*-lead-[0-9]", "*-lead-[0-9][0-9]", "*-coord", "*-coord-[0-9]", "*-coord-[0-9][0-9]"],
    "board_helper": ["*board-helper*"],
}
ORDER = ("board_helper", "manager", "lead")
# Launch role (specialist name) -> pack role. A role absent here (project-manager, which serves both modes) says
# nothing, and resolution falls through to the name patterns.
DEFAULT_LAUNCH_ROLES = {"manager": "manager", "lead": "lead", "worker": "worker", "board-audit-runner": "board_helper",
                        "board-helper": "board_helper"}  # a configured manager pattern wins over the legacy -coord lead default


def patterns() -> dict[str, list[str]]:
    """Name patterns per role: the project's route_roles replace the default for the roles they name."""
    out = {k: list(v) for k, v in DEFAULT_PATTERNS.items()}
    try:
        conf = pm_config.get_data("PM_ROUTE_ROLES", {}) or {}
    except SystemExit:
        conf = {}
    for role, pat in conf.items():
        if role in DEFAULT_PATTERNS:
            out[role] = [pat] if isinstance(pat, str) else list(pat)
    return out


def launch_roles() -> dict[str, str]:
    """Launch role -> pack role: the defaults, with the project's `launch_roles` setting merged over them."""
    out = dict(DEFAULT_LAUNCH_ROLES)
    try:
        conf = pm_config.get_data("PM_LAUNCH_ROLES", {}) or {}
    except SystemExit:
        conf = {}
    out.update({str(k): str(v) for k, v in conf.items() if v in ROLES})
    return out


def by_launch(launch_role) -> str | None:
    """The pack role a launch role maps to, or None when it maps to none."""
    return launch_roles().get(str(launch_role or "").strip()) if launch_role else None


def worktree_root(start) -> pathlib.Path | None:
    """The nearest directory at or above `start` holding a role file or a .git entry."""
    try:
        p = pathlib.Path(start).resolve()
    except OSError:
        return None
    for d in (p, *p.parents):
        if (d / ROLE_FILE).is_file() or (d / ".git").exists():
            return d
    return None


def declared(directory) -> str | None:
    """The role in the role file of the worktree that contains `directory`, if any and valid."""
    root = worktree_root(directory) if directory else None
    if root is None:
        return None
    try:
        word = (root / ROLE_FILE).read_text().strip().split()[0].lower()
    except (OSError, IndexError):
        return None
    return word if word in ROLES else None


def by_name(*names) -> str | None:
    pats = patterns()
    for role in ORDER:
        for name in names:
            if name and any(fnmatch.fnmatch(name, p) for p in pats[role]):
                return role
    return None


def source(name: str | None = None, directory=None, launch_role: str | None = None) -> tuple[str, str]:
    """(role, where it came from): file, launch, name or default."""
    role = declared(directory)
    if role:
        return role, "file"
    role = by_launch(launch_role)
    if role:
        return role, "launch"
    role = by_name(name, os.path.basename(str(directory or "")).rstrip("/"))
    if role:
        return role, "name"
    return "worker", "default"


def resolve(name: str | None = None, directory=None, launch_role: str | None = None) -> str:
    """Role of a session: role file, else launch role, else name patterns, else worker."""
    return source(name, directory, launch_role)[0]


def current_source() -> tuple[str, str]:
    """(role, source) of the session this process runs in (hooks): its project dir or cwd, launch role, name."""
    directory = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return source(os.environ.get("SUBSTRATE_HOLDER") or os.environ.get("XTRM_SESSION_NAME"), directory,
                  os.environ.get("XTMUX_AGENT_ROLE"))


def current() -> str:
    return current_source()[0]


def write(role: str, directory=None) -> pathlib.Path:
    if role not in ROLES:
        raise ValueError(f"role must be one of {', '.join(ROLES)}")
    root = worktree_root(directory or os.getcwd()) or pathlib.Path(directory or os.getcwd())
    path = root / ROLE_FILE
    tmp = path.with_suffix(".tmp")
    tmp.write_text(role + "\n")
    os.replace(tmp, path)
    exclude(root, ROLE_FILE)
    return path


def exclude(root: pathlib.Path, name: str = ROLE_FILE) -> None:
    """Keep a kit file out of git: add it to the repository's info/exclude (shared by every worktree)."""
    import subprocess
    try:
        r = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-common-dir"], capture_output=True, text=True,
                           timeout=10)
        if r.returncode != 0:
            return
        common = pathlib.Path(r.stdout.strip())
        exclude_file = (common if common.is_absolute() else root / common) / "info" / "exclude"
        lines = exclude_file.read_text().splitlines() if exclude_file.is_file() else []
        if name not in (line.strip() for line in lines):
            exclude_file.parent.mkdir(parents=True, exist_ok=True)
            with open(exclude_file, "a") as fh:
                fh.write(("\n" if lines and lines[-1] else "") + name + "\n")
    except (OSError, subprocess.SubprocessError):
        pass


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="pm_role.py", description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=("show", "set", "clear"))
    ap.add_argument("role", nargs="?")
    ap.add_argument("--dir", default=None)
    ap.add_argument("--name", default=None)
    ap.add_argument("--launch-role", default=None, help="the specialist role it was launched with")
    a = ap.parse_args(argv)
    if a.action == "set":
        print(write(a.role or "", a.dir))
        return 0
    if a.action == "clear":
        root = worktree_root(a.dir or os.getcwd())
        if root and (root / ROLE_FILE).is_file():
            (root / ROLE_FILE).unlink()
            print(f"removed {root / ROLE_FILE}")
        return 0
    if a.dir or a.name or a.launch_role:
        role, src = source(a.name, a.dir or os.getcwd(), a.launch_role)
    else:
        role, src = current_source()
    print(f"{role} ({src})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ValueError as exc:
        sys.exit(f"pm_role: {exc}")
