#!/usr/bin/env python3
"""Snapshot + deterministic facts for the Mercury market-data board audit.

Every relational or arithmetic fact lives here, in code, so the judge never has to
infer something it cannot see.

Provenance rule used by the STALE class below:
  STALE = 7 d from now, provisional, single-case (PR #879).
That threshold is global, measured from the current time, and was fitted to one
observed case. No text may claim it is calibrated.

Environment:
  JIRA_EMAIL        required, no default
  JIRA_TOKEN_FILE   optional, defaults to ~/.secrets/atlassian-api-token.txt
  MMD_BASE_REPO     optional, the market-data checkout git is read from; overridable
                    with --repo on the command line

Unit tests: `python3 facts.py --selftest` (network cases report SKIPPED, not pass).
"""
import base64, datetime, json, os, pathlib, re, subprocess, sys, urllib.request

JIRA_BASE = 'https://mercuryintel.atlassian.net'
TOKEN_FILE = os.environ.get('JIRA_TOKEN_FILE') or str(
    pathlib.Path.home() / '.secrets' / 'atlassian-api-token.txt')

# CME daily halt: the only window in which the Rust tick ingestor may be swapped.
# Git reads (on_stable) need a market-data checkout. Never a literal path: set it here.
BASE_REPO = os.environ.get('MMD_BASE_REPO') or os.getcwd()
INGESTOR_HALT_UTC = ('21:17', '21:55')

WINDOW_KEYS = ["ISSUE-454", "ISSUE-455", "ISSUE-456", "ISSUE-457", "ISSUE-458",
               "ISSUE-182", "ISSUE-306", "ISSUE-373", "ISSUE-374", "ISSUE-375"]


def jira_email():
    """Required, no default: a silent fallback would post as the wrong account."""
    email = os.environ.get('JIRA_EMAIL')
    if not email:
        raise SystemExit('JIRA_EMAIL is required (no default is assumed)')
    return email


def jira_call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(JIRA_BASE + path, data=data, method=method)
    token = pathlib.Path(TOKEN_FILE).read_text().strip()
    req.add_header('Authorization', 'Basic ' + base64.b64encode(f'{jira_email()}:{token}'.encode()).decode())
    req.add_header('Accept', 'application/json')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b'{}')


def parse_jira_time(value):
    """Jira custom-field datetime '2026-10-22T06:00:00.000+0200' -> aware UTC datetime."""
    if not value:
        return None
    text = value.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+0000'
    for fmt in ('%Y-%m-%dT%H:%M:%S.%f%z', '%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%d'):
        try:
            dt = datetime.datetime.strptime(text, fmt)
            if fmt == '%Y-%m-%d':
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            return dt.astimezone(datetime.timezone.utc)
        except ValueError:
            continue
    raise ValueError(f'unparseable Jira time: {value!r}')


def is_ingestor_row(row):
    text = ((row.get('summary') or '') + ' ' + ' '.join(row.get('labels') or [])).lower()
    return 'ingestor' in text or 'tick' in text


def window_band(row):
    """The UTC band this Task's window must fall inside, or None when any band is fine."""
    if is_ingestor_row(row):
        start, end = INGESTOR_HALT_UTC
        return {'name': 'cme-daily-halt', 'utc_from': start, 'utc_to': end,
                'rule': 'the tick ingestor changes only inside the CME daily halt'}
    return None


def window_inside_expected_band(row):
    """(inside: bool|None, detail) — None means no band applies to this Task."""
    band = window_band(row)
    start = parse_jira_time(row.get('cf37'))
    end = parse_jira_time(row.get('cf38'))
    if band is None:
        return None, 'no band applies to this Task'
    if start is None or end is None:
        return None, 'window incomplete; band cannot be evaluated'
    halt_from = datetime.time.fromisoformat(band['utc_from'])
    halt_to = datetime.time.fromisoformat(band['utc_to'])
    day = start.date()
    band_start = datetime.datetime.combine(day, halt_from, tzinfo=datetime.timezone.utc)
    band_end = datetime.datetime.combine(day, halt_to, tzinfo=datetime.timezone.utc)
    inside = start >= band_start and end <= band_end
    detail = (f"window {start.strftime('%Y-%m-%dT%H:%MZ')}..{end.strftime('%H:%MZ')} vs band "
              f"{band['name']} {band_start.strftime('%Y-%m-%dT%H:%MZ')}..{band_end.strftime('%H:%MZ')}")
    return inside, detail


