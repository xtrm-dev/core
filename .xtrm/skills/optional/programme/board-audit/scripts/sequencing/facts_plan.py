#!/usr/bin/env python3
"""Programme sequencing facts (MMD-2909). Deterministic: no model, no network, no clock except --now.

Reads the snapshot written by snapshot_plan.py and writes, per judged node, an input file whose rows carry
precomputed facts and an `oracle` verdict. The workflow judges those rows; it never fetches.

  python3 facts_plan.py --snap snap --out run            # build inputs
  python3 facts_plan.py --selftest                       # positive and negative controls for every rule

Rules live in this file only. Every threshold marked PROVISIONAL is an assumption, not a calibration.
"""
import argparse
import datetime
import json
import pathlib
import re
import subprocess
import sys
from collections import defaultdict

UTC = datetime.UTC
FIRST_DAY = datetime.date(2026, 10, 26)
LAST_DAY = datetime.date(2026, 11, 5)
CST_FROM = datetime.date(2026, 11, 1)            # CDT ends 2026-11-01
TERMINAL = {'Completata', "Won't Do", 'Done with Follow-up', 'Done', 'Cancelled'}
FRESH_SECONDS = 3600
# PROVISIONAL constants (assumptions from DEPLOY.md and operator rulings, not calibrated):
WORKDAY_START = (6, 15)            # after the 05:45-06:15Z rollover quiet
WORKDAY_END = (20, 0)              # evening band starts 20:00Z in CDT
MAX_UTIL = 0.55                    # fraction of the 06:15-20:00Z day that booked change windows may fill
MAX_CHANGES_PER_DAY = 6            # production changes per day (PROVISIONAL; the booked calendar peaks at 5)
MIN_VERIFY_MARKET_H = 4            # market hours between two changes to one container
HUB_CHILDREN = 8                   # a parent with more children than this is a hub, not evidence of adjacency
P5_CONTROLS = 25                   # benign A-in-B-history pairs kept in the judged set as negative controls
BUNDLE_CAP = 8                     # largest bundle one window can carry (PROVISIONAL)
STOP_SQL = {'if', 'no', 'not', 'exists', 'the', 'a', 'on', 'table', 'view', 'index', 'only', 'to', 'in', 'as', 'or', 'and'}
TITLE_STOP = {'fix', 'feat', 'chore', 'with', 'from', 'that', 'this', 'into', 'issue', 'part', 'review', 'only', 'when', 'wire', 'adds', 'build', 'deps', 'test', 'tests', 'docs', 'than', 'then', 'also', 'make', 'not', 'for', 'and', 'the', 'its', 'are', 'was', 'use', 'uses', 'bump', 'hold', 'stacked', 'behind', 'default', 'every', 'each'}
STOP_SYMBOLS = {'main', 'new', 'default', 'run', 'setup', 'test', 'tests', 'fmt', 'from', 'drop', 'build', 'init',
                '__init__', 'get', 'set', 'parse', 'load', 'save', 'help', 'mod', 'build_parser', 'cli'}
REVERT_RE = re.compile(r'\b(revert(?:s|ed|ing)?|roll(?:s|ed)?[ -]?back|undo(?:es|ing)?|restore[sd]?|retire[sd]?|remove[sd]?|drop(?:s|ped)?|'
                       r'replace[sd]?|rewrite[sd]?|supersede[sd]?|delete[sd]?|purge[sd]?)\b', re.I)
NOSHIP_RE = re.compile(r'\b(review(?:er)?|verdict|audit|read-only|report|rubric|assertions?|judge|tests?|plants?|helper|fixture|harness|eval|plant|monitor-only|survey|inventory|postmortem|reconcile|service-knowledge|documentation)\b', re.I)
DESTRUCTIVE_RE = re.compile(r'\b(drop|purge|retire|delete|destructive)\b', re.I)
PATH_RE = re.compile(r'(?<![\w/.-])((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.(?:py|rs|yaml|yml|sql|toml|json|sh|md|cfg|ini))\b')


# ----------------------------------------------------------------------------- time and calendar

def utc(v):
    if not v:
        return None
    try:
        return datetime.datetime.fromisoformat(str(v).replace('Z', '+00:00')).astimezone(UTC)
    except Exception:
        return None


def z(dt):
    return dt.strftime('%m-%dT%H:%MZ') if dt else 'none'


def halt_band(day):
    cst = day >= CST_FROM
    lo, hi = ((22, 17), (22, 55)) if cst else ((21, 17), (21, 55))
    t = lambda h: datetime.datetime(day.year, day.month, day.day, h[0], h[1], tzinfo=UTC)
    return t(lo), t(hi)


def evening_band(day):
    cst = day >= CST_FROM
    a, b = ((21, 0), (24, 0)) if cst else ((20, 0), (23, 0))
    base = datetime.datetime(day.year, day.month, day.day, tzinfo=UTC)
    return base + datetime.timedelta(hours=a[0]), base + datetime.timedelta(hours=b[0])


def in_halt(a, b):
    """True when a short slot intersects the CME halt of a day it touches. Long intake windows are not halt changes."""
    if (b - a) > datetime.timedelta(hours=4):
        return False
    for d in {a.date(), b.date()}:
        lo, hi = halt_band(d)
        if a < hi and lo < b:
            return True
    return False


def in_evening_not_halt(a, b):
    if (b - a) > datetime.timedelta(hours=4):
        return False
    for d in {a.date(), b.date()}:
        lo, hi = evening_band(d)
        if a < hi and lo < b and not in_halt(a, b):
            return True
    return False


def market_open(dt):
    """Globex open: Sun ~22:00Z (23:00Z CST) to Fri ~21:00Z (22:00Z CST), minus the daily one-hour halt."""
    cst = dt.date() >= CST_FROM
    off = 1 if cst else 0
    wd = dt.weekday()                                   # Mon=0 .. Sun=6
    h = dt.hour + dt.minute / 60
    if wd == 5:
        return False
    if wd == 4 and h >= 21 + off:
        return False
    if wd == 6 and h < 22 + off:
        return False
    return not (21 + off <= h < 22 + off)


def market_hours_between(a, b):
    if b <= a:
        return 0.0
    n, t = 0, a
    while t < b:
        step = min(datetime.timedelta(minutes=30), b - t)
        if market_open(t):
            n += step.total_seconds()
        t += step
    return round(n / 3600, 1)


# ----------------------------------------------------------------------------- paths and targets

def classify_path(p):
    if p.startswith('alembic/versions/'):
        return 'migration'
    if p.startswith(('docs/', '.xtrm/', '.specialists/', '.claude/', '.agent/', '.gemini/', '.qwen/', '.githooks/')) or \
            p.endswith(('.md', '.gitignore', '.gitleaksignore')) or p in ('AGENTS.md', 'CLAUDE.md'):
        return 'doc'
    if p.startswith('.github/'):
        return 'ci'
    if p.startswith('tests/') or '/tests/' in p or re.search(r'(^|/)test_[^/]+\.py$|_test\.rs$', p):
        return 'test'
    if re.match(r'(requirements[^/]*\.txt|uv\.lock|poetry\.lock|Cargo\.lock|package-lock\.json|pyproject\.toml|osv-scanner\.toml)$', p) or \
            p.endswith(('Cargo.lock', 'package-lock.json')):
        return 'deps'
    if p.startswith('mercury-tui'):
        return 'other-repo'
    if p.startswith(('data/', 'evals/')):
        return 'data'
    if p.startswith('config/') or p == '.env.TEMPLATE' or p.startswith('docker-compose'):
        return 'config'
    if p == 'Makefile' or p == 'DEPLOY.md' or p.startswith('scripts/ops/') or p.startswith('scripts/ci/'):
        return 'tooling'
    return 'src'


def target_of(p):
    """Deploy target of a changed path. Order matters: the first rule that matches wins."""
    c = classify_path(p)
    if c in ('doc', 'test', 'ci', 'deps', 'other-repo', 'data'):
        return 'non-runtime'
    if c == 'migration':
        return 'migrate'
    if p.startswith('rust_ingestor/'):
        return 'mmd-tick-ingestor-rust'
    if p.startswith('config/'):
        return 'config(live ingestor at first 21:15Z restart)'
    if p.startswith('docker-compose') or p == '.env.TEMPLATE':
        return 'infra-compose'
    if c == 'tooling':
        return 'ops-tooling'
    if p.startswith(('api/mcp_server', 'api/mcp_v2/', 'api/docstrings/', 'api/mcp_http', 'api/toon', 'api/filtering', 'api/models/mcp_v2')):
        return 'mmd-mcp-server'
    if p.startswith('api/'):
        return 'mmd-api'
    if p.startswith('scripts/ingestion/'):
        return 'mmd-options-ingestor'
    if p.startswith('scripts/backup/'):
        return 'mmd-backup-service'
    if p.startswith(('analytics/', 'scripts/data/')):
        return 'mmd-snapshot-feed'
    return 'other-runtime'


HALT_ONLY_TARGETS = {'mmd-tick-ingestor-rust'}
DEPLOY_CONTAINERS = {'mmd-tick-ingestor-rust', 'mmd-mcp-server', 'mmd-api', 'mmd-snapshot-feed', 'mmd-options-ingestor', 'mmd-backup-service', 'mmd-data-feed'}
PROD_TARGETS = {'migrate', 'mmd-tick-ingestor-rust', 'mmd-mcp-server', 'mmd-api', 'mmd-snapshot-feed', 'mmd-options-ingestor',
                'mmd-backup-service', 'mmd-data-feed'}


# ----------------------------------------------------------------------------- windows

def window_kinds(summary, labels, start=None, end=None):
    s = (summary or '').lower()
    k = set()
    if re.match(r'promotion\b', s) and ('stable' in s or 'master' in s):
        k.add('promotion')
    elif re.match(r'(mmd )?merge\b', s):
        k.add('merge')
    if 'allowlist rotation' in s:
        k.add('mcp-rotation')
    if re.match(r'release v', s):
        k.add('release-tag')
    if 'ingestor' in s and ('swap' in s or 'image' in s) or 'cme halt' in s:
        k.add('ingestor-swap')
    if 'migrat' in s:
        k.add('migrate')
    if 'deploy' in s:
        k.add('deploy')
    if re.search(r'\b(repair|backfill|rebuild|recreate|quarantine|apply|switch|flip|cutover|switch-on|writer on|shadow)\b', s):
        k.add('data-change')
    if re.search(r'\b(verify|verifier|check|gate|report|review|checkpoint|compare|reads?|health)\b', s):
        k.add('verify')
    if re.search(r'\b(host|reclaim|reboot|restart)\b', s):
        k.add('host')
    if 'operator' in s or 'sergiu' in s:
        k.add('operator')
    # Destructive means the window itself removes data or objects. A feed deploy that ships a purge PR, or a verify gate named after a purge, is not.
    if DESTRUCTIVE_RE.search(s) and not ('verify' in k and not k & {'migrate', 'deploy'}) and not ('deploy' in k and 'migrate' not in k):
        k.add('destructive')
    if start and end and in_halt(start, end):
        k.add('halt-slot')
    return sorted(k)


