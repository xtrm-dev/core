#!/usr/bin/env python3
"""Router for the operator's inbound channels (operator ruling 2026-11-01T05:13Z).

The coordinator stopped watching the two inboxes; this lane is now the only router and filter.
Rule: FORWARD at once only when a comment needs a coordinator DECISION — a GO, an approval or a refusal,
a question to the coordinator, a production or window matter, or a halt. Everything else becomes one line
in the cycle report. Acks on rows already handled ("ok", "yes") are never forwarded one by one.

Channels (settings in board-audit/references/setup-lane.md):
  PM_BOT_INBOX       operator comments that mention the bot (written by the xtrm-bot watcher;
                     default <state_dir>/xtrm-bot-watch/inbox.jsonl)
  PM_ANSWERS_INBOX   Status board answers (written by status_board_sync.py;
                     default <status_board_state_dir>/answers-inbox.jsonl)

The classifier is explicit and prints the trigger it matched, so a misroute is auditable by the person who
receives it. It errs toward DECISION: a comment forwarded that did not need to be costs one message, a
decision never forwarded costs a day.
"""
import json
import os
import re
import subprocess
import sys

import lanecfg

LANE = lanecfg.lane()
CURSOR = f"{LANE}/route-cursor.json"
CHANNELS = {
    # One path per inbox, shared with status_board_sync.py through pm_config (defaults under the state dirs).
    "inbox": str(lanecfg.pm_config.bot_inbox()),
    "answers": str(lanecfg.pm_config.answers_inbox()),
}
DECISION = [
    # 'question' FIRST (2026-11-01): "i do not see issue 558 ... why?" was labelled trigger=negative, which
    # invites the reader to treat an ask as a veto. A '?' is the strongest signal in the list, so it goes first;
    # 'halt' and 'negative' still catch a bare "stop" or "do not merge" that carries no question mark.
    ("question", re.compile(r"\?", re.I)),
    ("halt", re.compile(r"\b(stop|halt|abort|freeze|hold off)\b", re.I)),
    ("negative", re.compile(r"\b(do not|don't|dont|wait)\b", re.I)),
    ("refusal", re.compile(r"\b(refuse|reject|no to|not approved|declin\w+|deny)\b", re.I)),
    # 'go' moved AFTER 'question' on 2026-11-01: "why both this and 352 ... go in 7th november?" was labelled
    # trigger=go because the sentence contains the word "go". The class was right, the label was misleading,
    # and a label that misleads is worse than no label.
    ("go", re.compile(r"\b(go ahead|approved?|proceed|ship it|merge it|green light|unblock|i approve)\b", re.I)),
    ("production", re.compile(r"\b(deploy|promote|promotion|rollback|migrate|window|release|restart)\b", re.I)),
    ("secret-or-access", re.compile(r"\b(keys?|rotat\w*|revok\w*|passwor\w*|credential\w*|lock\w*|access|permission\w*)\b", re.I)),
]
# A bare acknowledgement, whatever else it contains, is never a decision.
ACK = re.compile(r"^\W*(@[\w.-]+\W*)?(ok(ay)?|yes|yep|no|nope|thanks?|thx|ack|done|noted)\W*$", re.I)


def stamp():
    return subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()


OPERATOR_IDS = {lanecfg.operator_account_id()}
OPERATOR_NAME = lanecfg.operator_name()


def mentions_bot(text):
    return bool(re.search(r"@xtrm-bot\b", text or "", re.I))


def classify(text, answer=None, author_id=None, author=None):
    """(decision|info, trigger). An explicit answer field from the Status board counts as a decision only when
    it is not a bare yes: a 'yes' that answers a question already handled is an ack."""
    t = (text or "").strip()
    if answer is not None:
        a = str(answer).strip().lower()
        if a in ("yes", "no", "ok") and not t:
            return "info", f"ack:{a}"
        return "decision", f"answer:{a}"
    # Coordinator rule, 2026-11-01T12:00Z: EVERY operator comment that tags the bot reaches the coordinator as a
    # DECISION, whatever else it says. The classifier below is a filter for prose that arrives without the tag;
    # it must not be able to downgrade an explicit address to the bot. Ordered before ACK on purpose: "@xtrm-bot
    # ok" is a decision about the row it sits on, not a stray acknowledgement.
    if mentions_bot(t) and (author_id in OPERATOR_IDS or (author or "") == OPERATOR_NAME):
        return "decision", "mention-bot"
    if ACK.match(t):
        return "info", "ack"
    for name, rx in DECISION:
        if rx.search(t):
            return "decision", name
    if len(t) > 240:
        return "decision", "long-answer"
    return "info", "statement"