BLOCKING_WORDS = ('precondition', 'requires', 'needs', 'blocked', 'only after', 'must be merged',
                  'must ship', 'depends on', 'waiting on', 'before this window')


def stated_preconditions(description):
    """Quote the sentences that state a blocking condition. The judge reads the quote and
    decides; this function never decides 'met' or 'unmet' itself."""
    if not description:
        return 'none stated'
    text = ' '.join(description.split())
    quotes = []
    for sentence in re.split(r'(?<=[.!?])\s+', text):
        low = sentence.lower()
        if any(w in low for w in BLOCKING_WORDS):
            quotes.append(sentence.strip()[:180])
        if len(quotes) >= 2:
            break
    return ' | '.join(quotes) if quotes else 'none stated'


def same_slot_clusters(rows):
    """Tasks of one parent whose windows overlap. Same-slot is a fact; whether the two
    Tasks are ONE deploy is judged from their text, never guessed from the window."""
    clusters = []
    keys = list(rows)
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            A, B = rows[a], rows[b]
            if not A.get('parent') or A.get('parent') != B.get('parent'):
                continue
            if A.get('cf37') and A.get('cf38') and B.get('cf37') and B.get('cf38'):
                if A['cf37'] < B['cf38'] and B['cf37'] < A['cf38']:
                    clusters.append({'rows': sorted([a, b]), 'parent': A['parent']})
    return clusters


def order_facts(rows, predecessors):
    """predecessors: {row_key: [must_end_before_keys]}. Returns the ordering fact per row."""
    out = {}
    for key, deps in predecessors.items():
        facts = []
        for dep in deps:
            dep_row, row = rows.get(dep), rows.get(key)
            if not dep_row or not row:
                facts.append(f'{dep}: not in snapshot')
                continue
            dep_end = parse_jira_time(dep_row.get('cf38'))
            start = parse_jira_time(row.get('cf37'))
            if dep_end is None or start is None:
                facts.append(f'{dep}: window incomplete')
            elif dep_end <= start:
                facts.append(f'{dep} ends {dep_end.strftime("%Y-%m-%dT%H:%MZ")} at or before this start '
                             f'{start.strftime("%Y-%m-%dT%H:%MZ")} -> order holds')
            else:
                facts.append(f'{dep} ends {dep_end.strftime("%Y-%m-%dT%H:%MZ")} AFTER this start '
                             f'{start.strftime("%Y-%m-%dT%H:%MZ")} -> order violated')
        out[key] = '; '.join(facts) if facts else 'none'
    return out


