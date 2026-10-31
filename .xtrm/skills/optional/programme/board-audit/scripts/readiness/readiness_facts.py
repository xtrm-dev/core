#!/usr/bin/env python3
"""Snapshot + deterministic facts for the code-readiness audit (workflow code-readiness-v1).

One row per unfinished child of the open MMD epics (ISSUE-198 themes). Every relational fact is
computed here so the judge never has to infer it:

  substrate      each named MMD ref: lifecycle, readiness, closure outcome, createdAt, scope paths
  prs            every PR named in the ticket, bound by a 'Jira binding:' footer, or carrying the
                 key/ref in its title or branch; state, merge SHA, ancestry on origin/master and
                 origin/stable
  paths          each file path the contracts name: exists on origin/master, and the master
                 commits that touched it since the contract was created (the supersession check:
                 MMD-2782 was covered by MMD-2456/#920 and a grep missed it)
  make_targets   each `make <target>` the ticket names: present in origin/master's Makefile
  other_repo     mentions of infra / market-archive / quant / sierra repos
  oracle         the code verdict where code can decide; 'judge' otherwise

Usage (run from a market-data git checkout; read-only everywhere):
  readiness_facts.py snapshot --out rows.json
  readiness_facts.py chunk rows.json --size 40
  readiness_facts.py selftest rows.json
"""
import argparse, datetime as dt, hashlib, importlib.util, json, pathlib, re, subprocess, sys
from collections import Counter

JIRA_PY = str(pathlib.Path.home() / '.xtrm/skills/optional/programme/programme-coordination/scripts/jira.py')
REPO = 'mercuryintelligence/market-data'
TERMINAL = {'Completata', 'Done', "Won't Do", 'Cancelled', 'Done with Follow-up'}
EXT = r'(?:py|rs|yaml|yml|toml|json|sql|md|sh|mjs|ts|cfg|ini|txt)'
PATH_RE = re.compile(r'(?<![\w/.:-])((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.' + EXT + r')(?![\w/])')
MMD_RE = re.compile(r'\bMMD-(\d{3,4})\b')
PR_RE = re.compile(r'(?<![\w/])#(\d{3,4})\b')
MAKE_RE = re.compile(r'\bmake\s+([a-z][a-z0-9-]+)')
OTHER_RE = re.compile(r'\b(infra|market-archive|quant|sierra-data|sierra-vps|xtrm-tools)(?=#\d+|\s+(?:repo|PR|#\d+))', re.I)


def sh(*cmd, check=False):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if check and p.returncode:
        raise SystemExit(f'command failed: {" ".join(cmd)}\n{p.stderr[:400]}')
    return p


def jira():
    s = importlib.util.spec_from_file_location('j', JIRA_PY)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


def search(m, jql, fields):
    out, tok = [], None
    while True:
        body = {'jql': jql, 'maxResults': 100, 'fields': fields}
        if tok:
            body['nextPageToken'] = tok
        st, d = m.call('POST', '/rest/api/3/search/jql', body)
        if st != 200:
            raise SystemExit(f'jira search failed {st}: {str(d)[:300]}')
        out += d.get('issues', [])
        tok = d.get('nextPageToken')
        if d.get('isLast', True) or not tok:
            return out


def adf_text(n):
    if isinstance(n, dict):
        t = (n.get('text') or '') + ''.join(adf_text(c) for c in n.get('content', []))
        return t + ('\n' if n.get('type') in ('paragraph', 'heading', 'listItem', 'hardBreak', 'codeBlock') else '')
    return ''


