#!/usr/bin/env python3
"""Session kit for the project-management pack: the worktree files a session needs, and the project's common goal.

Every manager, lead and worker runs `pm_session.py show` as its first step (and after every compaction); whoever
launches a session runs `pm_session.py init` in the new worktree when the launch alone does not say everything.

  pm_session.py show [--dir D]                       role and its source, project, bound issue, kit warnings, goal
  pm_session.py init [--role R] [--issue REF] [--dir D]
                                                     write what the launch did not: .pm-role only when the launch
                                                     role does not already give R; .substrate-issue for REF; both
                                                     kept out of git (info/exclude)
  pm_session.py goal [--dir D]                       the common-goal block alone, to paste into a launch prompt

The common goal is what every session of the project serves beyond its own issue: the goal document (setting
goal_doc, a path relative to repo_dir, for example a PRD), the Substrate epic (epic) with its success criteria, the
Jira epic (jira_epic) and any extra pointers (goal_refs). The text lives in those sources; this script only points at
them and quotes the goal document's opening paragraph. Reads only; `init` writes the two kit files.
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402
import pm_role  # noqa: E402

ISSUE_FILE = ".substrate-issue"
STATEMENT_MAX = 700


def _setting(name: str, default=None):
    try:
        return pm_config.get(name, default)
    except SystemExit:
        return default


def _setting_data(name: str, default=None):
    try:
        return pm_config.get_data(name, default)
    except SystemExit:
        return default


def _run(args: list[str], cwd=None, timeout=20) -> str | None:
    try:
        r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout if r.returncode == 0 else None


def goal_doc_path() -> pathlib.Path | None:
    doc = _setting("PM_GOAL_DOC")
    if not doc:
        return None
    p = pathlib.Path(str(doc)).expanduser()
    if not p.is_absolute():
        repo = _setting("PM_REPO_DIR")
        if not repo:
            return p
        p = pathlib.Path(str(repo)).expanduser() / p
    return p


def statement(path: pathlib.Path) -> str:
    """The goal document's opening paragraph: the first prose block after its title."""
    try:
        text = path.read_text()
    except OSError:
        return ""
    para: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            if para:
                break
            continue
        if s.startswith(("#", "---", "|", "```", ">")) and not para:
            continue
        para.append(s)
    out = " ".join(para)
    return out if len(out) <= STATEMENT_MAX else out[:STATEMENT_MAX].rsplit(" ", 1)[0] + " …"


def epic_success(ref: str) -> tuple[str | None, str | None]:
    """(title, success) of a Substrate issue, or (None, None) when sb cannot read it."""
    out = _run([str(_setting("PM_SB_BIN", "sb")), "issue", "show", ref, "--json"])
    if not out:
        return None, None
    try:
        data = json.loads(out).get("data") or {}
    except ValueError:
        return None, None
    return data.get("title"), (data.get("contract") or {}).get("success")


def goal_lines(read_epic: bool = True) -> list[str]:
    lines = []
    doc = goal_doc_path()
    if doc is not None:
        if doc.is_file():
            sha = (_run(["git", "log", "-1", "--format=%h", "--", doc.name], cwd=doc.parent) or "").strip()
            lines.append(f"  goal document: {doc}" + (f" @ {sha}" if sha else ""))
            st = statement(doc)
            if st:
                lines.append(f"  it says: {st}")
        else:
            lines.append(f"  goal document: {doc} (MISSING: fix goal_doc in the config)")
    epic = _setting("PM_EPIC")
    if epic:
        title, success = epic_success(str(epic)) if read_epic else (None, None)
        lines.append(f"  Substrate epic: {epic}" + (f" — {title}" if title else ""))
        if success:
            lines.append(f"  epic success: {' '.join(str(success).split())[:STATEMENT_MAX]}")
    jira_epic = _setting("PM_JIRA_EPIC")
    if jira_epic:
        lines.append(f"  Jira epic: {jira_epic}")
    for ref in _setting_data("PM_GOAL_REFS", []) or []:
        lines.append(f"  also: {ref}")
    if not lines:
        return [("COMMON GOAL: none configured. The manager sets goal_doc (and epic, jira_epic) in the project's "
                 "config profile (references/setup.md); until then ask the manager what the project as a whole must "
                 "achieve.")]
    head = ("COMMON GOAL (every session of this project serves it, beyond its own issue). Read the goal document "
            "before you plan; when your work and the goal disagree, stop and ask your lead or the manager:")
    return [head, *lines]