def build_rows(issues, predecessors=None):
    """Attach every derived fact to its row as text the judge can cite."""
    predecessors = predecessors or {}
    stamp_row = {}
    clusters = same_slot_clusters(issues)
    orders = order_facts(issues, predecessors)
    for key, v in issues.items():
        partners = [c for c in clusters if key in c['rows']]
        partner_text = 'none'
        if partners:
            partner_text = '; '.join(
                f"{' + '.join(k for k in c['rows'] if k != key)} shares parent {c['parent']} and an overlapping window"
                for c in partners)
        prs = named_prs(v.get('desc'))
        required, subjects, references = blocker_facts(v.get('desc'))
        pr_facts = [pr_gate(n) for n in prs]
        gate_prs = [f['text'] for f in pr_facts if f['class'] == 'gate']
        hist_prs = [f['text'] for f in pr_facts if f['class'] == 'history']
        ok_prs = [f['text'] for f in pr_facts if f['class'] == 'satisfied']
        stale_prs = [f['text'] for f in pr_facts if f['class'] == 'stale']
        pr_fact = '; '.join(
            ([f'BLOCKING {t}' for t in gate_prs] + [f'SATISFIED {t}' for t in ok_prs]
             + [f'STALE {t}' for t in stale_prs] + [f'HISTORICAL {t}' for t in hist_prs])
            or ['no PR named in the description'])
        blocker_fact = ('; '.join(blocker_state(b) for b in required) if required
                        else 'no required dependency named')
        subject_fact = ('; '.join(blocker_state(b) for b in subjects) if subjects
                        else 'no subject issue named')
        ref_fact = '; '.join(references) if references else 'none'
        stable_fact = 'not applicable'
        if any(w in (stated_preconditions(v.get('desc')) or '').lower() for w in ('stable', 'promotion')):
            merged = [f for f in pr_facts if f['merged'] and f.get('merge_commit') and f['class'] == 'satisfied']
            if merged:
                stable_fact = '; '.join(
                    f"PR #{f['number']} merge {f['merge_commit']} on_stable={on_stable(f['merge_commit'])}"
                    for f in merged)
            else:
                stable_fact = 'no merged PR named, so nothing can be shown on stable'
        inside, detail = window_inside_expected_band(v)
        band_text = 'no band applies' if inside is None else ('inside expected band: ' if inside else 'OUTSIDE expected band: ') + detail
        stamp_row[key] = {
            'key': key, 'summary': v['summary'], 'status': v['status'], 'parent': v.get('parent'),
            'start': v.get('start'), 'due': v.get('due'), 'cf37': v.get('cf37'), 'cf38': v.get('cf38'),
            'proposed_action': 'verify the window is correctly scheduled and ordered for the plan',
            'evidence': (
                f"facts computed from the live read: status={v['status']}, parent={v.get('parent')}, "
                f"cf37={v.get('cf37')}, cf38={v.get('cf38')}, due={v.get('due')}; "
                f"same_slot_cluster={partner_text}; "
                f"order={orders.get(key, 'none')}; "
                f"expected_band={band_text}; "
                f"named_pr={pr_fact}; "
                f"named_blocker_required={blocker_fact}; "
                f"named_subject={subject_fact}; "
                f"named_reference_only={ref_fact}; "
                f"stable_check={stable_fact}; "
                f"stated_preconditions={stated_preconditions(v.get('desc'))}"
            ),
        }
        verdict, why = oracle(stamp_row[key])
        stamp_row[key]['evidence'] += f"; oracle={verdict} ({why})"
    return stamp_row


def adf_text(node):
    if isinstance(node, str):
        return node
    if isinstance(node, list):
        return ''.join(adf_text(x) for x in node)
    if isinstance(node, dict):
        if node.get('type') == 'text':
            return node.get('text') or ''
        sep = '\n' if node.get('type') in ('paragraph', 'heading', 'listItem', 'codeBlock', 'rule') else ' '
        return adf_text(node.get('content') or []) + sep
    return ''


DEP_WORDS = ('needs', 'require', 'requires', 'blocked', 'depends', 'waiting', 'precondition',
             'only after', 'before this window', 'must be merged', 'must ship')


def named_prs(text):
    return sorted({int(m) for m in re.findall(r'(?:PR\s*|#)(\d{2,4})\b', text or '')})


SUBJECT_MARKERS = ('substrate', 'work:', 'tracked by', 'issue:', 'owner issue', 'implementation:')
PROVENANCE_MARKERS = ('source:', 'originally', 'schedule-proposal', 'decision record', 'plan line',
                      'found by', 'proposed in')


def blocker_facts(text):
    """Classify each Substrate mention: dependency, subject or reference.

    A window description names issues in three different roles: the work item it ships
    ("Substrate MMD-2412"), a stated dependency ("needs MMD-2481"), and provenance
    ("Source: schedule-proposal-v3 (MMD-2534)"). Only the first two can gate a window. Treating
    provenance as a dependency fabricates blockers, which is what wrongly rejected a job-only
    window (ISSUE-327) on a PR belonging to a scheduling proposal.
    """
    text = ' '.join((text or '').split())
    found = {}
    for sentence in re.split(r'(?<=[.!?])\s+', text):
        low = sentence.lower()
        dep = any(w in low for w in DEP_WORDS)
        prov = any(w in low for w in PROVENANCE_MARKERS)
        subj = any(w in low for w in SUBJECT_MARKERS)
        for ref in re.findall(r'MMD-\d+', sentence):
            if ref in found and found[ref] != 'reference':
                continue
            role = 'dependency' if dep else ('subject' if (subj and not prov) else 'reference')
            if found.get(ref) == 'dependency':
                continue
            found[ref] = role
    deps = [r for r, v in found.items() if v == 'dependency']
    subjs = [r for r, v in found.items() if v == 'subject']
    refs = [r for r, v in found.items() if v == 'reference']
    return deps, subjs, refs


