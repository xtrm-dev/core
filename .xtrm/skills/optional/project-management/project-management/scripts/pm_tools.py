#!/usr/bin/env python3
"""Tool cards: the one source of "which tools you use, when, and how" for each pack role.

Read by pm_session.py (show, tools), the post-compact hook and the checkpoint hook's tools reminder, so the cards never
diverge. A card is one line: the tool, when to use it, the command. A project adds its own lines with the setting
tool_cards_extra ({role or "all": [line]}); the pack holds no instance data.

  pm_tools.py [role]      print the cards for a role (default: this session's role)
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402

_root = str(pm_config.PACK_ROOT)
_home = os.path.expanduser("~")
PACK = "~" + _root[len(_home):] if _root.startswith(_home + os.sep) else _root  # the real pack path, ready to copy

COMMON = [
    "journal-search: before you ask a peer what was decided, reported or handed off -> "
    f"python3 {PACK}/journal-search/scripts/jsearch.py \"<words>\"; a hit is a pointer: open it with sb journal show, re-check it live",
    "service-knowledge (skill + CLI): before you read a service's source -> /service-knowledge or /scope, then "
    "service-knowledge index query \"<text>\"; after a change to a service, its update flow (service-knowledge drift)",
    "sb help <group>: before a sb verb you have not used this session",
]
SPECIALISTS = (
    "specialists: the default for building and reviews (SKILL.md rule 1) -> specialist_list, specialist_dispatch "
    "{specialist, issue_ref}; give a kept-alive one its next issue with specialist_reply; stop it with specialist_stop_activation "
    "when its role has no queued work"
)
CARDS = {
    "manager": [
        "lead journals: once per hourly cycle -> sb journal since <ref> <seq>; rule in one batched message per lead, or none; "
        "never ask for status, never acknowledge (rule 40)",
        f"route_target.py: address peers by role -> python3 {PACK}/project-management/scripts/route_target.py --team",
        "pm_question.py: a question for the operator -> pm_question.py add --ref <ref> --q <text> --rec <text>",
        SPECIALISTS,
    ],
    "lead": [
        "decide and journal: a decision, merge or status goes to your journal (decision, result); message the manager only "
        "for what cannot wait an hour (rule 40)",
        SPECIALISTS + "; keep one pr-reviewer specialist alive for every PR of your workstream (rule 44)",
        "merge: your master-only PRs after the rule-44 review, gh pr merge --match-head-commit <sha> with the memory gate (rule 49)",
        "route_target.py --team: another lead's session name for a cross-workstream question",
    ],
    "worker": [
        "your contract: sb issue show <ref>; journal each milestone; close with a result (rule 54)",
        "specialists named in your VALIDATION: dispatch them and put the activation ids in your result (rule 52)",
    ],
    "board_helper": [
        "post-guard.py: every Jira comment -> post-guard.py <KEY> <file> --run <WORD> [--mention-first]",
        "route-forward.py --to <name>: deliver a routed operator decision; route-backlog.py shows what is undelivered",
    ],
}


def cards(role: str) -> list[str]:
    """The cards for a role: its own, the common ones, then the project's tool_cards_extra for the role and for all."""
    out = list(CARDS.get(role, [])) + list(COMMON)
    try:
        extra = pm_config.get_data("PM_TOOL_CARDS_EXTRA", {}) or {}
    except SystemExit:
        extra = {}
    if isinstance(extra, dict):
        for key in (role, "all"):
            val = extra.get(key) or []
            out += [val] if isinstance(val, str) else [str(v) for v in val]
    return out


def block(role: str, head: str = "TOOLS") -> list[str]:
    return [f"{head} ({role}): use them; each line says when"] + [f"  - {c}" for c in cards(role)]


def main(argv: list[str]) -> int:
    if argv:
        role = argv[0]
    else:
        import pm_role
        role = pm_role.current()
    print("\n".join(block(role)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
