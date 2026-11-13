#!/usr/bin/env python3
"""Resolve a routing role (manager, lead, board_helper) to the live session(s) that hold it.

A route target written into config or code goes stale the day its session ends (2026-11-12: the lane forwarded to
a coordinator socket that no longer existed, and 26 operator messages waited a day). The role is carried by the
session name instead, set once at launch, and resolved at send time against the live session registry of the xtrm
agent host (GET /v1/sessions on loopback).

Roles and their default patterns (override per project with the setting PM_ROUTE_ROLES, {role: fnmatch pattern}):
  manager       *[0-9]-manager        one per project and day, e.g. thu13-manager or thu3-manager
  lead          *-lead                one per epic and area, e.g. EPIC-7-api-lead; several are normal
  board_helper  *board-helper*        one per project
Workers never take the -manager or -lead suffix. A pattern matches the session's address (its worktree name, the
name SendMessage takes, e.g. example-xt-claude-thu13-manager) or its registry name. Only live sessions of this
project count: same PM_REPO_SLUG, or cwd inside PM_REPO_DIR or one of PM_MATCH_DIRS.

resolve(role) needs exactly one match: none or several is an error, never a guess. That is the rule for manager
and board_helper; a caller that needs one lead names it (several live leads are the normal state).
matches(role) lists every match; team() groups every live project session by role.

Usage: route_target.py ROLE [--json]     print the address (or the full record)
       route_target.py --all             one line per role (manager and board_helper resolved, leads listed)
       route_target.py --team [--json]   every live session of this project by role: manager, leads,
                                         board helper, workers/other
Exit:  0 resolved, 3 no live match, 4 several matches, 5 agent host unreachable, 2 unknown role.
"""
from __future__ import annotations

import fnmatch
import json
import os
import pathlib
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402

DEFAULT_ROLES = {"manager": "*[0-9]-manager", "lead": "*-lead", "board_helper": "*board-helper*"}
# Roles that exactly one live session holds; `lead` is plural by design.
SINGLE_ROLES = ("manager", "board_helper")
NOT_LIVE = {"history_only", "stopped", "ended"}


class RouteError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def roles() -> dict:
    return {**DEFAULT_ROLES, **(pm_config.get_data("PM_ROUTE_ROLES", {}) or {})}


def host_url() -> str:
    explicit = os.environ.get("XTRM_AGENT_HOST_URL")
    if explicit:
        return explicit.rstrip("/")
    info = pm_config.path("PM_AGENT_HOST_INFO", "~/.xtrm/run/agent-host.json")
    try:
        data = json.loads(info.read_text())
        return f"http://{data.get('address', '127.0.0.1')}:{data['port']}"
    except (OSError, ValueError, KeyError) as exc:
        raise RouteError(5, f"agent host info unreadable at {info} ({type(exc).__name__}); is `xt host` running?")


def sessions() -> list[dict]:
    try:
        with urllib.request.urlopen(host_url() + "/v1/sessions", timeout=10) as resp:
            return json.load(resp).get("sessions") or []
    except (OSError, ValueError) as exc:
        raise RouteError(5, f"agent host unreachable ({type(exc).__name__}: {exc})")


def address(s: dict) -> str:
    """The name SendMessage takes: the worktree directory name when the session runs in one, else its name."""
    parts = pathlib.PurePath(s.get("cwd") or "").parts
    if "worktrees" in parts:
        i = parts.index("worktrees")
        if i + 1 < len(parts):
            return parts[i + 1]
    return s.get("name") or ""


def in_project(s: dict) -> bool:
    slug = pm_config.get("PM_REPO_SLUG")
    dirs = [d for d in [pm_config.get("PM_REPO_DIR"), *(pm_config.get_data("PM_MATCH_DIRS", []) or [])] if d]
    if not slug and not dirs:
        return True
    if slug and s.get("repository") == slug:
        return True
    cwd = pathlib.Path(s.get("cwd") or "/nonexistent")
    for d in dirs:
        try:
            cwd.relative_to(pathlib.Path(str(d)).expanduser())
            return True
        except ValueError:
            continue
    return False


def _live_in_project(live: list[dict]) -> list[dict]:
    return [s for s in live if s.get("state") not in NOT_LIVE and in_project(s)]


