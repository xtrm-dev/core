#!/usr/bin/env python3
"""Between the item node and the day node: place the judged own-window items in slots and rebuild the day rows.

  python3 finalize_plan.py --snap snap --facts run/facts.json --tag f1 --out run-final

Reads the judged item verdicts (every run must agree; a flipped row keeps the code oracle and is listed), takes the own-window set,
runs the deterministic slot assignment, and writes run-final/rows-days.json plus run-final/final.json. No model call here.
"""
import argparse
import datetime
import json
import pathlib
import sys

import aggregate_plan as agg
import facts_plan as fp


def verdicts(tag):
    """Votes over runs 1..3 of the item node (run 3 may hold only the rows that flipped)."""
    import build_plan as bp
    v = bp.node_verdicts(tag, 'items')
    out = {k: x for k, x in v.items() if x['verdict'] not in ('UNSTABLE', 'MISSING')}
    unstable = [k for k, x in v.items() if x['verdict'] in ('UNSTABLE', 'MISSING')]
    return out, unstable, {k: x['oracle'] for k, x in v.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap', default='snap')
    ap.add_argument('--facts', default='run/facts.json')
    ap.add_argument('--tag', default='f1')
    ap.add_argument('--out', default='run-final')
    ap.add_argument('--worktree', default=fp.default_repo())
    a = ap.parse_args()
    facts = json.loads(pathlib.Path(a.facts).read_text())
    now = fp.utc(facts['meta']['built_at'])
    snap = fp.load_snap(a.snap)
    B = fp.build(snap, now, fp.tracked_files(a.worktree))
    rows = {r['key']: r for r in facts['items']}
    judged, unstable, oracle = verdicts(a.tag)
    own = []
    for k, r in rows.items():
        v = judged.get(k, {}).get('verdict') or oracle.get(k, r['oracle']).split('|')[0]
        if v == 'own-window':
            own.append(r)
    placed, unplaced, extra = fp.assign_slots(B, own)
    days = fp.day_facts(B, extra)
    out = pathlib.Path(a.out)
    out.mkdir(exist_ok=True)
    (out / 'rows-days.json').write_text(json.dumps([{'key': d['day'], 'summary': 'day capacity', 'oracle': d['oracle'], 'evidence': d['evidence']} for d in days], indent=1))
    outb = pathlib.Path(a.out + '-b')
    outb.mkdir(exist_ok=True)
    (outb / 'rows-days.json').write_text(json.dumps([{'key': d['day'], 'summary': 'day capacity as booked', 'oracle': d['oracle'], 'evidence': d['evidence']} for d in facts['days_booked']], indent=1))
    (out / 'final.json').write_text(json.dumps({
        'built_at': datetime.datetime.now(datetime.UTC).isoformat(), 'own_window_judged': [r['key'] for r in own], 'unstable_items': unstable,
        'placed': [(k, fp.z(s), fp.z(e), t) for k, s, e, t in placed], 'unplaced': unplaced, 'why_unplaced': {k: fp.assign_slots.why.get(k, {}) for k in unplaced}, 'days': days}, indent=1, default=str))
    print(f'own-window judged={len(own)} placed={len(placed)} unplaced={len(unplaced)} unstable_items={len(unstable)}')


if __name__ == '__main__':
    main()