_PR_CACHE = {}
_GH_ERR = None


def pr_gate(number):
    """Classify a PR as satisfied / gate / history. Age decides for closed-unmerged PRs:
    a PR closed without merging long ago is provenance, not a deliverable gate."""
    if number in _PR_CACHE:
        return _PR_CACHE[number]
    d = {}
    try:
        raw = subprocess.run(['gh', 'api', f'repos/mercuryintelligence/market-data/pulls/{number}'],
                             capture_output=True, text=True, timeout=30).stdout
        d = json.loads(raw or '{}')
    except Exception:
        d = {}
    if not d:
        info = {'text': f'PR #{number} unreadable', 'class': 'unknown', 'merged': False, 'open': False}
        _PR_CACHE[number] = info
        return info
    state = d.get('state')
    merged = bool(d.get('merged_at'))
    closed_at = d.get('closed_at') or d.get('merged_at')
    age = None
    if closed_at:
        try:
            age = (datetime.datetime.now(datetime.timezone.utc)
                   - parse_jira_time(closed_at)).days
        except Exception:
            age = None
    if merged:
        try:
            mage = (datetime.datetime.now(datetime.timezone.utc) - parse_jira_time(d['merged_at'])).days
        except Exception:
            mage = None
        if mage is not None and mage >= 7:
            cls = 'stale'
            text = (f"PR #{number} merged_at={d['merged_at']} STALE: merged {mage} days ago, "
                    f"too old to satisfy a per-window precondition")
        else:
            cls = 'satisfied'
            text = f"PR #{number} merged_at={d['merged_at']}"
    elif state == 'open':
        cls = 'gate'
        text = (f"PR #{number} open draft={d.get('draft')} mergeable={d.get('mergeable')}"
                f" ({d.get('mergeable_state')})")
    else:
        cls = 'history' if (age is not None and age >= 7) else 'gate'
        text = f"PR #{number} closed merged_at=None age_days={age}"
    info = {'text': text, 'class': cls, 'merged': merged, 'open': state == 'open', 'stale': cls == 'stale',
            'merge_commit': (d.get('merge_commit_sha') or '')[:9], 'number': number}
    _PR_CACHE[number] = info
    return info


def pr_state(number):
    return pr_gate(number)['text']


_STABLE = {}


def on_stable(sha):
    if not sha:
        return None
    if 'head' not in _STABLE:
        subprocess.run(['git', 'fetch', '--quiet', 'origin', 'stable'],
                       cwd=BASE_REPO, timeout=90, capture_output=True)
        r = subprocess.run(['git', 'rev-parse', 'origin/stable'], cwd=BASE_REPO, capture_output=True, text=True)
        _STABLE['head'] = (r.stdout or '').strip()
    r = subprocess.run(['git', 'merge-base', '--is-ancestor', sha, 'origin/stable'], cwd=BASE_REPO)
    return r.returncode == 0


def blocker_state(ref):
    """State of a required dependency: the PRs it names, classified, plus its own status."""
    try:
        out = subprocess.run(['sb', 'issue', 'show', ref], capture_output=True, text=True, timeout=30).stdout
        prs = sorted({int(m) for m in re.findall(r'(?:PR\s*|#)(\d{3,4})\b', out)})
        facts = [pr_gate(n) for n in prs]
        gates = [f['text'] for f in facts if f['class'] == 'gate']
        satisfied = [f['text'] for f in facts if f['class'] == 'satisfied']
        hist = [f['text'] for f in facts if f['class'] == 'history']
        state = 'unknown'
        for line in [l for l in out.splitlines() if l.strip()][:4]:
            if line.split() and line.split()[0] in ('OPEN', 'CLOSED', 'DONE', 'CANCELLED', 'BLOCKED', 'DEFERRED'):
                state = line.split()[0]
                break
        parts = [f'{ref} {state}']
        parts += [f'SATISFIED {t}' for t in satisfied]
        parts += [f'BLOCKING {t}' for t in gates]
        parts += [f'HISTORICAL {t}' for t in hist]
        return '; '.join(parts)
    except Exception as exc:
        return f'{ref} unreadable ({type(exc).__name__})'


