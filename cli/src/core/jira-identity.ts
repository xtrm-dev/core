// CORE-2526 / XT-190: agent processes act in Jira as a dedicated account, never as
// the operator. Machine state, all under $HOME and none of it secret:
//   ~/.xtrm/identities/atlassian-agent/identity.json   site, email, token file, acli HOME
//   ~/.xtrm/identities/atlassian-agent/home            isolated HOME holding the bot's acli profile
//   ~/.local/bin/acli                                  shim routing agent processes to that HOME
// The token file is supplied by the operator and is only ever read, never copied or printed.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SHIM_MARKER = '# xtrm-acli-agent-shim v1';
export const DEFAULT_SITE = 'mercuryintel.atlassian.net';

export interface JiraIdentity {
    site: string;
    email: string;
    tokenFile: string;
    home: string;
}

export interface JiraIdentityPaths {
    identityDir: string;
    identityFile: string;
    agentHome: string;
    shimPath: string;
    defaultTokenFile: string;
}

export interface RunResult { status: number | null; stdout: string; stderr: string }
export type RunFn = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string }) => RunResult;

export interface JiraIdentityDeps {
    home?: string;
    pathEnv?: string;
    run?: RunFn;
}

export interface Check { name: string; ok: boolean; detail: string }

export function jiraIdentityPaths(home: string = os.homedir()): JiraIdentityPaths {
    const identityDir = path.join(home, '.xtrm', 'identities', 'atlassian-agent');
    return {
        identityDir,
        identityFile: path.join(identityDir, 'identity.json'),
        agentHome: path.join(identityDir, 'home'),
        shimPath: path.join(home, '.local', 'bin', 'acli'),
        defaultTokenFile: path.join(home, '.secrets', 'atlassian-agent-token.txt'),
    };
}

/**
 * Python run by the shim before an agent's write (CORE-2537, CORE-2541): create, create-bulk, edit,
 * transition, comment create and comment update.
 * argv: <work dir> jira workitem <verb> ...; it writes the final acli argument list (NUL separated) to
 * <work>/argv and, for a transition, a label step to <work>/pre. Attribution never blocks a write: any
 * failure here makes the shim run the original command. The header and run-id rules mirror
 * scripts/jira.py in programme-coordination; keep the two in step (the tests compare them).
 * acli facts this relies on (checked live, acli 1.3.19): edit --labels and edit --from-json labelsToAdd ADD to the
 * existing labels; create-bulk reads the item key "label" (a "labels" key is silently ignored) and its assignee
 * needs an account id (@me and an email are refused), taken from the bot's acli profile.
 */
