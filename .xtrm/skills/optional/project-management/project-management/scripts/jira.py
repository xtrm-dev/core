"""Jira REST helper (token never printed).
Settings come from pm_config (env var, then the pack config file; see references/setup.md):
  JIRA_SITE (base URL), JIRA_TOKEN_FILE (path to the operator's API token file), PM_OPERATOR_EMAIL,
  PM_OPERATOR_ACCOUNT_ID, PM_OPERATOR_NAME (mention text), production_statuses (TX-07; falls back to
  done_statuses + "Waiting Production"). A missing required one stops the call with its name.
env: JIRA_EMAIL and JIRA_TOKEN_FILE set in the environment win over both identities below.
Identity: an agent process (SUBSTRATE_HOLDER set, or a claude/pi/codex ancestor process) uses the
xtrm-bot account from ~/.xtrm/identities/atlassian-agent/identity.json (made by `xt jira setup`);
XTRM_JIRA_AS=operator forces the operator account; explicit JIRA_EMAIL/JIRA_TOKEN_FILE always win.
Same rule as the acli shim (cli/src/core/jira-identity.ts); keep the two in step.
Attribution: text an agent process posts starts with `[agent:<holder> | run:<id>]` (` | fallback` when
SUBSTRATE_HOLDER is unset and the holder is derived from the runtime and worktree); creates, field edits
(PUT /rest/api/3/issue/<KEY>) and transitions by an agent add the label `actor=agent`, merged with the labels
already there. Neither ever refuses a write.
usage: jira.py GET <path> | jira.py POST|PUT <path> <json-file>
       jira.py transition <KEY> "<status name>"   (looks up the transition id by target status)
       jira.py transition-by-id <KEY> <id>        (verifies the id is offered on the row NOW, then moves)
       jira.py link <BLOCKER> <BLOCKED> [type]    (Blocker/Blocked named explicitly, link re-read)
       jira.py comment <KEY> <text-file>          (plain text; blank lines split paragraphs; ADF built here;
                                                   the token @operator becomes a mention of PM_OPERATOR_ACCOUNT_ID)
Prints the HTTP status and the JSON response; `comment` then prints `POSTED_TEXT <json string>`, the exact text posted.
Module use: post_comment(key, text, parent_id=None) returns (status, response, posted_text); parent_id posts it
as a threaded reply under that comment of the same ticket.

Phase 2 write guards (MMD-3546). A refusal prints the catalogue text for its event id (MMD-3544 catalogue),
so the failure teaches the rule instead of showing a bare HTTP code. In the order they run:
  TX-02  a transition is sent only with an id read live from THIS ticket in THIS run
  TX-04  a transition body may not carry a comment (Jira drops it silently)
  LK-01  a Blocks link must declare which side is the blocker; the declaration is checked, then stripped
  LK-02  a created link is read back at GET /rest/api/3/issueLink/<id> before it is reported
  OW-01  another writer's change inside 60 minutes refuses this lane's edit or move
  SC-03  a body that looks like it carries a credential is refused, and the value is never printed
  DP-02  a create whose summary or substrate label already exists is refused
  TX-07  a move to a production status (production_statuses) warns when no deployed-SHA evidence was read
Reads are unchanged: every guard runs on POST or PUT only.
Exit status: 0 done, 1 a write was refused or failed, 3 a move reached Jira but its re-read did not prove it
(TX-05 unverified: do not retry it). A read keeps the caller's exit status."""
import base64, hashlib, json, os, pathlib, re, sys, time, urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pm_config  # noqa: E402  (the pack's settings loader, same directory)

# Instance settings. Read at import WITHOUT failing, so importing this module never needs a config; the
# accessors below (operator(), operator_account_id(), site()) stop with the setting's name when one is missing.
OPERATOR_EMAIL = pm_config.get('PM_OPERATOR_EMAIL')
OPERATOR_TOKEN_FILE = pm_config.get('JIRA_TOKEN_FILE')
OPERATOR_ACCOUNT_ID = pm_config.get('PM_OPERATOR_ACCOUNT_ID')
OPERATOR_MENTION_TEXT = '@' + str(pm_config.get('PM_OPERATOR_NAME', 'operator')).lstrip('@')
OPERATOR_MENTION = '@operator'  # in comment text, becomes a real Jira mention that notifies the operator


def operator():
    """(email, token_file) of the operator account; both are required settings."""
    email = pm_config.get('PM_OPERATOR_EMAIL', required=True)
    token_file = pm_config.path('JIRA_TOKEN_FILE', required=True)
    return email, str(token_file)