def fetch(stamp_keys=None, day=None):
    keys = stamp_keys or WINDOW_KEYS
    jql = ('key in (' + ','.join(keys) + ')') if not day else (
        f'project = ISSUE AND cf[10015] = "{day}" AND labels = window')
    data = jira_call('POST', '/rest/api/3/search/jql', {
        'jql': jql, 'maxResults': 50,
        'fields': ['summary', 'status', 'parent', 'labels', 'customfield_10015', 'duedate',
                   'customfield_10237', 'customfield_10238', 'assignee', 'description']})
    issues = {}
    for it in data.get('issues', []):
        f = it['fields']
        issues[it['key']] = {
            'summary': f.get('summary'), 'status': (f.get('status') or {}).get('name'),
            'parent': (f.get('parent') or {}).get('key'), 'labels': f.get('labels') or [],
            'start': f.get('customfield_10015'), 'due': f.get('duedate'),
            'cf37': f.get('customfield_10237'), 'cf38': f.get('customfield_10238'),
            'assignee': (f.get('assignee') or {}).get('displayName'),
            'desc': adf_text(f.get('description') or ''),
        }
    return issues


PLAN_PREDECESSORS = {
    'ISSUE-455': ['ISSUE-454'], 'ISSUE-456': ['ISSUE-454'],
    'ISSUE-458': ['ISSUE-454'], 'ISSUE-373': ['ISSUE-458'], 'ISSUE-374': ['ISSUE-373'],
    'ISSUE-375': ['ISSUE-374'],
}

DAY_PREDECESSORS = {
    '2026-10-22': {'ISSUE-455': ['ISSUE-454'], 'ISSUE-456': ['ISSUE-454'],
                   'ISSUE-458': ['ISSUE-454'], 'ISSUE-373': ['ISSUE-458']},
    '2026-10-23': {'ISSUE-374': ['ISSUE-373'], 'ISSUE-375': ['ISSUE-374']},
}


