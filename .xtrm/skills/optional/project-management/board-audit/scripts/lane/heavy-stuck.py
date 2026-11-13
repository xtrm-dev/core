#!/usr/bin/env python3
"""HEAVY-STUCK: distinguish 'the nightly has not fired' from 'it fired and is stuck in the queue'.

Both read as PENDING in heavy-watch. Only the second is a blocked proof: a queued run is
evidence that the runners are not picking up work, not evidence that the suite is slow.
"""
import json, subprocess, datetime as dt, sys
from pathlib import Path

import lanecfg

REPO = Path(lanecfg.repo())
EVENTS = Path(lanecfg.lane()) / 'events.log'
STATE = Path(lanecfg.lane()) / 'heavy-stuck.state'
WORKFLOW = lanecfg.ci_workflow()
REPO_SLUG = lanecfg.repo_slug()
QUEUE_LIMIT_MIN = 30
# yesterday's schedule run fired 10:29:35Z though the file says cron 30 4 * * *; treat 12:00Z as
# the hour by which a missing run is a fact rather than an expectation
NOT_FIRED_AFTER_HOUR = 12

def utc(s):
    return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)

def now():
    return dt.datetime.now(dt.timezone.utc)

def runs():
    # one retry: a transient gh failure must not crash the check and hide the very condition it detects
    for _ in range(2):
        out = subprocess.run(['gh', 'run', 'list', '--workflow', WORKFLOW, '--event', 'schedule',
                              '--limit', '8', '--json', 'databaseId,createdAt,status,conclusion,headSha'],
                             cwd=str(REPO), capture_output=True, text=True, timeout=120)
        if out.returncode == 0:
            return json.loads(out.stdout or '[]')
    return None

def emit(line):
    with EVENTS.open('a') as f:
        f.write(line + '\n')
    print(line)

def pass_beat(n, st, reason):
    # a silent pass is indistinguishable from a check that never ran; count passes and say so every 4th
    st['passes'] = st.get('passes', 0) + 1
    STATE.write_text(json.dumps(st, indent=1))
    if st['passes'] % 4 == 0:
        emit(f"HEAVY-PASS {n.strftime('%Y-%m-%dT%H:%M:%SZ')} pass={st['passes']} of every 4: check alive, reason={reason}")
    return 0

def queue_depth(ahead_of):
    """How many unfinished runs were created before this one — the size of the wave it waits behind.
    Reported as a count of jobs, not as a diagnosis: a cause is stated only once it has been measured."""
    out = subprocess.run(['gh', 'api', f'/repos/{REPO_SLUG}/actions/runs?status=queued&per_page=100',
                          '--jq', '[.workflow_runs[]|.created_at]'],
                         capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        return None
    try:
        stamps = json.loads(out.stdout)
    except Exception:
        return None
    return sum(1 for t in stamps if t < ahead_of)


def main():
    n = now()
    today = n.strftime('%Y-%m-%d')
    rs = runs()
    st = json.loads(STATE.read_text()) if STATE.exists() else {}
    if rs is None:
        emit('HEAVY-STUCK-ERROR queue-read-failed')
        return pass_beat(n, st, 'queue read failed')
    todays = [r for r in rs if r['createdAt'].startswith(today)]
    if not todays:
        # not fired: only a fact after the hour it is expected
        if n.hour >= NOT_FIRED_AFTER_HOUR and st.get('notfired') != today:
            st['notfired'] = today
            STATE.write_text(json.dumps(st, indent=1))
            emit(f"HEAVY-NOT-FIRED {n.strftime('%Y-%m-%dT%H:%M:%SZ')} no schedule run of '{WORKFLOW}' exists for {today} "
                 f"after {NOT_FIRED_AFTER_HOUR}:00Z; the last one is {rs[0]['createdAt']} ({rs[0]['status']}/{rs[0]['conclusion']}) "
                 f"- a HEAVY proof cannot be produced until it runs")
        return pass_beat(n, st, 'no schedule run yet today')
    r = todays[0]
    if r['status'] in ('queued', 'pending'):
        age = (n - utc(r['createdAt'])).total_seconds() / 60
        why = 'stuck already reported' if age > QUEUE_LIMIT_MIN else "today's run queued but under the 30 min limit"
        if age > QUEUE_LIMIT_MIN and st.get('stuck') != str(r['databaseId']):
            st['stuck'] = str(r['databaseId'])
            STATE.write_text(json.dumps(st, indent=1))
            depth = queue_depth(r['createdAt'])
            behind = f"behind {depth} queued runs" if depth is not None else "behind an unmeasured queue"
            emit(f"HEAVY-STUCK {n.strftime('%Y-%m-%dT%H:%M:%SZ')} schedule run {r['databaseId']} ({r['createdAt']}, {r['headSha'][:10]}) "
                 f"has been {r['status']} for {age:.0f} min, {behind}; this is a proof waiting, not a suite "
                 f"running. Check which runner labels the jobs request and how many runners carry them before "
                 f"naming a cause. Report this once, as a measured wait, not as a failure.")
            return pass_beat(n, st, 'stuck reported now')
        return pass_beat(n, st, why)
    elif r['status'] == 'completed':
        st.pop('stuck', None); st.pop('notfired', None)
        return pass_beat(n, st, "today's run completed")
    return pass_beat(n, st, f"today's run is {r['status']}")

if __name__ == '__main__':
    sys.exit(main())