def operator_account_id():
    """The operator's Atlassian account id, the target of every @operator mention (required)."""
    return pm_config.get('PM_OPERATOR_ACCOUNT_ID', required=True)


def site():
    """The Jira base URL, e.g. https://<tenant>.atlassian.net (required)."""
    return str(pm_config.get('JIRA_SITE', required=True)).rstrip('/')


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
        email = env.get('JIRA_EMAIL') or pm_config.get('PM_OPERATOR_EMAIL', required=True)
        token_file = env.get('JIRA_TOKEN_FILE') or str(pm_config.path('JIRA_TOKEN_FILE', required=True))
        return email, os.path.expanduser(token_file)
    cfg = pathlib.Path.home() / '.xtrm/identities/atlassian-agent/identity.json'
    if cfg.exists() and is_agent_process():
        d = json.loads(cfg.read_text())
        global _AGENT
        _AGENT = True
        return d['email'], d['tokenFile']
    return operator()


_CREDS = None


def creds():
    """(email, token), resolved on first use so importing this module reads no secret."""
    global _CREDS
    if _CREDS is None:
        email, token_file = identity()
        _CREDS = (email, pathlib.Path(token_file).read_text().strip())
    return _CREDS


BASE = str(pm_config.get('JIRA_SITE') or '').rstrip('/') or None  # None until configured; _raw_call uses site()


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


def add_edit_label(body):
    """Adds `actor=agent` to an issue edit body and keeps the labels already on the ticket. `update.labels add` merges;
    Jira answers HTTP 400 when one field is in both `fields` and `update`, so a caller's `fields.labels` (a replace)
    gets the label inside its own list instead. A malformed `update` is left for Jira to reject."""
    fields = body.get('fields')
    if isinstance(fields, dict) and 'labels' in fields:
        fields['labels'] = with_actor_label(fields['labels'])
        return
    update = body.setdefault('update', {})
    ops = update.setdefault('labels', []) if isinstance(update, dict) else None
    if isinstance(ops, list) and {'add': ACTOR_LABEL} not in ops:
        ops.append({'add': ACTOR_LABEL})


def paragraphs(text):
    return [p.strip() for p in text.split('\n\n') if p.strip()]


def with_header(text):
    """The agent header and a blank line before the text; unchanged for a non-agent, empty or already headed text."""
    header = agent_header()
    if header is None or not paragraphs(text) or text.lstrip().startswith(HEADER_PREFIX):
        return text
    return f'{header}\n\n{text}'


# --- Phase 2 write guards (MMD-3546) -------------------------------------------------------------

STALENESS_MINUTES = 60            # the other-writer window, same value as post-guard.py
BOT_NAMES = ('xtrm-bot',)         # a comment by the bot is this lane's own voice
# TX-07: the statuses that claim the change runs in production, lower case. The board's done status names
# come from the config (production_statuses, else done_statuses plus "Waiting Production").
PRODUCTION_STATUSES = tuple(str(n).lower() for n in (
    pm_config.get_data('PM_PRODUCTION_STATUSES')
    or [*(pm_config.get_data('PM_DONE_STATUSES') or []), 'Waiting Production']))
TRANSITION_IDS_READ = {}          # key -> {id: name} read live from this ticket in this run (TX-02)
WROTE_THIS_RUN = set()            # keys this process already wrote: not "another writer" (OW-01)
_OWN_WRITE = False                # the internal actor=agent label PUT inside a move
_UNVERIFIED = False               # a move Jira accepted but the re-read did not prove: exit 3, never retried (TX-05)
MOVE_REREAD_TRIES = 5             # bounded re-read after a move: Jira can apply a transition after its 204
MOVE_REREAD_SECONDS = 0.4         # 5 x 0.4 s = about 2 s, then the move is reported unverified

BLOCK_MARKER = '_blocks'          # {"blocker": KEY, "blocked": KEY} in a Blocks link body (LK-01)


def _say(level, event, text):
    """The catalogue line: level and event id first, so a reader can find the rule."""
    line = f'{level} [{event}] {text}'
    print(line, file=sys.stderr if level == 'CAREFULLY' else sys.stdout)
    return line


def _refuse(status, event, text):
    return status, _say('REFUSED', event, text)