const SHIM_REWRITE_PY = String.raw`import csv, hashlib, io, json, os, pathlib, re, sys

work = pathlib.Path(sys.argv[1])
args = sys.argv[2:]
LABEL = 'actor=agent'
PREFIX = '[agent:'


def agent_ancestor(start=None):
    pid = os.getppid() if start is None else int(start)
    for _ in range(16):
        if pid <= 1:
            return None
        try:
            comm = pathlib.Path(f'/proc/{pid}/comm').read_text().strip()
            if comm in ('claude', 'pi', 'codex'):
                return pid, comm
            pid = next(int(l.split()[1]) for l in pathlib.Path(f'/proc/{pid}/status').read_text().splitlines() if l.startswith('PPid:'))
        except (OSError, StopIteration, ValueError):
            return None
    return None


def token(value):
    return re.sub(r'[^\w.:@-]', '-', value.strip())


def starttime(pid):
    try:
        return pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (OSError, IndexError):
        return ''


def run_id(found):
    rid = os.environ.get('SUBSTRATE_RUN_ID', '').strip()
    if rid:
        return token(rid)
    root = found[0] if found else os.getsid(0)
    try:
        boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    except OSError:
        boot = ''
    return hashlib.sha1(f'{boot}:{root}:{starttime(root)}'.encode()).hexdigest()[:6]


def worktree_slug():
    try:
        here = pathlib.Path.cwd()
    except OSError:
        return 'unknown'
    for d in (here, *here.parents):
        if (d / '.git').exists():
            return d.name or 'unknown'
    return here.name or 'unknown'


def agent_header():
    found = agent_ancestor(os.environ.get('XTRM_JIRA_WALK_FROM'))
    holder = os.environ.get('SUBSTRATE_HOLDER', '').strip()
    if holder:
        return f'{PREFIX}{token(holder)} | run:{run_id(found)}]'
    runtime = found[1] if found else 'agent'
    return f'{PREFIX}{runtime}-{token(worktree_slug())} | run:{run_id(found)} | fallback]'


def with_label(labels):
    labels = [] if labels is None else labels
    return labels if not isinstance(labels, list) or LABEL in labels else labels + [LABEL]


def hits(flag_args, long, short=None):
    found = []
    for i, a in enumerate(flag_args):
        if a == long or a == short:
            if i + 1 < len(flag_args):
                found.append((i, 'sep'))
        elif a.startswith(long + '=') or (short and a.startswith(short + '=')):
            found.append((i, 'inline'))
    return found


def value(flag_args, hit):
    i, kind = hit
    return flag_args[i + 1] if kind == 'sep' else flag_args[i].split('=', 1)[1]


def set_value(flag_args, hit, new):
    i, kind = hit
    if kind == 'sep':
        flag_args[i + 1] = new
    else:
        flag_args[i] = flag_args[i].split('=', 1)[0] + '=' + new


def first_text(node):
    if node.get('type') == 'text':
        return node.get('text', '')
    for child in node.get('content') or []:
        found = first_text(child)
        if found is not None:
            return found
    return None


def with_header(text):
    header = agent_header()
    stripped = text.strip()
    if stripped.startswith('{'):
        try:
            doc = json.loads(stripped)
        except ValueError:
            doc = None
        if isinstance(doc, dict) and doc.get('type') == 'doc':
            lead = first_text(doc)
            if not doc.get('content') or (lead or '').lstrip().startswith(PREFIX):
                return text
            doc['content'].insert(0, {'type': 'paragraph', 'content': [{'type': 'text', 'text': header}]})
            return json.dumps(doc)
    if not stripped or text.lstrip().startswith(PREFIX):
        return text
    return f'{header}\n\n{text}'


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8', newline='') as f:
        f.write(text)


def read_json(file):
    return json.loads(pathlib.Path(file).read_text(encoding='utf-8'))


def label_values(flag_args, long, short=None):
    return [l.strip() for h in hits(flag_args, long, short) for l in value(flag_args, h).split(',')]


def bot_account_id():
    """create-bulk accepts no @me: the assignee is the bot's account id. The work dir sits in the bot's HOME.
    SIMPLIFIED: first account_id in that dedicated profile. upgrade when the bot HOME holds several profiles."""
    try:
        text = (work.parent / '.config' / 'acli' / 'jira_config.yaml').read_text(encoding='utf-8')
    except OSError:
        return None
    found = re.search(r'^\s*account_id:\s*(\S+)', text, re.M)
    return found.group(1).strip('\'"') if found else None


def rewrite_create(a):
    if any(x in ('-h', '--help', '--generate-json') for x in a):
        return a
    assignee_named = bool(hits(a, '--assignee', '-a'))
    from_json = hits(a, '--from-json')
    if from_json:
        data = read_json(value(a, from_json[-1]))
        if isinstance(data, dict):
            if not data.get('assignee') and not assignee_named:
                data['assignee'] = '@me'
            data['labels'] = with_label(data.get('labels'))
            copy = work / 'create.json'
            write_private(copy, json.dumps(data))
            set_value(a, from_json[-1], str(copy))
        return a
    if not assignee_named:
        a += ['--assignee', '@me']
    if LABEL not in label_values(a, '--label', '-l'):
        a += ['--label', LABEL]
    return a


def rewrite_edit(a):
    """Adds actor=agent without replacing labels (acli adds). A caller who removes the label keeps that choice."""
    if any(x in ('-h', '--help', '--generate-json') for x in a):
        return a
    from_json = hits(a, '--from-json')
    if from_json:
        data = read_json(value(a, from_json[-1]))
        if isinstance(data, dict) and LABEL not in (data.get('labelsToRemove') or []):
            data['labelsToAdd'] = with_label(data.get('labelsToAdd'))
            copy = work / 'edit.json'
            write_private(copy, json.dumps(data))
            set_value(a, from_json[-1], str(copy))
        return a
    if LABEL in label_values(a, '--labels', '-l') + label_values(a, '--remove-labels'):
        return a
    given = hits(a, '--labels', '-l')
    if given and value(a, given[-1]).strip():
        set_value(a, given[-1], value(a, given[-1]) + ',' + LABEL)  # a string flag: the last one wins
    elif given:
        set_value(a, given[-1], LABEL)
    else:
        a += ['--labels', LABEL]
    return a


def rewrite_csv(rows, account):
    """create-bulk CSV: the label column holds comma separated labels, the assignee column an account id.
    Columns are added when absent; a cell the caller filled is kept. None = layout not understood, pass through."""
    header = [h.strip() for h in rows[0]] if rows else []
    if 'summary' not in header:
        return None
    for name in ['label'] + (['assignee'] if account else []):
        if name not in header:
            header.append(name)
    out = [header]
    for row in rows[1:]:
        if not any(cell.strip() for cell in row):
            out.append(row)
            continue
        row = row + [''] * (len(header) - len(row))
        i = header.index('label')
        labels = [l.strip() for l in row[i].split(',') if l.strip()]
        row[i] = ','.join(labels if LABEL in labels else labels + [LABEL])
        if account and not row[header.index('assignee')].strip():
            row[header.index('assignee')] = account
        out.append(row)
    return out


def rewrite_bulk(a):
    if any(x in ('-h', '--help', '--generate-json') for x in a):
        return a
    account = bot_account_id()
    for h in hits(a, '--from-json'):
        data = read_json(value(a, h))
        items = data.get('issues') if isinstance(data, dict) else data
        if not isinstance(items, list):
            continue
        for item in (i for i in items if isinstance(i, dict)):
            if account and not item.get('assignee'):
                item['assignee'] = account
            item['label'] = with_label(item.get('label'))
        copy = work / f'bulk-{h[0]}.json'
        write_private(copy, json.dumps(data))
        set_value(a, h, str(copy))
    for h in hits(a, '--from-csv'):
        with pathlib.Path(value(a, h)).open(encoding='utf-8-sig', newline='') as f:
            rows = rewrite_csv(list(csv.reader(f)), account)
        if rows is None:
            continue
        buf = io.StringIO()
        csv.writer(buf, lineterminator='\n').writerows(rows)
        copy = work / f'bulk-{h[0]}.csv'
        write_private(copy, buf.getvalue())
        set_value(a, h, str(copy))
    return a


def rewrite_comment(a):
    """comment create and comment update: the header goes on --body, --body-file and (update) --body-adf."""
    if a[3] not in ('create', 'update') or any(x in ('-h', '--help') for x in a):
        return a
    for h in hits(a, '--body', '-b'):
        set_value(a, h, with_header(value(a, h)))
    for long, short, ext in (('--body-file', '-F', 'txt'), ('--body-adf', None, 'json')):
        for h in hits(a, long, short):
            copy = work / f'body-{h[0]}.{ext}'
            write_private(copy, with_header(pathlib.Path(value(a, h)).read_text(encoding='utf-8')))
            set_value(a, h, str(copy))
    return a


def label_step(a):
    if any(x in ('-h', '--help') for x in a):
        return []
    selectors = []
    for long, short in (('--key', '-k'), ('--jql', None), ('--filter', None)):
        for i, kind in hits(a, long, short):
            selectors += a[i:i + 2] if kind == 'sep' else [a[i]]
    return ['jira', 'workitem', 'edit', *selectors, '--labels', LABEL, '--yes'] if selectors else []


def write_args(name, items):
    if items:
        (work / name).write_bytes(b''.join(os.fsencode(x) + b'\0' for x in items))


verb = args[2] if len(args) > 2 else ''
final, pre = list(args), []
if verb == 'create':
    final = rewrite_create(final)
elif verb == 'create-bulk':
    final = rewrite_bulk(final)
elif verb == 'edit':
    final = rewrite_edit(final)
elif verb == 'comment':
    final = rewrite_comment(final)
elif verb == 'transition':
    pre = label_step(final)
write_args('argv', final)
write_args('pre', pre)
`;

