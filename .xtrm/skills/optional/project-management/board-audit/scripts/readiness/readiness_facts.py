#!/usr/bin/env python3
"""Snapshot + deterministic facts for the code-readiness audit (workflow code-readiness-v1).

One row per unfinished child of the open project epics (the themes linked from PM_JIRA_EPIC). Every
relational fact is computed here so the judge never has to infer it:

  substrate      each named Substrate ref (PM_SB_PREFIX): lifecycle, readiness, closure outcome, createdAt, scope paths
  prs            every PR named in the ticket, bound by a 'Jira binding:' footer, or carrying the
                 key/ref in its title or branch; state, merge SHA, ancestry on origin/master and
                 origin/stable
  paths          each file path the contracts name: exists on origin/master, and the master
                 commits that touched it since the contract was created (the supersession check:
                 a contract was once covered by an older PR and a grep missed it)
  make_targets   each `make <target>` the ticket names: present in origin/master's Makefile
  other_repo     mentions of the sibling repositories listed in config other_repos
  oracle         the code verdict where code can decide; 'judge' otherwise

Settings (pm_config; see ../../references/setup.md): PM_JIRA_PROJECT, PM_JIRA_EPIC, PM_SB_PREFIX,
PM_SB_PROJECT_ID, PM_REPO_SLUG, PM_PR_SINCE, custom_fields, terminal_statuses, readiness_extra_epics,
other_repos, readiness_controls. Jira access through the pack's jira.py.

Usage (run from a PM_REPO_DIR git checkout; read-only everywhere):
  readiness_facts.py snapshot --out rows.json
  readiness_facts.py chunk rows.json --size 40
  readiness_facts.py selftest rows.json
"""
import argparse, datetime as dt, hashlib, importlib.util, json, pathlib, re, subprocess, sys
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / 'project-management' / 'scripts'))
import pm_config  # noqa: E402  (the pack's settings loader)

JIRA_PY = str(pm_config.jira_py())
REPO = pm_config.get('PM_REPO_SLUG')
PROJECT = pm_config.get('PM_JIRA_PROJECT')
ROOT_EPIC = pm_config.get('PM_JIRA_EPIC')
SB_PREFIX = pm_config.get('PM_SB_PREFIX') or 'SB'
SB_PROJECT = pm_config.get('PM_SB_PROJECT_ID')
PR_SINCE = pm_config.get('PM_PR_SINCE')
EXTRA_EPICS = pm_config.get_data('PM_READINESS_EXTRA_EPICS', [])
_CF = pm_config.get_data('PM_CUSTOM_FIELDS', {})
CF_WIN_START, CF_WIN_END = _CF.get('window_start'), _CF.get('window_end')
TERMINAL = set(pm_config.get_data('PM_TERMINAL_STATUSES', []))
OTHER_REPOS = pm_config.get_data('PM_OTHER_REPOS', [])
EXT = r'(?:py|rs|yaml|yml|toml|json|sql|md|sh|mjs|ts|cfg|ini|txt)'
PATH_RE = re.compile(r'(?<![\w/.:-])((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.' + EXT + r')(?![\w/])')
SB_RE = re.compile(r'\b' + re.escape(SB_PREFIX) + r'-(\d{3,4})\b')
SB_NUM = len(SB_PREFIX) + 1   # ref[SB_NUM:] is the number of a <PREFIX>-<n> ref
PR_RE = re.compile(r'(?<![\w/])#(\d{3,4})\b')
MAKE_RE = re.compile(r'\bmake\s+([a-z][a-z0-9-]+)')
OTHER_RE = (re.compile(r'\b(' + '|'.join(re.escape(r) for r in OTHER_REPOS) + r')(?=#\d+|\s+(?:repo|PR|#\d+))', re.I)
            if OTHER_REPOS else None)