SECRET_PATTERNS = (
    ('atlassian-api-token', re.compile(r'ATATT[0-9A-Za-z_\-=]{8,}')),
    ('github-token', re.compile(r'gh[pousr]_[0-9A-Za-z]{20,}')),
    ('github-fine-grained-token', re.compile(r'github_pat_[0-9A-Za-z_]{20,}')),
    ('openai-style-key', re.compile(r'\bsk-[A-Za-z0-9]{20,}')),
    ('slack-token', re.compile(r'xox[abprs]-[0-9A-Za-z-]{10,}')),
    ('aws-access-key', re.compile(r'\bAKIA[0-9A-Z]{16}\b')),
    ('private-key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ('jwt', re.compile(r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.')),
    ('credential-in-url', re.compile(r'[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s@]+@', re.I)),
    ('named-credential', re.compile(r'(?i)\b(bearer|token|password|passwd|secret|api[_-]?key)\b\s*[:=]\s*["\']?[A-Za-z0-9_\-.+/]{16,}')),
)


def secret_shape(text):
    """(pattern name, length) of the first credential-shaped value in `text`, else None.

    The VALUE is never returned: printing it once puts it in the transcript for good (SC-03). A body that a
    guard cannot quote is a body whose refusal must describe shape and length only.
    """
    for name, rx in SECRET_PATTERNS:
        m = rx.search(text or '')
        if m:
            return name, len(m.group(0))
    return None


def _jql_summary(summary):
    """A conservative search term for an exact summary: quotes and backslashes removed, first 60 chars."""
    return re.sub(r'[\\"]', ' ', summary).strip()[:60]


def duplicate_create(body):
    """The existing ticket with this exact summary or this substrate label, or None (DP-02).

    A scripted create once produced eight duplicate tickets from a re-import. The search is a candidate
    filter only: the returned row is accepted when its summary equals the new one exactly, or when it
    carries the same `substrate:<ref>` label, which is the durable identity of one Substrate issue.
    """
    fields = (body or {}).get('fields') or {}
    summary = (fields.get('summary') or '').strip()
    labels = [lab for lab in (fields.get('labels') or []) if str(lab).startswith('substrate:')]
    project = ((fields.get('project') or {}).get('key') or '').strip()
    if not summary and not labels:
        return None
    parts = []
    if summary:
        parts.append(f'summary ~ "{_jql_summary(summary)}"')
    if labels:
        parts.append('labels = "%s"' % labels[0])
    jql = ('project = %s AND ' % project if project else '') + '(' + ' OR '.join(parts) + ')'
    st, out = _raw_call('POST', '/rest/api/3/search/jql',
                        {'jql': jql, 'maxResults': 50, 'fields': ['summary', 'labels']})
    if st != 200 or not isinstance(out, dict):
        _say('CAREFULLY', 'DP-02', f'the duplicate check could not run (search HTTP {st}); this create was NOT '
                                   'checked against existing rows — verify the row list by hand')
        return None
    for row in out.get('issues') or []:
        f = row.get('fields') or {}
        if labels and set(labels) & set(f.get('labels') or []):
            return row.get('key')
        if summary and (f.get('summary') or '').strip() == summary:
            return row.get('key')
    return None


def utc(value):
    """Any Jira timestamp -> 'YYYY-MM-DDTHH:MM:SSZ'. Never print a host-local clock as if it were UTC."""
    from datetime import datetime, timezone
    try:
        t = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return str(value)
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _newest_foreign_comment(key):
    """(author, created, text) of the newest comment, or (None, None, '') when unreadable."""
    st, out = _raw_call('GET', f'/rest/api/3/issue/{key}/comment?maxResults=1&orderBy=-created')
    comment = ((out or {}).get('comments') or [{}])[0] if st == 200 else {}
    text = ' '.join(str(n.get('text', '')) for p in (comment.get('body') or {}).get('content', [])
                    for n in p.get('content', []) if n.get('type') == 'text')
    return ((comment.get('author') or {}).get('displayName'), comment.get('created'), text.strip())


