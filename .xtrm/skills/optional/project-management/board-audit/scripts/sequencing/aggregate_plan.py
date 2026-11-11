#!/usr/bin/env python3
"""Compare AgentRun outputs over the same rows. Majority is computed here, in code.

  python3 aggregate_plan.py DIR_RUN1 DIR_RUN2 [DIR_RUN3 ...]      # each DIR holds input-NN.json and run-NN.json from run_plan.py
Reports: verdict flips between runs (and flips in in_keys/target), disagreement with the code oracle, overrides.
Refuses any run whose status is not complete.
"""
import json
import pathlib
import sys
from collections import Counter


def load_run(d):
    d = pathlib.Path(d)
    oracle, res = {}, {}
    for inp in sorted(d.glob('input-*.json')):
        for r in json.loads(inp.read_text())['rows']:
            oracle[r['key']] = r['oracle']
        run = json.loads(inp.with_name(inp.name.replace('input', 'run')).read_text())
        if run.get('status') != 'complete':
            raise SystemExit(f'refusing {d}: {inp.name} status={run.get("status")}')
        for v in run['output']:
            res[v['key']] = v
    return oracle, res


def main(dirs):
    runs = [load_run(d) for d in dirs]
    oracle = runs[0][0]
    keys = sorted(oracle)
    flips, field_flips, mism, overrides, majority = [], [], [], [], {}
    for k in keys:
        vs = [r[1].get(k) for r in runs]
        if any(v is None for v in vs):
            flips.append((k, 'MISSING'))
            continue
        verdicts = [v['verdict'] for v in vs]
        c = Counter(verdicts)
        top, n = c.most_common(1)[0]
        majority[k] = top if n * 2 > len(verdicts) else 'NO_MAJORITY'
        if len(c) > 1:
            flips.append((k, verdicts))
        extra = [json.dumps(v.get('in_keys') or v.get('target'), sort_keys=True) for v in vs]
        if len(set(extra)) > 1 and len(c) == 1:
            field_flips.append((k, extra))
        o = oracle[k].split('|')[0]
        for i, v in enumerate(vs):
            if v['verdict'] != o:
                mism.append((k, i + 1, o, v['verdict'], v['rule'], v['note'][:160]))
            if str(v['rule']).startswith(('OVERRIDE', 'J1')):
                overrides.append((k, i + 1, v['verdict'], v['rule'], v['note'][:120]))
    print(f'runs={len(runs)} rows={len(keys)} verdict_flips={len(flips)}/{len(keys)} field_flips={len(field_flips)} '
          f'mismatch_vs_oracle={len(mism)} overrides_or_J1={len(overrides)}')
    for k, v in flips:
        print('  FLIP', k, v)
    for k, v in field_flips:
        print('  FIELD-FLIP', k, v)
    for m in mism:
        print('  MISMATCH', m)
    for o in overrides:
        print('  OVERRIDE/J1', o)
    return {'flips': flips, 'field_flips': field_flips, 'mismatch': mism, 'overrides': overrides, 'majority': majority}


if __name__ == '__main__':
    main(sys.argv[1:])
