"""Jira REST helper (token never printed).
env: JIRA_TOKEN_FILE (path to the API token file), JIRA_EMAIL, JIRA_SITE override the defaults below.
Identity: an agent process (SUBSTRATE_HOLDER set, or a claude/pi/codex ancestor process) uses the
xtrm-bot account from ~/.xtrm/identities/atlassian-agent/identity.json (made by `xt jira setup`);
XTRM_JIRA_AS=operator forces the operator account; explicit JIRA_EMAIL/JIRA_TOKEN_FILE always win.
Same rule as the acli shim (cli/src/core/jira-identity.ts); keep the two in step.
Attribution: text an agent process posts starts with `[agent:<holder> | run:<id>]` (` | fallback` when
SUBSTRATE_HOLDER is unset and the holder is derived from the runtime and worktree); creates and
transitions by an agent add the label `actor=agent`. Neither ever refuses a write.
usage: jira.py GET <path> | jira.py POST|PUT <path> <json-file>
       jira.py transition <KEY> "<status name>"   (looks up the transition id by target status)
       jira.py comment <KEY> <text-file>          (plain text; blank lines split paragraphs; ADF built here)
Prints the HTTP status and the JSON response; `comment` then prints `POSTED_TEXT <json string>`, the exact text posted.
Module use: post_comment(key, text) returns (status, response, posted_text)."""
import base64, hashlib, json, os, pathlib, re, sys, urllib.request, urllib.error

OPERATOR_EMAIL = 'jagger.xtrm@gmail.com'
OPERATOR_TOKEN_FILE = '/home/dawid/.secrets/atlassian-api-token.txt'


AGENT_COMMS = ('claude', 'pi', 'codex')


def agent_ancestor(start=None):
    """(pid, comm) of the nearest claude/pi/codex ancestor, or None (a resumed session may lack SUBSTRATE_HOLDER)."""
    pid = os.getppid() if start is None else int(start)
    for _ in range(16):
        if pid <= 1:
            return None
        try:
            comm = pathlib.Path(f'/proc/{pid}/comm').read_text().strip()
            if comm in AGENT_COMMS:
                return pid, comm
            pid = next(int(l.split()[1]) for l in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if l.startswith('PPid:'))
        except (OSError, StopIteration, ValueError):
            return None
    return None


def in_agent_tree(start=None):
    return agent_ancestor(start) is not None


def is_agent_process():
    """SUBSTRATE_HOLDER set or a claude/pi/codex ancestor, unless XTRM_JIRA_AS=operator. Same rule as the acli shim."""
    env = os.environ
    return env.get('XTRM_JIRA_AS') != 'operator' and bool(env.get('SUBSTRATE_HOLDER') or in_agent_tree(env.get('XTRM_JIRA_WALK_FROM')))


_AGENT = False  # set by identity() when the agent account was selected


def identity():
    """(email, token_file). identity.json present = opted in: an agent then never falls back to the operator."""
    env = os.environ
    if 'JIRA_EMAIL' in env or 'JIRA_TOKEN_FILE' in env:
        return env.get('JIRA_EMAIL', OPERATOR_EMAIL), env.get('JIRA_TOKEN_FILE', OPERATOR_TOKEN_FILE)
    cfg = pathlib.Path.home() / '.xtrm/identities/atlassian-agent/identity.json'
    if cfg.exists() and is_agent_process():
        d = json.loads(cfg.read_text())
        global _AGENT
        _AGENT = True
        return d['email'], d['tokenFile']
    return OPERATOR_EMAIL, OPERATOR_TOKEN_FILE


_CREDS = None


def creds():
    """(email, token), resolved on first use so importing this module reads no secret."""
    global _CREDS
    if _CREDS is None:
        email, token_file = identity()
        _CREDS = (email, pathlib.Path(token_file).read_text().strip())
    return _CREDS


BASE = os.environ.get('JIRA_SITE', 'https://mercuryintel.atlassian.net')


_ME = None


def my_account_id():
    global _ME
    if _ME is None:
        _ME = call('GET', '/rest/api/3/myself')[1]['accountId']
    return _ME


ACTOR_LABEL = 'actor=agent'
HEADER_PREFIX = '[agent:'


def _token(value):
    """Keeps a holder or run id inside the header grammar (no spaces, `|` or `]`)."""
    return re.sub(r'[^\w.:@-]', '-', value.strip())


def _starttime(pid):
    try:
        return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return ''


def run_id():
    """SUBSTRATE_RUN_ID if set, else 6 hex chars stable for one agent process tree: sha1 of boot id, the nearest
    claude/pi/codex ancestor's pid and start time (the session leader when there is none)."""
    rid = os.environ.get('SUBSTRATE_RUN_ID', '').strip()
    if rid:
        return _token(rid)
    found = agent_ancestor(os.environ.get('XTRM_JIRA_WALK_FROM'))
    root = found[0] if found else os.getsid(0)
    try:
        boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except OSError:
        boot = ''
    return hashlib.sha1(f'{boot}:{root}:{_starttime(root)}'.encode()).hexdigest()[:6]