def selftest():
    ok = True
    def check(name, got, want):
        nonlocal ok
        good = got == want
        ok = ok and good
        print(('PASS' if good else 'FAIL'), name, '->', got, '' if good else f'(want {want})')

    # 1. same-slot pair ISSUE-182/ISSUE-306: one deploy, one slot -> a cluster, not a violation.
    rows = {
        'ISSUE-182': {'parent': 'ISSUE-433', 'summary': 'backup re-home', 'cf37': '2026-10-22T14:07:00.000+0200', 'cf38': '2026-10-22T14:52:00.000+0200'},
        'ISSUE-306': {'parent': 'ISSUE-433', 'summary': 'backup hardening', 'cf37': '2026-10-22T14:07:00.000+0200', 'cf38': '2026-10-22T14:52:00.000+0200'},
    }
    cl = same_slot_clusters(rows)
    check('182/306 detected as one same-slot cluster', [c['rows'] for c in cl], [['ISSUE-182', 'ISSUE-306']])

    # 2. ISSUE-457 as it was entered: 23:17+0100 -> 22:17Z, outside the 21:17-21:55Z halt.
    ing = {'summary': 'MMD window: ingestor swap Mon (rust)', 'labels': ['window'], 'cf37': '2026-10-26T23:17:00.000+0100', 'cf38': '2026-10-26T23:55:00.000+0100'}
    inside, detail = window_inside_expected_band(ing)
    check('457 as entered is OUTSIDE the halt band', (inside, '2026-10-26T22:17Z' in detail), (False, True))

    # 3. the same Task entered correctly (22:17+0100 -> 21:17Z .. 21:47+0100 -> 21:47Z) is inside.
    ing_ok = dict(ing, cf37='2026-10-26T22:17:00.000+0100', cf38='2026-10-26T22:47:00.000+0100')
    check('457 corrected is INSIDE the halt band', window_inside_expected_band(ing_ok)[0], True)

    # 4. a non-ingestor Task has no band, so the band check cannot fail it.
    other = {'summary': 'mmd-api deploy', 'cf37': '2026-10-22T12:07:00.000+0200', 'cf38': '2026-10-22T12:37:00.000+0200'}
    check('non-ingestor row has no band', window_inside_expected_band(other)[0], None)

    # 5. ordering: 458 (ends 10:37+0200 = 08:37Z) before 373 (starts 10:07+0200 = 08:07Z) -> violated.
    order_rows = {
        'ISSUE-458': {'cf37': '2026-10-22T10:07:00.000+0200', 'cf38': '2026-10-22T10:37:00.000+0200'},
        'ISSUE-373': {'cf37': '2026-10-23T10:07:00.000+0200', 'cf38': '2026-10-23T11:07:00.000+0200'},
    }
    f = order_facts(order_rows, {'ISSUE-373': ['ISSUE-458']})['ISSUE-373']
    check('458 precedes 373 across days', 'order holds' in f, True)

    # 6. UTC conversion respects the offset (CET vs CEST).
    check('23:17+0100 is 22:17Z', parse_jira_time('2026-10-26T23:17:00.000+0100').strftime('%H:%MZ'), '22:17Z')
    check('23:17+0200 is 21:17Z', parse_jira_time('2026-10-26T23:17:00.000+0200').strftime('%H:%MZ'), '21:17Z')
    # 7. S7 blocking-language fact: absence is not a defect; a stated condition is quoted.
    job_only = 'Job-only backfill start. Run the 90-day reload from the last settlement, then verify row counts.'
    check('job-only window states no precondition', stated_preconditions(job_only), 'none stated')
    states = 'Precondition: the rotation PR must be merged before this window opens. Then run the switch.'
    check('stated condition is quoted, not judged', 'rotation PR must be merged' in stated_preconditions(states), True)
    check('empty description is none stated', stated_preconditions(''), 'none stated')

    # 8. provenance mention must not become a blocker; dependency language must.
    deps, subjs, refs = blocker_facts('Originally tracked in MMD-2534; this window is job-only.')
    check('provenance mention is reference only', (deps, subjs, refs), ([], [], ['MMD-2534']))
    deps2, subjs2, refs2 = blocker_facts('Source: schedule-proposal-v3 (MMD-2534). Services: job-only.')
    check('Source: marker stays provenance', (deps2, subjs2), ([], []))
    deps3, _, _ = blocker_facts('Needs MMD-2481 ruling before this window opens.')
    check('dependency language makes a mention required', deps3, ['MMD-2481'])
    _, subjs4, _ = blocker_facts('Substrate MMD-2412.')
    check('Substrate marker makes a mention the subject', subjs4, ['MMD-2412'])

    # 9. merged age decides stale vs satisfied. These two need GitHub, so on a host that
    # cannot answer they are SKIPPED, never counted as a pass.
    _PR_CACHE.clear()
    old = pr_gate(879)    # merged 2026-10-05, allowlist rotation
    # The fresh-merge case must not pin a PR: a fixed number goes stale after 7 days (2026-10-29,
    # #991 flipped the selftest). Take the newest PR merged within the last 3 days.
    fresh = {'class': 'unknown'}
    try:
        import datetime as _dt
        _raw = subprocess.run(['gh', 'api', 'repos/mercuryintelligence/market-data/pulls?state=closed&sort=updated&direction=desc&per_page=40'],
                              capture_output=True, text=True, timeout=30).stdout
        _now = _dt.datetime.now(_dt.timezone.utc)
        for _p in json.loads(_raw or '[]'):
            _m = _p.get('merged_at')
            if _m and (_now - _dt.datetime.fromisoformat(_m.replace('Z', '+00:00'))).total_seconds() < 3 * 86400:
                fresh = pr_gate(_p['number'])
                break
    except Exception:
        fresh = {'class': 'unknown'}
    if old['class'] == 'unknown' or fresh['class'] == 'unknown':
        print('SKIP 17-day-old merge is STALE -> GitHub unreachable')
        print('SKIP yesterday merge is SATISFIED -> GitHub unreachable')
    else:
        check('17-day-old merge is STALE', old['class'], 'stale')
        check('yesterday merge is SATISFIED', fresh['class'], 'satisfied')

    print('\nSELFTEST', 'PASSED' if ok else 'FAILED')
    return 0 if ok else 1