def read_channel(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for n, line in enumerate(fh):
            line = line.strip()
            if not line:
                continue
            try:
                out.append((n, json.loads(line)))
            except json.JSONDecodeError:
                out.append((n, {"_raw": line}))
    return out


OUTBOX = f"{LANE}/pending-routes.jsonl"


def already_outboxed(rid, cid=None):
    """True when this decision is already in the outbox, under ANY channel.

    Ids are prefixed by channel (`inbox:`/`jira:`), so matching on the id alone missed the case that matters:
    the same operator comment arriving through two channels. That happened twice on 2026-11-01 (c16461/16462,
    then c16471/16472) because route-jira.py delivers first and the watcher writes the same comment minutes
    later. The comment id is the identity; the channel is only the road it travelled.
    """
    if not os.path.exists(OUTBOX):
        return False
    with open(OUTBOX, encoding="utf-8") as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("id") == rid:
                return True
            if cid is not None and str(r.get("cid")) == str(cid):
                return True
    return False


def append_outbox(row):
    with lanecfg.outbox_lock(OUTBOX):
        return _append_outbox(row)


def _append_outbox(row):
    """Durable, because a DECISION is not delivered by printing it to a terminal.

    WHAT WENT WRONG on 2026-11-01: c16409 was classified correctly at 09:20:54Z (ROUTE-DECISION is in events.log at
    that minute) and still never reached the coordinator. The event was written between two monitors: every monitor
    starts with `tail -n0`, so a line appended while no monitor is armed is never seen by anyone, and events.log is
    never re-read. The loss was structural, not a misclassification. This outbox plus route-backlog.py makes an
    undelivered decision a visible, countable fact instead of a silence.
    """
    seen, seen_cids = set(), set()
    if os.path.exists(OUTBOX):
        with open(OUTBOX, encoding="utf-8") as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("id"):
                    seen.add(rec["id"])
                if rec.get("cid"):
                    seen_cids.add(str(rec["cid"]))
    if row["id"] in seen:
        return
    # The comment id is the identity; the channel is only the road it travelled. This writer relied on its one
    # call site remembering that (already_outboxed above), and route-jira.py's twin did not, so c16940/16941 were
    # written and forwarded twice on 2026-11-04.
    if row.get("cid") and str(row["cid"]) in seen_cids:
        return
    with open(OUTBOX, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")


def main():
    cur = {}
    if os.path.exists(CURSOR):
        try:
            cur = json.load(open(CURSOR))
        except json.JSONDecodeError:
            cur = {}
    first = not cur
    n_dec = n_info = 0
    # FIRST-RUN RACE, found on 2026-11-01: the baseline was taken three seconds AFTER the bot watcher wrote the
    # operator's comment (c16382, 05:10:44Z created, 05:14:12Z detected, baseline 05:14:15Z), so a
    # live decision was swallowed as "old". A baseline may only silence the past, so on the first pass every
    # entry created within the last hour is still classified and reported with a pre-baseline marker.
    import datetime as _dt
    def fresh(row, minutes=60):
        for k in ("created", "at", "detectedAt"):
            v = row.get(k)
            if not v:
                continue
            try:
                t = _dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
            except ValueError:
                continue
            if t.tzinfo is None:
                t = t.replace(tzinfo=_dt.timezone.utc)
            age = (_dt.datetime.now(_dt.timezone.utc) - t).total_seconds() / 60
            return age <= minutes
        return False
    for name, path in CHANNELS.items():
        rows = read_channel(path)
        start = int(cur.get(name, len(rows) if first else 0))
        if first:
            start = min(start, next((i for i, (_n, r) in enumerate(rows) if fresh(r)), start))
        for idx, row in rows[start:]:
            if "_raw" in row:
                print(f"ROUTE-UNPARSED {stamp()} {name} line={idx} {row['_raw'][:160]}")
                continue
            if name == "inbox":
                key, cid = row.get("key"), row.get("commentId")
                text, answer = row.get("text"), None
                who, at = row.get("author"), row.get("created")
            else:
                key, cid = row.get("qid"), None
                text, answer = row.get("comment"), row.get("answer")
                who, at = row.get("by"), row.get("at")
            author_id = row.get("authorId") if name == "inbox" else None
            kind, trigger = classify(text, answer, author_id=author_id, author=who)
            if first:
                trigger = f"pre-baseline:{trigger}"
            head = f"{(text or '')[:200]}".replace("\n", " ")
            if kind == "decision":
                rid = f"{name}:{cid or idx}"
                # A decision already delivered by another channel must not announce itself again. Since
                # 2026-11-01T13:50Z this happens by design: route-jira.py delivers a comment and route-watch.py
                # reads the same comment minutes later, once xtrm-bot-watch has written it to its inbox. The
                # outbox already refused the duplicate row; the PRINT was still going out and looked like a
                # second decision. Quiet by construction is the only version a human can trust.
                if already_outboxed(rid, cid):
                    print(f"ROUTE-DUPLICATE-SKIPPED {stamp()} channel={name} key={key} cid={cid} "
                          f"(already delivered by another channel)")
                else:
                    n_dec += 1
                    append_outbox({"id": rid, "channel": name, "key": key, "cid": cid, "author": who,
                                   "at": at, "trigger": trigger, "text": (text or "")[:600],
                                   "seen_at": stamp(), "delivered": False})
                    print(f"ROUTE-DECISION {stamp()} channel={name} key={key} cid={cid} author={who} at={at} "
                          f"trigger={trigger} text={head!r}")
            else:
                n_info += 1
                print(f"ROUTE-INFO {stamp()} channel={name} key={key} cid={cid} author={who} trigger={trigger} "
                      f"text={head[:120]!r}")
        cur[name] = len(rows)
    json.dump(cur, open(CURSOR, "w"), indent=1)
    if first:
        print(f"ROUTE-BASELINE {stamp()} cursors recorded ({', '.join(f'{k}={v}' for k, v in cur.items())}); "
              f"entries from the last hour are still classified and marked pre-baseline, so a live decision "
              f"written seconds before the baseline cannot be swallowed")
    elif not (n_dec or n_info):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