def other_writer_refusal(key, verb):
    """(status, text) when another writer changed `key` inside the window, else None (OW-01/OW-03).

    Extended to field edits and transitions in MMD-3546: before this, only comment posts were guarded,
    so a lane could move or edit a row another writer had just answered. Two exemptions, both explicit:
    a row THIS process already wrote is not another writer's, and JIRA_FORCE_WRITE=1 after the change was
    read (the OW-02 text is printed so the bypass leaves a record).
    """
    if _OWN_WRITE or key in WROTE_THIS_RUN:
        return None
    from datetime import datetime, timezone
    st, iss = _raw_call('GET', f'/rest/api/3/issue/{key}?fields=updated')
    if st != 200 or not isinstance(iss, dict):
        _say('CAREFULLY', 'OW-01', f'the other-writer check on {key} could not read the row (HTTP {st}); the write '
                                          'continues UNCHECKED')
        return None
    try:
        age = (datetime.now(timezone.utc)
               - datetime.fromisoformat(str(iss['fields']['updated']).replace('Z', '+00:00'))).total_seconds() / 60
    except (KeyError, TypeError, ValueError):
        _say('CAREFULLY', 'OW-01', f'{key} has no readable updated time; the other-writer check did not run')
        return None
    author, created, text = _newest_foreign_comment(key)
    if age >= STALENESS_MINUTES or (author or '') in BOT_NAMES or not author:
        return None
    if os.environ.get('JIRA_FORCE_WRITE') == '1':
        _say('CAREFULLY', 'OW-02', f'JIRA_FORCE_WRITE=1 skipped the other-writer check on {key}, which changed '
                                   f'{age:.0f} min ago by {author!r}. --force is for a change you have READ, never '
                                   'for an assumption about its age, and the only record that you read it is the '
                                   'text you write quoting it. Rule: post-guard.py:270-277 and project-management '
                                   'SKILL.md:302-307. Do: quote the comment you read, with its id and UTC time, in the '
                                   'body you write.')
        return None
    event = 'OW-03' if verb == 'move' else 'OW-01'
    if verb == 'move':
        text_out = (f'another writer changed {key} within the hour, so this lane does not move it. One row has one '
                    'writer, and two writes inside an hour is the shape that lost a decision. Rule: board-audit '
                    'SKILL.md:334 and 297-344. Do: report the row to the coordinator and wait; a re-read after the '
                    'other writer settles is the next step.')
    else:
        text_out = (f'{key} changed {age:.0f} minutes ago by {author} (comment at {utc(created)}), and the newest '
                    f'comment is: {text[:240]!r}. Nothing was written. A second writer on one row produces two '
                    'answers and the later one overwrites a decision the first one never saw. Rule: '
                    'post-guard.py:263-277, project-management SKILL.md:302-307 and board-audit SKILL.md:334. '
                    'Do: read that comment, decide whether its content changes what you were going to do, and '
                    'either stop or write a change that names it (JIRA_FORCE_WRITE=1 once you have read it).')
    return 409, _say('REFUSED', event, text_out)


def transition_direction(key, body):
    """(status, text) when a transition POST must be refused, else None (TX-02 / TX-04)."""
    if not isinstance(body, dict):
        return _refuse(400, 'TX-02', 'the transition request body is not a JSON object, so its id cannot be checked. '
                                     'Rule: board-audit SKILL.md:44-49. Do: send {"transition": {"id": "<id>"}} '
                                     'with an id read live from the row.')
    fields = body.get('fields') if isinstance(body.get('fields'), dict) else {}
    update = body.get('update') if isinstance(body.get('update'), dict) else {}
    if 'comment' in fields or 'comment' in update or 'comment' in body:
        return _refuse(400, 'TX-04', 'the move carried a comment in the same request. Jira answers 204 for that '
                                     'request and silently drops the comment, so the board shows a move with no '
                                     'reason and the comment id you report does not exist. Rule: board-audit '
                                     'SKILL.md:49. Do: send the move alone, then post the comment through the guarded '
                                     'comment path, then re-read the comment list and report the id you read back.')
    tid = str((body.get('transition') or {}).get('id') or '')
    live = TRANSITION_IDS_READ.get(key) or {}
    if not tid or tid not in live:
        shown = ', '.join(f'{n} (id {i})' for i, n in sorted(live.items())) or 'none read this run'
        return _refuse(400, 'TX-02', f'the transition id {tid or "<missing>"} was taken from the script, not read from '
                                     'the ticket in this run. The same id can mean Blocked in one project and '
                                     'Deferred in another (one id meant Blocked on one board and Deferred on '
                                     'another), so a '
                                     'remembered id moves tickets into the wrong status. Rule: board-audit '
                                     'SKILL.md:44-49 and batch-protocol.md:7-10. Do: run `jira.py transition-by-id '
                                     '<KEY> <id>` (or `jira.py transition <KEY> "<status name>"`), which reads '
                                     'GET /rest/api/3/issue/<KEY>/transitions in the same process, prints each id '
                                     f'beside its name, and moves only an id it just read. Offered live now: {shown}.')
    return None


