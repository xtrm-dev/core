#!/usr/bin/env python3
"""Positive/negative controls for the router classifier, drawn from the artefact the router reads (Jira).

Why: a router that stops and an inbox with no news look identical. Before arming this lane's loop, the
classifier must say YES to a comment that needs a decision and NO to one that does not, on real operator
comments pulled live in the same run — not on a synthetic string.

Each case names a real comment id and the verdict it must produce (config key route_control_cases:
a list of [jira-key, comment-id, expected-kind, why]). Both directions are required:
  positive  a real approval / question / standing instruction  -> decision
  negative  a bare ack, an empty body with answer: yes          -> info
"""
import importlib.util
import sys

import lanecfg
import jira  # noqa: E402  (on sys.path through lanecfg)

LANE = lanecfg.lane()
OPERATOR_ID = lanecfg.operator_account_id()
OPERATOR = lanecfg.operator_name()

# (key, comment-id, expected kind, why): real operator comments on this board, from the config file
CASES = [tuple(c) for c in lanecfg.data("PM_ROUTE_CONTROL_CASES", required=True)]

# Negative cases are classified from their stored body; an empty body carrying answer: yes is the
# Tabellone shape and never reaches Jira, so it is passed to the classifier directly.
NEGATIVE_LITERAL = [
    ("", "yes", "info", "empty body + answer:yes is an ack, not a decision"),
    ("ok.", None, "info", "bare ack"),
]

# DOCUMENTED DIVERGENCE, not a defect. board-audit SKILL.md says "@xtrm-bot ok." must be INFO, while
# route-watch.py carries a LATER dated ruling (coordinator, 2026-11-01T12:00Z): every operator comment that
# tags the bot is a DECISION about the row it sits on, ordered before the ACK test on purpose. The later,
# narrower rule wins and it matches the "err toward forwarding" doctrine, so the control encodes the code.
MENTION_CASES = [
    ("@xtrm-bot ok.", "decision", "mention-bot", "bot mention outranks the ack test (2026-11-01T12:00Z ruling)"),
]


def classify():
    spec = importlib.util.spec_from_file_location("routewatch", str(lanecfg.SCRIPTS / "route-watch.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.classify


def flat(node, out):
    if isinstance(node, dict):
        t = node.get("type")
        if t == "text":
            out.append(node.get("text", ""))
        elif t == "mention":
            out.append("@" + (node.get("attrs") or {}).get("text", ""))
        elif t in ("paragraph", "listItem", "hardBreak"):
            out.append("\n")
        for v in node.get("content") or []:
            flat(v, out)
    elif isinstance(node, list):
        for v in node:
            flat(v, out)


def body_of(key, cid):
    st, b = jira.call("GET", f"/rest/api/3/issue/{key}/comment/{cid}")
    if st >= 300:
        return None, None
    out = []
    flat(b.get("body"), out)
    author = (b.get("author") or {})
    return "".join(out).strip(), author.get("accountId")


def main():
    fn = classify()
    failures = 0
    print(f"ROUTE-CONTROLS lane={LANE}")
    for key, cid, want, why in CASES:
        text, aid = body_of(key, cid)
        if text is None:
            print(f"  UNMEASURED {key} c{cid}: comment read failed ({why})")
            failures += 1
            continue
        kind, trigger = fn(text, None, author_id=aid, author=OPERATOR)
        ok = kind == want
        failures += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'} {key} c{cid} -> {kind}/{trigger} (want {want}) :: {why}")
        print(f"       first 90 chars: {text[:90]!r}")
    for text, answer, want, why in NEGATIVE_LITERAL:
        kind, trigger = fn(text, answer, author_id=OPERATOR_ID, author=OPERATOR)
        ok = kind == want
        failures += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'} literal answer={answer!r} text={text!r} -> {kind}/{trigger} "
              f"(want {want}) :: {why}")
    for text, want, want_trigger, why in MENTION_CASES:
        kind, trigger = fn(text, None, author_id=OPERATOR_ID, author=OPERATOR)
        ok = kind == want and trigger == want_trigger
        failures += 0 if ok else 1
        print(f"  {'PASS' if ok else 'FAIL'} literal text={text!r} -> {kind}/{trigger} "
              f"(want {want}/{want_trigger}) :: {why}")
    print(f"ROUTE-CONTROLS {'PASS' if not failures else 'FAILURES=' + str(failures)}")
    return 0 if not failures else 3


if __name__ == "__main__":
    sys.exit(main())