PROD_KINDS = {'ingestor-swap', 'migrate', 'deploy', 'destructive', 'data-change', 'halt-slot'}


def is_prod_change(kinds):
    """A window changes production when it carries a prod kind and is not only a verify/gate/read."""
    ks = set(kinds)
    if not ks & PROD_KINDS:
        return False
    return not ('verify' in ks and not ks & {'deploy', 'migrate', 'ingestor-swap', 'destructive'})


def window_targets(summary, pr_tg):
    s = (summary or '').lower()
    t = set(pr_tg)
    for key, name in (('mmd-api', 'mmd-api'), ('mmd-mcp-server', 'mmd-mcp-server'), ('snapshot-feed', 'mmd-snapshot-feed'),
                      ('ingestor', 'mmd-tick-ingestor-rust'), ('mmd-data-feed', 'mmd-data-feed'), ('backup-service', 'mmd-backup-service'),
                      ('questdb', 'questdb'), ('timescale', 'migrate'), ('migrat', 'migrate')):
        if key in s:
            t.add(name)
    t.discard('non-runtime')
    return sorted(t)


def is_folded(labels):
    return any(l.startswith('folded-into:') for l in labels or [])


def halt_collisions(windows, now):
    """Windows whose slots both sit in the same night's CME halt, from the slot fields only. A folded ticket is
    bookkeeping and never a second change; a summary that merely mentions a restart time never counts."""
    by_day = defaultdict(list)
    for w in windows:
        a, b = utc(w['start_utc']), utc(w['end_utc'])
        if not a or not b or is_folded(w.get('labels')) or w.get('status') in TERMINAL:
            continue
        if in_halt(a, b):
            by_day[a.date()].append(w['key'])
    return {d.isoformat(): ks for d, ks in by_day.items() if len(ks) > 1}


# ----------------------------------------------------------------------------- PR footprints

def refs_in(text, pat):
    return set(re.findall(pat, text or ''))


def build_prs(snap):
    g = snap['git']
    stable, master = set(g['stable_shas']), set(g['master_shas'])
    out = {}
    for p in snap['prs']['prs']:
        sha = (p.get('mergeCommit') or {}).get('oid')
        if p['_state'] == 'OPEN':
            landed = 'open'
        elif p['baseRefName'] == 'stable':
            landed = 'promotion'
        elif sha in stable:
            landed = 'stable'
        elif sha in master:
            landed = 'master'
        else:
            landed = 'unknown'
        title = p.get('title') or ''
        files = {}
        for f in p.get('files') or []:
            c = classify_path(f['path'])
            files[f['path']] = {'cls': c, 'target': target_of(f['path']), 'status': f.get('status'),
                                'add': f.get('add') or 0, 'del': f.get('del') or 0,
                                'symbols': [s for s in f.get('symbols') or [] if s not in STOP_SYMBOLS],
                                'keys': f.get('config_keys') or [], 'sql': [q for q in (f.get('sql_objects') or []) if q not in STOP_SQL and len(q) > 2],
                                'patch_missing': bool(f.get('patch_missing'))}
        strong = refs_in(title + ' ' + (p.get('headRefName') or ''), r'MMD-\d+') | \
            {'MMD-' + m for m in re.findall(r'(?i)mmd[-_]?(\d{3,4})', p.get('headRefName') or '')}
        out[p['number']] = {
            'n': p['number'], 'title': title, 'state': p['_state'], 'base': p['baseRefName'], 'draft': bool(p.get('isDraft')),
            'created': p.get('createdAt'), 'merged': p.get('mergedAt'), 'sha': sha, 'landed': landed,
            'refs_strong': sorted(strong), 'refs_weak': sorted(refs_in(p.get('body'), r'MMD-\d+') - strong),
            'jira': sorted(refs_in(title + ' ' + (p.get('body') or ''), r'ISSUE-\d+')),
            'kind': 'deps' if re.match(r'(?i)(chore|build)\(deps', title) or 'dependabot' in (p.get('headRefName') or '') else 'work',
            'files': files, 'review': p.get('reviewDecision') or '', 'hold': title.upper().startswith('HOLD'),
        }
    return out


def title_tokens(t):
    return {w for w in re.findall(r'[a-z][a-z0-9_]{3,}', (t or '').lower()) if w not in TITLE_STOP and not re.fullmatch(r'mmd\d*', w)}


def pr_targets(pr):
    return sorted({f['target'] for f in pr['files'].values()} - {'non-runtime'})


def relevant_files(pr):
    return {p: f for p, f in pr['files'].items() if f['cls'] in ('src', 'config', 'migration', 'tooling')}


def pair_overlap(fa, fb):
    """Overlap between two footprints {path: {cls, symbols, keys, sql, status, patch_missing}}.
    Strong: same symbol in one file, same config key, same SQL object, or two new migration revisions.
    Weak: same relevant file with no shared symbol. Doc, test, ci and dependency files never count."""
    rel = lambda fp: {p: f for p, f in fp.items() if f['cls'] in ('src', 'config', 'migration', 'tooling')}
    ra, rb = rel(fa), rel(fb)
    shared = sorted(set(ra) & set(rb))
    syms, keys, sqls, unreliable = [], [], [], False
    for p in shared:
        a, b = ra[p], rb[p]
        syms += [f'{p}::{s}' for s in sorted(set(a['symbols']) & set(b['symbols']))]
        keys += [f'{p}::{k}' for k in sorted(set(a['keys']) & set(b['keys']))]
        sqls += sorted(set(a['sql']) & set(b['sql']))
        if a.get('patch_missing') or b.get('patch_missing') or a.get('declared') or b.get('declared'):
            unreliable = True
    mig_a = {p for p, f in ra.items() if f['cls'] == 'migration' and f.get('status') in ('added', None, 'declared')}
    mig_b = {p for p, f in rb.items() if f['cls'] == 'migration' and f.get('status') in ('added', None, 'declared')}
    mig_chain = bool(mig_a and mig_b and mig_a != mig_b)
    strong = bool(syms or keys or sqls or mig_chain)
    return {'shared_files': shared, 'symbols': syms, 'keys': keys, 'sql': sqls, 'migration_chain': mig_chain,
            'strong': strong, 'weak': bool(shared) and not strong, 'unreliable': unreliable and bool(shared)}


def pair_oracle(ov, b_title, a_title='', a_in_b=None, a_open=False):
    """Rule order is the rubric order. a_in_b: True when A's merge commit is already in B's history, False when it is not,
    None when unknown. Returns (verdict, rule)."""
    if not (ov['strong'] or ov['weak']):
        return 'benign', 'P0'
    if ov['unreliable'] and not ov['strong']:
        return 'needs-review', 'P1'
    shared_subject = bool(title_tokens(b_title) & title_tokens(a_title)) if a_title else True
    if REVERT_RE.search(b_title or '') and ov['shared_files'] and shared_subject:
        return 'real-conflict', 'P2'
    if ov['strong']:
        if not a_open and a_in_b is True:
            return 'benign', 'P5'
        if not a_open and a_in_b is None:
            return 'needs-review', 'P6'
        return 'needs-order', 'P3'
    return 'benign', 'P4'


# ----------------------------------------------------------------------------- bundles

def bundle_oracle(members):
    """members: dicts with key, kinds, targets, destructive, blocked, lane. Returns (verdict, rule, core_keys).
    bundle = merge every member into one window; partial = merge only `core`, the rest keep their own windows;
    split = merge nothing. A member that cannot join (destructive stage, halt-only image swap, blocked) never rides in the core."""
    halt = [m for m in members if set(m['targets']) & HALT_ONLY_TARGETS or 'ingestor-swap' in m['kinds'] or 'halt-slot' in m['kinds']]
    destr = [m for m in members if m['destructive'] or 'mcp-rotation' in m['kinds']]
    live = [m for m in members if not m['blocked']]
    if len(destr) >= 2:
        core = [m['key'] for m in members if m not in destr and not m['blocked'] and m not in halt]
        return ('partial', 'K1', core) if len(core) >= 2 else ('split', 'K1', [])
    if halt and len(halt) < len(members):
        core = [m['key'] for m in members if m not in halt and not m['blocked']]
        return ('partial', 'K2', core) if len(core) >= 2 else ('split', 'K2', [])
    if len(live) < len(members):
        core = [m['key'] for m in live]
        return ('partial', 'K3', core) if len(core) >= 2 else ('split', 'K3', [])
    return 'bundle', 'K5', [m['key'] for m in members]


class UF:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


# ----------------------------------------------------------------------------- build

def load_snap(d):
    d = pathlib.Path(d)
    snap = {n: json.loads((d / f'{n}.json').read_text()) for n in ('git', 'jira', 'calendar', 'prs', 'sb')}
    snap['ancestry'] = json.loads((d / 'ancestry.json').read_text()) if (d / 'ancestry.json').exists() else {'prs': {}}
    return snap


def default_repo():
    """MMD_REPO, else the git root of the current directory."""
    import os
    if os.environ.get('MMD_REPO'):
        return os.environ['MMD_REPO']
    p = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    return p.stdout.strip() or '.'


def tracked_files(worktree):
    p = subprocess.run(['git', '-C', worktree, 'ls-tree', '-r', '--name-only', 'origin/master'], capture_output=True, text=True)
    return set(p.stdout.split())


def day_range():
    d = FIRST_DAY
    while d <= LAST_DAY:
        yield d
        d += datetime.timedelta(days=1)


def short(s, n=70):
    s = re.sub(r'\s+', ' ', s or '').strip()
    return s if len(s) <= n else s[:n - 1] + '~'