def link_direction(body):
    """(status, text) when a Blocks link body must be refused, else the body to send (LK-01).

    A guard cannot guess which ticket is the blocker from two keys, so the caller declares it. The
    declaration is checked against inward/outward and then stripped: what Jira receives is exactly
    {"inwardIssue": BLOCKER, "outwardIssue": BLOCKED}, read inward-to-outward.
    """
    if not isinstance(body, dict):
        return _refuse(400, 'LK-01', 'the link body is not a JSON object, so its direction cannot be checked')
    inward = ((body.get('inwardIssue') or {}).get('key') or '').strip()
    outward = ((body.get('outwardIssue') or {}).get('key') or '').strip()
    type_name = str((body.get('type') or {}).get('name') or '').strip()
    if type_name.lower() != 'blocks':
        return {k: v for k, v in body.items() if k != BLOCK_MARKER}
    ref = ('In Jira the link type Blocks is read inward-to-outward, so inwardIssue is the blocker and '
           'outwardIssue is the blocked ticket. Reversed, the board says the wrong work is waiting. Rule: '
           'verification.md:39-46 and waiting-production-audit.md:64-71. Do: declare `_blocks: {"blocker": '
           '<KEY>, "blocked": <KEY>}` (or call `jira.py link <BLOCKER> <BLOCKED>`), which builds '
           '{"inwardIssue": BLOCKER, "outwardIssue": BLOCKED}; the declaration is stripped before the request '
           'and the link is re-read at GET /rest/api/3/issueLink/<id>.')
    declared = body.get(BLOCK_MARKER)
    if not isinstance(declared, dict):
        return _refuse(400, 'LK-01', 'the Blocks link body does not declare which ticket is the blocker, so its '
                                     'direction cannot be checked. ' + ref)
    blocker = str(declared.get('blocker') or '').strip()
    blocked = str(declared.get('blocked') or '').strip()
    if not blocker or not blocked:
        return _refuse(400, 'LK-01', 'the Blocks declaration is incomplete: it names the blocker and the blocked '
                                     'ticket. ' + ref)
    if (inward, outward) != (blocker, blocked):
        return _refuse(400, 'LK-01', f'the Blocks link puts {outward or "<none>"} as the blocked ticket and '
                                     f'{inward or "<none>"} as the blocker, but the declaration says {blocker} '
                                     f'blocks {blocked}. ' + ref)
    return {k: v for k, v in body.items() if k != BLOCK_MARKER}


def _verify_link(status, out):
    """Re-read a created link at its own endpoint and report it (LK-02 / LK-03)."""
    if status >= 300 or not isinstance(out, dict) or not out.get('id'):
        return status, out
    lid = out['id']
    st, link = _raw_call('GET', f'/rest/api/3/issueLink/{lid}')
    inward = ((link or {}).get('inwardIssue') or {}).get('key') if st == 200 else None
    outward = ((link or {}).get('outwardIssue') or {}).get('key') if st == 200 else None
    kind = ((link or {}).get('type') or {}).get('name') if st == 200 else None
    if st != 200 or not inward or not outward:
        return _refuse(409, 'LK-02', f'link {lid} was created but GET /rest/api/3/issueLink/{lid} could not be read '
                                     f'(HTTP {st}), so the direction is unproven and the link is not reported as '
                                     'done. Rule: verification.md:39-46. Do: read the endpoint, print '
                                     'inwardIssue.key and outwardIssue.key with the type name, and only then '
                                     'report the link.')
    _say('DONE', 'LK-03', f'link {lid} created: {inward} blocks {outward}. Checked: '
                            f'GET /rest/api/3/issueLink/{lid} shows type {kind} with inwardIssue {inward} and '
                            f'outwardIssue {outward}. Rule: verification.md:39-46.'
                            if str(kind).lower() == 'blocks' else
                            f'link {lid} created: type {kind}, inwardIssue {inward}, outwardIssue {outward}. '
                            f'Checked: GET /rest/api/3/issueLink/{lid} reads both ends back. Rule: '
                            'verification.md:39-46.')
    return status, out


