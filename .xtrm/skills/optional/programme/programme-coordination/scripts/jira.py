"""Jira REST helper (token never printed).
env: JIRA_TOKEN_FILE (path to the API token file), JIRA_EMAIL, JIRA_SITE override the defaults below.
Identity: an agent process (SUBSTRATE_HOLDER set, or a claude/pi/codex ancestor process) uses the
xtrm-bot account from ~/.xtrm/identities/atlassian-agent/identity.json (made by `xt jira setup`);
XTRM_JIRA_AS=operator forces the operator account; explicit JIRA_EMAIL/JIRA_TOKEN_FILE always win.
Same rule as the acli shim (cli/src/core/jira-identity.ts); keep the two in step.
usage: jira.py GET <path> | jira.py POST|PUT <path> <json-file>
       jira.py transition <KEY> "<status name>"   (looks up the transition id by target status)
       jira.py comment <KEY> <text-file>          (plain text; blank lines split paragraphs; ADF built here)
Prints the HTTP status and the JSON response."""
import base64, json, os, pathlib, sys, urllib.request, urllib.error

OPERATOR_EMAIL = 'jagger.xtrm@gmail.com'
OPERATOR_TOKEN_FILE = '/home/dawid/.secrets/atlassian-api-token.txt'


def in_agent_tree(start=None):
    """True when a claude/pi/codex process is an ancestor (a resumed session may lack SUBSTRATE_HOLDER)."""
    pid = os.getppid() if start is None else int(start)
    for _ in range(16):
        if pid <= 1:
            return False
        try:
            comm = pathlib.Path(f'/proc/{pid}/comm').read_text().strip()
            if comm in ('claude', 'pi', 'codex'):
                return True
            pid = next(int(l.split()[1]) for l in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if l.startswith('PPid:'))
        except (OSError, StopIteration, ValueError):
            return False
    return False


def identity():
    """(email, token_file). identity.json present = opted in: an agent then never falls back to the operator."""
    env = os.environ
    if 'JIRA_EMAIL' in env or 'JIRA_TOKEN_FILE' in env:
        return env.get('JIRA_EMAIL', OPERATOR_EMAIL), env.get('JIRA_TOKEN_FILE', OPERATOR_TOKEN_FILE)
    cfg = pathlib.Path.home() / '.xtrm/identities/atlassian-agent/identity.json'
    if env.get('XTRM_JIRA_AS') != 'operator' and cfg.exists() and (env.get('SUBSTRATE_HOLDER') or in_agent_tree(env.get('XTRM_JIRA_WALK_FROM'))):
        d = json.loads(cfg.read_text())
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


def call(method, path, body=None):
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
    return call('POST', f'/rest/api/3/issue/{key}/transitions', {'transition': {'id': ids[0]}})


def adf(text):
    paras = [p.strip() for p in text.split('\n\n') if p.strip()]
    content = []
    for p in paras:
        nodes = []
        for i, line in enumerate(p.split('\n')):
            if i:
                nodes.append({'type': 'hardBreak'})
            nodes.append({'type': 'text', 'text': line})
        content.append({'type': 'paragraph', 'content': nodes})
    return {'type': 'doc', 'version': 1, 'content': content}


if __name__ == '__main__':
    m, p = sys.argv[1], sys.argv[2]
    if m == 'transition':
        st, out = transition(p, sys.argv[3])
    elif m == 'comment':
        st, out = call('POST', f'/rest/api/3/issue/{p}/comment', {'body': adf(pathlib.Path(sys.argv[3]).read_text())})
    else:
        body = json.loads(pathlib.Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else None
        st, out = call(m, p, body)
    print('HTTP', st)
    print(json.dumps(out, indent=1)[:6000] if not isinstance(out, str) else out)