def build(snap, now, tracked=frozenset()):
    prs = build_prs(snap)
    jira = {r['key']: r for r in snap['jira']['rows']}
    sbs = {r['ref']: r for r in snap['sb']['open']}
    sb_state = snap['sb']['state']
    edges = snap['sb']['edges']
    parent = {e['to']: e['from'] for e in edges if e['kind'] == 'parent_child'}
    children = defaultdict(list)
    for e in edges:
        if e['kind'] == 'parent_child':
            children[e['from']].append(e['to'])
    blocks_out, blocks_in = defaultdict(set), defaultdict(set)
    for e in edges:
        if e['kind'] == 'blocks':
            blocks_out[e['from']].add(e['to'])
            blocks_in[e['to']].add(e['from'])
    mirror = {}
    for r in jira.values():
        for l in r['labels']:
            if l.startswith('substrate:'):
                mirror.setdefault(l.split(':', 1)[1], []).append(r['key'])

    windows = {}
    for w in snap['calendar']['windows']:
        a, b = utc(w['start_utc']), utc(w['end_utc'])
        desc = w.get('desc_text') or ''
        named = refs_in(desc + ' ' + (w.get('summary') or ''), r'(?:#|market-data#|pull/)(\d{3,4})')
        linked = set()
        for c in w.get('comments') or []:
            linked |= refs_in(c['text'], r'PR-link market-data#(\d+)')
        nums = sorted({int(x) for x in named | linked if int(x) in prs and prs[int(x)]['landed'] != 'promotion'})
        kinds = window_kinds(w['summary'], w['labels'], a, b)
        ptg = sorted({t for n in nums for t in pr_targets(prs[n])})
        windows[w['key']] = {
            'key': w['key'], 'summary': w['summary'], 'status': w['status'], 'start': a, 'end': b, 'labels': w['labels'],
            'parent': w.get('parent'), 'kinds': kinds, 'prod_change': is_prod_change(kinds), 'terminal': w['status'] in TERMINAL,
            'folded': is_folded(w['labels']), 'folded_into': [l.split(':', 1)[1] for l in w['labels'] if l.startswith('folded-into:')],
            'sb_refs': [l.split(':', 1)[1] for l in w['labels'] if l.startswith('substrate:')],
            'prs': nums, 'targets': window_targets(w['summary'], ptg), 'destructive': 'destructive' in kinds,
            'blocked': w['status'] == 'Blocked', 'comments': w.get('comments_total'), 'future': b >= now,
        }
    live_windows = {k: w for k, w in windows.items() if not w['terminal'] and not w['folded'] and w['future']}

    promote_at, deploy_at, merge_at = {}, {}, {}
    for w in live_windows.values():
        for n in w['prs']:
            if 'merge' in w['kinds']:
                if n not in merge_at or w['start'] < merge_at[n][0]:
                    merge_at[n] = (w['start'], w['key'])
                continue
            tgt = promote_at if 'promotion' in w['kinds'] else deploy_at
            if n not in tgt or w['start'] < tgt[n][0]:
                tgt[n] = (w['start'], w['key'])
    for n, pr in prs.items():
        sel = deploy_at.get(n) or promote_at.get(n) or (None, None)
        pr['t_ship'], pr['ship_window'] = sel
        pr['windows'] = sorted(k for k, w in live_windows.items() if n in w['prs'])

    def under(ref, top):
        n = 0
        while ref in parent and n < 30:
            ref = parent[ref]
            n += 1
            if ref == top:
                return True
        return False

    def ancestors(ref):
        out, n = [], 0
        while ref in parent and n < 12:
            ref = parent[ref]
            out.append(ref)
            n += 1
        return out

    win_ref = defaultdict(list)
    for w in live_windows.values():
        for r in w['sb_refs']:
            win_ref[r].append(w['key'])
    strong_open, strong_merged = defaultdict(list), defaultdict(list)
    for n, pr in prs.items():
        for r in pr['refs_strong']:
            (strong_open if pr['state'] == 'OPEN' else strong_merged)[r].append(n)

    items = {}
    for ref, r in sbs.items():
        if r['kind'] == 'epic' or not under(ref, 'MMD-2331') or r['state'] == 'done':
            continue
        anc = ancestors(ref)
        last = utc(r.get('last_ts')) or datetime.datetime.fromtimestamp((r.get('updated_ms') or 0) / 1000, UTC)
        c = r['contract']
        scope = c.get('scope')
        txt = ' '.join(str(x) for x in (c.get('problem'), c.get('success'), ' '.join(scope) if isinstance(scope, list) else scope) if x)
        rel_dup = [(e['kind'], e['from'], e['to']) for e in edges if e['kind'] in ('duplicates', 'supersedes') and ref in (e['from'], e['to'])]
        items[ref] = {
            'ref': ref, 'title': r['title'], 'kind': r['kind'], 'state': r['state'], 'readiness': r['readiness'], 'attested': r['attested'],
            'claim': r.get('claim_holder'), 'idle_days': (now - last).days, 'last_kind': r.get('last_kind'),
            'problem': (c.get('problem') or '')[:280], 'success': (c.get('success') or '')[:200],
            'deferUntil': r.get('deferUntil'), 'parent': parent.get(ref), 'ancestors': anc,
            'windows_direct': sorted(win_ref.get(ref, [])),
            'windows_via_ancestor': sorted({w for a in anc for w in win_ref.get(a, [])}),
            'open_prs': sorted(strong_open.get(ref, [])), 'merged_prs': sorted(strong_merged.get(ref, [])),
            'blockers': sorted(b for b in blocks_in.get(ref, set()) if sb_state.get(b) not in ('done', 'cancelled')),
            'blocks': sorted(blocks_out.get(ref, set())), 'jira': mirror.get(ref, []),
            'declared': sorted({p for p in PATH_RE.findall(txt) if p in tracked}), 'rel_dup': rel_dup,
            'parent_state': sb_state.get(parent.get(ref)), 'text': txt,
        }
    return {'prs': prs, 'jira': jira, 'windows': windows, 'live_windows': live_windows, 'items': items, 'sb_state': sb_state,
            'sb_title': snap['sb']['title'], 'blocks_out': blocks_out, 'blocks_in': blocks_in, 'parent': parent, 'children': children,
            'now': now, 'win_ref': win_ref, 'promote_at': promote_at, 'deploy_at': deploy_at, 'merge_at': merge_at, 'git': snap['git'], 'ancestry': snap['ancestry']['prs']}


def build_pairs(B, cap=1000):
    prs = B['prs']
    work = {n: p for n, p in prs.items() if p['kind'] == 'work' and p['landed'] != 'promotion' and relevant_files(p)}
    earlier = [p for p in work.values() if p['landed'] in ('stable', 'master', 'open')]
    rows, stats, seen = [], defaultdict(int), set()
    inf = datetime.datetime.max.replace(tzinfo=UTC)

    def tkey(p):
        if p['landed'] in ('stable', 'master'):
            return (0, utc(p['merged']) or inf, p['n'])
        return (1, p['t_ship'] or inf, p['n'])

    for b in work.values():
        if b['landed'] != 'open':
            continue
        for a in earlier:
            if a['n'] == b['n'] or (a['n'], b['n']) in seen or (b['n'], a['n']) in seen:
                continue
            if a['landed'] == 'open' and tkey(a) > tkey(b):
                continue                                     # an open pair is judged once, earlier first
            ov = pair_overlap(relevant_files(a), relevant_files(b))
            if not (ov['strong'] or ov['weak']):
                continue
            predates = bool(a['landed'] in ('stable', 'master') and utc(b['created']) and utc(a['merged']) and utc(b['created']) < utc(a['merged']))
            an = B['ancestry'].get(str(b['n']), {})
            a_in_b = (a['n'] in an.get('contains', [])) if an.get('fetched') else None
            if ov['weak'] and not ov['unreliable']:
                stats['weak_dropped'] += 1
                continue
            seen.add((a['n'], b['n']))
            verdict, rule = pair_oracle(ov, b['title'], a['title'], a_in_b, a['landed'] == 'open')
            if rule == 'P5':
                stats['benign_a_in_b_history'] += 1
            order_holds = 'yes' if a['landed'] in ('stable', 'master') else (
                'yes' if (a['t_ship'] and b['t_ship'] and a['t_ship'] <= b['t_ship']) else 'unknown')
            same_win = bool(set(a['windows']) & set(b['windows']))
            tshared = sorted(title_tokens(b['title']) & title_tokens(a['title']))
            rows.append({
                'pair': f"PR#{a['n']}>PR#{b['n']}", 'a': a['n'], 'b': b['n'], 'oracle': verdict, 'rule': rule, 'ov': ov, 'predates': predates, 'a_in_b': a_in_b,
                'strength': (3 if REVERT_RE.search(b['title']) and ov['shared_files'] else 0) + 2 * len(ov['symbols']) + 2 * len(ov['keys']) + len(ov['sql'])
                + (3 if ov['migration_chain'] else 0) + (1 if predates else 0) - (100 if rule == 'P5' else 0),
                'evidence': ' | '.join([
                    f"A=PR#{a['n']} landed={a['landed']} merged={z(utc(a['merged']))} refs={','.join(a['refs_strong']) or 'none'} title={short(a['title'], 80)!r}",
                    f"B=PR#{b['n']} landed=open draft={b['draft']} hold={b['hold']} created={z(utc(b['created']))} refs={','.join(b['refs_strong']) or 'none'} title={short(b['title'], 80)!r}",
                    f"a_in_b_history={'yes' if a_in_b else 'no' if a_in_b is False else 'unknown'} b_behind_master_commits={an.get('behind_master', 'unknown')} b_predates_a={'yes' if predates else 'no'}",
                    f"b_scheduled={z(b['t_ship'])}:{b['ship_window'] or 'none'}",
                    f"a_scheduled={z(a['t_ship'])}:{a['ship_window'] or 'none'}",
                    f"order_holds={order_holds}",
                    f"same_window={'yes' if same_win else 'no'}",
                    f"shared_symbols={';'.join(ov['symbols'][:6]) or 'none'}",
                    f"shared_config_keys={';'.join(ov['keys'][:4]) or 'none'}",
                    f"shared_sql={';'.join(ov['sql'][:3]) or 'none'}",
                    f"migration_chain={'yes' if ov['migration_chain'] else 'no'}",
                    f"shared_files={';'.join(ov['shared_files'][:5]) or 'none'}",
                    f"b_revert_words={'yes' if REVERT_RE.search(b['title']) else 'no'} title_shared_subject={','.join(tshared[:4]) or 'none'}",
                    f"footprint_unreliable={'yes' if ov['unreliable'] else 'no'}",
                ]),
            })
    rows.sort(key=lambda r: (-r['strength'], r['pair']))
    stats['pairs_total'] = len(rows)
    return rows[:cap], dict(stats), rows