def call(method, path, body=None):
    """The one HTTP path. Reads pass straight through; every write runs the guards above."""
    route = path.split('?')[0].rstrip('/')
    key_match = re.fullmatch(r'/rest/api/3/issue/([^/]+)', route)
    if method == 'GET' and re.fullmatch(r'/rest/api/3/issue/[^/]+/transitions', route):
        st, out = _raw_call(method, path, body)
        if st == 200 and isinstance(out, dict):
            TRANSITION_IDS_READ[route.split('/')[5]] = {str(t['id']): t['to']['name']
                                                        for t in out.get('transitions') or []}
        return st, out
    if method in ('POST', 'PUT') and body is not None:
        shape = secret_shape(json.dumps(body))
        if shape:
            return _refuse(400, 'SC-03', f'the body to write to {route} contains something shaped like a credential '
                                       f'({shape[0]}, {shape[1]} characters, value not printed). A Jira field or '
                                       'comment is visible to every reader of the board and cannot be un-shared. '
                                       'Rule: fleet.md:97-103 and jira.py:1-16. Do: remove the value, describe it '
                                       'instead, and if the value was already posted, report it to the '
                                       'coordinator as an incident rather than editing quietly.')
    if method in ('POST', 'PUT') and re.fullmatch(r'/rest/api/3/issue/[^/]+/comment(/[^/]+)?', route):
        st, out = _raw_call(method, path, body)
        if st < 300:
            WROTE_THIS_RUN.add(route.split('/')[5])  # this process wrote it: not "another writer" (OW-01/OW-03)
        return st, out
    if method == 'POST' and route.endswith('/transitions'):
        key = route.split('/')[5]
        bad = transition_direction(key, body)
        if bad:
            return bad
        bad = other_writer_refusal(key, 'move')
        if bad:
            return bad
        st, out = _raw_call(method, path, body)
        if st < 300:
            WROTE_THIS_RUN.add(key)
        return st, out
    if method == 'POST' and route == '/rest/api/3/issueLink':
        send = link_direction(body)
        if isinstance(send, tuple):
            return send
        st, out = _raw_call(method, path, send)
        return _verify_link(st, out)
    if method == 'POST' and route == '/rest/api/3/issue':
        dup = duplicate_create(body)
        if dup:
            return _refuse(400, 'DP-02', f'a ticket with this summary already exists as {dup}. A scripted create once '
                                       'produced eight duplicate tickets from a re-import, and a duplicate splits '
                                       'the history, the sprint view and the audit. Rule: jira.md:173-188 and '
                                       'board-audit SKILL.md:368-370. Do: search label substrate:<ref> and the '
                                       'exact summary first, compare the summary as an exact string after the read, '
                                       'then either reuse the existing ticket or change the title.')
        st, out = _raw_call(method, path, body)
        if st < 300 and isinstance(out, dict) and out.get('key'):
            WROTE_THIS_RUN.add(out['key'])
        return st, out
    if method == 'PUT' and (key_match or re.fullmatch(r'/rest/api/3/issue/[^/]+/assignee', route)):
        key = key_match.group(1) if key_match else route.split('/')[5]
        bad = other_writer_refusal(key, 'edit')
        if bad:
            return bad
        st, out = _raw_call(method, path, body)
        if st < 300:
            WROTE_THIS_RUN.add(key)
        return st, out
    return _raw_call(method, path, body)


def _raw_call(method, path, body=None):
    """The unguarded request. Only call() and the guards above use it; nothing else may."""
    route = path.split('?')[0].rstrip('/')
    # GUARD: comment POSTs must go through post-guard.py. Direct calls are refused.
    if method == 'POST' and route.endswith('/comment'):
        if os.environ.get('POST_GUARD_ACTIVE') != '1':
            # The guard ships with this skill, so every project can reach it: the earlier text named a
            # path that existed only in one lane's cache and refused feedor, econ and infra coordinators
            # with nothing to run (coordinator ruling 2026-11-02).
            raise RuntimeError(
                "REFUSED: direct comment POST. Comments go through "
                "~/.xtrm/skills/optional/project-management/project-management/scripts/post-guard.py "
                "<KEY> <text-file> --run <WORD> [--mention-first] (the only write path). "
                "Set POST_GUARD_ACTIVE=1 only inside that tool."
            )
    # A ticket the agent account creates is assigned to it unless the caller names an assignee.
    if method == 'POST' and route == '/rest/api/3/issue' and isinstance(body, dict):
        creds()
        fields = body.setdefault('fields', {})
        if _AGENT and not fields.get('assignee'):
            fields['assignee'] = {'accountId': my_account_id()}
        if is_agent_process():
            fields['labels'] = with_actor_label(fields.get('labels'))
    elif method == 'PUT' and re.fullmatch(r'/rest/api/3/issue/[^/]+', route) and isinstance(body, dict) and is_agent_process():
        add_edit_label(body)  # a field edit; not /assignee, /transitions or other sub-resources
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(site() + path, data=data, method=method)
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


def _deploy_evidence(evidence):
    """The running-image/merge evidence text for a production move, from the argument or env (TX-07)."""
    text = evidence if evidence is not None else os.environ.get('JIRA_DEPLOY_EVIDENCE', '')
    return (text or '').strip()


def _has_sha(text):
    return bool(re.search(r'\b[0-9a-f]{7,40}\b', text or ''))


