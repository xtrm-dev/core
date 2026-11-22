#!/usr/bin/env python3
"""Reconcile the operator's answers every pass: answers/* against questions/* against pending-routes.

Why (MMD-5389, 2026-11-18): an answer that never became a pending route cannot be delivered, alarmed or marked,
so silence looked exactly like success three times in one day (answers:25 late, three answers never enqueued,
answers:49 unread while repeating in the alarm until a close overwrote it). route-backlog.py counts routes that
EXIST and are undelivered; nothing counted answers that never got a route at all. This closes that hole with one
line per pass and a count:

  ANSWER-RECONCILE <stamp> answers=N questions=M routed=R open=O unrouted=U young=Y history=H pending=P
                   result=OK|ALARM

answers = every answers/* doc newer than the seed (the population); routed = the ones the lane can account for;
unrouted = the ones it cannot and that are inside the alarm window; young = too fresh to have failed yet;
history = older than the last answer that arrived and outside the lookback. answers = routed + unrouted + young +
history, always: nothing is dropped silently.

An answer (from the board's answers/* store, newer than status_board_answer_seed_at) is ROUTED when the lane can
show one of:
  - a transport delivery by the sync: its inbox row's `delivered` is `xtmux:...` or `send-keys:...`;
  - a pending-routes row for it, delivered or not (an undelivered route is route-backlog.py's alarm, not this
    script's);
  - its question is CLOSED and its delivery was not file-only: a bare ok on a row already handled is noise, and
    route-watch.py suppresses it on purpose (the negative control).
Every other answer older than GRACE_MIN minutes prints one ANSWER-UNROUTED line (at most MAX_LINES lines, then one
suppressed count; the count is always exact) with its id, its question's state and the reason (never-enqueued |
marked-routed-not-delivered | file-only-no-route | no-route). An answer younger than GRACE_MIN counts as young and
is not alarmed: the sync runs every five minutes, so a fresh answer has not failed yet. SUCCESS is a delivered
route or a visible alarm within 15 minutes, and GRACE_MIN is that bound.

The window: an answer newer than the last answer that actually arrived somewhere is always in scope; an answer
older than that watermark is history unless it is also within PM_ANSWER_RECONCILE_LOOKBACK_H hours (default 24).
The pre-fix backlog is the second case (46 of 47 answers marked routed and delivered nowhere) and must alarm; the
seventeen days before it must not drown the line that has to be read within fifteen minutes.

FAILS CLOSED. When the store cannot be read (credentials, network, an unparsable answers/questions doc), it prints
the same line with answers=UNMEASURED and result=UNMEASURED and exits 2. A count of zero is only ever printed
after a successful read: "no answers" and "could not look" must not print the same number.

Reads: the here.now data API (the same list endpoint lane-watchdog.py trusts), <status board state>/state.json for
the ids the sync has routed, pm_config.answers_inbox() and <lane>/pending-routes.jsonl.

Closing the loop: an alarm that nobody can clear becomes noise, so an answer that was delivered by hand (the
operator's text sent to the asker, the answer re-typed into a session) is recorded with
`--ack <qid> --to <session>`: one delivered pending-routes row, the same artifact route-forward.py and
mark-sent.py use, so route-backlog.py stays quiet for it. `--ack` without `--to` is refused: an ack names where
the answer went.

Called from scheduler.sh in the route pass (every 5 minutes).

Run: python3 reconcile-answers.py [--ack <qid> --to <session>] ...
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import lanecfg

LANE = lanecfg.lane()
OUTBOX = os.path.join(LANE, "pending-routes.jsonl")
STATE_FILE = os.path.join(str(lanecfg.pm_config.status_board_state_dir()), "state.json")
SEED_AT = str(lanecfg.get("PM_STATUS_BOARD_ANSWER_SEED_AT", "") or "")
SITE = str(lanecfg.get("PM_STATUS_BOARD_SITE", required=True))
KEY_FILE = os.path.expanduser(str(lanecfg.get("PM_STATUS_BOARD_KEY_FILE", "~/.herenow/credentials")))
BASE = "https://here.now/api/v1/publishes/%s/data/docs" % SITE
GRACE_MIN = 15
DEFAULT_LOOKBACK_H = 24
MAX_LINES = 20


def _lookback():
    """(hours, note). Never below the grace window, never a crash on a value that is not a number.

    A lookback shorter than GRACE_MIN would put the horizon inside the grace window, and an answer younger than
    the grace would be both young and history: the clamp keeps the two buckets disjoint (the review found 392
    such breaks at 0.1 h). A value that is not a number must not take the whole pass down at import: fall back to
    the default and say so in the pass output.
    """
    raw = str(lanecfg.get("PM_ANSWER_RECONCILE_LOOKBACK_H", "") or "").strip()
    if not raw:
        return DEFAULT_LOOKBACK_H, ""
    floor = GRACE_MIN / 60.0
    try:
        hours = float(raw)
    except ValueError:
        return DEFAULT_LOOKBACK_H, ("PM_ANSWER_RECONCILE_LOOKBACK_H=%r is not a number; using %g h"
                                    % (raw, DEFAULT_LOOKBACK_H))
    if hours < floor:
        return floor, ("PM_ANSWER_RECONCILE_LOOKBACK_H=%g is below the %d min grace; using %g h"
                       % (hours, GRACE_MIN, floor))
    return hours, ""


LOOKBACK_H, LOOKBACK_NOTE = _lookback()
# The lane's own read of the key the sync uses: a listed owner's answer is delivered by its inbox line alone,
# so it must have a lane route even when the question is already closed (MMD-5389).
FILE_ONLY = lanecfg.file_only()
TRANSPORT = ("xtmux:", "send-keys:")


class StoreUnreadable(Exception):
    """The answers/questions store could not be read: UNMEASURED, never a zero."""


def stamp(now=None):
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value):
    try:
        t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def age_min(when, now=None):
    """Minutes since a parsed timestamp (None when the input has no time in it)."""
    if when is None:
        return None
    return ((now or datetime.now(timezone.utc)) - when).total_seconds() / 60


def read_store():
    """{path: doc} for the whole board data store, or StoreUnreadable.

    One non-200, one network error, one record without a path, one unparsable answers/questions doc and the whole
    read is unknown: a partial list would under-count the answers and print a confident number that is wrong.
    """
    try:
        with open(KEY_FILE) as fh:
            key = fh.read().strip()
    except OSError as exc:
        raise StoreUnreadable("credentials unreadable: %s" % exc)
    if not key:
        raise StoreUnreadable("credentials empty: %s" % KEY_FILE)
    out, cursor = {}, None
    while True:
        url = BASE + "?limit=100"
        if cursor:
            url += "&cursor=" + urllib.parse.quote(cursor)
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key,
                                                   "Accept": "application/json",
                                                   "User-Agent": "reconcile-answers/MMD-5389"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                body = json.loads(r.read() or b"{}")
        except Exception as exc:  # HTTPError, URLError, timeout, bad JSON: one fact, UNMEASURED
            raise StoreUnreadable("list failed: %s" % str(exc)[:160])
        for rec in body.get("records") or []:
            data = rec.get("data") or {}
            path = data.get("path")
            if not path:
                # A record with no path is a store we cannot enumerate: counting only the records we understand
                # is exactly the silent under-count this script exists to prevent.
                raise StoreUnreadable("record without a path")
            doc = data.get("doc")
            if isinstance(doc, str):
                try:
                    doc = json.loads(doc)
                except ValueError:
                    doc = None
            if doc is None and (path.startswith("answers/") or path.startswith("questions/")):
                raise StoreUnreadable("unparsable doc %s" % path)
            out[path] = doc or {}
        cursor = body.get("nextCursor")
        if not cursor:
            return out


def read_jsonl(path):
    """Rows of a JSONL file the pack writes; a malformed line is skipped, never fatal (the writers escape JSON)."""
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def read_state():
    """(routed answer ids, note). An unreadable state is a note, not an UNMEASURED: the ledger still measures."""
    if not os.path.exists(STATE_FILE):
        return set(), "state-missing"
    try:
        with open(STATE_FILE, encoding="utf-8") as fh:
            state = json.load(fh) or {}
    except (ValueError, OSError):
        return set(), "state-unparsable"
    return {str(x) for x in (state.get("routed_answer_ids") or [])}, ""


def questions_open(store):
    """{question id: asker} for every question row still on the board, across all questions/<owner> docs."""
    out = {}
    for path, doc in store.items():
        if not path.startswith("questions/") or not isinstance(doc, dict):
            continue
        for row in doc.get("rows") or []:
            if isinstance(row, dict) and row.get("id"):
                out[str(row["id"])] = str(row.get("by") or path.split("/", 1)[1])
    return out


def route_rows(qid, outbox):
    """The pending-route rows for one answer: route-watch.py keys an answers row by its qid."""
    return [r for r in outbox if r.get("key") == qid or r.get("id") == "answers:" + qid]


def reconcile(store, inbox, outbox, routed_ids, now=None):
    """(summary, lines). Pure: every input is already read, so the replay fixture can drive it. No network.

    The window, and why it is two rules, not one:
    - an answer NEWER than the last answer that actually arrived somewhere (a route row, or a transport
      delivery) is always in scope: if the sync stopped, that watermark stops moving and the loss is loud;
    - an answer older than that watermark was already superseded by something that did arrive, so it is history
      -- UNLESS it is within LOOKBACK_H hours, because "superseded" is exactly what the pre-fix backlog looks
      like (46 of 47 answers stamped delivered=file-only, marked routed, delivered nowhere) and a day of those
      must alarm, not a day plus seventeen.
    """
    now = now or datetime.now(timezone.utc)
    question_open = questions_open(store)
    inbox_by_qid = {}
    for row in inbox:
        if row.get("qid"):
            inbox_by_qid[str(row["qid"])] = row   # the sync appends once per answer; last one wins
    routed = {str(x) for x in (routed_ids or [])}
    seed = parse_ts(SEED_AT) if SEED_AT else None
    facts = []
    for path in sorted(store):
        if not path.startswith("answers/"):
            continue
        qid = path[len("answers/"):]
        doc = store[path] if isinstance(store[path], dict) else {}
        when = parse_ts(doc.get("at"))
        if seed is not None and when is not None and when < seed:
            continue
        entry = inbox_by_qid.get(qid) or {}
        delivered = str(entry.get("delivered") or "")
        is_open = qid in question_open
        # A recorded file-only delivery, or none at all to an owner the config lists: either way the inbox
        # line was the whole delivery, so this answer needs a lane route or it reached nobody.
        file_only = (delivered == "file-only"
                     or (not delivered and str(entry.get("owner") or "") in FILE_ONLY))
        transport = delivered.startswith(TRANSPORT)
        accounted = (transport or bool(route_rows(qid, outbox))
                     or bool(entry and not is_open and not file_only))
        facts.append({"qid": qid, "when": when, "entry": entry, "delivered": delivered,
                      "is_open": is_open, "file_only": file_only, "accounted": accounted})
    marks = [f["when"] for f in facts if f["accounted"] and f["when"]]
    watermark = max(marks) if marks else None
    horizon = now - timedelta(hours=LOOKBACK_H)
    lines, unrouted, young, history = [], [], 0, 0
    for f in facts:
        if f["accounted"]:
            continue
        when, age = f["when"], age_min(f["when"], now)
        if age is not None and age < GRACE_MIN:
            young += 1
            continue
        if watermark is not None and when is not None and when < watermark and when < horizon:
            history += 1   # older than the last thing that arrived AND outside the lookback
            continue
        if not f["entry"]:
            reason = "never-enqueued" if f["qid"] not in routed else "marked-routed-not-delivered"
        elif f["file_only"]:
            reason = "file-only-no-route"
        else:
            reason = "no-route"
        unrouted.append(f["qid"])
        if len(lines) < MAX_LINES:
            # The asker when the question is still open: the alarm is then actionable as it stands, with the exact
            # --to route-forward.py needs. A closed question has no asker left to name.
            asker = (" asker=%s" % question_open[f["qid"]]) if f["is_open"] else ""
            lines.append("ANSWER-UNROUTED %s id=%s question=%s%s age=%smin reason=%s%s" %
                         (stamp(now), f["qid"], "open" if f["is_open"] else "closed", asker,
                          "?" if age is None else "%.0f" % age, reason,
                          "" if f["entry"] else " (no inbox row: the sync never appended it)"))
    if len(unrouted) > len(lines):
        lines.append("ANSWER-UNROUTED-MORE %s suppressed=%d (the ANSWER-RECONCILE count is exact)"
                     % (stamp(now), len(unrouted) - len(lines)))
    summary = {
        "answers": len(facts),
        "history": history,
        "questions": len(question_open),
        "routed": sum(1 for f in facts if f["accounted"]),
        "open": sum(1 for f in facts if f["is_open"]),
        "unrouted": len(unrouted),
        "young": young,
        "pending": len([r for r in outbox if r.get("channel") == "answers" and not r.get("delivered")]),
    }
    return summary, lines


def ack(qid, to, note=""):
    """Record that one answer was delivered by hand: a delivered route row, the artifact the lane already uses."""
    row = {"id": "answers:ack-" + qid, "channel": "answers", "key": qid, "cid": None,
           "author": "reconcile-ack", "at": stamp(), "trigger": "manual-ack", "text": "",
           "seen_at": stamp(), "delivered": True, "to": to, "note": (note or "")[:200]}
    with lanecfg.outbox_lock(OUTBOX):
        with open(OUTBOX, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
    return row


def main(argv=None):
    ap = argparse.ArgumentParser(description="Reconcile operator answers against questions and pending routes.")
    ap.add_argument("--ack", action="append", default=[], metavar="QID",
                    help="an answer id delivered by hand; record it as a delivered route (needs --to)")
    ap.add_argument("--to", default="", metavar="SESSION", help="where the acked answer was delivered")
    ap.add_argument("--note", default="", help="one line of context for the ack")
    args = ap.parse_args(argv)
    if args.ack:
        if not args.to.strip():
            print("ANSWER-RECONCILE-ACK-REFUSED %s reason=no-destination (--ack needs --to <session>)"
                  % stamp())
            return 3
        for qid in args.ack:
            ack(qid, args.to.strip(), args.note)
        print("ANSWER-RECONCILE-ACK %s ids=%s to=%s" % (stamp(), ",".join(args.ack), args.to.strip()))
    routed_ids, note = read_state()
    if LOOKBACK_NOTE:
        print("ANSWER-RECONCILE-NOTE %s %s" % (stamp(), LOOKBACK_NOTE))
    if note:
        print("ANSWER-RECONCILE-NOTE %s %s; measuring with the inbox and the outbox alone"
              % (stamp(), note))
    try:
        store = read_store()
    except StoreUnreadable as exc:
        print("ANSWER-RECONCILE %s answers=UNMEASURED questions=UNMEASURED routed=UNMEASURED "
              "open=UNMEASURED unrouted=UNMEASURED young=UNMEASURED pending=UNMEASURED "
              "result=UNMEASURED reason=%s" % (stamp(), str(exc)[:200]))
        return 2
    summary, lines = reconcile(store, read_jsonl(str(lanecfg.pm_config.answers_inbox())),
                               read_jsonl(OUTBOX), routed_ids)
    for line in lines:
        print(line)
    print("ANSWER-RECONCILE %s answers=%d questions=%d routed=%d open=%d unrouted=%d young=%d history=%d "
          "pending=%d result=%s" % (stamp(), summary["answers"], summary["questions"], summary["routed"],
                                    summary["open"], summary["unrouted"], summary["young"],
                                    summary["history"], summary["pending"],
                         "ALARM" if summary["unrouted"] else "OK"))
    return 1 if summary["unrouted"] else 0


if __name__ == "__main__":
    sys.exit(main())