def build_bundles(B):
    prs, W, parent_of = B['prs'], B['live_windows'], B['parent']
    uf, units = UF(), {}
    for k, w in W.items():
        if {'promotion', 'merge', 'release-tag'} & set(w['kinds']) or not (w['prod_change'] or w['prs']):
            continue                        # a window that changes nothing in production has nothing to merge
        units[k] = {'key': k, 'kind': 'window', 'w': w}
    covered = {n for w in W.values() for n in w['prs']}
    for n, p in prs.items():
        if p['landed'] == 'open' and p['kind'] == 'work' and n not in covered and relevant_files(p):
            units[f'PR#{n}'] = {'key': f'PR#{n}', 'kind': 'orphan-pr', 'pr': p}

    unit_prs = lambda u: set(u['w']['prs']) if u['kind'] == 'window' else {u['pr']['n']}
    unit_refs = lambda u: set(u['w']['sb_refs']) if u['kind'] == 'window' else set(u['pr']['refs_strong'])
    unit_theme = lambda u: u['w']['parent'] if u['kind'] == 'window' else None
    unit_family = lambda u: 'mcp-rotation' if u['kind'] == 'window' and 'mcp-rotation' in u['w']['kinds'] else None
    unit_targets = lambda u: set(u['w']['targets']) if u['kind'] == 'window' else set(pr_targets(u['pr']))

    def unit_fp(u):
        fp = {}
        for n in unit_prs(u):
            for p, f in relevant_files(prs[n]).items():
                fp.setdefault(p, f)
        return fp

    keys = sorted(units)
    kids = B['children']
    narrow = lambda x: parent_of.get(x) if len(kids.get(parent_of.get(x), [])) <= HUB_CHILDREN else None
    edge_why, edge_rank = defaultdict(set), {}
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            ua, ub = units[a], units[b]
            why, rank = set(), 9
            sp = unit_prs(ua) & unit_prs(ub)
            if sp:
                why.add('shared_pr:' + ','.join(str(x) for x in sorted(sp)[:3]))
                rank = min(rank, 0)
            ra, rb = unit_refs(ua), unit_refs(ub)
            if ra & rb:
                why.add('shared_ref:' + ','.join(sorted(ra & rb)[:2]))
                rank = min(rank, 1)
            else:
                for x in ra:
                    for y in rb:
                        if narrow(x) == y or narrow(y) == x or (narrow(x) and narrow(x) == narrow(y)):
                            why.add(f'adjacent_ref:{x}~{y}')
                            rank = min(rank, 2)
            if unit_prs(ua) and unit_prs(ub) and not sp:
                ov = pair_overlap(unit_fp(ua), unit_fp(ub))
                if ov['strong']:
                    why.add(f"overlap:{len(ov['symbols'])}sym/{len(ov['keys'])}key")
                    rank = min(rank, 3)
            if rank == 9:
                ta, tb = unit_theme(ua), unit_theme(ub)
                if ta and ta == tb and unit_targets(ua) & unit_targets(ub):
                    why.add(f'note:same_theme_target:{ta}')
                if unit_family(ua) and unit_family(ua) == unit_family(ub):
                    why.add('note:same_family:mcp-rotation (each MCP window needs its own rotation: not bundled)')
            if why:
                edge_why[(a, b)] = why
                edge_rank[(a, b)] = rank
    size = defaultdict(lambda: 1)
    skipped = []
    for (a, b), rk in sorted(edge_rank.items(), key=lambda kv: (kv[1], kv[0])):
        if rk == 9:
            continue
        ra_, rb_ = uf.find(a), uf.find(b)
        if ra_ == rb_:
            continue
        if size[ra_] + size[rb_] > BUNDLE_CAP:
            skipped.append((a, b))
            continue
        uf.union(a, b)
        size[uf.find(a)] = size[ra_] + size[rb_]
    comps = defaultdict(list)
    for k in keys:
        comps[uf.find(k)].append(k)
    rows = []
    for ks in sorted((sorted(v) for v in comps.values() if len(v) >= 2), key=lambda v: v[0]):
        members = []
        for k in ks:
            u = units[k]
            if u['kind'] == 'window':
                w = u['w']
                members.append({'key': k, 'kinds': w['kinds'], 'targets': w['targets'], 'destructive': w['destructive'], 'blocked': w['blocked'],
                                'start': w['start'], 'lane': w['parent'], 'summary': w['summary'], 'status': w['status'], 'prs': w['prs'], 'type': 'window'})
            else:
                p = u['pr']
                members.append({'key': k, 'kinds': [], 'targets': pr_targets(p), 'destructive': False, 'blocked': p['draft'] or p['hold'],
                                'start': None, 'lane': None, 'summary': p['title'], 'status': 'draft' if p['draft'] else 'open', 'prs': [p['n']], 'type': 'orphan-pr'})
        verdict, rule, core = bundle_oracle(members)
        times = [m['start'] for m in members if m['start']]
        span = round((max(times) - min(times)).total_seconds() / 86400, 1) if len(times) > 1 else 0.0
        whys = sorted({w for (a, b), ws in edge_why.items() if a in ks and b in ks for w in ws})
        tg = sorted({t for m in members for t in m['targets']})
        bid = 'B-' + ks[0].replace('ISSUE-', 'I').replace('PR#', 'P')
        halt_m = [m['key'] for m in members if set(m['targets']) & HALT_ONLY_TARGETS or 'ingestor-swap' in m['kinds'] or 'halt-slot' in m['kinds']]
        ev = ' | '.join([
            f'bundle={bid}', f'members={len(ks)}:{",".join(ks)}', f'span_days={span}', f'targets={",".join(tg) or "none"}',
            f"halt_only_members={','.join(halt_m) or 'none'}",
            f"destructive_members={','.join(m['key'] for m in members if m['destructive'] or 'mcp-rotation' in m['kinds']) or 'none'} (destructive step or one MCP allowlist rotation per MCP window: each keeps its own window)",
            f"blocked_members={','.join(m['key'] for m in members if m['blocked']) or 'none'}",
            f"edges={';'.join(whys[:6]) or 'none'}",
            'members_detail=' + ' ## '.join(
                f"{m['key']} {m['type']} {z(m['start'])} {m['status'][:10]} kinds={','.join(m['kinds']) or '-'} tg={','.join(m['targets']) or '-'} prs={','.join(str(x) for x in m['prs'][:4]) or '-'} :: {short(m['summary'], 60)}"
                for m in members),
        ])
        rows.append({'bundle': bid, 'members': ks, 'oracle': verdict, 'rule': rule, 'core': core, 'evidence': ev, 'span_days': span,
                     'targets': tg, 'size': len(ks), 'edges': whys})
    return rows, {'units': len(units), 'singletons': sum(1 for v in comps.values() if len(v) == 1), 'edges_skipped_by_cap': len(skipped)}


def item_ships(it, prs):
    ptg = set()
    for n in it['open_prs']:
        ptg |= set(pr_targets(prs[n]))
    if ptg & (PROD_TARGETS | {'config(live ingestor at first 21:15Z restart)'}):
        return 'yes'
    if it['kind'] in ('research', 'decision'):
        return 'no'
    if re.match(r'(?i)(review|audit|decide|assess|investigate|survey|map|document|write up)\b', it['title']) or NOSHIP_RE.search(it['title']):
        return 'no'
    if re.search(r'(?i)\b(deploy|migrat|backfill|repair|swap|cutover|rebuild|ingest|serve|serving|writer|publish)\b', it['title']):
        return 'likely'
    return 'unknown'


def done_gaps(it, ttl_shared, in_win_text, open_kids):
    """Reasons a merged PR does not prove the item done. Empty list plus a merged PR means done evidence."""
    gaps = []
    if it['open_prs']:
        gaps.append('open_pr')
    if in_win_text:
        gaps.append('named_in_live_window:' + ','.join(in_win_text[:2]))
    if open_kids:
        gaps.append('open_children:' + str(len(open_kids)))
    if it['merged_prs'] and not any(ttl_shared.values()):
        gaps.append('pr_title_shares_no_subject_word')
    return gaps


def build_items(B):
    prs, items, W = B['prs'], B['items'], B['live_windows']
    rows = []
    for ref, it in sorted(items.items(), key=lambda kv: int(kv[0].split('-')[1])):
        if it['windows_direct']:
            continue
        ships = item_ships(it, prs)
        # Done evidence needs more than a merged PR that names the ref: the PR title must share a subject word with the item,
        # no live window may name the ref in its summary (work still scheduled), and no child issue may be open.
        in_win_text = sorted(wk for wk, w in W.items() if ref in re.findall(r'MMD-\d+', w['summary'] or ''))
        open_kids = [c for c in B['children'].get(ref, []) if B['sb_state'].get(c) not in ('done', 'cancelled', None)]
        ttl_shared = {n: sorted(title_tokens(it['title']) & title_tokens(prs[n]['title']))[:3] for n in it['merged_prs']}
        gaps = done_gaps(it, ttl_shared, in_win_text, open_kids)
        done_ev = bool(it['merged_prs'] and not gaps)
        done_state = 'yes' if done_ev else ('partial' if it['merged_prs'] else 'no')
        cand = {}
        for n in it['open_prs'] + it['merged_prs']:
            for wk in prs[n]['windows']:
                cand.setdefault(wk, set()).add(f'shared_pr:{n}')
        for wk in in_win_text:
            cand.setdefault(wk, set()).add('window_names_ref')
        for wk in it['windows_via_ancestor']:
            cand.setdefault(wk, set()).add('ancestor_ref_window')
        sibs = [c for c in B['children'].get(it['parent'], []) if c != ref] if len(B['children'].get(it['parent'], [])) <= HUB_CHILDREN else []
        for s in sibs:
            for wk in B['win_ref'].get(s, []):
                cand.setdefault(wk, set()).add(f'sibling_ref:{s}')
        for bl in it['blocks']:
            for wk in B['win_ref'].get(bl, []):
                cand.setdefault(wk, set()).add(f'blocks:{bl}')
        for bl in it['blockers']:
            for wk in B['win_ref'].get(bl, []):
                cand.setdefault(wk, set()).add(f'blocked_by:{bl}')
        if it['declared']:
            dfp = {p: {'cls': classify_path(p), 'symbols': [], 'keys': [], 'sql': [], 'status': 'declared', 'declared': True} for p in it['declared']}
            for wk, w in W.items():
                wfp = {}
                for n in w['prs']:
                    wfp.update(relevant_files(prs[n]))
                ov = pair_overlap(dfp, wfp)
                if ov['shared_files']:
                    cand.setdefault(wk, set()).add(f"declared_file_overlap:{len(ov['shared_files'])}")
        score = lambda ws: sum(3 if x.startswith(('shared_pr', 'declared_file', 'window_names')) else 2 if x.startswith(('sibling', 'blocks', 'blocked_by')) else 1 for x in ws)
        ok_target = lambda wk: wk in W and W[wk]['prod_change'] and not ({'promotion', 'merge', 'release-tag'} & set(W[wk]['kinds']))
        cand = {wk: {x for x in ws if not (x.startswith('declared_file_overlap:') and int(x.split(':')[1]) < 2)} for wk, ws in cand.items()}
        top = [(wk, sorted(ws)) for wk, ws in sorted(cand.items(), key=lambda kv: (-score(kv[1]), kv[0])) if ok_target(wk) and ws][:3]
        strong_cand = [(wk, ws) for wk, ws in top if any(x.startswith(('shared_pr', 'declared_file', 'window_names', 'sibling_ref', 'blocks')) for x in ws)]
        blk_nowin = [b for b in it['blockers'] if not B['win_ref'].get(b) and not (B['items'].get(b) and B['items'][b]['open_prs'])]
        zombie = (it['parent_state'] in ('done', 'cancelled') and not it['claim'] and it['idle_days'] > 3 and not it['open_prs'])
        if done_ev or it['rel_dup'] or zombie:
            oracle, rule = 'zombie-close', 'I1'
        elif ships == 'no':
            oracle, rule = 'no-window-needed', 'I2'
        elif it['readiness'] in ('draft', 'blocked') or blk_nowin or (it['deferUntil'] and str(it['deferUntil'])[:10] > '2026-11-05'):
            oracle, rule = 'defer-after-11-05', 'I3'
        elif strong_cand:
            oracle, rule = 'bundle-into', 'I4'
        elif ships in ('yes', 'likely') or (ships == 'unknown' and it['open_prs']):
            oracle, rule = 'own-window', 'I5'
        elif len(it['blocks']) >= 3:
            oracle, rule = 'own-window', 'I7'
        else:
            oracle, rule = 'defer-after-11-05', 'I6'
        opr = ' ' + ','.join(f"#{n}:{prs[n]['landed']}/{'draft' if prs[n]['draft'] else 'ready'}/files={len(prs[n]['files'])}/tg={'+'.join(pr_targets(prs[n])) or '-'}" for n in it['open_prs'][:2]) if it['open_prs'] else ''
        rows.append({
            'key': ref, 'oracle': oracle, 'rule': rule, 'ships': ships, 'value': len(it['blocks']) + (2 if it['open_prs'] else 0),
            'bundle_cands': top, 'jira': it['jira'], 'open_prs': it['open_prs'], 'readiness': it['readiness'], 'kind': it['kind'], 'title': it['title'],
            'evidence': ' | '.join([
                f"item={ref} kind={it['kind']} readiness={it['readiness']} attested={'yes' if it['attested'] else 'no'} claim={it['claim'] or 'none'} idle_days={it['idle_days']}",
                f"title={short(it['title'], 110)!r}",
                f"problem={short(it['problem'], 220)!r}",
                f"ships={ships}",
                f"done_evidence={done_state} done_gaps={','.join(gaps) or 'none'} merged_prs={','.join(str(x) for x in it['merged_prs'][:3]) or 'none'}",
                'merged_pr_titles=' + ('; '.join(f"#{n} {short(prs[n]['title'], 70)}" for n in it['merged_prs'][:2]) or 'none'),
                f"open_prs={','.join(str(x) for x in it['open_prs'][:3]) or 'none'}{opr}",
                f"dup_or_superseded={';'.join('%s %s>%s' % x for x in it['rel_dup'][:2]) or 'none'}",
                f"parent={it['parent'] or 'none'} parent_state={it['parent_state'] or 'none'} jira_mirror={','.join(it['jira']) or 'none'}",
                f"blocked_by_open={','.join(it['blockers'][:4]) or 'none'} of_which_without_window_or_pr={','.join(blk_nowin[:4]) or 'none'}",
                f"blocks_count={len(it['blocks'])}",
                f"deferUntil={it['deferUntil'] or 'none'}",
                'bundle_candidates=' + (';'.join(f"{wk}[{'+'.join(ws)}]" for wk, ws in top) or 'none'),
                f"window_via_ancestor={','.join(it['windows_via_ancestor'][:3]) or 'none'}",
            ]),
        })
    return rows


