#!/usr/bin/env python3
"""Odd-N majority over code-readiness-v1 runs (in code, not by a model), then a compare against an
independent second method (the MMD-3014 manual table). Usage:
  aggregate_readiness.py --runs run-*.json --rows rows.json [--method2 code-readiness.json] --out majority.json
A run whose status is not 'complete' is refused, never averaged in.
"""
import argparse, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from readiness_facts import evidence_text
from collections import Counter

# method-2 vocabulary -> method-1 vocabulary
M2 = {'NOT-BUILT': 'NOT_BUILT', 'OPEN-PR': 'OPEN_PR', 'OTHER-REPO': 'OTHER_REPO', 'DONE-DRIFT': 'BUILT',
      'BUILT': 'BUILT', 'PARTIAL': 'PARTIAL', 'OPERATIONAL': 'OPERATIONAL', 'SUPERSEDED': 'SUPERSEDED'}


def load_run(p):
    d = json.loads(pathlib.Path(p).read_text())
    if d.get('status') != 'complete':
        raise SystemExit(f'refusing {p}: status={d.get("status")} {str(d.get("error"))[:200]}')
    out = d.get('output')
    rows = out if isinstance(out, list) else (out or {}).get('verdicts') or (out or {}).get('rows')
    if not isinstance(rows, list):
        raise SystemExit(f'refusing {p}: no verdict list in output')
    return {r['key']: r for r in rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', nargs='+', required=True)
    ap.add_argument('--rows', required=True)
    ap.add_argument('--method2')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    facts = {r['key']: r for r in json.loads(pathlib.Path(a.rows).read_text())['rows']}
    # group run files by chunk: run-<chunk>-<i>.json
    groups = {}
    for p in a.runs:
        stem = pathlib.Path(p).stem
        chunk = stem.rsplit('-', 1)[0]
        groups.setdefault(chunk, []).append(load_run(p))
    sizes = {c: len(v) for c, v in groups.items()}
    if any(n % 2 == 0 for n in sizes.values()):
        raise SystemExit(f'each chunk needs an odd number of complete runs: {sizes}')
    m2 = {}
    if a.method2:
        for r in json.loads(pathlib.Path(a.method2).read_text())['rows']:
            m2[r['jira']] = M2.get(r['classif'], r['classif'])
    table, flips = [], 0
    for chunk, runs in groups.items():
        for key in runs[0]:
            vs = [run[key] for run in runs if key in run]
            if len(vs) != len(runs):
                raise SystemExit(f'{key} missing from a run of {chunk}')
            c = Counter(v['class'] for v in vs)
            top, n = c.most_common(1)[0]
            maj = top if n * 2 > len(vs) else 'NO_MAJORITY'
            flips += len(c) > 1
            pick = next((v for v in vs if v['class'] == maj), vs[0])
            quote_ok = key in facts and pick['evidence_quote'].strip() in evidence_text(facts[key])
            row = {'key': key, 'majority': maj, 'votes': [v['class'] for v in vs], 'rule': pick['rule'],
                   'oracle': facts.get(key, {}).get('oracle'), 'slot_utc': facts.get(key, {}).get('slot_utc'),
                   'summary': facts.get(key, {}).get('summary', '')[:90], 'missing': pick['missing'],
                   'first_code_site': pick['first_code_site'], 'size': pick['size'], 'blocker': pick['blocker'],
                   'evidence_quote': pick['evidence_quote'], 'quote_verbatim': quote_ok, 'note': pick['note'],
                   'method2': m2.get(key), 'agree': (m2.get(key) == maj) if key in m2 else None}
            if row['oracle'] not in ('judge', None) and maj != row['oracle']:
                row['oracle_mismatch'] = True
            table.append(row)
    table.sort(key=lambda r: (r['slot_utc'] or '9999', r['key']))
    dis = [r for r in table if r['agree'] is False or r['majority'] == 'NO_MAJORITY' or r.get('oracle_mismatch') or not r['quote_verbatim'] or r['majority'] in ('NOT_BUILT', 'PARTIAL', 'NEEDS_HUMAN')]
    summary = {'rows': len(table), 'runs_per_chunk': sizes, 'rows_with_run_disagreement': flips,
               'majority_counts': dict(Counter(r['majority'] for r in table)),
               'compared_with_method2': sum(r['agree'] is not None for r in table),
               'agree_with_method2': sum(r['agree'] is True for r in table), 'needs_deep_read': len(dis)}
    pathlib.Path(a.out).write_text(json.dumps({'summary': summary, 'rows': table, 'deep_read': [r['key'] for r in dis]}, indent=1))
    print(json.dumps(summary))
    for r in dis:
        print(f"  DEEP-READ {r['key']} {r['slot_utc']} majority={r['majority']} votes={r['votes']} method2={r['method2']} oracle={r['oracle']}")


if __name__ == '__main__':
    main()
