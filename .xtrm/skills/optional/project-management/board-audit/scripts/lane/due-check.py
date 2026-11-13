#!/usr/bin/env python3
"""Due dates against slots, under the rule the coordinator refined on 2026-11-01T12:13Z.

  due == slot START date   for a window shorter than a day
  due == slot END date     for a multi-day row (the freeze rows, which span days)
  past slots              are never touched: back-dating a row whose slot has gone achieves nothing

Dates are read in the SLOT'S OWN offset (+0100 today), never in UTC. A slot opening at 00:30 local is the
30th locally and the previous day in UTC, so converting first made three correct rows report as mismatches on
2026-11-09 (three rows). The offset is what the author wrote and what the operator reads.

Prints only violations, and only counts them when the count changes, because a hygiene line that repeats itself
every hour stops being read. This is the rule one multi-day row settled: its slot spans Tue 18:30Z to Thu 07:37Z
and its due is the Thursday, the end, not the start.
"""
import json, os, sys, urllib.parse, datetime as dt

import lanecfg
import jira  # noqa: E402  (on sys.path through lanecfg)

LANE = lanecfg.lane()
PROJECT = lanecfg.project()
SLOT_START = lanecfg.custom_field("window_start")
SLOT_END = lanecfg.custom_field("window_end")
CF_START = lanecfg.cf_num("window_start")
STATE = f"{LANE}/due-check.state"
LONG_ROW = 20 * 3600          # a slot this long is a span, not a window


def parse(s):
    # keep the stored offset: .date() below must answer in the slot's own zone, not in UTC
    return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%f%z') if s else None


def rows():
    tok, out = None, []
    while True:
        url = ('/rest/api/3/search/jql?jql=' +
               urllib.parse.quote(f'project = {PROJECT} AND cf[{CF_START}] is not EMPTY ORDER BY cf[{CF_START}] ASC') +
               f'&maxResults=100&fields=summary,{SLOT_START},{SLOT_END},duedate,status')
        if tok:
            url += '&nextPageToken=' + tok
        st, b = jira.call('GET', url)
        if st >= 300:
            return None
        out += b.get('issues') or []
        tok = b.get('nextPageToken')
        if b.get('isLast') or not tok:
            return out


def main():
    iss = rows()
    if iss is None:
        print("DUE-CHECK-ERROR API refused the search")
        return 1
    now = dt.datetime.now(dt.timezone.utc)
    bad = []
    for i in iss:
        f = i['fields']
        a, b = parse(f.get(SLOT_START)), parse(f.get(SLOT_END))
        due = f.get('duedate')
        if not (a and b and due):
            continue
        if b < now:                       # past slot: never touched
            continue
        multi = (b - a).total_seconds() >= LONG_ROW
        want = (b if multi else a).date().isoformat()
        if due != want:
            bad.append((i['key'], due, want, 'end' if multi else 'start', f['summary'][:52]))
    sig = str(len(bad))
    try:
        prev = open(STATE).read().strip()
    except FileNotFoundError:
        prev = None
    open(STATE, 'w').write(sig)
    if not bad:
        if prev not in (None, '0'):
            print(f"DUE-CHECK {dt.datetime.now(dt.timezone.utc):%Y-%m-%dT%H:%MZ} all clear (was {prev})")
        return 0
    if prev == sig:
        return 0
    for key, due, want, which, su in bad:
        print(f"DUE-MISMATCH {key} due={due} want={want} ({which} of slot) | {su}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