/**
 * The shim. "Agent" = SUBSTRATE_HOLDER is set OR a claude/pi/codex process is an
 * ancestor: a session resumed without the env var is still an agent.
 * XTRM_JIRA_AS=operator forces the operator profile. XTRM_JIRA_WALK_FROM is a test hook.
 * jira.py implements the same rule; keep the two in step.
 * Agent writes carry attribution (CORE-2537, CORE-2541): an `[agent:<holder> | run:<id>]` comment header
 * (comment create and update), the label actor=agent on create, create-bulk, edit and transition, and a default
 * assignee on create and create-bulk. Interactive --editor is not rewritten. See SHIM_REWRITE_PY.
 */
export function shimSource(realAcli: string): string {
    return `#!/usr/bin/env bash
${SHIM_MARKER}
# Agent processes run acli as the xtrm-bot profile in a dedicated HOME, so the operator's own
# acli profile is never switched. Installed by: xt jira setup. Rollback: rm this file.
real="\${XTRM_ACLI_REAL:-${realAcli}}"
in_agent_tree() {
  local p=\${XTRM_JIRA_WALK_FROM:-$$} i comm
  for i in {1..16}; do
    p=$(awk '/^PPid:/{print $2}' "/proc/$p/status" 2>/dev/null) || return 1
    [[ -n $p && $p -gt 1 ]] || return 1
    read -r comm < "/proc/$p/comm" 2>/dev/null || return 1
    case $comm in claude|pi|codex) return 0 ;; esac
  done
  return 1
}
if [[ "\${XTRM_JIRA_AS:-}" != operator ]] && { [[ -n "\${SUBSTRATE_HOLDER:-}" ]] || in_agent_tree; }; then
  h="\${XTRM_JIRA_AGENT_HOME:-$HOME/.xtrm/identities/atlassian-agent/home}"
  if [[ ! -f "$h/.config/acli/jira_config.yaml" ]]; then
    echo "acli shim: agent profile missing at $h (run: xt jira setup, or set XTRM_JIRA_AS=operator)" >&2
    exit 78
  fi
  args=("$@"); pre=(); work=""
  if [[ "\${1:-}" == jira && "\${2:-}" == workitem ]]; then
    case "\${3:-}:\${4:-}" in
      create:*|create-bulk:*|edit:*|transition:*|comment:create|comment:update)
        work=$(mktemp -d "$h/.rewrite.XXXXXX") || work=""
        if [[ -n $work ]] && python3 -I - "$work" "$@" <<'PY'
${SHIM_REWRITE_PY}
PY
        then
          [[ -f $work/argv ]] && mapfile -d '' -t args < "$work/argv"
          [[ -f $work/pre ]] && mapfile -d '' -t pre < "$work/pre"
        else
          echo "acli shim: could not add the agent header, label or assignee; running the command unchanged" >&2
        fi
        ;;
    esac
  fi
  if [[ \${#pre[@]} -gt 0 ]]; then
    HOME="$h" "$real" "\${pre[@]}" >/dev/null </dev/null || echo "acli shim: label step failed; continuing with the command" >&2
  fi
  if [[ -n $work ]]; then
    HOME="$h" "$real" "\${args[@]}"; code=$?
    rm -rf "$work"; exit $code
  fi
  HOME="$h" exec "$real" "\${args[@]}"
fi
exec "$real" "$@"
`;
}