STD_STARTS = [(7, 7), (9, 7), (11, 7), (13, 7), (15, 7), (17, 7), (18, 37)]


def day_facts(B, extra=()):
    """extra: tuples (key, start, end, targets, prod_change, kinds) for proposed windows added to the booked ones."""
    entries = [(k, w['start'], w['end'], sorted(set(w['targets']) & DEPLOY_CONTAINERS) if w['prod_change'] else [], w['prod_change'], w['kinds'], 'booked')
               for k, w in B['live_windows'].items()]
    entries += [tuple(e) + ('proposed',) for e in extra]
    by_day = defaultdict(list)
    for e in entries:
        by_day[e[1].date()].append(e)
    rows = []
    for d in day_range():
        es = sorted(by_day.get(d, []), key=lambda e: e[1])
        wd = d.strftime('%a')
        day_lo = datetime.datetime(d.year, d.month, d.day, *WORKDAY_START, tzinfo=UTC)
        day_hi = datetime.datetime(d.year, d.month, d.day, *WORKDAY_END, tzinfo=UTC)
        halts = [e for e in es if 'halt-slot' in (e[5] or []) or in_halt(e[1], e[2])]
        changes = [e for e in es if e[4] and e not in halts]
        promos = [e for e in es if 'promotion' in (e[5] or [])]
        spans = sorted((max(e[1], day_lo), min(e[2], day_hi)) for e in changes if e[2] > day_lo and e[1] < day_hi)
        busy, cur = 0.0, None
        for a, b in spans:
            if cur and a <= cur[1]:
                cur = (cur[0], max(cur[1], b))
            else:
                busy += (cur[1] - cur[0]).total_seconds() / 60 if cur else 0
                cur = (a, b)
        busy += (cur[1] - cur[0]).total_seconds() / 60 if cur else 0
        util = round(busy / ((day_hi - day_lo).total_seconds() / 60), 2)
        evening = [e[0] for e in es if e[4] and in_evening_not_halt(e[1], e[2])]
        overlap_same = []
        for i, a in enumerate(changes):
            for b in changes[i + 1:]:
                sh_ = set(a[3]) & set(b[3])
                if a[1] < b[2] and b[1] < a[2] and sh_:
                    overlap_same.append(f'{a[0]}~{b[0]}:{"+".join(sorted(sh_))}')
        starts = defaultdict(list)
        for e in changes:
            starts[e[1]].append(e[0])
        parallel = [v for v in starts.values() if len(v) > 1]
        squeezed = []
        chg = sorted([e for e in entries if e[4]], key=lambda e: e[1])
        for i, a in enumerate(chg):
            if a[1].date() != d:
                continue
            for b in chg[i + 1:]:
                if b[1] >= a[2] and (set(a[3]) & set(b[3])):
                    mh = market_hours_between(a[2], b[1])
                    if mh < MIN_VERIFY_MARKET_H:
                        squeezed.append(f'{a[0]}->{b[0]}:{mh}h')
                    break
        reasons = []
        if len(halts) > 1:
            reasons.append('halt_collision')
        if evening:
            reasons.append('evening_band')
        if overlap_same:
            reasons.append('same_target_overlap')
        if util > MAX_UTIL:
            reasons.append('utilization')
        if len(squeezed) >= 2:
            reasons.append('verification_squeezed')
        if len(changes) + len(halts) > MAX_CHANGES_PER_DAY:
            reasons.append('change_count')
        hb, eb = halt_band(d), evening_band(d)
        rows.append({
            'day': d.isoformat(), 'oracle': 'over-capacity' if reasons else 'fits', 'reasons': reasons, 'util': util, 'n': len(es),
            'evidence': ' | '.join([
                f"day={d.isoformat()} {wd} season={'CST' if d >= CST_FROM else 'CDT'} market={'closed (Sat)' if wd == 'Sat' else 'open'}",
                f"halt_band={hb[0]:%H:%M}-{hb[1]:%H:%M}Z evening_band={eb[0]:%H:%M}-{eb[1]:%H:%M}Z",
                f"windows_booked={sum(1 for e in es if e[6] == 'booked')} proposed_added={sum(1 for e in es if e[6] == 'proposed')} prod_changes={len(changes) + len(halts)} (limit {MAX_CHANGES_PER_DAY}, PROVISIONAL) promotions={len(promos)}",
                f"halt_slot_changes={len(halts)}:{','.join(e[0] for e in halts) or 'none'}",
                f"working_day_utilization={util} (limit {MAX_UTIL}, PROVISIONAL)",
                f"evening_band_violations={','.join(evening) or 'none'}",
                f"same_target_overlaps={';'.join(overlap_same) or 'none'}",
                f"parallel_same_start={';'.join('+'.join(v) for v in parallel) or 'none'}",
                f"verification_squeezed={';'.join(squeezed) or 'none'} (min {MIN_VERIFY_MARKET_H} market hours, PROVISIONAL)",
                'windows=' + ' ## '.join(f"{e[0]} {e[1]:%H:%MZ}-{e[2]:%H:%MZ} {e[6]} tg={','.join(e[3]) or '-'} kinds={','.join(e[5] or []) or '-'}" for e in es),
            ]),
        })
    return rows


def assign_slots(B, own_rows):
    """Greedy and deterministic. The earliest standard start on a day where the day stays within capacity: day >= 10-27
    (master freeze lifts after the 10-26 promote-merge), after the slot end of every booked blocker, halt-only targets only
    in the halt and never Fri/Sat, other changes on weekdays outside the evening band. Unplaced items are returned."""
    prs, items = B['prs'], B['items']
    placed, unplaced, extra = [], [], []
    why = defaultdict(lambda: defaultdict(int))
    for r in sorted(own_rows, key=lambda r: (-r['value'], r['key'])):
        it = items[r['key']]
        tg = set()
        for n in it['open_prs']:
            tg |= set(pr_targets(prs[n]))
        tg = sorted(tg - {'non-runtime'}) or ['unspecified:' + r['key']]
        halt_only = bool(set(tg) & HALT_ONLY_TARGETS)
        earliest = datetime.datetime(2026, 10, 27, tzinfo=UTC)
        for b in it['blockers']:
            for wk in B['win_ref'].get(b, []):
                earliest = max(earliest, B['live_windows'][wk]['end'] + datetime.timedelta(minutes=30))
        kinds = ['ingestor-swap', 'halt-slot'] if halt_only else ['deploy']
        ok = None
        for d in day_range():
            if d < earliest.date():
                continue
            if halt_only:
                if d.weekday() in (4, 5):
                    continue
                lo, hi = halt_band(d)
                cands = [(lo + datetime.timedelta(minutes=1), hi)]
            else:
                if d.weekday() in (5, 6):
                    continue
                cands = [(datetime.datetime(d.year, d.month, d.day, h, m, tzinfo=UTC), None) for h, m in STD_STARTS]
            for s, e_ in cands:
                e = e_ or (s + datetime.timedelta(minutes=45))
                if s < earliest:
                    continue
                if any(x[1] == s and x[4] for x in extra) or any(w['start'] == s and w['prod_change'] for w in B['live_windows'].values()):
                    why[r['key']]['start_taken'] += 1
                    continue
                row = next(x for x in day_facts(B, extra + [(r['key'], s, e, tg, True, kinds)]) if x['day'] == d.isoformat())
                for rs in row['reasons']:
                    why[r['key']][rs] += 1
                if row['oracle'] == 'fits':
                    ok = (s, e)
                    break
            if ok:
                break
        if ok:
            extra.append((r['key'], ok[0], ok[1], tg, True, kinds))
            placed.append((r['key'], ok[0], ok[1], tg))
        else:
            unplaced.append(r['key'])
    assign_slots.why = {k: dict(v) for k, v in why.items()}
    return placed, unplaced, extra