def bound_issue(directory) -> str | None:
    ref = os.environ.get("SUBSTRATE_ISSUE_REF") or os.environ.get("SUBSTRATE_ISSUE")
    if ref:
        return ref.strip()
    root = pm_role.worktree_root(directory)
    for d in [pathlib.Path(directory), *([root] if root else [])]:
        try:
            line = (d / ISSUE_FILE).read_text().splitlines()[0].strip()
        except (OSError, IndexError):
            continue
        if line:
            return line
    return None


def kit(directory) -> list[str]:
    launch = os.environ.get("XTMUX_AGENT_ROLE")
    role, src = pm_role.source(os.environ.get("SUBSTRATE_HOLDER") or os.environ.get("XTRM_SESSION_NAME"),
                               directory, launch)
    try:
        project, why = pm_config.select_project()
    except SystemExit as exc:
        project, why = None, str(exc)
    issue = bound_issue(directory)
    lines = [f"role: {role} (from {src}" + (f", launched as {launch}" if launch else "") + ")",
             f"project: {project or '-'} ({why})", f"bound issue: {issue or '-'}"]
    warn = []
    if src in ("name", "default") and role != "worker":
        warn.append(f"role comes only from the session name: relaunch with --role {role}, or pm_session.py init "
                    f"--role {role}")
    if role == "worker" and src == "default" and not issue:
        warn.append("no role and no bound issue: if you are a manager or a lead, run pm_session.py init --role <r>")
    if not issue:
        warn.append("no bound issue: pm_session.py init --issue <ref> (a worker: its issue; a lead: its workstream "
                    "epic; the manager: manager_issue)")
    if len(pm_config.project_names()) > 1 and not os.environ.get("PM_PROJECT"):
        warn.append(f"several projects in the config and PM_PROJECT unset: export PM_PROJECT={project or '<name>'}")
    lines += [f"KIT: {w}" for w in warn] or ["kit: complete"]
    return lines


def init(role: str | None, issue: str | None, directory) -> list[str]:
    done = []
    root = pm_role.worktree_root(directory) or pathlib.Path(directory)
    if role:
        if role not in pm_role.ROLES:
            raise ValueError(f"role must be one of {', '.join(pm_role.ROLES)}")
        launched = pm_role.by_launch(os.environ.get("XTMUX_AGENT_ROLE"))
        if launched == role and not pm_role.declared(directory):
            done.append(f"role {role} comes from the launch; no role file needed")
        else:
            done.append(f"wrote {pm_role.write(role, root)}")
    if issue:
        path = root / ISSUE_FILE
        tmp = path.with_suffix(".tmp")
        tmp.write_text(issue.strip() + "\n")
        os.replace(tmp, path)
        pm_role.exclude(root, ISSUE_FILE)
        done.append(f"wrote {path} ({issue.strip()})")
    return done


def main(argv: list[str]) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="pm_session.py", description=__doc__.splitlines()[0])
    ap.add_argument("action", choices=("show", "init", "goal"))
    ap.add_argument("--dir", default=None)
    ap.add_argument("--role", default=None)
    ap.add_argument("--issue", default=None)
    a = ap.parse_args(argv)
    directory = a.dir or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    if a.action == "goal":
        print("\n".join(goal_lines()))
        return 0
    if a.action == "init":
        if not (a.role or a.issue):
            ap.error("init needs --role and/or --issue")
        for line in init(a.role, a.issue, directory):
            print(line)
    print("\n".join(kit(directory)))
    print("\n".join(goal_lines()))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ValueError as exc:
        sys.exit(f"pm_session: {exc}")