const defaultRun: RunFn = (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { env: opts.env, input: opts.input, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function isOurShim(file: string): boolean {
    try {
        return fs.readFileSync(file, 'utf8').split('\n', 3).includes(SHIM_MARKER);
    } catch {
        return false;
    }
}

/**
 * Null when the installed shim is byte for byte what this xt version writes for the real acli path the
 * shim embeds; otherwise the reason. The shim is only rewritten by `xt jira setup`, so an older one goes stale.
 */
function shimCurrentProblem(shimPath: string): string | null {
    if (!isOurShim(shimPath)) return `no xtrm shim to compare: ${shimPath}`;
    const installed = fs.readFileSync(shimPath, 'utf8');
    const embedded = /^real="\$\{XTRM_ACLI_REAL:-(.*)\}"$/m.exec(installed)?.[1];
    return embedded !== undefined && installed === shimSource(embedded) ? null : 'stale shim: run xt jira setup';
}

/** First `acli` on PATH that is an executable file and not our shim. */
export function resolveRealAcli(pathEnv: string = process.env.PATH ?? ''): string | null {
    for (const dir of pathEnv.split(':').filter(Boolean)) {
        const candidate = path.join(dir, 'acli');
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile() && !isOurShim(candidate)) return candidate;
        } catch { /* not here */ }
    }
    return null;
}