def calendar_table(B):
    rows = []
    for k, w in sorted(B['windows'].items(), key=lambda kv: kv[1]['start']):
        if w['end'].date() < FIRST_DAY or w['start'].date() > LAST_DAY:
            continue
        rows.append({'key': k, 'day': w['start'].date().isoformat(), 'start': z(w['start']), 'end': z(w['end']), 'status': w['status'],
                     'summary': short(w['summary'], 90), 'kinds': w['kinds'], 'targets': w['targets'], 'prs': w['prs'],
                     'refs': w['sb_refs'], 'folded_into': w['folded_into'], 'terminal': w['terminal'], 'parent': w['parent']})
    return rows


FREEZE_LIFT = datetime.datetime(2026, 10, 26, 9, 0, tzinfo=UTC)     # after the ISSUE-391 promote-merge (07:50-08:50Z)
PROMO_HHMM = (7, 50)                                                    # the booked promotion slot of ISSUE-391/398/472


def promotion_plan(B):
    """Fewest promotions that satisfy every deploy deadline. A PR is ready when it is on master (now) or, if open and not draft or
    HOLD, once the freeze lifts (PROVISIONAL: review state is not modelled). Its deadline is the start of the first live non-promotion
    window that deploys it, minus 60 minutes (PROVISIONAL). Candidate promotion times are the daily 07:50Z slot. Greedy: take the
    earliest uncovered deadline, place a promotion at the latest slot at or before it, carry every uncovered PR that is ready by then."""
    prs, now = B['prs'], B['now']
    need = {}
    for n, (t, wk) in B['deploy_at'].items():
        p = prs[n]
        if p['landed'] == 'master':
            need[n] = (now, t - datetime.timedelta(minutes=60), wk)
        elif p['landed'] == 'open':
            ready = None if (p['draft'] or p['hold']) else max(FREEZE_LIFT, B['merge_at'][n][0] if n in B['merge_at'] else FREEZE_LIFT)
            need[n] = (ready, t - datetime.timedelta(minutes=60), wk)
    base = datetime.datetime(2026, 10, 26, *PROMO_HHMM, tzinfo=UTC)
    slots = [base + datetime.timedelta(days=i) for i in range(10) if (base + datetime.timedelta(days=i)).weekday() < 5]
    slots = sorted(slots + [datetime.datetime(2026, 10, 26, 10, 2, tzinfo=UTC)])      # second 10-26 promotion named by the coordinator (UNVERIFIED in the repo)
    unready = {n: v for n, v in need.items() if v[0] is None}
    todo = {n: v for n, v in need.items() if v[0] is not None}
    promos, infeasible = [], []
    while todo:
        n0 = min(todo, key=lambda n: (todo[n][1], n))
        dl = todo[n0][1]
        cand = [s_ for s_ in slots if s_ <= dl and s_ >= todo[n0][0]]
        if not cand:
            infeasible.append({'pr': n0, 'window': todo[n0][2], 'deadline': z(dl), 'ready': z(todo[n0][0])})
            del todo[n0]
            continue
        s_ = cand[-1]
        carry = sorted(n for n, v in todo.items() if v[0] <= s_)
        promos.append({'at': z(s_), 'carries': carry, 'feeds_windows': sorted({todo[n][2] for n in carry}),
                       'first_deadline': z(dl), 'open_prs': [n for n in carry if prs[n]['landed'] == 'open']})
        for n in carry:
            del todo[n]
    booked = [{'key': k, 'at': z(w['start']), 'summary': short(w['summary'], 80), 'prs': w['prs']} for k, w in sorted(B['live_windows'].items(), key=lambda kv: kv[1]['start']) if 'promotion' in w['kinds']]
    merges = [{'key': k, 'at': z(w['start']), 'summary': short(w['summary'], 80), 'prs': w['prs']} for k, w in sorted(B['live_windows'].items(), key=lambda kv: kv[1]['start']) if 'merge' in w['kinds']]
    return {'proposed_promotions': promos, 'booked_promotions': booked, 'booked_merges': merges, 'infeasible_deadline_before_ready': infeasible,
            'not_ready_draft_or_hold': {n: {'window': v[2], 'deadline': z(v[1])} for n, v in sorted(unready.items())},
            'prs_considered': len(need)}


def history_candidates(B, cap=25):
    """Landed-landed pairs where the later PR reads like a revert of the earlier one: same relevant file, a shared symbol, revert words in
    the later title and a shared subject token. Not judged by the workflow; listed for the human to check."""
    work = [p for p in B['prs'].values() if p['kind'] == 'work' and p['landed'] in ('stable', 'master') and relevant_files(p) and p['merged']]
    work.sort(key=lambda p: p['merged'])
    out = []
    for i, b in enumerate(work):
        if not REVERT_RE.search(b['title']):
            continue
        for a in work[:i]:
            ov = pair_overlap(relevant_files(a), relevant_files(b))
            if ov['strong'] and ov['symbols'] and (title_tokens(a['title']) & title_tokens(b['title'])):
                out.append({'a': a['n'], 'b': b['n'], 'a_title': short(a['title'], 80), 'b_title': short(b['title'], 80), 'a_landed': a['landed'], 'b_landed': b['landed'],
                            'symbols': ov['symbols'][:4], 'shared_subject': sorted(title_tokens(a['title']) & title_tokens(b['title']))[:4],
                            'gap_days': (utc(b['merged']) - utc(a['merged'])).days})
    out.sort(key=lambda r: (r['gap_days'], -len(r['symbols'])))
    return out[:cap], len(out)


def landed_table(B):
    rows = []
    for n, p in sorted(B['prs'].items(), key=lambda kv: kv[1]['merged'] or '', reverse=True):
        if p['landed'] in ('stable', 'master', 'promotion'):
            rows.append({'n': n, 'merged': (p['merged'] or '')[:16], 'landed': p['landed'], 'title': short(p['title'], 90), 'refs': p['refs_strong'], 'jira': p['jira'],
                         'targets': pr_targets(p), 'files': len(p['files'])})
    return rows


def run(snap_dir, out_dir, now, tracked):
    snap = load_snap(snap_dir)
    B = build(snap, now, tracked)
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pairs, pstats, allpairs = build_pairs(B)
    bundles, bstats = build_bundles(B)
    items = build_items(B)
    placed, unplaced, extra = assign_slots(B, [r for r in items if r['oracle'] == 'own-window'])
    days_booked, days_proposed = day_facts(B), day_facts(B, extra)
    wl = [{'key': k, 'start_utc': w['start'].isoformat(), 'end_utc': w['end'].isoformat(), 'labels': w['labels'], 'status': w['status']} for k, w in B['windows'].items()]
    meta = {'built_at': now.isoformat(), 'snapshot_stamps': {n: snap[n].get('fetched_at') for n in snap if isinstance(snap[n], dict)}, 'rubric': 'plan-facts-v1',
            'counts': {'prs': len(B['prs']), 'windows': len(B['windows']), 'live_windows': len(B['live_windows']), 'unwindowed_items': len(items),
                       'pairs_total': pstats.get('pairs_total'), 'bundles': len(bundles)}}
    default = lambda x: x.isoformat() if hasattr(x, 'isoformat') else sorted(x) if isinstance(x, set) else str(x)
    (out / 'facts.json').write_text(json.dumps({
        'meta': meta, 'calendar': calendar_table(B), 'halt_collisions': halt_collisions(wl, now), 'pair_stats': pstats, 'bundle_stats': bstats,
        'promotion': promotion_plan(B), 'landed': landed_table(B), 'history_candidates': history_candidates(B), 'slots_placed': [(k, z(s), z(e), t) for k, s, e, t in placed], 'slots_unplaced': unplaced,
        'days_booked': days_booked, 'days_proposed': days_proposed, 'bundles': bundles, 'pairs': allpairs, 'items': items,
        'folded_with_slot': [{'key': k, 'folded_into': w['folded_into'], 'start': z(w['start'])} for k, w in B['windows'].items() if w['folded'] and w['future']],
        'git': {'master': B['git']['master'], 'stable': B['git']['stable'], 'unpromoted_commits': len(B['git']['delta_master_not_stable'])},
        'merged_unpromoted_prs': sorted(n for n, p in B['prs'].items() if p['landed'] == 'master'),
        'open_prs': {n: {'title': short(p['title'], 90), 'created': (p['created'] or '')[:10], 'draft': p['draft'], 'windows': p['windows'], 'targets': pr_targets(p)}
                     for n, p in B['prs'].items() if p['landed'] == 'open'},
    }, default=default, indent=1))
    return B, meta, pairs, bundles, items, days_booked, days_proposed


def write_inputs(out_dir, pairs, bundles, items, days):
    out = pathlib.Path(out_dir)
    sets = {
        'bundles': [{'key': b['bundle'], 'summary': f"{b['size']} units, {b['span_days']}d span", 'oracle': b['oracle'] + '|' + (','.join(b['core']) or 'none'), 'evidence': b['evidence']} for b in bundles],
        'pairs': [{'key': p['pair'], 'summary': 'rewrite-risk pair', 'oracle': p['oracle'], 'evidence': p['evidence']}
                  for p in [q for q in pairs if q['rule'] != 'P5'] + [q for q in pairs if q['rule'] == 'P5'][:P5_CONTROLS]],
        'items': [{'key': r['key'], 'summary': short(r['title'], 100), 'oracle': r['oracle'] + ('|' + r['bundle_cands'][0][0] if r['oracle'] == 'bundle-into' and r['bundle_cands'] else ''), 'evidence': r['evidence']} for r in items],
        'days': [{'key': d['day'], 'summary': 'day capacity', 'oracle': d['oracle'], 'evidence': d['evidence']} for d in days],
    }
    for name, rows in sets.items():
        (out / f'rows-{name}.json').write_text(json.dumps(rows, indent=1))
    return {k: len(v) for k, v in sets.items()}


def check_fresh(snap_dir, now, allow_stale):
    bad = []
    for n in ('git', 'jira', 'calendar', 'prs', 'sb', 'ancestry'):
        t = utc(json.loads((pathlib.Path(snap_dir) / f'{n}.json').read_text()).get('fetched_at'))
        age = (now - t).total_seconds()
        if age > FRESH_SECONDS:
            bad.append(f'{n} is {int(age / 60)} min old')
    if bad and not allow_stale:
        raise SystemExit('REFUSED: snapshot older than 1 h (' + '; '.join(bad) + '). Re-run snapshot_plan.py or pass --allow-stale.')
    return bad


# ----------------------------------------------------------------------------- selftest

