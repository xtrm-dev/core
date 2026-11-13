#!/usr/bin/env python3
"""Session role for the project-management pack: manager, lead, board_helper or worker.

One resolver for every consumer (route_target.py and the pack hooks), so they can never disagree.
Resolution order:
1. The role file: a one-word `.pm-role` in the session's worktree root, written by whoever launches the session
   (`python3 pm_role.py set <role>`; CORE-2702 tracks an xt launch flag that writes it). Names are then free.
2. The session name against the project's `route_roles` patterns (a pattern or a list per role; defaults below).
3. worker.

The claim is not a role source (a new manager holds none at start, and a lapsed lease would drop the role); it only
breaks a tie between two live managers, in route_target.py.

CLI: pm_role.py show [--dir D] [--name N] | pm_role.py set <role> [--dir D] | pm_role.py clear [--dir D]
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
ORDER = ("board_helper", "manager", "lead")  # a configured manager pattern wins over the legacy -coord lead default


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


def resolve(name: str | None = None, directory=None) -> str:
    """Role of a session: role file in `directory`'s worktree, else `name` patterns, else worker."""
    return declared(directory) or by_name(name, os.path.basename(str(directory or "")).rstrip("/")) or "worker"


def current() -> str:
    """Role of the session this process runs in (hooks): its project dir or cwd, its holder name."""
    directory = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    return resolve(os.environ.get("SUBSTRATE_HOLDER") or os.environ.get("XTRM_SESSION_NAME"), directory)


def write(role: str, directory=None) -> pathlib.Path:
    if role not in ROLES:
        raise ValueError(f"role must be one of {', '.join(ROLES)}")
    root = worktree_root(directory or os.getcwd()) or pathlib.Path(directory or os.getcwd())
    path = root / ROLE_FILE
    tmp = path.with_suffix(".tmp")
    tmp.write_text(role + "\n")
    os.replace(tmp, path)
    _exclude(root)
    return path


def _exclude(root: pathlib.Path) -> None:
    """Keep the role file out of git: add it to the repository's info/exclude (shared by every worktree)."""
    import subprocess
    try:
        r = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-common-dir"], capture_output=True, text=True,
                           timeout=10)
        if r.returncode != 0:
            return
        common = pathlib.Path(r.stdout.strip())
        exclude = (common if common.is_absolute() else root / common) / "info" / "exclude"
        lines = exclude.read_text().splitlines() if exclude.is_file() else []
        if ROLE_FILE not in (line.strip() for line in lines):
            exclude.parent.mkdir(parents=True, exist_ok=True)
            with open(exclude, "a") as fh:
                fh.write(("\n" if lines and lines[-1] else "") + ROLE_FILE + "\n")
    except (OSError, subprocess.SubprocessError):
        pass


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="pm_role.py", description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=("show", "set", "clear"))
    ap.add_argument("role", nargs="?")
    ap.add_argument("--dir", default=None)
    ap.add_argument("--name", default=None)
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
    if a.dir or a.name:
        role = resolve(a.name, a.dir or os.getcwd())
        src = "file" if declared(a.dir or os.getcwd()) else ("name" if role != "worker" else "default")
    else:
        role = current()
        src = "file" if declared(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()) else ("name" if role != "worker" else "default")
    print(f"{role} ({src})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ValueError as exc:
        sys.exit(f"pm_role: {exc}")