def worktree_slug():
    """Name of the directory holding the .git entry above the cwd (the worktree), else the cwd name."""
    try:
        here = pathlib.Path.cwd()
    except OSError:
        return 'unknown'
    for d in (here, *here.parents):
        if (d / '.git').exists():
            return d.name or 'unknown'
    return here.name or 'unknown'


def agent_header():
    """`[agent:<holder> | run:<id>]` for an agent process, else None. Without SUBSTRATE_HOLDER the holder is
    `<runtime>-<worktree dir>` and the header ends ` | fallback]`: attribution is never a reason to refuse a write."""
    if not is_agent_process():
        return None
    holder = os.environ.get('SUBSTRATE_HOLDER', '').strip()
    if holder:
        return f'{HEADER_PREFIX}{_token(holder)} | run:{run_id()}]'
    found = agent_ancestor(os.environ.get('XTRM_JIRA_WALK_FROM'))
    runtime = found[1] if found else 'agent'  # no ancestor: a blank SUBSTRATE_HOLDER made this an agent process
    return f'{HEADER_PREFIX}{runtime}-{_token(worktree_slug())} | run:{run_id()} | fallback]'


def with_actor_label(labels):
    """Caller labels kept, `actor=agent` merged in once. A malformed value is left for Jira to reject."""
    labels = [] if labels is None else labels
    return labels if not isinstance(labels, list) or ACTOR_LABEL in labels else labels + [ACTOR_LABEL]


def paragraphs(text):
    return [p.strip() for p in text.split('\n\n') if p.strip()]


def with_header(text):
    """The agent header and a blank line before the text; unchanged for a non-agent, empty or already headed text."""
    header = agent_header()
    if header is None or not paragraphs(text) or text.lstrip().startswith(HEADER_PREFIX):
        return text
    return f'{header}\n\n{text}'


def call(method, path, body=None):
    # A ticket the agent account creates is assigned to it unless the caller names an assignee.
    if method == 'POST' and path.split('?')[0].rstrip('/') == '/rest/api/3/issue' and isinstance(body, dict):
        creds()
        fields = body.setdefault('fields', {})
        if _AGENT and not fields.get('assignee'):
            fields['assignee'] = {'accountId': my_account_id()}
        if is_agent_process():
            fields['labels'] = with_actor_label(fields.get('labels'))
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    email, tok = creds()
    req.add_header('Authorization', 'Basic ' + base64.b64encode(f'{email}:{tok}'.encode()).decode())
    req.add_header('Accept', 'application/json')
    if data is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:2000]


def transition(key, status):
    st, out = call('GET', f'/rest/api/3/issue/{key}/transitions')
    if st != 200:
        return st, out
    ids = [t['id'] for t in out['transitions'] if t['to']['name'].lower() == status.lower()]
    if not ids:
        return 400, 'no transition to %r; available: %s' % (status, [t['to']['name'] for t in out['transitions']])
    if is_agent_process():  # label first: the ticket already carries it when the transition fires
        label_status, _ = call('PUT', f'/rest/api/3/issue/{key}', {'update': {'labels': [{'add': ACTOR_LABEL}]}})
        if label_status >= 300:
            print(f'warning: label {ACTOR_LABEL} not added to {key} (HTTP {label_status}); transition continues', file=sys.stderr)
    return call('POST', f'/rest/api/3/issue/{key}/transitions', {'transition': {'id': ids[0]}})


def adf(text):
    content = []
    for p in paragraphs(text):
        nodes = []
        for i, line in enumerate(p.split('\n')):
            if i:
                nodes.append({'type': 'hardBreak'})
            nodes.append({'type': 'text', 'text': line})
        content.append({'type': 'paragraph', 'content': nodes})
    return {'type': 'doc', 'version': 1, 'content': content}


def post_comment(key, text):
    """Posts a comment. Returns (status, response, posted_text); posted_text is exactly the text of the ADF body
    sent (agent header included, paragraphs normalised the way adf() builds them), for a read-back compare."""
    posted = '\n\n'.join(paragraphs(with_header(text)))
    st, out = call('POST', f'/rest/api/3/issue/{key}/comment', {'body': adf(posted)})
    return st, out, posted


if __name__ == '__main__':
    m, p = sys.argv[1], sys.argv[2]
    if m == 'transition':
        st, out = transition(p, sys.argv[3])
    elif m == 'comment':
        st, out, posted = post_comment(p, pathlib.Path(sys.argv[3]).read_text())
    else:
        body = json.loads(pathlib.Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else None
        st, out = call(m, p, body)
    print('HTTP', st)
    print(json.dumps(out, indent=1)[:6000] if not isinstance(out, str) else out)
    if m == 'comment' and st < 300:
        print('POSTED_TEXT', json.dumps(posted, ensure_ascii=False))
