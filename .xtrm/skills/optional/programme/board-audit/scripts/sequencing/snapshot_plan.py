#!/usr/bin/env python3
"""Snapshot for programme sequencing (MMD-2909). Read-only against Jira, Substrate, GitHub and git.

Own copy of the board helper's snapshot code (audit-1026/snapshot.py, enrich_sb.py) plus what
sequencing needs: PR changed files with hunk symbols, git ancestry against origin/stable and
origin/master, window comments, and Substrate contracts. Writes <out>/{jira,sb,prs,git,calendar}.json,
each stamped with its own fetch time. The only git command that changes anything is `git fetch`.
"""
import argparse
import concurrent.futures as cf
import datetime
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import time

REPO = 'mercuryintelligence/market-data'
def _repo_root():
    """The checkout whose origin/master and origin/stable are read: MMD_REPO, else the git root of the current directory."""
    if os.environ.get('MMD_REPO'):
        return os.environ['MMD_REPO']
    p = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    return p.stdout.strip() or '.'


WORKTREE = _repo_root()
JIRA_PY = os.environ.get('MMD_JIRA_PY') or str(pathlib.Path.home() / '.pi' / 'agent' / 'skills' / 'programme-coordination' / 'scripts' / 'jira.py')
PR_SINCE = '2026-09-27'
JIRA_FIELDS = [
    'summary', 'status', 'issuetype', 'labels', 'parent', 'duedate', 'customfield_10015',
    'customfield_10237', 'customfield_10238', 'description', 'created', 'updated', 'resolution',
    'resolutiondate', 'assignee', 'issuelinks', 'customfield_10020',
]
NOW = datetime.datetime.now(datetime.UTC)


def log(*a):
    print(f'[{time.strftime("%H:%M:%S", time.gmtime())}Z]', *a, flush=True)


