#!/usr/bin/env python3
"""Verdict cache keyed by row content: reuse the judged verdicts of rows whose input did not change, judge only the changed rows.

  python3 reuse_plan.py delta --node items --old-base OLD/runs --old-tag r1 --rows run/rows-items.json     # prints changed keys
  python3 reuse_plan.py merge --node items --old-base OLD/runs --old-tag r1 --new-tag r3 --rows run/rows-items.json
        # expects runs/<new-tag>-<node>-chg-1 and -chg-2 (and -chg-3) from run_plan.py --keys <changed>; writes runs/<new-tag>-<node>-1..3

A row is unchanged when key, oracle and evidence are byte-identical to the row the old runs judged. Rubric and workflow must be unchanged
(the caller checks the rubric sha in the MANIFEST files). Majorities stay computed in code by build_plan.py over the merged directories.
"""
import argparse
import json
import pathlib

import aggregate_plan as agg


def old_runs(base, tag, node):
    out = []
    for i in (1, 2, 3):
        d = pathlib.Path(base) / f'{tag}-{node}-{i}'
        if d.exists():
            rows, res = {}, {}
            for inp in sorted(d.glob('input-*.json')):
                for r in json.loads(inp.read_text())['rows']:
                    rows[r['key']] = r
                run = json.loads(inp.with_name(inp.name.replace('input', 'run')).read_text())
                for v in run['output']:
                    res[v['key']] = v
            out.append((i, rows, res))
    return out


def changed_keys(old, new_rows):
    old_rows = {}
    for _, rows, _ in old:
        old_rows.update(rows)
    return [r['key'] for r in new_rows if r['key'] not in old_rows or old_rows[r['key']]['evidence'] != r['evidence'] or old_rows[r['key']]['oracle'] != r['oracle']]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['delta', 'merge'])
    ap.add_argument('--node', required=True)
    ap.add_argument('--old-base', required=True)
    ap.add_argument('--old-tag', required=True)
    ap.add_argument('--new-tag', default='')
    ap.add_argument('--rows', required=True)
    ap.add_argument('--base', default='runs')
    a = ap.parse_args()
    new_rows = json.loads(pathlib.Path(a.rows).read_text())
    old = old_runs(a.old_base, a.old_tag, a.node)
    chg = changed_keys(old, new_rows)
    if a.mode == 'delta':
        print(','.join(chg))
        return
    by_key = {r['key']: r for r in new_rows}
    for i, _, res in old:
        out = pathlib.Path(a.base) / f'{a.new_tag}-{a.node}-{i}'
        chg_dir = pathlib.Path(a.base) / f'{a.new_tag}-{a.node}-chg-{i}'
        verdicts = {k: v for k, v in res.items() if k in by_key and k not in chg}
        if chg and chg_dir.exists():
            _, cres = agg.load_run(chg_dir)
            verdicts.update({k: v for k, v in cres.items() if k in by_key})
        out.mkdir(parents=True, exist_ok=True)
        rows = [by_key[k] for k in by_key if k in verdicts]
        (out / 'input-01.json').write_text(json.dumps({'batch_id': f'{a.node}-merged-{i}', 'rubric': 'see MANIFEST of the source runs', 'rows': rows}, indent=1))
        (out / 'run-01.json').write_text(json.dumps({'status': 'complete', 'output': [verdicts[r['key']] for r in rows]}, indent=1))
        (out / 'MANIFEST.json').write_text(json.dumps({'merged_from': f'{a.old_tag}', 'changed_rows_rejudged': len(chg), 'rows': len(rows)}, indent=1))
        rej = len([r['key'] for r in rows if r['key'] in chg])
        print(f'{out}: {len(rows)} rows ({rej} rejudged now, {len(rows) - rej} reused from {a.old_tag})')


if __name__ == '__main__':
    main()