def utc(v):
    if not v:
        return None
    return dt.datetime.strptime(v, '%Y-%m-%dT%H:%M:%S.%f%z').astimezone(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')


_anc = {}
_rb = []


def remote_branches():
    if not _rb:
        out = sh('git', 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin').stdout.split()
        _rb.extend(b for b in out if b not in ('HEAD',))
    return _rb


def ancestor(sha, ref):
    if not sha:
        return None
    if (sha, ref) not in _anc:
        _anc[(sha, ref)] = sh('git', 'merge-base', '--is-ancestor', sha, ref).returncode == 0
    return _anc[(sha, ref)]


def created_iso(ref):
    num = ref.split('-')[1]
    q = ("select i.created_at from issues i join projects p on p.id=i.project_id "
         f"where p.id='prj_mmd' and i.human_number={num} limit 1;")
    v = sh('sqlite3', f'file:{pathlib.Path.home()}/.xtrm/state.db?mode=ro', q).stdout.strip()
    if not v.isdigit():
        return None
    return dt.datetime.fromtimestamp(int(v) / 1000, dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')


def sb_issue(ref):
    try:
        d = json.loads(sh('sb', 'issue', 'show', ref, '--json').stdout)['data']
    except Exception:
        return {'ref': ref, 'found': False}
    c = d.get('contract') or {}
    clo = d.get('closure') or {}
    scope = ' | '.join(c.get('scope') or [])
    success = c.get('success') or ''
    latest = ''
    try:
        e = json.loads(sh('sb', 'journal', 'latest', ref, '--json').stdout)['data']
        e = e[0] if isinstance(e, list) and e else e
        sem = (e or {}).get('semantic') or (e or {}).get('result') or {}
        latest = f"seq{(e or {}).get('seq')} {(e or {}).get('kind')}: {str(sem.get('summary') if isinstance(sem, dict) else sem)[:220]}"
    except Exception:
        pass
    return {'ref': ref, 'found': True, 'title': (d.get('title') or '')[:120], 'lifecycle': d.get('lifecycleState'),
            'readiness': d.get('readinessState'), 'closure_outcome': clo.get('outcome'),
            'closure': f"{clo.get('outcome')}: {str(clo.get('reason'))[:200]}" if clo.get('outcome') else None,
            'created': created_iso(ref), 'scope': scope[:600], 'success': success[:500],
            'paths': sorted(set(PATH_RE.findall(scope + ' ' + success)))[:8], 'latest': latest}


def path_facts(path):
    # No --since: covering work can predate the contract (MMD-2782 was drafted after #920 merged).
    exists = sh('git', 'cat-file', '-e', f'origin/master:{path}').returncode == 0
    args = ['git', 'log', 'origin/master', '--format=%h|%cs|%s', '-n', '6', '--', path]
    commits = []
    for line in sh(*args).stdout.strip().splitlines():
        h, d, s = line.split('|', 2)
        commits.append({'sha': h, 'date': d, 'subject': s[:110], 'on_stable': ancestor(h, 'origin/stable')})
    return {'path': path, 'exists_on_master': exists, 'recent_commits': commits}


def snapshot(out):
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
    sh('git', 'fetch', '-q', 'origin', 'master', 'stable', check=True)
    m = jira()
    st, e198 = m.call('GET', '/rest/api/3/issue/ISSUE-198?fields=issuelinks')
    linked = {(l.get('outwardIssue') or l.get('inwardIssue'))['key'] for l in e198['fields']['issuelinks']}
    epics = {e['key']: e['fields']['summary'] for e in search(m, 'project = ISSUE AND issuetype = Epic AND statusCategory != Done', ['summary'])
             if e['key'] in linked or e['key'] in ('ISSUE-198', 'ISSUE-488')}
    F = ['summary', 'status', 'issuetype', 'labels', 'parent', 'customfield_10237', 'customfield_10238', 'duedate', 'description']
    issues = search(m, 'project = ISSUE AND parent in (' + ','.join(sorted(epics)) + ') AND statusCategory != Done', F)
    targets = set(re.findall(r'^([a-z][a-z0-9-]+):', sh('git', 'show', 'origin/master:Makefile').stdout, re.M))
    prs = json.loads(sh('gh', 'pr', 'list', '--repo', REPO, '--state', 'all', '--limit', '1500', '--search', 'created:>=2026-08-01',
                        '--json', 'number,title,headRefName,state,mergedAt,mergeCommit,body', check=True).stdout)
    if len(prs) < 100:
        raise SystemExit(f'gh returned {len(prs)} PRs: instrument broken (expected hundreds)')
    bynum = {p['number']: p for p in prs}
    sbc, rows = {}, []
    for i in issues:
        f, key = i['fields'], i['key']
        desc = adf_text(f.get('description'))
        text = f['summary'] + '\n' + desc
        labels = f.get('labels') or []
        # A ref has a role: the substrate: label is the ticket's own subject; text mentions are context.
        label_refs = sorted({x.split(':', 1)[1] for x in labels if x.startswith('substrate:MMD-')})
        text_refs = sorted({f'MMD-{n}' for n in MMD_RE.findall(text)})
        refs = label_refs or text_refs[:3]
        mentioned = [r for r in text_refs if r not in refs][:5]
        for r in refs + mentioned:
            sbc.setdefault(r, sb_issue(r))
        named = {int(n) for n in PR_RE.findall(text)}
        matched = set()
        for p in prs:
            hay = p['title'] + ' ' + p['headRefName']
            if (re.search(rf'\b{key}\b', hay) or any(re.search(rf'(?i)\bmmd[-_ ]?{r[4:]}\b', hay) for r in refs)
                    or re.search(rf'Jira binding:[^\n]*\b{key}\b', p.get('body') or '')):
                matched.add(p['number'])
        prows = []
        for n in sorted(named | matched):  # matched uses own refs only (refs), never mentioned ones
            p = bynum.get(n)
            via = '+'.join(v for v, s in (('named', named), ('matched', matched)) if n in s)
            if not p:
                prows.append({'number': n, 'state': 'NOT_IN_LIST', 'via': via})
                continue
            sha = (p.get('mergeCommit') or {}).get('oid')
            prows.append({'number': n, 'state': p['state'], 'title': p['title'][:100], 'via': via,
                          'merged_at': (p.get('mergedAt') or '')[:16] or None, 'merge_sha': sha[:12] if sha else None,
                          'on_master': ancestor(sha, 'origin/master'), 'on_stable': ancestor(sha, 'origin/stable')})
        sub = [sbc[r] for r in refs]
        paths = sorted(set(PATH_RE.findall(text)) | {x for s in sub for x in s.get('paths', [])})[:8]
        pf = [path_facts(x) for x in paths]
        prbranches = {p['headRefName'] for p in prs}
        branches = []
        for r in refs:
            pat = re.compile(rf'(?i)mmd[-_]?{r[4:]}(?!\d)')
            for b in remote_branches():
                if pat.search(b) and b not in prbranches:
                    ahead = sh('git', 'rev-list', '--count', f'origin/master..origin/{b}').stdout.strip()
                    if ahead not in ('', '0'):
                        last = sh('git', 'log', '-1', '--format=%h|%cs|%s', f'origin/{b}').stdout.strip().split('|', 2)
                        branches.append({'branch': b, 'ref': r, 'ahead_of_master': int(ahead), 'last': last})
        status = f['status']['name']
        oracle, why = 'judge', 'no code rule decides'
        if status in TERMINAL:
            oracle, why = 'not_applicable', f'status {status} is terminal'
        elif any(p.get('state') == 'OPEN' and 'matched' in p.get('via', '') for p in prows):
            oracle, why = 'OPEN_PR', 'OPEN PR tied by key/own ref/footer: ' + ','.join(f"#{p['number']}" for p in prows if p.get('state') == 'OPEN' and 'matched' in p.get('via', ''))
        elif branches:
            oracle, why = 'PARTIAL', 'own-ref code on a branch with NO PR: ' + ','.join(b['branch'] for b in branches)
        elif sub and all(s.get('closure_outcome') in ('superseded', 'duplicate') for s in sub):
            oracle, why = 'SUPERSEDED', 'every named MMD ref is closed superseded/duplicate'
        elif sub and all(s.get('closure_outcome') == 'completed' for s in sub) and any(p.get('on_master') for p in prows):
            oracle, why = 'BUILT', 'every named MMD ref closed completed and a tied PR is merged on master'
        rows.append({'key': key, 'type': f['issuetype']['name'], 'status': status, 'epic': f['parent']['key'],
                     'epic_summary': epics.get(f['parent']['key'], '')[:60], 'window': 'window' in labels,
                     'slot_utc': utc(f.get('customfield_10237')), 'slot_end_utc': utc(f.get('customfield_10238')),
                     'due': f.get('duedate'), 'summary': f['summary'], 'description': desc.strip()[:2200], 'labels': labels,
                     'mmd_refs': refs, 'mentioned_refs': [sbc[r] for r in mentioned], 'substrate': sub, 'prs': prows, 'paths': pf,
                     'unpr_branches': branches,
                     'make_targets': [{'target': t, 'exists_on_master': t in targets} for t in sorted(set(MAKE_RE.findall(text)))],
                     'other_repo_mentions': sorted({o.lower() for o in OTHER_RE.findall(text)}), 'oracle': oracle, 'oracle_why': why})
    rows.sort(key=lambda r: (r['slot_utc'] or '9999', r['key']))
    payload = {'stamp': stamp, 'source': 'readiness_facts.py snapshot', 'epics': epics, 'rows': rows}
    payload['input_hash'] = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]
    pathlib.Path(out).write_text(json.dumps(payload, indent=1))
    print(f"{stamp} rows={len(rows)} epics={len(epics)} prs_listed={len(prs)} oracle={dict(Counter(r['oracle'] for r in rows))} hash={payload['input_hash']}")


def evidence_text(r):
    L = [f"key={r['key']} type={r['type']} status={r['status']} window={r['window']} slot_utc={r['slot_utc']} due={r['due']}",
         f"epic={r['epic']} ({r['epic_summary']})", f"summary={r['summary']}", f"oracle={r['oracle']} ({r['oracle_why']})"]
    for s in r['substrate']:
        if not s.get('found'):
            L.append(f"substrate {s['ref']}: NOT FOUND")
            continue
        L += [f"substrate {s['ref']}: '{s['title']}' lifecycle={s['lifecycle']} readiness={s['readiness']} closure={s['closure']} created={s.get('created')}",
              f"  scope: {s['scope'][:400]}", f"  success: {s['success'][:350]}"] + ([f"  latest journal: {s['latest']}"] if s.get('latest') else [])
    if not r['substrate']:
        L.append('substrate: no MMD ref named')
    for s in r.get('mentioned_refs', []):
        L.append(f"mentioned (context, not this ticket's subject) {s['ref']}: '{s.get('title','')[:80]}' lifecycle={s.get('lifecycle')} closure={s.get('closure_outcome')}")
    for b in r.get('unpr_branches', []):
        L.append(f"branch origin/{b['branch']} (own ref {b['ref']}) has NO PR, {b['ahead_of_master']} commits ahead of master, last={b['last']}")
    for p in r['prs']:
        L.append(f"pr #{p['number']} via={p.get('via')} state={p.get('state')} merged={p.get('merged_at')} sha={p.get('merge_sha')} "
                 f"on_master={p.get('on_master')} on_stable={p.get('on_stable')} title={p.get('title')}")
    if not r['prs']:
        L.append('prs: none named, none bound by footer, none with the key or ref in title/branch')
    for pf in r['paths']:
        c = '; '.join(f"{x['sha']} {x['date']} on_stable={x['on_stable']} '{x['subject']}'" for x in pf['recent_commits']) or 'none'
        L.append(f"path {pf['path']} exists_on_master={pf['exists_on_master']} last_commits_on_master: {c}")
    if not r['paths']:
        L.append('paths: none named in ticket or contracts')
    L += [f"make {t['target']} exists_on_master={t['exists_on_master']}" for t in r['make_targets']]
    L.append(f"other_repo_mentions={r['other_repo_mentions'] or 'none'}")
    L.append(f"description (first 1500 chars): {r['description'][:1500]}")
    return '\n'.join(L)


def chunk(path, size):
    d = json.loads(pathlib.Path(path).read_text())
    rows = [r for r in d['rows'] if r['oracle'] != 'not_applicable']
    rubric = (pathlib.Path(__file__).parent / 'RUBRIC.md').read_text()
    for n, i in enumerate(range(0, len(rows), size)):
        part = rows[i:i + size]
        inp = {'batch_id': f"readiness-{d['stamp']}-{n}", 'rubric': rubric,
               'rows': [{'key': r['key'], 'summary': r['summary'][:200], 'oracle': r['oracle'], 'evidence': evidence_text(r)} for r in part]}
        out = pathlib.Path(path).with_suffix(f'.chunk-{n}.json')
        out.write_text(json.dumps(inp, indent=1))
        print(out, len(part), 'rows; max evidence chars', max(len(x['evidence']) for x in inp['rows']))


def selftest(path):
    by = {r['key']: r for r in json.loads(pathlib.Path(path).read_text())['rows']}
    fails = 0

    def check(name, cond):
        nonlocal fails
        print(('PASS ' if cond else 'FAIL ') + name)
        fails += not cond
    r = by.get('ISSUE-423')
    check('positive: ISSUE-423 (MMD-2376) ties #938 merged on master', bool(r) and any(p['number'] == 938 and p.get('on_master') for p in r['prs']))
    r = by.get('ISSUE-345')
    check('positive: ISSUE-345 oracle OPEN_PR via #946', bool(r) and r['oracle'] == 'OPEN_PR' and any(p['number'] == 946 for p in r['prs']))
    r = by.get('ISSUE-501')
    check('positive: ISSUE-501 supersession visible: a commit on config/tick_quarantine.yaml names MMD-2456',
          bool(r) and any('MMD-2456' in c['subject'] or '#920' in c['subject'] for p in r['paths'] if 'tick_quarantine' in p['path'] for c in p['recent_commits']))
    check('positive: ISSUE-501 oracle SUPERSEDED (MMD-2782 closed superseded)', bool(r) and r['oracle'] == 'SUPERSEDED')
    r = by.get('ISSUE-450')
    check('negative: ISSUE-450 (MMD-2659 explorer S1) has no PR merged on master', bool(r) and not any(p.get('on_master') for p in r['prs']))
    r = by.get('ISSUE-246')
    check('negative: ISSUE-246 is not BUILT (its PR #940 is open)', bool(r) and r['oracle'] != 'BUILT')
    r = by.get('ISSUE-495')
    check('positive: ISSUE-495 shows the no-PR branch xt/MMD-2353-stir', bool(r) and any(b['branch'] == 'xt/MMD-2353-stir' for b in r.get('unpr_branches', [])))
    print('controls failed:', fails)
    return 1 if fails else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    sp.add_parser('snapshot').add_argument('--out', required=True)
    b = sp.add_parser('chunk'); b.add_argument('path'); b.add_argument('--size', type=int, default=40)
    sp.add_parser('selftest').add_argument('path')
    ns = ap.parse_args()
    if ns.cmd == 'snapshot':
        snapshot(ns.out)
    elif ns.cmd == 'chunk':
        chunk(ns.path, ns.size)
    else:
        sys.exit(selftest(ns.path))
