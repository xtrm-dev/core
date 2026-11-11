#!/usr/bin/env python3
"""Deterministic odd-N majority over AgentRun run outputs.

Majority is computed here, in code, not by a model: a model averaging its own samples is
another judgment, not a check. Usage: python3 aggregate.py run-v3-1.json run-v3-2.json ...
"""
import json, sys
from collections import Counter


def main(paths):
    runs = []
    for p in paths:
        d = json.load(open(p))
        if d.get('status') != 'complete':
            print(f'refusing: {p} status={d.get("status")}'); return 2
        runs.append({r['key']: r for r in d['output']['rows']})
    keys = list(runs[0])
    disagreement, unstable, table = 0, [], []
    for k in keys:
        verdicts = [r[k]['verdict'] for r in runs]
        counts = Counter(verdicts)
        top, n = counts.most_common(1)[0]
        majority = top if n * 2 > len(verdicts) else 'NO_MAJORITY'
        if len(counts) > 1:
            disagreement += 1
        if majority == 'NO_MAJORITY':
            unstable.append(k)
        table.append((k, verdicts, majority, runs[0][k].get('rule')))
    print(f'runs={len(runs)} rows={len(keys)} disagreement={disagreement}/{len(keys)} '
          f'({100*disagreement/len(keys):.0f}%) no_majority={unstable or "none"}')
    for k, v, m, rule in table:
        print(f'  {k:11} {m:22} rule={str(rule)[:12]:12} runs={v}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
