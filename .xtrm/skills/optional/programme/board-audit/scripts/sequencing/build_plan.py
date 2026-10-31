#!/usr/bin/env python3
"""Compile PLAN-1105.md from facts.json, final.json and the judged verdicts. Deterministic formatting: no model call, no network.

  python3 build_plan.py --facts run/facts.json --final run-final/final.json --tag f1 --days-tag f1d --out PLAN-1105.md
"""
import argparse
import collections
import datetime
import json
import pathlib
import re

import aggregate_plan as agg

HERE = pathlib.Path(__file__).parent


def node_verdicts(tag, node, n=3, base='runs'):
    """Votes over every run directory found (runs 1 and 2 cover all rows; a run 3 may cover only the rows that flipped)."""
    dirs = [HERE / base / f'{tag}-{node}-{i}' for i in range(1, n + 1)]
    runs = [agg.load_run(d) for d in dirs if d.exists()]
    oracle = runs[0][0]
    out = {}
    for k in oracle:
        vs = [r[1][k] for r in runs if k in r[1]]
        verdicts = [v['verdict'] for v in vs]
        cnt = collections.Counter(verdicts)
        top, c = cnt.most_common(1)[0]
        if len(vs) < 2:
            out[k] = {'verdict': 'MISSING', 'stable': False, 'oracle': oracle[k], 'runs': vs, 'all_verdicts': verdicts}
            continue
        voted = len(cnt) > 1
        verdict = top if c * 2 > len(verdicts) else 'UNSTABLE'
        pick = next(v for v in vs if v['verdict'] == verdict) if verdict != 'UNSTABLE' else vs[0]
        out[k] = {'verdict': verdict, 'stable': not voted, 'voted': voted, 'oracle': oracle[k], 'runs': vs, 'rule': pick['rule'], 'note': pick['note'],
                  'in_keys': pick.get('in_keys'), 'target': pick.get('target'), 'all_verdicts': verdicts}
    return out