def jira_mod():
    spec = importlib.util.spec_from_file_location('jira', JIRA_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def flatten(node, out=None):
    out = [] if out is None else out
    if isinstance(node, dict):
        t = node.get('type')
        if t == 'text':
            out.append(node.get('text', ''))
        elif t == 'inlineCard':
            out.append(node.get('attrs', {}).get('url', ''))
        elif t == 'hardBreak':
            out.append('\n')
        for c in node.get('content') or []:
            flatten(c, out)
        if t in ('paragraph', 'heading', 'listItem'):
            out.append('\n')
    elif isinstance(node, list):
        for c in node:
            flatten(c, out)
    return out


def adf_text(desc):
    if not desc:
        return ''
    return desc if isinstance(desc, str) else ''.join(flatten(desc))


def page_jql(j, query, fields, cap=3000):
    issues, token = [], None
    while True:
        body = {'jql': query, 'maxResults': 100, 'fields': fields}
        if token:
            body['nextPageToken'] = token
        st, data = j.call('POST', '/rest/api/3/search/jql', body)
        if st != 200:
            raise SystemExit(f'jql {st}: {query} :: {str(data)[:200]}')
        issues += data.get('issues', [])
        token = data.get('nextPageToken')
        if not token or data.get('isLast') or len(issues) >= cap:
            return issues


def to_row(i, tag):
    f = i['fields']
    links = []
    for l in f.get('issuelinks') or []:
        other = l.get('outwardIssue') or l.get('inwardIssue') or {}
        links.append({'type': (l.get('type') or {}).get('name'), 'dir': 'out' if l.get('outwardIssue') else 'in',
                      'key': other.get('key'),
                      'status': ((other.get('fields') or {}).get('status') or {}).get('name')})
    text = adf_text(f.get('description'))
    return {
        'key': i['key'], 'summary': f.get('summary'), 'type': (f.get('issuetype') or {}).get('name'),
        'status': (f.get('status') or {}).get('name'),
        'status_category': ((f.get('status') or {}).get('statusCategory') or {}).get('key'),
        'labels': f.get('labels') or [], 'parent': (f.get('parent') or {}).get('key'), 'links': links,
        'duedate': f.get('duedate'), 'start_date': f.get('customfield_10015'),
        'cf37': f.get('customfield_10237'), 'cf38': f.get('customfield_10238'),
        'created': f.get('created'), 'updated': f.get('updated'),
        'resolution': (f.get('resolution') or {}).get('name'), 'resolutiondate': f.get('resolutiondate'),
        'desc_chars': len(text), 'desc_text': text, 'tags': [tag],
    }


def comments_full(j, key):
    st, data = j.call('GET', f'/rest/api/3/issue/{key}/comment?maxResults=100')
    if st != 200 or not isinstance(data, dict):
        return {'key': key, 'total': None, 'comments': []}
    cs = [{'created': c.get('created'), 'author': (c.get('author') or {}).get('displayName'),
           'text': adf_text(c.get('body'))[:1500]} for c in data.get('comments', [])]
    return {'key': key, 'total': data.get('total'), 'comments': cs}


def snapshot_jira(j):
    seen, rows = set(), []
    queries = [
        ('open', 'project = ISSUE AND statusCategory != Done ORDER BY key ASC'),
        ('epic198_children', 'project = ISSUE AND parent = ISSUE-198 ORDER BY key ASC'),
        ('epic198_linked', 'project = ISSUE AND issue in linkedIssues("ISSUE-198") ORDER BY key ASC'),
        ('recent_done', 'project = ISSUE AND statusCategory = Done AND updated >= -14d ORDER BY key ASC'),
    ]
    for tag, q in queries:
        for i in page_jql(j, q, JIRA_FIELDS):
            if i['key'] not in seen:
                seen.add(i['key'])
                rows.append(to_row(i, tag))
    return rows


def snapshot_calendar(j):
    lo = datetime.datetime(2026, 10, 25, tzinfo=datetime.UTC)
    hi = datetime.datetime(2026, 11, 6, tzinfo=datetime.UTC)
    windows = []
    for i in page_jql(j, 'project = ISSUE AND cf[10237] is not EMPTY ORDER BY cf[10237] ASC', JIRA_FIELDS):
        row = to_row(i, 'calendar')
        try:
            a = datetime.datetime.fromisoformat(row['cf37']).astimezone(datetime.UTC)
            b = datetime.datetime.fromisoformat(row['cf38']).astimezone(datetime.UTC)
        except Exception:
            continue
        if b < lo or a > hi:
            continue
        row.update({'start_utc': a.isoformat(), 'end_utc': b.isoformat()})
        windows.append(row)
    windows.sort(key=lambda r: r['start_utc'])
    return windows


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def sb_cli(args):
    p = sh(['sb'] + args)
    try:
        d = json.loads(p.stdout)
    except Exception:
        return None
    return d.get('data') if isinstance(d, dict) else None


def sb_enrich_one(row, ids):
    iss = row['issue']
    ref = f"MMD-{iss['humanNumber']}"
    d = sb_cli(['issue', 'show', ref, '--json']) or {}
    claim = d.get('claim') or {}
    jr = sb_cli(['journal', 'show', ref, '--limit', '3', '--json'])
    entries = jr if isinstance(jr, list) else (jr or {}).get('entries') or []
    entries = [e for e in entries if isinstance(e, dict)]
    last = entries[-1] if entries else {}
    ts = last.get('createdAt') or last.get('timestamp')
    if isinstance(ts, (int, float)):
        ts = datetime.datetime.fromtimestamp(ts / 1000, datetime.UTC).isoformat()
    sem = last.get('semantic') if isinstance(last.get('semantic'), dict) else {}
    contract = (row.get('revisions') or [{}])[-1].get('contract') or {}
    return {
        'ref': ref, 'flat_id': iss['id'], 'title': iss['title'], 'kind': iss['kind'], 'state': iss['lifecycleState'],
        'deferUntil': iss.get('deferUntil'), 'priority': iss.get('priority'),
        'created_ms': iss['createdAt'], 'updated_ms': iss['updatedAt'],
        'readiness': d.get('readinessState'), 'attested': bool(d.get('attestation')),
        'contractHash': iss.get('currentContractHash'),
        'claim_holder': claim.get('holder'), 'claim_expires_ms': claim.get('expiresAt'),
        'closure': d.get('closure'),
        'last_ts': ts, 'last_kind': last.get('kind'), 'last_summary': str(sem.get('summary') or '')[:300],
        'contract': {k: contract.get(k) for k in ('problem', 'success', 'scope', 'nonGoals', 'constraints',
                                                     'validation', 'output')},
    }


def snapshot_sb(out_dir):
    exp_path = out_dir / 'sb-export.json'
    sh(['sb', 'export', 'project', '--project', 'prj_mmd', '--file', str(exp_path)])
    exp = json.loads(exp_path.read_text())
    ids = {i['issue']['id']: f"MMD-{i['issue']['humanNumber']}" for i in exp['issues']}
    state = {ids[i['issue']['id']]: i['issue']['lifecycleState'] for i in exp['issues']}
    title = {ids[i['issue']['id']]: i['issue']['title'] for i in exp['issues']}
    open_rows = [r for r in exp['issues'] if r['issue']['lifecycleState'] in ('open', 'deferred', 'blocked', 'ready')]
    log('sb open set', len(open_rows))
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        enriched = list(pool.map(lambda r: sb_enrich_one(r, ids), open_rows))
    by_flat = {r['flat_id']: r for r in enriched}
    edges = []
    for e in exp['edges']:
        if not e.get('active'):
            continue
        a, b = ids.get(e['fromIssue']), ids.get(e['toIssue'])
        if a and b:
            edges.append({'kind': e['kind'], 'from': a, 'to': b})
    parent = {}
    for e in edges:
        if e['kind'] == 'parent_child':
            parent[e['to']] = e['from']
    for r in enriched:
        r['parent'] = parent.get(r['ref'])
    return {'open': enriched, 'edges': edges, 'state': state, 'title': title}


FUNC = re.compile(r'^[+-]\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?(?:def|fn|class|struct|enum|trait|impl|type|const|static)\s+([A-Za-z_][A-Za-z0-9_]*)')
HUNK = re.compile(r'^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@\s*(.*)$')
YKEY = re.compile(r'^[+-]\s*([A-Za-z_][A-Za-z0-9_.\-]*)\s*[:=]')
SQLOBJ = re.compile(r'(?i)\b(?:create|alter|drop)\s+(?:table|materialized view|view|index)\s+(?:if (?:not )?exists\s+)?([A-Za-z_][A-Za-z0-9_.]*)')
CONF_EXT = ('.yaml', '.yml', '.toml', '.env', '.ini', '.json')


def file_symbols(path, patch):
    syms, keys, sqls = set(), set(), set()
    for line in (patch or '').splitlines():
        m = HUNK.match(line)
        if m and m.group(1):
            ctx = re.search(r'(?:def|fn|class|struct|enum|trait|impl|type)\s+([A-Za-z_][A-Za-z0-9_]*)', m.group(1))
            if ctx:
                syms.add(ctx.group(1))
            continue
        m = FUNC.match(line)
        if m:
            syms.add(m.group(1))
        if path.endswith(CONF_EXT) or path.startswith('config/'):
            k = YKEY.match(line)
            if k:
                keys.add(k.group(1))
        s = SQLOBJ.search(line) if line[:1] in '+-' else None
        if s:
            sqls.add(s.group(1).lower())
    return sorted(syms)[:60], sorted(keys)[:60], sorted(sqls)[:20]


def pr_files(num):
    p = sh(['gh', 'api', f'repos/{REPO}/pulls/{num}/files', '--paginate', '--jq', '.[]|tojson'])
    files = []
    for line in p.stdout.splitlines():
        try:
            o = json.loads(line)
        except Exception:
            continue
        syms, keys, sqls = file_symbols(o['filename'], o.get('patch'))
        files.append({'path': o['filename'], 'status': o.get('status'), 'add': o.get('additions'),
                      'del': o.get('deletions'), 'symbols': syms, 'config_keys': keys, 'sql_objects': sqls,
                      'patch_missing': o.get('patch') is None and (o.get('changes') or 0) > 0,
                      'previous': o.get('previous_filename')})
    return {'number': num, 'files': files, 'ok': p.returncode == 0}


def snapshot_prs(out_dir):
    fields = 'number,title,state,baseRefName,headRefName,mergedAt,closedAt,createdAt,url,body,mergeCommit,headRefOid,isDraft,labels,reviewDecision,author'
    openp = json.loads(sh(['gh', 'pr', 'list', '--repo', REPO, '--state', 'open', '--json', fields, '--limit', '300']).stdout or '[]')
    merged = json.loads(sh(['gh', 'pr', 'list', '--repo', REPO, '--state', 'merged', '--search', f'merged:>={PR_SINCE}',
                            '--json', fields, '--limit', '400']).stdout or '[]')
    for p in openp:
        p['_state'] = 'OPEN'
    for p in merged:
        p['_state'] = 'MERGED'
    prs = openp + merged
    log('prs', len(openp), 'open', len(merged), 'merged; fetching files')
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        for res in pool.map(lambda p: pr_files(p['number']), prs):
            for p in prs:
                if p['number'] == res['number']:
                    p['files'] = res['files']
                    p['files_ok'] = res['ok']
                    break
    return {'since': PR_SINCE, 'open': len(openp), 'merged': len(merged), 'prs': prs}


def snapshot_git():
    sh(['git', '-C', WORKTREE, 'fetch', 'origin'])
    head = lambda r: sh(['git', '-C', WORKTREE, 'rev-parse', r]).stdout.strip()
    stable_set = set(sh(['git', '-C', WORKTREE, 'rev-list', 'origin/stable']).stdout.split())
    master_set = set(sh(['git', '-C', WORKTREE, 'rev-list', 'origin/master']).stdout.split())
    delta = []
    for line in sh(['git', '-C', WORKTREE, 'log', '--format=%H%x09%P%x09%cI%x09%s', 'origin/stable..origin/master']).stdout.splitlines():
        h, par, ts, subj = line.split('\t', 3)
        delta.append({'sha': h, 'parents': par.split(), 'committed': ts, 'subject': subj})
    stable_ahead = sh(['git', '-C', WORKTREE, 'log', '--format=%H', 'origin/master..origin/stable']).stdout.split()
    return {'master': head('origin/master'), 'stable': head('origin/stable'), 'delta_master_not_stable': delta,
            'stable_not_master': stable_ahead, 'stable_shas': sorted(stable_set), 'master_shas': sorted(master_set)}


def snapshot_ancestry(out_dir):
    """For every open PR: which landed PRs' merge commits are already in its history, and how far behind master it is.
    Fetches the PR head objects by SHA (git fetch only), then reads ancestry with rev-list. Writes ancestry.json."""
    prs = json.loads((out_dir / 'prs.json').read_text())['prs']
    landed = {(p.get('mergeCommit') or {}).get('oid'): p['number'] for p in prs
              if p['_state'] == 'MERGED' and p['baseRefName'] != 'stable' and (p.get('mergeCommit') or {}).get('oid')}
    open_prs = [p for p in prs if p['_state'] == 'OPEN']
    shas = sorted({p['headRefOid'] for p in open_prs if p.get('headRefOid')})
    for i in range(0, len(shas), 12):
        sh(['git', '-C', WORKTREE, 'fetch', '--no-tags', '--quiet', 'origin'] + shas[i:i + 12])
    res = {}
    for p in open_prs:
        h = p.get('headRefOid')
        have = h and sh(['git', '-C', WORKTREE, 'cat-file', '-t', h]).stdout.strip() == 'commit'
        if not have:
            res[str(p['number'])] = {'head': h, 'fetched': False}
            continue
        anc = set(sh(['git', '-C', WORKTREE, 'rev-list', h]).stdout.split())
        behind = sh(['git', '-C', WORKTREE, 'rev-list', '--count', f'{h}..origin/master']).stdout.strip()
        res[str(p['number'])] = {'head': h, 'fetched': True, 'contains': sorted(n for sha_, n in landed.items() if sha_ in anc),
                                 'behind_master': int(behind or 0)}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(pathlib.Path(__file__).parent / 'snap'))
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.UTC).isoformat()
    want = set(a.only.split(',')) if a.only else {'git', 'jira', 'calendar', 'prs', 'sb', 'ancestry'}
    j = jira_mod() if want & {'jira', 'calendar'} else None
    if 'git' in want:
        g = snapshot_git()
        g['fetched_at'] = datetime.datetime.now(datetime.UTC).isoformat()
        (out / 'git.json').write_text(json.dumps(g))
        log('git master', g['master'][:9], 'stable', g['stable'][:9], 'delta', len(g['delta_master_not_stable']))
    if 'jira' in want:
        rows = snapshot_jira(j)
        (out / 'jira.json').write_text(json.dumps({'fetched_at': datetime.datetime.now(datetime.UTC).isoformat(), 'rows': rows}))
        log('jira rows', len(rows))
    if 'calendar' in want:
        wins = snapshot_calendar(j)
        with cf.ThreadPoolExecutor(max_workers=6) as pool:
            cm = {c['key']: c for c in pool.map(lambda w: comments_full(j, w['key']), wins)}
        for w in wins:
            w['comments'] = cm[w['key']]['comments']
            w['comments_total'] = cm[w['key']]['total']
        (out / 'calendar.json').write_text(json.dumps({'fetched_at': datetime.datetime.now(datetime.UTC).isoformat(), 'windows': wins}))
        log('windows', len(wins))
    if 'prs' in want:
        prs = snapshot_prs(out)
        prs['fetched_at'] = datetime.datetime.now(datetime.UTC).isoformat()
        (out / 'prs.json').write_text(json.dumps(prs))
        log('prs written', len(prs['prs']))
    if 'sb' in want:
        sb = snapshot_sb(out)
        sb['fetched_at'] = datetime.datetime.now(datetime.UTC).isoformat()
        (out / 'sb.json').write_text(json.dumps(sb))
        log('sb written', len(sb['open']), 'open;', len(sb['edges']), 'edges')
    if 'ancestry' in want:
        anc = snapshot_ancestry(out)
        (out / 'ancestry.json').write_text(json.dumps({'fetched_at': datetime.datetime.now(datetime.UTC).isoformat(), 'prs': anc}))
        log('ancestry', len(anc), 'open PRs;', sum(1 for v in anc.values() if v.get('fetched')), 'fetched')
    (out / 'STAMP').write_text(stamp)
    log('done', stamp)


if __name__ == '__main__':
    main()