def main(argv):
    global BASE_REPO
    if '--selftest' in argv:
        return selftest()
    if '--repo' in argv:
        BASE_REPO = argv[argv.index('--repo') + 1]
    out = argv[argv.index('--out') + 1] if '--out' in argv else 'input.json'
    day = argv[argv.index('--day') + 1] if '--day' in argv else None
    issues = fetch(day=day)
    rows = build_rows(issues, DAY_PREDECESSORS.get(day, PLAN_PREDECESSORS))
    if not issues:
        print(f'no window rows found for day {day}'); return 1
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    payload = {'batch_id': f"{'day-' + day if day else 'batch'}-{stamp}", 'rubric': RUBRIC, 'rows': [rows[k] for k in issues]}
    pathlib.Path(out).write_text(json.dumps(payload, indent=1))
    print(f'wrote {out}: {len(payload["rows"])} rows, stamp {stamp}')
    return 0


def oracle(row):
    """The factual part of the rubric, in code: S1, S2, S3, S5, S6.
    S4 (is this one deploy?), S7 (is the quoted condition met?) and S8 (terminal) stay with the judge."""
    ev = row.get('evidence') or ''
    def grab(name):
        m = re.search(name + r'=([^;]*)', ev)
        return (m.group(1).strip() if m else '')
    if (row.get('status') or '') in ('Done', 'Completata', "Won't Do", 'Done with Follow-up',
                                     'Cancelled', 'Closed'):
        return 'not_applicable', 'S0 window already closed'
    if not row.get('cf37') or not row.get('cf38'):
        return 'reject_needs_evidence', 'S1 window bounds missing'
    if str(row['cf37']) >= str(row['cf38']):
        return 'reject_needs_evidence', 'S1 start not before end'
    band = grab('expected_band')
    if 'OUTSIDE' in band:
        return 'reject_needs_evidence', 'S2 outside expected band'
    if 'BLOCKING PR #' in ev:
        return 'reject_needs_evidence', 'S6 a named PR is a blocking gate'
    order = grab('order')
    if 'order violated' in order:
        return 'reject_needs_evidence', 'S3 order violated'
    status = row.get('status') or ''
    if status in ('Blocked', 'Bloccato'):
        return 'reject_needs_evidence', 'S5 status Blocked'
    pre = grab('stated_preconditions')
    if pre and pre != 'none stated':
        if 'on_stable=False' in ev:
            return 'reject_needs_evidence', 'S7 condition shown unmet (not on stable)'
        if 'on_stable=True' not in ev:
            return 'approve_with_change', 'S7 condition stated but not provable from Jira; a human must check it'
    return 'approve', 'S8 no factual rule failed'


def attention(row):
    """Evidence the judge should weigh but the oracle will not decide on: an unmerged PR or an
    open named blocker. Text scanning cannot tell a deliverable PR from a historical mention, so
    these rows are where the human sample-check has to look."""
    ev = row.get('evidence') or ''
    flags = []
    for frag in re.findall(r'PR #\d+ [^;]*', ev):
        if 'merged_at=' not in frag:
            flags.append(frag.strip())
    for frag in re.findall(r'MMD-\d+ [a-z][^;]*', ev):
        if 'names PR(s)' not in frag:
            flags.append(frag.strip())
    return flags