def _move(key, tid, name, evidence=None):
    """Label, move, re-read, and report what the re-read proved (TX-05 / TX-06 / TX-07)."""
    global _OWN_WRITE, _UNVERIFIED
    bad = other_writer_refusal(key, 'move')
    if bad:
        return bad
    if name.lower() in PRODUCTION_STATUSES:
        proof = _deploy_evidence(evidence)
        if not _has_sha(proof):
            _say('CAREFULLY', 'TX-07', f'{key} is moving to {name} with no proof of what runs in production. Being '
                                       'merged on master, or being promoted to stable, says nothing about the image '
                                       'that serves traffic; the running image SHA is the only authority, and a '
                                       'ticket may be called done while its change is not live. Rule: '
                                       'waiting-production-audit.md:8-11 and 32-41, coordinator-operations.md:50-55. '
                                       'Do: read the running image SHA and the merge commit, paste both values into '
                                       'the comment, and pass them as JIRA_DEPLOY_EVIDENCE (or the evidence '
                                       'argument) so this check sees them.')
    if is_agent_process():  # label first: the ticket already carries it when the transition fires
        _OWN_WRITE = True
        try:
            label_status, _ = call('PUT', f'/rest/api/3/issue/{key}', {'update': {'labels': [{'add': ACTOR_LABEL}]}})
        finally:
            _OWN_WRITE = False
        if label_status >= 300:
            _say('CAREFULLY', 'TX-06', f'{key} is moving to {name}, but the label {ACTOR_LABEL} could not be added '
                                       f'(HTTP {label_status}). The board now cannot tell an agent write from a '
                                       "person's write, which is the evidence the next auditor needs. The move "
                                       'continues and is not rolled back. Rule: jira.md:13-15 and board-audit '
                                       'SKILL.md:108-119. Do: fix the label with a separate edit that keeps every '
                                       'existing label, then re-read the label list; if it still fails, report the '
                                       'row as unlabelled rather than silent.')
    st, out = call('POST', f'/rest/api/3/issue/{key}/transitions', {'transition': {'id': tid}})
    if st >= 300:
        return st, out
    # A move is only a move once the row says so: re-read the status and the label and report both. Jira can apply
    # a transition a moment after its 204, so the re-read is bounded and repeated before the move is called
    # unverified (MMD-3566 F3: one late-applied move was reported as failed 1.5 s before Jira finished it).
    for attempt in range(MOVE_REREAD_TRIES + 1):
        rst, row = _raw_call('GET', f'/rest/api/3/issue/{key}?fields=status,labels')
        fields = ((row or {}).get('fields') or {}) if rst == 200 else {}
        seen = ((fields.get('status') or {}).get('name') or 'UNREAD') if rst == 200 else 'UNREAD'
        labelled = ACTOR_LABEL in (fields.get('labels') or [])
        if seen.lower() == name.lower() or attempt == MOVE_REREAD_TRIES:
            break
        time.sleep(MOVE_REREAD_SECONDS)
    if seen.lower() == name.lower():
        _say('DONE', 'TX-05', f'{key} moved to {seen} (transition id {tid}). Checked after the write: the row\'s '
                               f'status reads {seen}, the label {ACTOR_LABEL} is '
                               f'{"present" if labelled else "MISSING"}, and the row was read back with '
                               f'GET /rest/api/3/issue/{key}. The move is recorded by id in this output so a later '
                               'reader can repeat it. Rule: verification.md:5-8 and jira.md:13-15.')
        return st, out
    _UNVERIFIED = True
    return _refuse(409, 'TX-05', f'{key} was sent transition id {tid} for {name!r} and Jira answered HTTP {st}, but '
                                  f'{MOVE_REREAD_TRIES + 1} re-reads of GET /rest/api/3/issue/{key} over about '
                                  f'{MOVE_REREAD_TRIES * MOVE_REREAD_SECONDS:.1f} s show status {seen} (HTTP {rst}). '
                                  'The move is UNVERIFIED, and this is not a failed move: it may still apply, so '
                                  'this run exits 3 and the move must not be retried. Rule: verification.md:5-8 and '
                                  'jira.md:13-15. Do: read the row directly and report what it says; if it still does '
                                  'not show the new status, report the row to the coordinator instead of moving it '
                                  'again.')


def transition(key, status, evidence=None):
    """Move by target status name, resolved against the live transition list in this run (TX-01, TX-05)."""
    st, out = call('GET', f'/rest/api/3/issue/{key}/transitions')
    if st != 200:
        return st, out
    live = TRANSITION_IDS_READ.get(key) or {}
    ids = [i for i, n in live.items() if n.lower() == status.lower()]
    if not ids:
        shown = ', '.join(f'{n} (id {i})' for i, n in sorted(live.items())) or 'none'
        return _refuse(400, 'TX-01', f'the ticket {key} has no move to {status!r}. Jira offers these moves right now: '
                                    f'{shown}. A move is chosen from the live list, never from a name remembered '
                                    "from a skill file, because a project's transition ids and names change "
                                    'between projects. Rule: jira.md:111-128 and board-audit SKILL.md:44-49. Do: '
                                    'pick the id from the list printed above, then run the move again.')
    return _move(key, ids[0], live[ids[0]], evidence)