export function readIdentity(paths: JiraIdentityPaths): JiraIdentity | null {
    try {
        const raw = fs.readJsonSync(paths.identityFile) as Partial<JiraIdentity>;
        if (raw.site && raw.email && raw.tokenFile && raw.home) return raw as JiraIdentity;
    } catch { /* absent or invalid */ }
    return null;
}

function tokenFileProblem(file: string): string | null {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return `token file not found: ${file}`; }
    if (!st.isFile() || st.size === 0) return `token file is empty or not a file: ${file}`;
    if (st.mode & 0o077) return `token file must be mode 600: ${file}`;
    return null;
}

function statusShowsEmail(run: RunFn, real: string, home: string, email: string): boolean {
    const r = run(real, ['jira', 'auth', 'status'], { env: { ...process.env, HOME: home } });
    return r.status === 0 && r.stdout.includes(email);
}

export interface SetupOptions { email?: string; site?: string; tokenFile?: string }

/**
 * Idempotent. Order matters: the shim exits 78 for agents when the profile is missing, so
 * it is installed last, after the bot login has been verified. Throws with a plain message.
 */
export function setupJiraIdentity(opts: SetupOptions, deps: JiraIdentityDeps = {}): JiraIdentity {
    const paths = jiraIdentityPaths(deps.home);
    const run = deps.run ?? defaultRun;
    const existing = readIdentity(paths);
    const email = opts.email ?? existing?.email;
    if (!email) throw new Error('--email is required the first time (the agent account email)');
    const identity: JiraIdentity = {
        site: opts.site ?? existing?.site ?? DEFAULT_SITE,
        email,
        tokenFile: opts.tokenFile ?? existing?.tokenFile ?? paths.defaultTokenFile,
        home: paths.agentHome,
    };

    const problem = tokenFileProblem(identity.tokenFile);
    if (problem) throw new Error(problem);
    const real = resolveRealAcli(deps.pathEnv);
    if (!real) throw new Error('acli not found on PATH');
    if (fs.existsSync(paths.shimPath) && !isOurShim(paths.shimPath)) {
        throw new Error(`${paths.shimPath} exists and is not the xtrm shim; move it aside first`);
    }

    fs.ensureDirSync(paths.identityDir, 0o700);
    fs.ensureDirSync(paths.agentHome, 0o700);
    fs.chmodSync(paths.identityDir, 0o700);
    fs.chmodSync(paths.agentHome, 0o700);
    fs.writeJsonSync(paths.identityFile, identity, { spaces: 2, mode: 0o600 });
    fs.chmodSync(paths.identityFile, 0o600);

    const token = fs.readFileSync(identity.tokenFile, 'utf8').trim();
    const login = run(real, ['jira', 'auth', 'login', '--site', identity.site, '--email', identity.email, '--token'], {
        env: { ...process.env, HOME: paths.agentHome },
        input: token,
    });
    if (login.status !== 0) throw new Error(`acli login failed (exit ${login.status}); the token or account is not accepted`);
    if (!statusShowsEmail(run, real, paths.agentHome, identity.email)) {
        throw new Error('acli login reported success but the bot profile does not show the expected account');
    }

    fs.ensureDirSync(path.dirname(paths.shimPath));
    fs.writeFileSync(paths.shimPath, shimSource(real), { mode: 0o755 });
    fs.chmodSync(paths.shimPath, 0o755);
    return identity;
}

