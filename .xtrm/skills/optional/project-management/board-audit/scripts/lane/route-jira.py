#!/usr/bin/env python3
"""The router's THIRD channel: Jira read directly.

WHY THIS EXISTS (2026-11-01T13:47Z, CORRECTED 13:50Z). route-watch.py reads two local inbox files, and for four
hours the first of them, the bot watcher's inbox.jsonl, had an mtime and a newest entry of 09:27Z. I called
the feeder dead. IT WAS NOT. The coordinator checked: xtrm-bot-watch.timer fires every 10 min with a 20-min
lookback, its log shows RUN ... new=0 at 13:09/13:19/13:30/13:40 and then new=2 at
13:50:04Z, and the inbox was silent only because the operator wrote no @xtrm-bot comment between 09:26Z and
13:40Z. c16461 was written 49 s AFTER the 13:40:03Z run, so the 13:50Z run was the first that could carry it.

THE LESSON, which is the reason this paragraph exists rather than being deleted: an mtime measures the last
WRITE, not the last ATTEMPT, and the two cases look identical. Before calling a producer dead, look for its
heartbeat — the timer, the log's RUN lines — not its output.

So this channel is REDUNDANCY, not repair. A router with one input has one point of silence; a second opinion on
the same question costs two seconds of search and survives a feeder that dies in a way I would not notice.
Worst-case lag on the primary channel is 10 min (timer) plus 300 s (router). Duplicates are pre-empted: when the
watcher later writes inbox:<cid> for a comment this channel already delivered, that row is recorded delivered
with duplicate_of=jira:<cid>, so one decision is still one message.

It shares the classifier, the outbox and the delivery model with route-watch.py: an id of the form jira:<cid>,
marked delivered by mark-routed.py only after a successful SendMessage.
"""
import datetime as dt
import importlib.util
import json
import os
import re
import sys
import urllib.parse

import lanecfg
import jira  # noqa: E402  (on sys.path through lanecfg)

LANE = lanecfg.lane()
PROJECT = lanecfg.project()
CURSOR = f"{LANE}/route-jira-cursor.json"
OUTBOX = f"{LANE}/pending-routes.jsonl"
OPERATOR_IDS = {lanecfg.operator_account_id()}
OPERATOR_NAMES = lanecfg.operator_names()
LOOKBACK_H = 3