def md_cell(s, n=90):
    s = re.sub(r'\s+', ' ', str(s or '')).replace('|', '/').strip()
    return s if len(s) <= n else s[:n - 1] + '~'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--facts', default='run/facts.json')
    ap.add_argument('--final', default='run-final/final.json')
    ap.add_argument('--tag', default='f1')
    ap.add_argument('--days-tag', default='f1d')
    ap.add_argument('--bundles-tag', default='')
    ap.add_argument('--items-tag', default='')
    ap.add_argument('--out', default='PLAN-1105.md')
    a = ap.parse_args()
    F = json.loads((HERE / a.facts).read_text())
    FIN = json.loads((HERE / a.final).read_text())
    meta = F['meta']
    now = meta['built_at']
    bun = node_verdicts(a.bundles_tag or a.tag, 'bundles')
    pairs = node_verdicts(a.tag, 'pairs')
    items = node_verdicts(a.items_tag or a.tag, 'items')
    dayj = node_verdicts(a.days_tag, 'days')
    dayb = node_verdicts(a.days_tag + 'b', 'days') if (HERE / 'runs' / f'{a.days_tag}b-days-1').exists() else {}
    prs_open = F['open_prs']
    item_by = {r['key']: r for r in F['items']}
    pair_by = {p['pair']: p for p in F['pairs']}
    bundle_by = {b['bundle']: b for b in F['bundles']}
    placed = {k: (s, e, t) for k, s, e, t in FIN['placed']}
    L = []
    w = L.append

    # ------------------------------------------------------------------ header
    w('# PLAN-1105: programme sequencing to 2026-11-05')
    w('')
    w(f'Substrate issue MMD-2909. Built {now[:16]}Z by plan-1105. Proposals only: nothing in this file was written to Jira, Substrate, GitHub or production.')
    w('')
    w('## 0. Provenance and how to read this file')
    w('')
    w('| Item | Value |')
    w('|---|---|')
    for k, v in meta['snapshot_stamps'].items():
        w(f'| snapshot {k} | {str(v)[:19]}Z |')
    w(f"| git | origin/master {F['git']['master'][:9]}, origin/stable {F['git']['stable'][:9]}, {F['git']['unpromoted_commits']} commits on master not on stable |")
    w(f"| counts | {meta['counts']['prs']} PRs (open plus merged since 2026-09-27), {meta['counts']['windows']} windows in range, {meta['counts']['live_windows']} live (not closed, not folded, slot not over), {meta['counts']['unwindowed_items']} unwindowed programme items |")
    w(f"| rubric | {meta['rubric']} (see `rubrics.json`); workflows `programme-seq-{{bundles,pairs,items,days}}-v1.json` |")
    w('| judge | AgentRun CLI, model opencode-go/deepseek-v4.1-flash, `tools: []`, one `decide` per row; two runs per node; code compares them |')
    w('')
    rh = HERE / 'runhistory.json'
    if rh.exists():
        w('Run history (UTC, 2026-10-26):')
        w('')
        for line in json.loads(rh.read_text()):
            w(f'- {line}')
        w('')
    w('### Stability of the judged runs')
    w('')
    w('Verdict flips are rows where run 1 and run 2 gave different verdicts. A flipped row gets a third run and the majority of three decides; a row with no majority would stay UNSTABLE.')
    w('')
    w('| Node | Rows | Flips between run 1 and run 2 | Rows decided by a third run | Still unstable | Rows where the judge differs from the oracle |')
    w('|---|---|---|---|---|---|')
    for name, dd in (('bundles (K)', bun), ('pairs (P)', pairs), ('items (I)', items), ('days as proposed (D)', dayj)):
        flips = sum(1 for v in dd.values() if len(v['all_verdicts']) >= 2 and v['all_verdicts'][0] != v['all_verdicts'][1])
        voted = sum(1 for v in dd.values() if len(v['all_verdicts']) >= 3)
        uns = sum(1 for v in dd.values() if v['verdict'] in ('UNSTABLE', 'MISSING'))
        diff = sum(1 for v in dd.values() if v['verdict'] != v['oracle'].split('|')[0])
        w(f'| {name} | {len(dd)} | {flips} | {voted} | {uns} | {diff} |')
    w('')
    pj = HERE / 'pilot.json'
    if pj.exists():
        w('Pilot rounds (about 15 rows per node, two runs each; the rules changed after them, so they show the method, not the final rows):')
        w('')
        w('| Round | days | bundles | pairs | items | Note |')
        w('|---|---|---|---|---|---|')
        for p in json.loads(pj.read_text()):
            w(f"| {p['round']} | {p['days']} | {p['bundles']} | {p['pairs']} | {p['items']} | {p['note']} |")
        w('')
    w('Reading rules. A verdict here is a claim of the workflow over precomputed facts, not a ruling. Every row has a code oracle; where the judge differs the row appears in the Corrigenda section. A value marked PROVISIONAL is an assumption. A value marked UNVERIFIED was not checked against live state.')
    w('')

    # ------------------------------------------------------------------ (a)
    w('## (a) Calendar as booked, 2026-10-26 to 2026-11-05')
    w('')
    w('Halt slot: 21:17-21:55Z until 10-31, 22:17-22:55Z from 11-01. A row flagged FOLDED holds a slot but is bookkeeping for another ticket. A row flagged CLOSED+FUTURE is in a terminal status while its slot has not started.')
    w('')
    by_day = collections.defaultdict(list)
    for r in F['calendar']:
        by_day[r['day']].append(r)
    nowz = now[5:16]
    for d in sorted(by_day):
        if d < '2026-10-26' or d > '2026-11-05':
            continue
        w(f'### {d} ({datetime.date.fromisoformat(d).strftime("%a")})')
        w('')
        w('| Window | Slot (Z) | Status | Kind | Targets | PRs | Flags | Summary |')
        w('|---|---|---|---|---|---|---|---|')
        for r in by_day[d]:
            flags = []
            if r['folded_into']:
                flags.append('FOLDED into ' + ','.join(r['folded_into']))
            if r['terminal'] and r['start'] > nowz:
                flags.append('CLOSED+FUTURE')
            tg = [t for t in r['targets'] if t not in ('questdb',)]
            w(f"| {r['key']} | {r['start'][6:]}-{r['end'][6:]} | {md_cell(r['status'], 14)} | {','.join(r['kinds']) or '-'} | {md_cell(','.join(tg), 50) or '-'} | {','.join(str(x) for x in r['prs'][:5]) or '-'} | {'; '.join(flags) or '-'} | {md_cell(r['summary'], 80)} |")
        w('')
    cf = [r for r in F['calendar'] if r['terminal'] and r['start'] > nowz and '2026-10-26' <= r['day'] <= '2026-11-05']
    w(f"Observation. Folded tickets holding a future slot: {', '.join(x['key'] + ' (into ' + ','.join(x['folded_into']) + ' at ' + x['start'] + ')' for x in F['folded_with_slot'])}. Closed tickets holding a slot that has not started: {', '.join(r['key'] + ' ' + r['start'] + ' (' + r['status'] + ')' for r in cf) or 'none'}. Halt collisions after excluding folded tickets: {F['halt_collisions'] or 'none'}.")
    w('')

    # ------------------------------------------------------------------ (b)
    w('## (b) Promotion bundles and order')
    w('')
    P = F['promotion']
    w('### b1. Landed picture since 2026-09-27')
    w('')
    lc = collections.Counter(r['landed'] for r in F['landed'])
    days = collections.Counter(r['merged'][:10] for r in F['landed'] if r['landed'] in ('stable', 'master'))
    w(f"Merged PRs: {lc['stable']} on stable, {lc['master']} on master and not promoted, {lc['promotion']} promotion or hotfix PRs into stable. Merges per day (to master): " + ', '.join(f'{d[5:]}={n}' for d, n in sorted(days.items())) + '.')
    w('')
    promo = [r for r in F['landed'] if r['landed'] == 'promotion']
    w('Promotion history (PRs into stable, newest first): ' + '; '.join(f"#{r['n']} {r['merged'][5:16]}Z ({r['files']} files)" for r in promo[:12]) + '.')
    w('')
    w('Merged to master and not yet promoted: ' + ', '.join(f"#{r['n']}" for r in F['landed'] if r['landed'] == 'master') + '.')
    w('')
    w('### b2. Fewest promotions that meet every deploy deadline')
    w('')
    w('Model (PROVISIONAL). A PR needs a promotion before the first window that deploys it (window start minus 60 minutes). A merged PR is ready now. An open, non-draft PR is ready after the freeze lifts (10-26 09:00Z). Candidate promotion times are the daily 07:50Z slot plus the 10-26 10:02Z promotion the coordinator named. Greedy: place a promotion at the latest slot at or before the earliest uncovered deadline and carry every PR ready by then. Review state, CI state and conflicts are not modelled (UNVERIFIED).')
    w('')
    w('| Source | Promotion time | Carries | Feeds windows |')
    w('|---|---|---|---|')
    for p in P['booked_promotions']:
        w(f"| booked {p['key']} | {p['at']} | {','.join('#' + str(x) for x in p['prs'][:10]) or '-'} | {md_cell(p['summary'], 70)} |")
    for p in P['proposed_promotions']:
        w(f"| model | {p['at']} | {','.join('#' + str(x) for x in p['carries'])} | {','.join(p['feeds_windows'])} |")
    w('')
    w(f"Booked promotion windows: {len(P['booked_promotions'])}. Model minimum: {len(P['proposed_promotions'])}. Draft or HOLD PRs a window depends on (not placed): " + (', '.join(f"#{n} for {v['window']} (deadline {v['deadline']})" for n, v in P['not_ready_draft_or_hold'].items()) or 'none') + '. Infeasible deadlines: ' + (str(P['infeasible_deadline_before_ready']) or 'none') + '.')
    w('')
    w('Booked merge windows (a PR merges to master at that time; it cannot be promoted earlier): ' + (', '.join(f"{m['key']} {m['at']} (#{','.join(str(x) for x in m['prs'])})" for m in P['booked_merges']) or 'none') + '.')
    w('')
    w('### b3. Candidate window bundles (node K, judged)')
    w('')
    w('Meaning. bundle = merge all members into one window and one promotion. partial = merge only the core; the others keep their windows. split = merge nothing.')
    w('')
    w('| Bundle | Verdict | Rule | Core (in_keys) | Members | Targets | Reason |')
    w('|---|---|---|---|---|---|---|')
    for k in sorted(bun):
        v, b = bun[k], bundle_by[k]
        core = v['in_keys'] if v.get('in_keys') is not None else b['core']
        flag = '' if v['stable'] else ' (UNSTABLE: ' + '/'.join(v['all_verdicts']) + ')'
        w(f"| {k} | {v['verdict']}{flag} | {md_cell(v['rule'], 14)} | {','.join(core) or '-'} | {','.join(b['members'])} | {md_cell(','.join(b['targets']), 60)} | {md_cell(v['note'], 140)} |")
    w('')
    w('Order inside any merged window follows DEPLOY.md: migrate, then snapshot-feed, then api, then mcp-server. The ingestor image never joins a day window; it keeps its CME-halt slot.')
    w('')

    # ------------------------------------------------------------------ (c)
    w('## (c) Rewrite and revert risk')
    w('')
    w('Pairs are A (landed, or scheduled earlier) and B (an open PR that touches the same code). Strong overlap means a shared symbol, config key, SQL object or two new migration revisions in one file set. Doc, test, CI and dependency files never count. A pair where A is already in the history of B is benign (rule P5) and is not listed. Pair count before the cap: ' + str(F['pair_stats'].get('pairs_total')) + ' strong pairs; weak same-file pairs dropped: ' + str(F['pair_stats'].get('weak_dropped')) + '.')
    w('')
    cnt = collections.Counter(v['verdict'] for v in pairs.values())
    w('Judged pairs: ' + ', '.join(f'{k}={n}' for k, n in sorted(cnt.items())) + '.')
    w('')
    byB = collections.defaultdict(list)
    for k, v in pairs.items():
        if v['verdict'] in ('needs-order', 'real-conflict', 'needs-review', 'UNSTABLE'):
            p = pair_by[k]
            byB[p['b']].append((p, v))
    rows = []
    for bnum, lst in byB.items():
        o = prs_open.get(str(bnum), {})
        behind = re.search(r'b_behind_master_commits=(\d+)', lst[0][0]['evidence'])
        rows.append((len([1 for p, v in lst if v['verdict'] == 'real-conflict']), len(lst), bnum, o, behind.group(1) if behind else '?', lst))
    rows.sort(key=lambda r: (-r[0], -r[1], r[2]))
    w('| Open PR B | State | Behind master | Window | A-PRs judged risky | real-conflict | needs-order | needs-review | Action |')
    w('|---|---|---|---|---|---|---|---|---|')
    for rc, n, bnum, o, behind, lst in rows:
        vc = collections.Counter(v['verdict'] for p, v in lst)
        landed_not_in = sum(1 for p, v in lst if p['a_in_b'] is False)
        action = 'rebase on origin/master and retest before merge' if landed_not_in else 'order after the listed open A-PRs'
        w(f"| #{bnum} {md_cell(o.get('title', ''), 60)} | {'draft' if o.get('draft') else 'ready'} | {behind} | {','.join(o.get('windows', [])) or 'none'} | {n} | {vc['real-conflict']} | {vc['needs-order']} | {vc['needs-review'] + vc['UNSTABLE']} | {action} |")
    w('')
    w('### c2. The strongest pairs (files and symbols)')
    w('')
    w('| Pair (A>B) | Verdict | Rule | Shared files | Shared symbols | Note |')
    w('|---|---|---|---|---|---|')
    ranked = sorted([(pair_by[k]['strength'], k, v) for k, v in pairs.items() if v['verdict'] in ('real-conflict', 'needs-order', 'needs-review', 'UNSTABLE')], reverse=True)
    for s, k, v in ranked[:40]:
        p = pair_by[k]
        w(f"| {k} | {v['verdict']} | {md_cell(v['rule'], 12)} | {md_cell(';'.join(p['ov']['shared_files'][:3]), 70)} | {md_cell(';'.join(x.split('::')[-1] for x in p['ov']['symbols'][:5]), 60)} | {md_cell(v['note'], 120)} |")
    w('')
    w(f'The full pair table with every judged row is in `runs/{a.tag}-pairs-*` and `run/facts.json` (key `pairs`).')
    w('')
    hc, hn = F['history_candidates']
    w(f'### c3. Landed-after-landed revert candidates (code only, not judged, low precision)')
    w('')
    w(f'{hn} landed pairs have a later PR whose title carries revert words, a shared symbol and a shared subject word. None was read against the diff (UNVERIFIED); most are fixes to the same function. The shortest gaps:')
    w('')
    w('| A (earlier) | B (later) | Gap days | Shared symbols |')
    w('|---|---|---|---|')
    for r in hc[:10]:
        w(f"| #{r['a']} {md_cell(r['a_title'], 50)} | #{r['b']} {md_cell(r['b_title'], 50)} | {r['gap_days']} | {md_cell(';'.join(x.split('::')[-1] for x in r['symbols']), 60)} |")
    w('')

    # ------------------------------------------------------------------ (d)
    w('## (d) Unwindowed programme items')
    w('')
    ic = collections.Counter(v['verdict'] for v in items.values())
    w('Scope. Open Substrate issues under programme MMD-2331 (not epics) that no live window names. Verdicts: ' + ', '.join(f'{k}={n}' for k, n in sorted(ic.items())) + '. The contract lists four classes; the fifth, no-window-needed, holds analysis, review and decision items that ship nothing.')
    w('')
    for verdict in ('own-window', 'bundle-into', 'zombie-close', 'no-window-needed', 'defer-after-11-05', 'UNSTABLE'):
        keys = sorted([k for k, v in items.items() if v['verdict'] == verdict], key=lambda k: -item_by[k]['value'])
        if not keys:
            continue
        w(f'### d. {verdict} ({len(keys)})')
        w('')
        w('| Item | Title | Value | Target or slot | Rule | Note |')
        w('|---|---|---|---|---|---|')
        for k in keys:
            v, r = items[k], item_by[k]
            tgt = v.get('target') if verdict == 'bundle-into' else (f"{placed[k][0]}-{placed[k][1][6:]}" if k in placed else ('NO SLOT FITS' if verdict == 'own-window' else '-'))
            w(f"| {k} | {md_cell(r['title'], 70)} | {r['value']} | {md_cell(tgt, 30)} | {md_cell(v['rule'], 10)} | {md_cell(v['note'], 100)} |")
        w('')

    # ------------------------------------------------------------------ (e)
    w('## (e) Capacity per day')
    w('')
    w('Model (PROVISIONAL): a day fails when it has more than one halt change, a production change in the evening band, two changes to one container with overlapping slots, working-day utilization above 0.55, or two squeezed verification gaps (under 4 market hours before the next change to the same container). Folded and closed windows are excluded. "As booked" is code arithmetic; "with proposals" adds the judged own-window items at the slots in section (d).')
    w('')
    w('| Day | Windows booked | As booked (code) | With proposals (judge) | Reasons | Utilization |')
    w('|---|---|---|---|---|---|')
    for d in FIN['days']:
        booked = next(x for x in F['days_booked'] if x['day'] == d['day'])
        jv = dayj.get(d['day'], {})
        w(f"| {d['day']} | {booked['n']} | {booked['oracle']} | {jv.get('verdict', '?')} | {','.join(d['reasons']) or '-'} | {d['util']} |")
    w('')
    w(f"Own-window items judged: {len(FIN['own_window_judged'])}; placed: {len(FIN['placed'])}; do not fit: {len(FIN['unplaced'])}.")
    w('')
    if FIN['unplaced']:
        w('Items that do not fit before 2026-11-05, ranked by value (blocks_count plus 2 if a PR exists):')
        w('')
        w('| Item | Title | Value | Why it does not fit |')
        w('|---|---|---|---|')
        for k in sorted(FIN['unplaced'], key=lambda k: -item_by[k]['value']):
            r = item_by[k]
            halt = 'mmd-tick-ingestor-rust' in r['evidence']
            wy = FIN.get('why_unplaced', {}).get(k, {})
            w(f"| {k} | {md_cell(r['title'], 70)} | {r['value']} | {('ingestor image, halt night only; ' if halt else '') + 'slots refused for: ' + (', '.join(f'{a_}={n_}' for a_, n_ in sorted(wy.items(), key=lambda kv: -kv[1])[:4]) or 'no candidate day after blockers')} |")
        w('')

    # ------------------------------------------------------------------ (f) proposals
    props = []

    def add(score, title, action, evidence, risk):
        props.append({'score': score, 'title': title, 'action': action, 'evidence': evidence, 'risk': risk})

    for d in FIN['days']:
        booked = next(x for x in F['days_booked'] if x['day'] == d['day'])
        if booked['oracle'] == 'over-capacity':
            ev = [x for x in booked['evidence'].split(' | ') if x.startswith(('same_target', 'evening_band_v', 'verification_squeezed', 'halt_slot'))]
            add(95 - len(booked['reasons']) * 0, f"Fix the booked calendar on {d['day']}", 'Re-time or merge the windows named in the evidence; each reason below breaks a DEPLOY.md rule or removes verification time.',
                f"reasons={','.join(booked['reasons'])}; " + '; '.join(ev)[:420], 'Moving a window needs a free slot the same week and a coordinator comment with old and new UTC times.')
    clos = [r for r in F['calendar'] if r['terminal'] and r['start'] > nowz and '2026-10-26' <= r['day'] <= '2026-11-05']
    if F['folded_with_slot'] or clos:
        add(80, 'Clear slots that hold no change', 'Clear cf37/cf38 on folded tickets that have not started and on closed tickets whose slot never ran; record the old slot in a comment first.',
            '; '.join(f"{x['key']} folded into {','.join(x['folded_into'])} at {x['start']}" for x in F['folded_with_slot']) + '; ' + '; '.join(f"{r['key']} {r['status']} slot {r['start']}" for r in clos),
            'A slot that ran keeps its fields as the record; only a slot that never ran is cleared (board-audit standing rule).')
    pr = P['proposed_promotions']
    booked_n = len(P['booked_promotions'])
    if pr and len(pr) < booked_n:
        add(88, f'Reduce promotions from {booked_n} booked to {len(pr)}', 'Carry every ready PR in the promotions listed in b2; drop the later booked promotion windows once their PRs are on stable.',
            '; '.join(f"{p['at']} carries {len(p['carries'])} PRs for {','.join(p['feeds_windows'][:6])}" for p in pr),
            'Assumes the open PRs are reviewed and mergeable after the freeze lifts (UNVERIFIED). If they are not, keep the booked daily promotion that carries them.')
    elif pr:
        add(86, f'Keep {len(pr)} promotions but re-time them: none can be dropped', f'The booked calendar has {booked_n} promotions and the deadline model needs {len(pr)}; move the carried PRs to the model times in b2 so that each promotion carries the largest set.',
            '; '.join(f"{p['at']} carries {len(p['carries'])} PRs for {','.join(p['feeds_windows'][:6])}" for p in pr) + '; booked: ' + ', '.join(f"{p['key']} {p['at']}" for p in P['booked_promotions']),
            'Assumes the open PRs are reviewed and mergeable after the freeze lifts (UNVERIFIED).')
    F_win = {r['key']: r['start'] for r in F['calendar']}
    gates = []
    for rc, n, bnum, o, behind, lst in rows:
        ts = [F_win[wk] for wk in o.get('windows', []) if wk in F_win]
        t0 = min(ts) if ts else None
        gates.append((70 + (15 if (t0 and t0 < '11-01') else 0) + min(n, 20) / 2 + rc, bnum, o, behind, lst, n, t0))
    gates.sort(key=lambda g: -g[0])
    for sc, bnum, o, behind, lst, n, t0 in gates[:3]:
        add(sc, f"Gate PR #{bnum} behind a rebase", f"Do not merge or deploy #{bnum} before it is rebased on origin/master and its tests rerun; it is {behind} commits behind and touches code {n} landed or earlier PRs changed.",
            f"{md_cell(o.get('title', ''), 80)}; draft={o.get('draft')}; window={','.join(o.get('windows', [])) or 'none'}" + (f" first slot {t0}" if t0 else '') + "; verdicts: " + ', '.join(f"{p['pair']}={v['verdict']}" for p, v in lst[:4]),
            'A textual merge can succeed while silently dropping A changes; the rebase and retest are the protection.')
    if len(gates) > 3:
        add(66, f"Gate {len(gates) - 3} more open PRs behind a rebase", 'Apply the same rule to every PR in the table of section (c): rebase on origin/master and retest before merge.',
            ', '.join(f"#{g[1]} (behind {g[3]})" for g in gates[3:14]), 'Each rebase can change the PR; the retest is the control.')
    for k in sorted(bun):
        v, b = bun[k], bundle_by[k]
        core = v.get('in_keys') or []
        if v['verdict'] in ('bundle', 'partial') and len(core) >= 2:
            add(60 + len(core), f'Merge windows {", ".join(core[:6])} ({k})', f'Run {", ".join(core)} as one window and one promotion; keep the others as booked.',
                md_cell(v['note'], 260), 'Merging removes verification gaps between the members: keep the order migrate, feed, api, mcp and a watcher check inside the window.')
    z_ = sorted([k for k, v in items.items() if v['verdict'] == 'zombie-close'])
    if z_:
        add(58, f'Close {len(z_)} Substrate issues with evidence of completion', 'Close with the merged PR as the result; the memory gate applies.', f"{len(z_)} items, for example " + ', '.join(z_[:8]),
            'A closure needs the result comment; verify the PR matches the contract before closing.')
    if FIN['unplaced']:
        add(66, f"{len(FIN['unplaced'])} own-window items do not fit before 11-05", 'Rule on each: defer past 11-05, fold into a booked halt night, or free a night.', ', '.join(FIN['unplaced'][:10]), 'Ingestor image changes are limited to the CME halt, never Fri or Sat.')
    d_ = sorted([k for k, v in items.items() if v['verdict'] == 'defer-after-11-05'])
    if d_:
        add(45, f'{len(d_)} items leave the programme (defer past the hard stop)', 'Label them, remove any window hint, report them in the 11-05 end report.', f"{len(d_)} items; reasons are draft contract, a blocker with no window, or no code in flight",
            'An item with a high block count may delay others; see the value column in (d).')
    n_ = sorted([k for k, v in items.items() if v['verdict'] == 'no-window-needed'])
    if n_:
        add(30, f'{len(n_)} items need no window', 'Mark no-window so the window health checks stop counting them.', ', '.join(n_[:8]), 'None for production; the label is bookkeeping.')
    stale = [(n, o) for n, o in prs_open.items() if not o['windows'] and o['created'] < '2026-10-12' and 'deps' not in o['title'].lower() and not re.match(r'(?i)(chore|build)\(deps', o['title'])]
    if stale:
        add(52, f'{len(stale)} open PRs older than two weeks have no window', 'Rule on each: window, rebase, or close.', ', '.join(f"#{n}" for n, o in stale[:12]), 'Closing a draft loses its branch context; the branch remains on GitHub.')
    deps = [n for n, o in prs_open.items() if re.match(r'(?i)(chore|build)\(deps', o['title'])]
    if deps:
        add(35, f'{len(deps)} open dependency PRs: take them in one dedicated promotion', 'Merge after the programme freeze and let the weekly OSV issue decide which to keep.', ', '.join(f'#{n}' for n in deps[:12]), 'Dependency bumps change runtime behaviour; do not carry them in a promotion that also carries data fixes.')
    props.sort(key=lambda p: -p['score'])
    w('## (f) PROPOSALS')
    w('')
    w('Ranked by impact on correctness and on the 11-05 stop. The first ten are the proposals the coordinator should read.')
    w('')
    for i, p in enumerate(props, 1):
        w(f"{i}. **{p['title']}.** {p['action']}  ")
        w(f"   Evidence: {p['evidence']}  ")
        w(f"   Risk: {p['risk']}")
        w('')

    # ------------------------------------------------------------------ corrigenda
    w('## Corrigenda and judge-oracle mismatches')
    w('')
    mism = []
    for node, dd in (('bundles', bun), ('pairs', pairs), ('items', items), ('days', dayj)):
        for k, v in dd.items():
            o = v['oracle'].split('|')[0]
            if v['verdict'] not in (o,):
                mism.append((node, k, o, v.get('all_verdicts') or v['verdict'], md_cell(v.get('rule'), 30), md_cell(v.get('note'), 150)))
    w(f'Judge versus code oracle: {len(mism)} rows differ out of {len(bun) + len(pairs) + len(items) + len(dayj)} judged. The judge may differ only through a semantic step (J1) or by naming a contradicting field.')
    w('')
    w('| Node | Row | Oracle | Judge runs | Rule | Reason |')
    w('|---|---|---|---|---|---|')
    for m in mism:
        w('| ' + ' | '.join(str(x) for x in m) + ' |')
    w('')
    voted = [(n, k) for n, dd in (('bundles', bun), ('pairs', pairs), ('items', items), ('days', dayj)) for k, v in dd.items() if v.get('voted')]
    uns = [(n, k) for n, dd in (('bundles', bun), ('pairs', pairs), ('items', items), ('days', dayj)) for k, v in dd.items() if v['verdict'] in ('UNSTABLE', 'MISSING')]
    w('Rows where run 1 and run 2 disagreed and a third run decided by majority: ' + (', '.join(f'{n}:{k}' for n, k in voted) or 'none') + '.')
    w('')
    w('Rows still without a majority (shown with the code oracle in the tables): ' + (', '.join(f'{n}:{k}' for n, k in uns) or 'none') + '.')
    w('')
    w('Corrections made to my own work during this task (all fixed before this plan was built):')
    w('')
    for c in json.loads((HERE / 'corrigenda.json').read_text()) if (HERE / 'corrigenda.json').exists() else []:
        w(f'- {c}')
    w('')
    w('## Hand-checks against live state')
    w('')
    hp = HERE / 'handchecks.json'
    if hp.exists():
        w('| # | Claim checked | Live source and result | Match |')
        w('|---|---|---|---|')
        for i, h in enumerate(json.loads(hp.read_text()), 1):
            w(f"| {i} | {md_cell(h['claim'], 170)} | {md_cell(h['live'], 260)} | {h['match']} |")
        w('')
    w('## Limits (UNVERIFIED unless stated)')
    w('')
    for c in json.loads((HERE / 'limits.json').read_text()) if (HERE / 'limits.json').exists() else []:
        w(f'- {c}')
    (HERE / a.out).write_text('\n'.join(L) + '\n')
    print('wrote', a.out, len(L), 'lines;', len(props), 'proposals')


if __name__ == '__main__':
    main()