/** Read-only. ok=false anywhere means agents would not run as the bot. */
export function doctorJiraIdentity(deps: JiraIdentityDeps = {}): Check[] {
    const paths = jiraIdentityPaths(deps.home);
    const run = deps.run ?? defaultRun;
    const pathEnv = deps.pathEnv ?? process.env.PATH ?? '';
    const checks: Check[] = [];
    const add = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };

    const identity = readIdentity(paths);
    add('identity.json', !!identity, identity ? `${identity.email} @ ${identity.site}` : `missing or invalid: ${paths.identityFile}`);
    if (identity) {
        const problem = tokenFileProblem(identity.tokenFile);
        add('token file', !problem, problem ?? `${identity.tokenFile} (mode 600)`);
    }
    const profile = path.join(paths.agentHome, '.config', 'acli', 'jira_config.yaml');
    add('bot acli profile', fs.existsSync(profile), fs.existsSync(profile) ? profile : `missing: ${profile}`);
    const real = resolveRealAcli(pathEnv);
    add('real acli', !!real, real ?? 'not found on PATH');
    if (identity && real && fs.existsSync(profile)) {
        const ok = statusShowsEmail(run, real, paths.agentHome, identity.email);
        add('bot login', ok, ok ? `acli authenticated as ${identity.email}` : 'acli does not show the bot account');
    }
    add('shim installed', isOurShim(paths.shimPath), isOurShim(paths.shimPath) ? paths.shimPath : `missing or foreign: ${paths.shimPath}`);
    const shimProblem = shimCurrentProblem(paths.shimPath);
    add('shim current', !shimProblem, shimProblem ?? 'matches the shim this xt version installs');
    const firstAcli = pathEnv.split(':').filter(Boolean).map(d => path.join(d, 'acli')).find(c => fs.existsSync(c));
    add('shim first on PATH', firstAcli === paths.shimPath, firstAcli ? `first acli on PATH: ${firstAcli}` : 'no acli on PATH');
    return checks;
}

export interface SweepRow { key: string; summary: string; assigned: boolean }
export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/**
 * Safety net for tickets the bot reported without an assignee (any creation path the shim
 * and jira.py do not cover). Lists them; with apply, assigns them to the bot.
 */
export async function sweepUnassigned(
    opts: { apply: boolean; days: number },
    deps: JiraIdentityDeps & { fetch?: FetchFn } = {},
): Promise<SweepRow[]> {
    const paths = jiraIdentityPaths(deps.home);
    const identity = readIdentity(paths);
    if (!identity) throw new Error(`no identity: run xt jira setup (${paths.identityFile})`);
    const problem = tokenFileProblem(identity.tokenFile);
    if (problem) throw new Error(problem);
    const doFetch: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init) as ReturnType<FetchFn>);
    const token = fs.readFileSync(identity.tokenFile, 'utf8').trim();
    const headers = {
        Authorization: `Basic ${Buffer.from(`${identity.email}:${token}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };
    const base = `https://${identity.site}`;
    const days = Math.max(1, Math.floor(opts.days));
    const jql = `reporter = currentUser() AND assignee is EMPTY AND created >= -${days}d ORDER BY created DESC`;
    const search = await doFetch(`${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`, { headers });
    if (!search.ok) throw new Error(`Jira search failed (HTTP ${search.status})`);
    const issues: Array<{ key: string; fields?: { summary?: string } }> = (await search.json()).issues ?? [];
    const rows: SweepRow[] = issues.map(i => ({ key: i.key, summary: i.fields?.summary ?? '', assigned: false }));
    if (!opts.apply || rows.length === 0) return rows;

    const me = await doFetch(`${base}/rest/api/3/myself`, { headers });
    if (!me.ok) throw new Error(`Jira /myself failed (HTTP ${me.status})`);
    const accountId = (await me.json()).accountId as string;
    for (const row of rows) {
        const put = await doFetch(`${base}/rest/api/3/issue/${encodeURIComponent(row.key)}/assignee`, {
            method: 'PUT', headers, body: JSON.stringify({ accountId }),
        });
        row.assigned = put.ok;
    }
    return rows;
}