def _holds(s: dict, pattern: str) -> bool:
    return fnmatch.fnmatch(address(s), pattern) or fnmatch.fnmatch(s.get("name") or "", pattern)


def matches(role: str, live: list[dict] | None = None) -> list[dict]:
    """Every live session of this project whose address or name matches the role's pattern."""
    pattern = roles().get(role)
    if pattern is None:
        raise RouteError(2, f"unknown role {role!r}; configured: {', '.join(sorted(roles()))}")
    live = sessions() if live is None else live
    return [s for s in _live_in_project(live) if _holds(s, pattern)]


def record(role: str, s: dict) -> dict:
    return {"role": role, "address": address(s), "name": s.get("name"), "session_id": s.get("sessionId"),
            "state": s.get("state"), "pane": (s.get("tmux") or {}).get("paneId")}


def resolve(role: str, live: list[dict] | None = None) -> dict:
    """The one live session holding ``role``. Several matches is an error for every role, `lead` included:
    a caller that needs one lead of several passes its name instead."""
    found = matches(role, live)
    pattern = roles()[role]
    if not found:
        raise RouteError(3, f"no live session of this project matches {role} pattern {pattern!r}; "
                            f"launch it with a matching name (references/setup.md, \"Routing roles\")")
    if len(found) > 1:
        hint = ("; name the lead you mean" if role not in SINGLE_ROLES else "; exactly one may hold the role")
        raise RouteError(4, f"{len(found)} live sessions match {role} pattern {pattern!r}: "
                            f"{', '.join(sorted(address(s) for s in found))}{hint}")
    return record(role, found[0])


def find(name: str, live: list[dict] | None = None) -> dict | None:
    """The one live project session whose address or name is ``name`` (or ends with ``-<name>``), else None."""
    live = _live_in_project(sessions() if live is None else live)
    exact = [s for s in live if name in (address(s), s.get("name"))]
    found = exact or [s for s in live if address(s).endswith("-" + name) or (s.get("name") or "").endswith("-" + name)]
    return record("named", found[0]) if len(found) == 1 else None


def team(live: list[dict] | None = None) -> dict:
    """Every live session of this project grouped by role: {role: [record]}, plus "other" (workers and the rest).
    A session matching several patterns is listed under the first role in roles() order."""
    live = _live_in_project(sessions() if live is None else live)
    pats = roles()
    out: dict[str, list[dict]] = {r: [] for r in pats}
    out["other"] = []
    for s in sorted(live, key=address):
        role = next((r for r, p in pats.items() if _holds(s, p)), "other")
        out[role].append(record(role, s))
    return out


def print_team(t: dict) -> None:
    for role in [*[r for r in t if r != "other"], "other"]:
        label = "workers/other" if role == "other" else role
        names = ", ".join(r["address"] for r in t[role]) or "-"
        print(f"team    {label:<14} {names}")


def main(argv: list[str]) -> int:
    if argv[:1] in (["--all"], ["--team"]):
        try:
            live = sessions()
        except RouteError as exc:
            print(f"ERROR   {exc}")
            return exc.code
        if argv[0] == "--team":
            t = team(live)
            if argv[1:] == ["--json"]:
                print(json.dumps(t))
            else:
                print_team(t)
            return 0
        worst = 0
        for role in sorted(roles()):
            if role not in SINGLE_ROLES:
                found = matches(role, live)
                print(f"route   {role:<14} -> {', '.join(sorted(address(s) for s in found)) or '(none live)'}")
                continue
            try:
                print(f"route   {role:<14} -> {resolve(role, live)['address']}")
            except RouteError as exc:
                print(f"UNROUTED {role:<13} {exc}")
                worst = worst or exc.code
        return worst
    if len(argv) not in (1, 2) or (len(argv) == 2 and argv[1] != "--json"):
        print("usage: " + __doc__.split("Usage: ", 1)[1].split("\nExit:", 1)[0].strip())
        return 2
    try:
        target = resolve(argv[0])
    except RouteError as exc:
        print(f"route_target: {exc}", file=sys.stderr)
        return exc.code
    print(json.dumps(target) if len(argv) == 2 else target["address"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