def classifier():
    spec = importlib.util.spec_from_file_location("routewatch", str(lanecfg.SCRIPTS / "route-watch.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.classify


def stamp():
    return dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def to_utc(s):
    try:
        return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%f%z').astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:
        try:
            return dt.datetime.strptime(s[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        except Exception:
            return s


def parse_ts(s):
    try:
        return dt.datetime.strptime(s[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=dt.timezone.utc)
    except Exception:
        return None


def append_outbox(row):
    with lanecfg.outbox_lock(OUTBOX):
        return _append_outbox(row)


def _append_outbox(row):
    """Append one decision, deduplicated on the COMMENT id, not on the channel-prefixed id.

    The id of a decision is `inbox:<cid>` or `jira:<cid>`, so the same operator comment arriving on both channels
    produced two rows and two forwards (2026-11-04, c16940/16941: the inbox row landed at 02:29:49Z and the jira
    row still printed at 02:29:52Z). route-watch.py's own already_outboxed() had been fixed for exactly this on
    2026-11-01; this writer was not. The comment id is the identity, the channel is only the road it travelled.
    """
    seen, seen_cids = set(), set()
    if os.path.exists(OUTBOX):
        with open(OUTBOX, encoding='utf-8') as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get('id'):
                    seen.add(rec['id'])
                if rec.get('cid'):
                    seen_cids.add(str(rec['cid']))
    if row['id'] in seen:
        return False
    if row.get('cid') and str(row['cid']) in seen_cids:
        return False
    with open(OUTBOX, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(row) + '\n')
    return True


def _card_ref(url):
    """The ticket key a card points at, or the url when it is not a browse link."""
    m = re.search(r'/browse/([A-Z][A-Z0-9]*-\d+)(?:\?.*)?$', url or '')
    return m.group(1) if m else (url or '')


def flat(node, out):
    """Flatten ADF to text. A card is a REFERENT, not decoration: dropping it removed two linked rows
    from one operator question (c17030), one from another (c17033) and three from a third (c17122),
    where the lost cards were the options in the question itself. Everything the operator linked is kept, by key when the url names one."""
    if isinstance(node, dict):
        t = node.get('type')
        attrs = node.get('attrs') or {}
        if t == 'text':
            out.append(node.get('text', ''))
        elif t == 'mention':
            out.append('@' + (attrs.get('text') or ''))
        elif t == 'inlineCard':
            out.append(_card_ref(attrs.get('url') or attrs.get('data') or ''))
        elif t in ('blockCard', 'embedCard'):
            out.append(_card_ref(attrs.get('url') or attrs.get('data') or ''))
        elif t == 'emoji':
            out.append(attrs.get('shortName') or attrs.get('text') or '')
        elif t in ('paragraph', 'listItem', 'hardBreak', 'bulletList', 'orderedList'):
            out.append('\n')
        for v in node.get('content') or []:
            flat(v, out)
    elif isinstance(node, list):
        for v in node:
            flat(v, out)


def recent_rows():
    jql = f'project = {PROJECT} AND updated >= -{LOOKBACK_H}h ORDER BY updated DESC'
    url = ('/rest/api/3/search/jql?jql=' + urllib.parse.quote(jql) +
           '&maxResults=100&fields=summary,status')
    st, b = jira.call('GET', url)
    if st >= 300:
        return None
    return b.get('issues') or []


def max_comment_id():
    rows = recent_rows()
    if rows is None:
        return None
    best = 0
    for i in rows:
        st, c = jira.call('GET', f"/rest/api/3/issue/{i['key']}/comment?maxResults=100&orderBy=-created")
        for cm in (c.get('comments') or []):
            try:
                best = max(best, int(cm['id']))
            except Exception:
                pass
    return best


def main():
    classify = classifier()
    cur = {}
    cold = not os.path.exists(CURSOR)
    if not cold:
        cur = json.load(open(CURSOR))
    cutoff_id = cur.get('max_id', 0)
    if cold:
        # Prime the cursor from what already exists rather than replaying the whole day as decisions.
        cutoff_id = max_comment_id() or 0
        json.dump({'max_id': cutoff_id}, open(CURSOR, 'w'), indent=1)
        print(f"ROUTE-JIRA-BASELINE {stamp()} primed at comment id {cutoff_id}; decisions before it are "
              f"history and are not replayed")
        return 0

    rows = recent_rows()
    if rows is None:
        print(f"ROUTE-JIRA-ERROR {stamp()} Jira refused the search")
        return 1

    n_dec = n_info = 0
    newest = cutoff_id
    seen = []
    for i in rows:
        key = i['key']
        st, c = jira.call('GET', f"/rest/api/3/issue/{key}/comment?maxResults=100&orderBy=-created")
        for cm in (c.get('comments') or []):
            try:
                cid = int(cm['id'])
            except Exception:
                continue
            if cid <= cutoff_id:
                continue
            author = (cm.get('author') or {})
            aid = author.get('accountId')
            who = author.get('displayName') or ''
            if not (aid in OPERATOR_IDS or who.strip().lower() in OPERATOR_NAMES):
                continue
            out = []
            flat(cm.get('body'), out)
            text = ''.join(out).strip()
            # Jira returns +0100 local time. Appending 'Z' to a local timestamp was a one-hour lie, the same trap
            # recorded on 2026-11-01: convert with the offset, never slice and label.
            created = to_utc(cm.get('created'))
            kind, trigger = classify(text, None, author_id=aid, author=who)
            seen.append(cid)
            newest = max(newest, cid)
            head = text[:200].replace('\n', ' ')
            if kind == 'decision':
                n_dec += 1
                rid = f'jira:{cid}'
                fresh = append_outbox({'id': rid, 'channel': 'jira', 'key': key, 'cid': str(cid),
                                       'author': who, 'at': created, 'trigger': trigger,
                                       'text': text[:600], 'seen_at': stamp(), 'delivered': False})
                if fresh:
                    print(f"ROUTE-DECISION-JIRA {stamp()} key={key} cid={cid} author={who} at={created} "
                          f"trigger={trigger} text={head!r}", flush=True)
            else:
                n_info += 1
                print(f"ROUTE-INFO-JIRA {stamp()} key={key} cid={cid} author={who} trigger={trigger} "
                      f"text={head[:100]!r}", flush=True)
    if newest > cutoff_id:
        json.dump({'max_id': newest}, open(CURSOR, 'w'), indent=1)
    if not (n_dec or n_info):
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