RUBRIC = (
 "You judge ONE row of a board snapshot. Every relational and arithmetic fact has ALREADY been computed "
 "and is written in the row's evidence field (same_slot_cluster, order, expected_band, named_pr, "
 "named_blocker_required, named_subject, named_reference_only, stable_check, stated_preconditions). Use those facts; do "
 "not recompute them and do not infer a relation that is not written there.\n"
 "Apply these steps in order and stop at the first that returns a verdict. Name the step id in rule. Verdict vocabulary (tri-state gate): approve=clean, approve_with_change=advisory, reject_needs_evidence=fix_now, not_applicable=abstain.\n"
 "S0 (terminal window): if status is Done, Completata, Won't Do, Done with Follow-up, Cancelled or Closed "
 "-> not_applicable, saying the window is closed and only a plan for a future slot is auditable. S0 fails OPEN: a closed window is never a plan and can never reject.\n"
 "S1 (window integrity): if cf37 or cf38 is null, or cf37 >= cf38, or due is before the calendar date of cf37 "
 "-> reject_needs_evidence, naming the failing field.\n"
 "S2 (expected band): read expected_band. If it says OUTSIDE -> reject_needs_evidence, naming the band and the "
 "UTC times. If it says 'no band applies' or 'inside expected band' -> continue.\n"
 "S3 (order): read order. If order is 'none' -> continue. If any dependency says 'order violated' -> "
 "reject_needs_evidence, naming that dependency. If every dependency says 'order holds' -> continue.\n"
 "S4 (same slot): read same_slot_cluster. If 'none' -> continue. If it names a partner, decide whether the two "
 "Tasks are ONE deploy (their summaries name the same component, e.g. both describe the backup). One deploy in "
 "one slot is ALLOWED and must not be rejected; two different changes in one slot -> reject_needs_evidence, "
 "naming the partner.\n"
 "S5 (status): if status is Blocked or Bloccato -> reject_needs_evidence, and state whether the row records an "
 "unblocking condition; if it does not, say so. S5 fails CLOSED: a Blocked window rejects even when every other fact is clean.\n"
 "S6 (deliverable gate): read named_pr, named_subject and named_blocker_required. A fact tagged SATISFIED or "
 "DONE is not a gate. A fact tagged HISTORICAL (a PR closed without merging at least 7 days ago) is provenance, "
 "not a gate, and must not be rejected on. A fact tagged BLOCKING is a gate -> reject_needs_evidence, quoting "
 "that fact verbatim. A subject issue that is still OPEN but names only SATISFIED PRs is NOT a gate: the window "
 "may be what closes it. named_reference_only is provenance and is NEVER a gate.\n"
 "S7 (blocking language): read stated_preconditions. Three outcomes only. "
 "(a) 'none stated' -> the absence of a precondition is NOT a defect and MUST NOT be rejected for it: that is a "
 "job-only window with nothing to gate, continue to S8. "
 "(b) a condition is shown UNMET. UNMET has exactly two possible sources and no others: (i) a fact tagged "
 "BLOCKING (which S6 already handles), or (ii) stable_check containing on_stable=False. Nothing else may be read "
 "as unmet. If neither source is present, the condition is not shown unmet and you must use (c). "
 "(c) a condition is STATED but no fact shows it met or unmet -> verdict approve_with_change, quoting the "
 "condition verbatim as the check a human must make before GO. Absence of a fact is NEVER grounds for a reject: "
 "it means Jira does not record it, not that it is absent. Worked example: a condition reading 'the deploy fix "
 "is merged' where named_pr says 'no PR named in the description' is (c), because Jira never recorded which PR "
 "carries the fix; it is NOT a reject and NOT unmet. "
 "A PR tagged STALE (merged 7 or more days before now) does NOT show a per-window precondition met, so it falls "
 "into (c), not (b). "
 "When the condition is about a merge reaching stable, stable_check answers it: on_stable=True is met, "
 "on_stable=False is unmet, 'no merged PR named' is (c).\n"
"S8 (terminal): if no earlier step returned a verdict -> approve, citing each step you evaluated (S1/S2/S3/S4/S5/S6/S7 as applicable) and naming the facts you checked. not_applicable is ONLY for a step the rubric marks as skipped or S0, never for a row that "
 "passed S1-S7. approve means NO JIRA-VISIBLE DEFECT: it is not a GO, and it never implies a status change; the "
 "GO/DRY decision and every transition belong to the coordinator.\n"
 "S9 (oracle agreement): the evidence ends with an oracle verdict computed in code from these same facts. "
 "Your verdict MUST equal the oracle verdict, and rule MUST name the oracle's step id. This is not optional: the "
 "oracle is the deterministic reading of the facts, and re-deriving it from the prose is how verdicts became "
 "unstable. You may diverge only when a specific fact contradicts the oracle; then keep your verdict and name "
 "the contradiction in note, so the disagreement is visible rather than silent. "
 "Never invent a field value. Quote the fact you relied on.")


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