def transition_by_id(key, tid, evidence=None):
    """Move by id, but only an id this row offers now: a remembered id is refused (TX-02)."""
    st, out = call('GET', f'/rest/api/3/issue/{key}/transitions')
    if st != 200:
        return st, out
    live = TRANSITION_IDS_READ.get(key) or {}
    tid = str(tid)
    if tid not in live:
        shown = ', '.join(f'{n} (id {i})' for i, n in sorted(live.items())) or 'none'
        return _refuse(400, 'TX-02', f'the transition id {tid} is not offered on {key} right now, so it was taken from '
                                    'a script rather than read from the ticket in this run. The same id can mean '
                                    'Blocked in one project and Deferred in another (one id meant Blocked on one '
                                    'board and Deferred on another), so a remembered id moves tickets into the '
                                    'wrong status. '
                                    'Rule: board-audit SKILL.md:44-49 and batch-protocol.md:7-10. Do: run `jira.py '
                                    f'transition-by-id {key} <id>` with an id from the live list — {shown} — or '
                                    f'`jira.py transition {key} "<status name>"` to let it resolve the live id.')
    print(f'move {live[tid]!r} (id {tid}) read live from {key} in this run')
    return _move(key, tid, live[tid], evidence)


def create_link(blocker, blocked, type_name='Blocks'):
    """Blocks link with the direction named once, checked, and re-read (LK-01 / LK-02 / LK-03)."""
    body = {'type': {'name': type_name},
            'inwardIssue': {'key': blocker},
            'outwardIssue': {'key': blocked}}
    if type_name.lower() == 'blocks':
        body[BLOCK_MARKER] = {'blocker': blocker, 'blocked': blocked}
    return call('POST', '/rest/api/3/issueLink', body)


def adf(text):
    content = []
    for p in paragraphs(text):
        nodes = []
        for i, line in enumerate(p.split('\n')):
            if i:
                nodes.append({'type': 'hardBreak'})
            for j, part in enumerate(line.split(OPERATOR_MENTION)):
                if j:
                    nodes.append({'type': 'mention', 'attrs': {'id': operator_account_id(), 'text': OPERATOR_MENTION_TEXT}})
                if part:
                    nodes.append({'type': 'text', 'text': part})
        content.append({'type': 'paragraph', 'content': nodes})
    return {'type': 'doc', 'version': 1, 'content': content}


def post_comment(key, text, parent_id=None):
    """Posts a comment. Returns (status, response, posted_text); posted_text is exactly the text of the ADF body
    sent (agent header included, paragraphs normalised the way adf() builds them), for a read-back compare.

    parent_id posts it as a threaded reply: Jira stores the comment under that parent comment of the same
    ticket. The caller validates the target before this call; Jira rejects a parent from another ticket."""
    posted = '\n\n'.join(paragraphs(with_header(text)))
    payload = {'body': adf(posted)}
    if parent_id is not None:
        payload['parentId'] = int(parent_id)
    st, out = call('POST', f'/rest/api/3/issue/{key}/comment', payload)
    return st, out, posted


if __name__ == '__main__':
    m, p = sys.argv[1], sys.argv[2]
    if m == 'transition':
        st, out = transition(p, sys.argv[3])
    elif m == 'transition-by-id':
        st, out = transition_by_id(p, sys.argv[3])
    elif m == 'link':
        st, out = create_link(p, sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else 'Blocks')
    elif m == 'comment':
        st, out, posted = post_comment(p, pathlib.Path(sys.argv[3]).read_text())
    else:
        body = json.loads(pathlib.Path(sys.argv[3]).read_text()) if len(sys.argv) > 3 else None
        st, out = call(m, p, body)
    print('HTTP', st)
    print(json.dumps(out, indent=1)[:6000] if not isinstance(out, str) else out)
    if st >= 300 and m != 'GET':  # a refused WRITE is an error; a read keeps the exit status callers expect
        sys.exit(3 if _UNVERIFIED else 1)  # 3: Jira took the move but the re-read did not prove it — never retry
    if m == 'comment' and st < 300:
        print('POSTED_TEXT', json.dumps(posted, ensure_ascii=False))