def _fp(path, status='modified', symbols=(), keys=(), sql=(), patch_missing=False):
    return {path: {'cls': classify_path(path), 'symbols': list(symbols), 'keys': list(keys), 'sql': list(sql), 'status': status, 'patch_missing': patch_missing}}


def selftest(snap_dir=None):
    res = []
    check = lambda name, cond, detail='': res.append((name, bool(cond), detail))
    T = lambda s: datetime.datetime.fromisoformat(s).astimezone(UTC)

    check('class: alembic revision is migration (positive)', classify_path('alembic/versions/mmd2808_iv_normal.py') == 'migration')
    check('class: docs file is not src (negative)', classify_path('docs/mcp/market-data-mcp-api.md') == 'doc')
    check('class: Makefile is tooling, not src (negative)', classify_path('Makefile') == 'tooling')
    check('class: test file is test (negative)', classify_path('tests/unit/analytics/options/test_ssvi_surface.py') == 'test')
    check('target: rust ingestor is halt-only (positive)', target_of('rust_ingestor/src/main.rs') in HALT_ONLY_TARGETS)
    check('target: analytics path is snapshot-feed (positive)', target_of('analytics/options/surface.py') == 'mmd-snapshot-feed')
    check('target: mcp_v2 is the mcp server, plain api is not (negative)', target_of('api/mcp_v2/catalogue.py') == 'mmd-mcp-server' and target_of('api/repositories/snapshots.py') == 'mmd-api')
    check('target: tests deploy nothing (negative)', target_of('tests/test_x.py') == 'non-runtime')

    check('offset: +0100 stored 22:17 is 21:17Z (positive)', T('2026-10-29T22:17:00.000+0100') == datetime.datetime(2026, 10, 29, 21, 17, tzinfo=UTC))
    check('halt: CDT slot 21:17-21:55Z is halt (positive)', in_halt(T('2026-10-29T21:17:00+00:00'), T('2026-10-29T21:55:00+00:00')))
    check('halt: CST slot 22:17-22:55Z on 11-02 is halt (positive)', in_halt(T('2026-11-02T22:17:00+00:00'), T('2026-11-02T22:55:00+00:00')))
    check('halt: 21:17Z slot on 11-02 is not the CST halt (negative)', not in_halt(T('2026-11-02T21:17:00+00:00'), T('2026-11-02T21:55:00+00:00')))
    check('halt: ISSUE-293 case 09:40-09:55Z is not halt although its text says 21:15Z (negative)', not in_halt(T('2026-10-26T09:40:00+00:00'), T('2026-10-26T09:55:00+00:00')))
    check('halt: ISSUE-353 case 23:07Z-00:07Z starts after the CST halt (negative)', not in_halt(T('2026-11-02T23:07:00+00:00'), T('2026-11-03T00:07:00+00:00')))
    check('halt: 8 h intake window is not a halt change (negative)', not in_halt(T('2026-10-29T14:00:00+00:00'), T('2026-10-29T22:00:00+00:00')))
    check('evening: 20:30-21:00Z non-halt slot violates (positive)', in_evening_not_halt(T('2026-10-27T20:30:00+00:00'), T('2026-10-27T21:00:00+00:00')))
    check('evening: slot ending at 19:50Z is clear (negative)', not in_evening_not_halt(T('2026-10-28T19:00:00+00:00'), T('2026-10-28T19:50:00+00:00')))
    check('evening: the halt slot itself is allowed (negative)', not in_evening_not_halt(T('2026-10-29T21:17:00+00:00'), T('2026-10-29T21:55:00+00:00')))
    wins = [{'key': 'ISSUE-314', 'start_utc': '2026-10-29T21:17:00+00:00', 'end_utc': '2026-10-29T21:55:00+00:00', 'labels': [], 'status': 'Blocked'},
            {'key': 'ISSUE-330', 'start_utc': '2026-10-29T21:17:00+00:00', 'end_utc': '2026-10-29T21:55:00+00:00', 'labels': ['folded-into:ISSUE-314'], 'status': 'Blocked'}]
    check('collision: a folded ticket holding the slot is bookkeeping (negative)', halt_collisions(wins, None) == {})
    wins[1]['labels'] = []
    check('collision: two unfolded changes in one halt collide (positive)', '2026-10-29' in halt_collisions(wins, None))
    check('market: Saturday closed; Monday 10:00Z open; daily halt closed (positive and negative)',
          not market_open(T('2026-10-31T12:00:00+00:00')) and market_open(T('2026-10-26T10:00:00+00:00')) and not market_open(T('2026-10-27T21:30:00+00:00')))
    check('market hours: Mon 10:00Z to 14:00Z is 4.0 (positive)', market_hours_between(T('2026-10-26T10:00:00+00:00'), T('2026-10-26T14:00:00+00:00')) == 4.0)

    check('kind: promotion window (positive)', 'promotion' in window_kinds('promotion master->stable (Mon 10-26)', []))
    check('kind: MCP allowlist rotation (positive)', 'mcp-rotation' in window_kinds('MCP allowlist rotation PR for ISSUE-338', []))
    check('kind: a verify window is not a prod change (negative)', not is_prod_change(window_kinds('MMD check: Monday EOD bars vs Sierra .dly (read-only)', [])))
    check('kind: migrate+deploy is a prod change (positive)', is_prod_change(window_kinds('migration + deploy feed/api for delta', [])))
    check('kind: a feed deploy that ships a purge PR is not destructive (negative; the ISSUE-345 case)', 'destructive' not in window_kinds('corr-hmm-v1 purge + v2 bound: feed deploy (#946)', []))
    check('kind: a migrate window that purges rows is destructive (positive; the ISSUE-344 case)', 'destructive' in window_kinds('migrate: corr-hmm-v1 purge (#946, alembic mmd2374)', []))
    check('kind: a verify gate named after a purge is not destructive (negative; the ISSUE-352 case)', 'destructive' not in window_kinds('5-min purge gate: replay parity report', []))
    check('kind: destructive drop flagged (positive)', 'destructive' in window_kinds('drop QuestDB view ohlcv_30m (v1), NEEDS OPERATOR YES', []))

    A = _fp('analytics/options/surface.py', symbols=['fit_ssvi', 'surface_state'])
    Bsame, Bdiff = _fp('analytics/options/surface.py', symbols=['fit_ssvi']), _fp('analytics/options/surface.py', symbols=['other_fn'])
    ov = pair_overlap(A, Bsame)
    check('pair: same symbol in same file is strong (positive)', ov['strong'] and ov['symbols'] == ['analytics/options/surface.py::fit_ssvi'])
    ov = pair_overlap(A, Bdiff)
    check('pair: same file, different symbols is weak not strong (negative)', ov['weak'] and not ov['strong'])
    check('pair: weak overlap is benign by rule P4 (negative)', pair_oracle(ov, 'MMD-1 add other_fn') == ('benign', 'P4'))
    d_ = pair_overlap(_fp('docs/mcp/market-data-mcp-api.md'), _fp('docs/mcp/market-data-mcp-api.md'))
    check('pair: docs-only shared file is no overlap (negative)', not d_['strong'] and not d_['weak'])
    check('pair: same symbol in different files is not shared (negative)', not pair_overlap(_fp('a/x.py', symbols=['f']), _fp('b/x.py', symbols=['f']))['strong'])
    check('pair: two new alembic revisions form a migration chain (positive)',
          pair_overlap(_fp('alembic/versions/mmd2807_a.py', 'added'), _fp('alembic/versions/mmd2808_b.py', 'added'))['migration_chain'])
    check('pair: one alembic revision against none is no chain (negative)', not pair_overlap(_fp('alembic/versions/mmd2807_a.py', 'added'), _fp('analytics/x.py'))['migration_chain'])
    kA = _fp('config/session_profiles.json', keys=['TPO_BIN'])
    check('pair: same config key is strong (positive)', pair_overlap(kA, _fp('config/session_profiles.json', keys=['TPO_BIN']))['strong'])
    check('pair: different config keys in one file are weak (negative)', not pair_overlap(kA, _fp('config/session_profiles.json', keys=['OTHER']))['strong'])
    check('pair: strong overlap, A landed and not in B history, gives needs-order, rule P3 (positive)', pair_oracle(pair_overlap(A, Bsame), 'fix fit_ssvi bounds', 'add fit_ssvi', False) == ('needs-order', 'P3'))
    check('pair: strong overlap but A already in B history is benign, rule P5 (negative)', pair_oracle(pair_overlap(A, Bsame), 'fix fit_ssvi bounds', 'add fit_ssvi', True) == ('benign', 'P5'))
    check('pair: strong overlap with unknown ancestry needs review, rule P6 (positive)', pair_oracle(pair_overlap(A, Bsame), 'fix fit_ssvi bounds', 'add fit_ssvi', None) == ('needs-review', 'P6'))
    check('pair: two open PRs with strong overlap need order whatever the ancestry (positive)', pair_oracle(pair_overlap(A, Bsame), 'fix fit_ssvi bounds', 'add fit_ssvi', None, True) == ('needs-order', 'P3'))
    check('pair: revert wording on a shared file and a shared subject gives real-conflict, rule P2 (positive)', pair_oracle(pair_overlap(A, Bsame), 'Revert fit_ssvi change', 'add fit_ssvi surface', True) == ('real-conflict', 'P2'))
    check('pair: revert wording about another subject is not a conflict (negative)', pair_oracle(pair_overlap(A, Bsame), 'drop redundant index on candles', 'add fit_ssvi surface', True)[0] != 'real-conflict')
    check('class: data/golden json is data, not src (negative)', classify_path('data/golden/bar_builder_es_slice.json') == 'data' and target_of('data/golden/x.json') == 'non-runtime')
    check('pair: "reverse proxy" is not revert wording (negative)', not REVERT_RE.search('add reverse proxy header'))
    check('pair: patch missing without symbol evidence needs review, rule P1 (positive)',
          pair_oracle(pair_overlap(_fp('api/app.py', patch_missing=True), _fp('api/app.py')), 'tweak app') == ('needs-review', 'P1'))
    check('pair: no overlap is benign, rule P0 (negative)', pair_oracle(pair_overlap(A, _fp('api/app.py', symbols=['x'])), 'x') == ('benign', 'P0'))

    m = lambda key, **kw: dict({'key': key, 'kinds': [], 'targets': ['mmd-api'], 'destructive': False, 'blocked': False, 'lane': 'L'}, **kw)
    check('bundle: two destructive drops never ride together; two clean members still bundle, rule K1 (positive)', bundle_oracle([m('I1', destructive=True), m('I2', destructive=True), m('I3'), m('I4')]) == ('partial', 'K1', ['I3', 'I4']))
    check('bundle: two destructive drops and one clean member split, rule K1 (positive)', bundle_oracle([m('I1', destructive=True), m('I2', destructive=True), m('I3')])[:2] == ('split', 'K1'))
    check('bundle: two MCP allowlist rotations never merge, one per MCP window (positive)', bundle_oracle([m('R1', kinds=['mcp-rotation']), m('R2', kinds=['mcp-rotation'])])[:2] == ('split', 'K1'))
    check('bundle: one MCP rotation next to an api deploy still bundles (negative)', bundle_oracle([m('R1', kinds=['mcp-rotation']), m('I2')])[0] == 'bundle')
    check('kind: merge window is not a promotion (negative)', 'promotion' not in window_kinds('Merge #1076 (MMD-2798 HO/RB/BZ) into master after promotion #6', []) and 'merge' in window_kinds('Merge #1076 (MMD-2798) into master after promotion #6', []))
    check('kind: promotion master->stable is a promotion (positive)', 'promotion' in window_kinds('promotion master->stable #6 feeding the R1 MCP candidate', []))
    check('bundle: one destructive member alone does not split (negative)', bundle_oracle([m('I1', destructive=True), m('I3')])[0] == 'bundle')
    check('bundle: ingestor swap mixed with two api deploys is partial and the core excludes the swap (positive)',
          bundle_oracle([m('I1', targets=['mmd-tick-ingestor-rust'], kinds=['ingestor-swap']), m('I2'), m('I5')]) == ('partial', 'K2', ['I2', 'I5']))
    check('bundle: ingestor swap plus a single api deploy leaves no core, so split (negative for bundling)',
          bundle_oracle([m('I1', targets=['mmd-tick-ingestor-rust'], kinds=['ingestor-swap']), m('I2')]) == ('split', 'K2', []))
    check('bundle: all-ingestor members are not partial (negative)',
          bundle_oracle([m('I1', targets=['mmd-tick-ingestor-rust'], kinds=['ingestor-swap']), m('I2', targets=['mmd-tick-ingestor-rust'], kinds=['ingestor-swap'])])[0] == 'bundle')
    check('bundle: a blocked member is left out, rule K3 (positive)', bundle_oracle([m('I1'), m('I2'), m('I3', blocked=True)]) == ('partial', 'K3', ['I1', 'I2']))
    check('bundle: clean same-target members bundle, rule K5 (positive)', bundle_oracle([m('I1'), m('I2')]) == ('bundle', 'K5', ['I1', 'I2']))
    uf = UF()
    uf.union('a', 'b')
    check('union-find: joined units share a root; a stranger does not (positive and negative)', uf.find('a') == uf.find('b') and uf.find('c') != uf.find('a'))

    def mk(wins_):
        return {'live_windows': {k: {'start': T(s), 'end': T(e), 'targets': tg, 'prod_change': prod, 'kinds': kinds} for k, s, e, tg, prod, kinds in wins_}}
    day = lambda B, d: next(r for r in day_facts(B) if r['day'] == d)
    halt_w = lambda k: (k, '2026-10-29T21:17:00+00:00', '2026-10-29T21:55:00+00:00', ['mmd-tick-ingestor-rust'], True, ['ingestor-swap', 'halt-slot'])
    check('day: two changes in one halt is over-capacity (positive)', 'halt_collision' in day(mk([halt_w('X1'), halt_w('X2')]), '2026-10-29')['reasons'])
    check('day: one halt change fits (negative)', day(mk([halt_w('X1')]), '2026-10-29')['oracle'] == 'fits')
    check('day: a deploy in the evening band is over-capacity (positive)',
          'evening_band' in day(mk([('X1', '2026-10-28T20:30:00+00:00', '2026-10-28T21:00:00+00:00', ['mmd-api'], True, ['deploy'])]), '2026-10-28')['reasons'])
    check('day: a morning deploy fits (negative)',
          day(mk([('X1', '2026-10-28T09:07:00+00:00', '2026-10-28T09:52:00+00:00', ['mmd-api'], True, ['deploy'])]), '2026-10-28')['oracle'] == 'fits')
    check('day: two overlapping deploys of one container collide (positive)',
          'same_target_overlap' in day(mk([('X1', '2026-10-28T09:00:00+00:00', '2026-10-28T10:00:00+00:00', ['mmd-api'], True, ['deploy']),
                                           ('X2', '2026-10-28T09:30:00+00:00', '2026-10-28T10:30:00+00:00', ['mmd-api'], True, ['deploy'])]), '2026-10-28')['reasons'])
    check('day: parallel deploys of different containers do not collide (negative)',
          'same_target_overlap' not in day(mk([('X1', '2026-10-28T09:00:00+00:00', '2026-10-28T10:00:00+00:00', ['mmd-api'], True, ['deploy']),
                                               ('X2', '2026-10-28T09:00:00+00:00', '2026-10-28T10:00:00+00:00', ['mmd-snapshot-feed'], True, ['deploy'])]), '2026-10-28')['reasons'])
    many = mk([(f'X{i}', f'2026-10-28T{7 + i:02d}:07:00+00:00', f'2026-10-28T{7 + i:02d}:50:00+00:00', [f'c{i}'], True, ['deploy']) for i in range(7)])
    check('day: seven production changes exceed the daily limit (positive)', 'change_count' in day(many, '2026-10-28')['reasons'])
    few = mk([(f'X{i}', f'2026-10-28T{7 + i:02d}:07:00+00:00', f'2026-10-28T{7 + i:02d}:50:00+00:00', [f'c{i}'], True, ['deploy']) for i in range(3)])
    check('day: three production changes on distinct containers fit (negative)', 'change_count' not in day(few, '2026-10-28')['reasons'])
    check('day: a read-only verify window never counts as a change (negative)',
          day(mk([('X1', '2026-10-28T20:30:00+00:00', '2026-10-28T21:00:00+00:00', [], False, ['verify'])]), '2026-10-28')['oracle'] == 'fits')

    check('ships: research kind ships nothing (negative)', item_ships({'kind': 'research', 'title': 'Study vol surface', 'open_prs': []}, {}) == 'no')
    check('ships: a deploy-worded task likely ships (positive)', item_ships({'kind': 'task', 'title': 'Deploy the feed with the new roll calendar', 'open_prs': []}, {}) == 'likely')
    base = {'open_prs': [], 'merged_prs': [929]}
    check('done: merged PR sharing a subject word, nothing scheduled, no children, is done evidence (positive)', done_gaps(base, {929: ['serving']}, [], []) == [])
    check('done: a live window naming the ref blocks done evidence (negative; the MMD-2640 case)', done_gaps(base, {929: ['swap']}, ['ISSUE-457'], [])[0].startswith('named_in_live_window'))
    check('done: an open child blocks done evidence (negative)', done_gaps(base, {929: ['serving']}, [], ['MMD-2684']) == ['open_children:1'])
    check('done: a PR title with no shared subject word is not done evidence (negative)', done_gaps(base, {929: []}, [], []) == ['pr_title_shares_no_subject_word'])
    check('ships: an independent review of a PR ships nothing, though the title names a PR (negative)', item_ships({'kind': 'task', 'title': 'Independent review PR #987 (MMD-2521) at head f5c82851', 'open_prs': []}, {}) == 'no')
    check('ships: a rubric or harness repair ships nothing (negative)', item_ships({'kind': 'task', 'title': 'MMD-2673 repair 6: judge emits raw answers, verdict only in rubric.py', 'open_prs': []}, {}) == 'no')
    check('ships: a backfill is likely a production change (positive)', item_ships({'kind': 'task', 'title': 'Spread candle history backfill from SCID replay', 'open_prs': []}, {}) == 'likely')
    check('ships: a pr-reviewer verdict task ships nothing (negative)', item_ships({'kind': 'task', 'title': 'pr-reviewer: PR #1003 head a408b7219 (MMD-2564)', 'open_prs': []}, {}) == 'no')
    check('ships: a review task ships nothing (negative)', item_ships({'kind': 'task', 'title': 'Review PR 1010: swap-tool fix', 'open_prs': []}, {}) == 'no')

    if snap_dir and (pathlib.Path(snap_dir) / 'prs.json').exists():
        snap = load_snap(snap_dir)
        prs = build_prs(snap)
        check('live: PR 1079 changes analytics/options/surface.py with symbol fit_ssvi (positive)',
              1079 in prs and 'fit_ssvi' in prs[1079]['files'].get('analytics/options/surface.py', {}).get('symbols', []))
        check('live: a merged-to-stable PR is classified stable (positive)', any(p['landed'] == 'stable' for p in prs.values()))
        check('live: every promotion PR is base stable (positive)', all(p['base'] == 'stable' for p in prs.values() if p['landed'] == 'promotion'))
        check('live: open PRs are never classified stable (negative)', all(p['landed'] == 'open' for p in prs.values() if p['state'] == 'OPEN'))
        W = {w['key']: w for w in snap['calendar']['windows']}
        check('live: ISSUE-330 carries folded-into and is bookkeeping (positive)', 'ISSUE-330' in W and is_folded(W['ISSUE-330']['labels']))
        check('live: ISSUE-314 is not folded (negative)', 'ISSUE-314' in W and not is_folded(W['ISSUE-314']['labels']))
        hc = halt_collisions([{'key': k, 'start_utc': w['start_utc'], 'end_utc': w['end_utc'], 'labels': w['labels'], 'status': w['status']} for k, w in W.items()], None)
        check('live: no halt collision remains once the fold is excluded (negative)', '2026-10-29' not in hc, str(hc))
    else:
        res.append(('live controls need a snapshot', None, 'no snapshot'))
    bad = [r for r in res if r[1] is False]
    for name, ok_, detail in res:
        print(('PASS ' if ok_ else 'SKIP ' if ok_ is None else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok_ else ''))
    print(f'selftest: {sum(1 for r in res if r[1])} pass, {len(bad)} fail, {sum(1 for r in res if r[1] is None)} skip')
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--snap', default='snap')
    ap.add_argument('--out', default='run')
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--allow-stale', action='store_true')
    ap.add_argument('--worktree', default=default_repo())
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest(a.snap if pathlib.Path(a.snap).exists() else None))
    now = datetime.datetime.now(UTC)
    stale = check_fresh(a.snap, now, a.allow_stale)
    tracked = tracked_files(a.worktree)
    if len(tracked) < 500:
        raise SystemExit(f'REFUSED: git ls-tree origin/master in {a.worktree!r} returned {len(tracked)} paths. Set MMD_REPO or --worktree to the market-data checkout; an empty tracked set silently removes every declared-file overlap.')
    B, meta, pairs, bundles, items, days_b, days_p = run(a.snap, a.out, now, tracked)
    counts = write_inputs(a.out, pairs, bundles, items, days_p)
    print(json.dumps({'meta': meta, 'rows': counts, 'stale': stale}, indent=1))


if __name__ == '__main__':
    main()