def require_settings():
    for name in ('PM_JIRA_PROJECT', 'PM_JIRA_EPIC', 'PM_SB_PREFIX', 'PM_SB_PROJECT_ID', 'PM_REPO_SLUG', 'PM_PR_SINCE'):
        pm_config.get(name, required=True)
    for name in ('PM_CUSTOM_FIELDS', 'PM_TERMINAL_STATUSES'):
        pm_config.get_data(name, required=True)


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
    num = ref[SB_NUM:]
    q = ("select i.created_at from issues i join projects p on p.id=i.project_id "
         f"where p.id='{SB_PROJECT}' and i.human_number={num} limit 1;")
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
    # No --since: covering work can predate the contract (one was drafted after its covering PR merged).
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
    st, root = m.call('GET', f'/rest/api/3/issue/{ROOT_EPIC}?fields=issuelinks')
    linked = {(l.get('outwardIssue') or l.get('inwardIssue'))['key'] for l in root['fields']['issuelinks']}
    epics = {e['key']: e['fields']['summary'] for e in search(m, f'project = {PROJECT} AND issuetype = Epic AND statusCategory != Done', ['summary'])
             if e['key'] in linked or e['key'] in (ROOT_EPIC, *EXTRA_EPICS)}
    F = ['summary', 'status', 'issuetype', 'labels', 'parent', CF_WIN_START, CF_WIN_END, 'duedate', 'description']
    issues = search(m, f'project = {PROJECT} AND parent in (' + ','.join(sorted(epics)) + ') AND statusCategory != Done', F)
    targets = set(re.findall(r'^([a-z][a-z0-9-]+):', sh('git', 'show', 'origin/master:Makefile').stdout, re.M))
    prs = json.loads(sh('gh', 'pr', 'list', '--repo', REPO, '--state', 'all', '--limit', '1500', '--search', f'created:>={PR_SINCE}',
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
        label_refs = sorted({x.split(':', 1)[1] for x in labels if x.startswith(f'substrate:{SB_PREFIX}-')})
        text_refs = sorted({f'{SB_PREFIX}-{n}' for n in SB_RE.findall(text)})
        refs = label_refs or text_refs[:3]
        mentioned = [r for r in text_refs if r not in refs][:5]
        for r in refs + mentioned:
            sbc.setdefault(r, sb_issue(r))
        named = {int(n) for n in PR_RE.findall(text)}
        matched = set()
        for p in prs:
            hay = p['title'] + ' ' + p['headRefName']
            if (re.search(rf'\b{key}\b', hay) or any(re.search(rf'(?i)\b{re.escape(SB_PREFIX)}[-_ ]?{r[SB_NUM:]}\b', hay) for r in refs)
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
            pat = re.compile(rf'(?i){re.escape(SB_PREFIX)}[-_]?{r[SB_NUM:]}(?!\d)')
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
            oracle, why = 'SUPERSEDED', f'every named {SB_PREFIX} ref is closed superseded/duplicate'
        elif sub and all(s.get('closure_outcome') == 'completed' for s in sub) and any(p.get('on_master') for p in prows):
            oracle, why = 'BUILT', f'every named {SB_PREFIX} ref closed completed and a tied PR is merged on master'
        rows.append({'key': key, 'type': f['issuetype']['name'], 'status': status, 'epic': f['parent']['key'],
                     'epic_summary': epics.get(f['parent']['key'], '')[:60], 'window': 'window' in labels,
                     'slot_utc': utc(f.get(CF_WIN_START)), 'slot_end_utc': utc(f.get(CF_WIN_END)),
                     'due': f.get('duedate'), 'summary': f['summary'], 'description': desc.strip()[:2200], 'labels': labels,
                     'sb_refs': refs, 'mentioned_refs': [sbc[r] for r in mentioned], 'substrate': sub, 'prs': prows, 'paths': pf,
                     'unpr_branches': branches,
                     'make_targets': [{'target': t, 'exists_on_master': t in targets} for t in sorted(set(MAKE_RE.findall(text)))],
                     'other_repo_mentions': sorted({o.lower() for o in OTHER_RE.findall(text)}) if OTHER_RE else [], 'oracle': oracle, 'oracle_why': why})
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
        L.append(f'substrate: no {SB_PREFIX} ref named')
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
    # RUBRIC.md names the repository and the Substrate prefix as {repo_name} / {sb_prefix} placeholders.
    rubric = ((pathlib.Path(__file__).parent / 'RUBRIC.md').read_text()
              .replace('{repo_name}', pm_config.get('PM_REPO_NAME', required=True))
              .replace('{sb_prefix}', SB_PREFIX))
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
    # Live controls are board facts, so they live in config (readiness_controls), one object each:
    #   {"name", "key", and any of: "oracle", "oracle_not", "pr_on_master": n, "has_pr": n,
    #    "no_pr_on_master": true, "path_contains" + "commit_terms": [..], "unpr_branch"}
    # Every condition named in one control must hold. No controls configured -> nothing is proven.
    controls = pm_config.get_data('PM_READINESS_CONTROLS', [])
    if not controls:
        print('SKIP no readiness_controls configured: the snapshot is unproven')
    for c in controls:
        r = by.get(c['key'])
        ok = bool(r)
        if ok and 'oracle' in c:
            ok = r['oracle'] == c['oracle']
        if ok and 'oracle_not' in c:
            ok = r['oracle'] != c['oracle_not']
        if ok and 'pr_on_master' in c:
            ok = any(p['number'] == c['pr_on_master'] and p.get('on_master') for p in r['prs'])
        if ok and 'has_pr' in c:
            ok = any(p['number'] == c['has_pr'] for p in r['prs'])
        if ok and c.get('no_pr_on_master'):
            ok = not any(p.get('on_master') for p in r['prs'])
        if ok and 'path_contains' in c:
            ok = any(any(t in x['subject'] for t in c['commit_terms'])
                     for p in r['paths'] if c['path_contains'] in p['path'] for x in p['recent_commits'])
        if ok and 'unpr_branch' in c:
            ok = any(b['branch'] == c['unpr_branch'] for b in r.get('unpr_branches', []))
        check(c['name'], ok)
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
        require_settings()
        snapshot(ns.out)
    elif ns.cmd == 'chunk':
        chunk(ns.path, ns.size)
    else:
        sys.exit(selftest(ns.path))
