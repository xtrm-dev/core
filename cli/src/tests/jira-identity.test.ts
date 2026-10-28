// CORE-2526: Jira agent identity. setup order and idempotence, doctor, and the shim's routing rule
// run for real under bash; jira.py is checked against the same rule.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    doctorJiraIdentity,
    jiraIdentityPaths,
    readIdentity,
    resolveRealAcli,
    setupJiraIdentity,
    shimSource,
    sweepUnassigned,
    SHIM_MARKER,
    type RunFn,
} from '../core/jira-identity.js';

const EMAIL = 'agent@example.test';
const TOKEN = 'tok-secret-value';

let home = '';
let realDir = '';
let tokenFile = '';
let calls: Array<{ args: string[]; home?: string; input?: string; shimThere: boolean }> = [];

function fakeRun(over: { loginStatus?: number; showEmail?: boolean } = {}): RunFn {
    return (_cmd, args, opts) => {
        calls.push({ args, home: opts.env?.HOME, input: opts.input, shimThere: fs.existsSync(jiraIdentityPaths(home).shimPath) });
        if (args[2] === 'login') return { status: over.loginStatus ?? 0, stdout: '', stderr: '' };
        return { status: 0, stdout: over.showEmail === false ? 'Not authenticated' : `Email: ${EMAIL}`, stderr: '' };
    };
}

function pathEnv(): string {
    return `${path.dirname(jiraIdentityPaths(home).shimPath)}:${realDir}`;
}

beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-id-'));
    realDir = path.join(home, 'usr-bin');
    fs.ensureDirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'acli'), '#!/bin/sh\necho real\n', { mode: 0o755 });
    tokenFile = path.join(home, 'token.txt');
    fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    calls = [];
});

afterEach(() => { fs.removeSync(home); });

describe('setupJiraIdentity', () => {
    it('requires an email the first time', () => {
        expect(() => setupJiraIdentity({ tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun() })).toThrow(/--email/);
    });

    it('refuses a token file that is missing, empty or group/world readable', () => {
        const deps = { home, pathEnv: pathEnv(), run: fakeRun() };
        expect(() => setupJiraIdentity({ email: EMAIL, tokenFile: path.join(home, 'nope') }, deps)).toThrow(/not found/);
        fs.chmodSync(tokenFile, 0o644);
        expect(() => setupJiraIdentity({ email: EMAIL, tokenFile }, deps)).toThrow(/mode 600/);
        expect(calls).toHaveLength(0);
    });

    it('logs in under the isolated HOME with the token on stdin, writes no secret, installs the shim last', () => {
        const identity = setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun() });
        const paths = jiraIdentityPaths(home);
        const login = calls.find(c => c.args[2] === 'login')!;
        expect(login.home).toBe(paths.agentHome);
        expect(login.input).toBe(TOKEN);
        expect(login.args.join(' ')).not.toContain(TOKEN);
        expect(login.shimThere).toBe(false);
        expect(fs.readFileSync(paths.identityFile, 'utf8')).not.toContain(TOKEN);
        expect(fs.statSync(paths.identityFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(paths.agentHome).mode & 0o777).toBe(0o700);
        expect(identity.home).toBe(paths.agentHome);
        expect(fs.readFileSync(paths.shimPath, 'utf8')).toContain(SHIM_MARKER);
        expect(fs.statSync(paths.shimPath).mode & 0o111).not.toBe(0);
    });

    it('installs no shim when the login fails or shows the wrong account', () => {
        const shim = jiraIdentityPaths(home).shimPath;
        expect(() => setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun({ loginStatus: 1 }) })).toThrow(/login failed/);
        expect(fs.existsSync(shim)).toBe(false);
        expect(() => setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun({ showEmail: false }) })).toThrow(/expected account/);
        expect(fs.existsSync(shim)).toBe(false);
    });

    it('refuses to overwrite a foreign acli at the shim path', () => {
        const shim = jiraIdentityPaths(home).shimPath;
        fs.ensureDirSync(path.dirname(shim));
        fs.writeFileSync(shim, '#!/bin/sh\necho mine\n', { mode: 0o755 });
        expect(() => setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun() })).toThrow(/not the xtrm shim/);
        expect(calls).toHaveLength(0);
        expect(fs.readFileSync(shim, 'utf8')).toContain('mine');
    });

    it('is idempotent and reuses the stored identity', () => {
        const deps = { home, pathEnv: pathEnv(), run: fakeRun() };
        setupJiraIdentity({ email: EMAIL, tokenFile }, deps);
        const again = setupJiraIdentity({}, deps);
        expect(again.email).toBe(EMAIL);
        expect(readIdentity(jiraIdentityPaths(home))?.tokenFile).toBe(tokenFile);
    });

    it('resolveRealAcli skips the shim', () => {
        setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun() });
        expect(resolveRealAcli(pathEnv())).toBe(path.join(realDir, 'acli'));
    });
});

describe('doctorJiraIdentity', () => {
    it('passes after setup and names each failing piece before it', () => {
        const before = doctorJiraIdentity({ home, pathEnv: pathEnv(), run: fakeRun() });
        expect(before.filter(c => !c.ok).map(c => c.name)).toEqual(expect.arrayContaining(['identity.json', 'bot acli profile', 'shim installed']));
        setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun() });
        // the fake run does not create the profile file; add it as acli would
        const profile = path.join(jiraIdentityPaths(home).agentHome, '.config', 'acli', 'jira_config.yaml');
        fs.ensureDirSync(path.dirname(profile));
        fs.writeFileSync(profile, 'version: 1\n');
        const after = doctorJiraIdentity({ home, pathEnv: pathEnv(), run: fakeRun() });
        expect(after.filter(c => !c.ok)).toEqual([]);
    });

    it('flags a shim that is not first on PATH', () => {
        setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun() });
        const reversed = `${realDir}:${path.dirname(jiraIdentityPaths(home).shimPath)}`;
        const checks = doctorJiraIdentity({ home, pathEnv: reversed, run: fakeRun() });
        expect(checks.find(c => c.name === 'shim first on PATH')?.ok).toBe(false);
    });
});

describe('shim routing (real bash)', () => {
    let shim = '';
    let agentHome = '';
    let operatorHome = '';

    beforeEach(() => {
        operatorHome = path.join(home, 'operator');
        agentHome = path.join(home, 'agent-home');
        fs.ensureDirSync(operatorHome);
        fs.ensureDirSync(path.join(agentHome, '.config', 'acli'));
        fs.writeFileSync(path.join(agentHome, '.config', 'acli', 'jira_config.yaml'), 'version: 1\n');
        const fakeReal = path.join(home, 'fake-real-acli');
        fs.writeFileSync(fakeReal, '#!/bin/sh\necho "HOME=$HOME"\n', { mode: 0o755 });
        shim = path.join(home, 'shim');
        fs.writeFileSync(shim, shimSource(fakeReal), { mode: 0o755 });
    });

    function env(extra: Record<string, string>): NodeJS.ProcessEnv {
        const base: NodeJS.ProcessEnv = { ...process.env, HOME: operatorHome, XTRM_JIRA_AGENT_HOME: agentHome, ...extra };
        for (const k of ['SUBSTRATE_HOLDER', 'XTRM_JIRA_AS', 'XTRM_JIRA_WALK_FROM']) if (!(k in extra)) delete base[k];
        return base;
    }
    const run = (extra: Record<string, string>) => spawnSync(shim, ['x'], { env: env(extra), encoding: 'utf8' });

    it('routes a process with SUBSTRATE_HOLDER to the agent HOME', () => {
        expect(run({ SUBSTRATE_HOLDER: 'w' }).stdout.trim()).toBe(`HOME=${agentHome}`);
    });

    it('exits 78 for an agent when the profile is missing, never falling back', () => {
        const r = run({ SUBSTRATE_HOLDER: 'w', XTRM_JIRA_AGENT_HOME: path.join(home, 'nowhere') });
        expect(r.status).toBe(78);
        expect(r.stdout).toBe('');
    });

    it('leaves a non-agent process on the operator HOME', () => {
        expect(run({ XTRM_JIRA_WALK_FROM: '1' }).stdout.trim()).toBe(`HOME=${operatorHome}`);
    });

    it('XTRM_JIRA_AS=operator wins over the holder', () => {
        expect(run({ SUBSTRATE_HOLDER: 'w', XTRM_JIRA_AS: 'operator' }).stdout.trim()).toBe(`HOME=${operatorHome}`);
    });

    it('treats a process under a claude ancestor as an agent although the env var is gone', () => {
        const claude = path.join(home, 'claude');
        fs.writeFileSync(claude, `#!/bin/bash\n${shim} x\n`, { mode: 0o755 });
        const r = spawnSync(claude, [], { env: env({}), encoding: 'utf8' });
        expect(r.stdout.trim()).toBe(`HOME=${agentHome}`);
    });
});

describe('jira.py identity rule', () => {
    const script = path.resolve(__dirname, '../../../.xtrm/skills/optional/programme/programme-coordination/scripts');
    const py = (extra: Record<string, string>, h: string) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: h, ...extra };
        for (const k of ['JIRA_EMAIL', 'JIRA_TOKEN_FILE', 'SUBSTRATE_HOLDER', 'XTRM_JIRA_AS', 'XTRM_JIRA_WALK_FROM']) if (!(k in extra)) delete env[k];
        const r = spawnSync('python3', ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(script)}); import jira; print(*jira.identity())`], { env, encoding: 'utf8' });
        return r.stdout.trim();
    };

    beforeEach(() => {
        const paths = jiraIdentityPaths(home);
        fs.ensureDirSync(paths.identityDir);
        fs.writeJsonSync(paths.identityFile, { site: 's', email: EMAIL, tokenFile, home: paths.agentHome });
    });

    it('uses the bot for a holder, the operator when forced, and explicit env over both', () => {
        expect(py({ SUBSTRATE_HOLDER: 'w' }, home)).toBe(`${EMAIL} ${tokenFile}`);
        expect(py({ SUBSTRATE_HOLDER: 'w', XTRM_JIRA_AS: 'operator' }, home)).toMatch(/^jagger\.xtrm@gmail\.com /);
        expect(py({ SUBSTRATE_HOLDER: 'w', JIRA_EMAIL: 'x@y.z', JIRA_TOKEN_FILE: '/t' }, home)).toBe('x@y.z /t');
    });

    it('stays on the operator when no agent signal is present or identity.json is absent', () => {
        expect(py({ XTRM_JIRA_WALK_FROM: '1' }, home)).toMatch(/^jagger\.xtrm@gmail\.com /);
        expect(py({ SUBSTRATE_HOLDER: 'w' }, fs.mkdtempSync(path.join(home, 'empty-')))).toMatch(/^jagger\.xtrm@gmail\.com /);
    });

    it('importing jira.py reads no secret', () => {
        expect(py({ XTRM_JIRA_WALK_FROM: '1' }, home)).not.toBe('');
    });
});

describe('shim default assignee (real bash)', () => {
    let shim = '';
    let agentHome = '';

    beforeEach(() => {
        agentHome = path.join(home, 'agent-home');
        fs.ensureDirSync(path.join(agentHome, '.config', 'acli'));
        fs.writeFileSync(path.join(agentHome, '.config', 'acli', 'jira_config.yaml'), 'version: 1\n');
        // The fake "real" acli prints its arguments and, for --from-json, the file it was given.
        const fakeReal = path.join(home, 'fake-real-acli');
        fs.writeFileSync(fakeReal, '#!/bin/bash\necho "ARGS: $*"\nwhile [ $# -gt 0 ]; do if [ "$1" = "--from-json" ]; then echo "FILE: $2"; cat "$2"; echo; fi; case "$1" in --from-json=*) f="${1#--from-json=}"; echo "FILE: $f"; cat "$f"; echo;; esac; shift; done\nexit ${FAKE_EXIT:-0}\n', { mode: 0o755 });
        shim = path.join(home, 'shim');
        fs.writeFileSync(shim, shimSource(fakeReal), { mode: 0o755 });
    });

    const run = (args: string[], extra: Record<string, string> = {}) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(home, 'operator'), XTRM_JIRA_AGENT_HOME: agentHome, SUBSTRATE_HOLDER: 'w', ...extra };
        return spawnSync(shim, args, { env, encoding: 'utf8' });
    };
    const leftovers = () => fs.readdirSync(agentHome).filter(f => f.startsWith('.rewrite.'));

    it('adds --assignee @me to a create that names none', () => {
        expect(run(['jira', 'workitem', 'create', '--summary', 'S', '--project', 'XT', '--type', 'Task']).stdout)
            .toContain('ARGS: jira workitem create --summary S --project XT --type Task --assignee @me');
    });

    it('keeps an explicit assignee, and leaves help, generate-json, other commands and the operator alone', () => {
        for (const args of [
            ['jira', 'workitem', 'create', '--summary', 'S', '--assignee', 'someone@x.test'],
            ['jira', 'workitem', 'create', '-a', 'someone@x.test'],
            ['jira', 'workitem', 'create', '--assignee=someone@x.test'],
            ['jira', 'workitem', 'create', '--help'],
            ['jira', 'workitem', 'create', '--generate-json'],
            ['jira', 'workitem', 'view', 'XT-1'],
        ]) expect(run(args).stdout).not.toContain('@me');
        expect(run(['jira', 'workitem', 'create', '--summary', 'S'], { XTRM_JIRA_AS: 'operator' }).stdout).not.toContain('@me');
    });

    it('rewrites --from-json into a private temp copy with the assignee, then removes it', () => {
        const src = path.join(home, 'wi.json');
        fs.writeJsonSync(src, { projectKey: 'XT', summary: 'S', type: 'Task' });
        const r = run(['jira', 'workitem', 'create', '--from-json', src]);
        expect(r.stdout).toMatch(/"assignee": ?"@me"/);
        expect(r.stdout).toMatch(/"summary": ?"S"/);
        expect(r.stdout).not.toContain(`FILE: ${src}`);
        expect(leftovers()).toEqual([]);
        expect(fs.readJsonSync(src)).not.toHaveProperty('assignee');
        const eq = run(['jira', 'workitem', 'create', `--from-json=${src}`]);
        expect(eq.stdout).toMatch(/"assignee": ?"@me"/);
    });

    it('keeps an assignee already in the JSON, passes an unreadable file through, and keeps the exit code', () => {
        const src = path.join(home, 'wi2.json');
        fs.writeJsonSync(src, { projectKey: 'XT', summary: 'S', assignee: 'someone@x.test' });
        expect(run(['jira', 'workitem', 'create', '--from-json', src]).stdout).toMatch(/"assignee": ?"someone@x.test"/);
        const missing = run(['jira', 'workitem', 'create', '--from-json', path.join(home, 'nope.json')]);
        expect(missing.stdout).toContain(`FILE: ${path.join(home, 'nope.json')}`);
        expect(leftovers()).toEqual([]);
        expect(run(['jira', 'workitem', 'create', '--from-json', src], { FAKE_EXIT: '3' }).status).toBe(3);
    });
});

describe('sweepUnassigned', () => {
    const issue = (key: string) => ({ key, fields: { summary: `s ${key}` } });
    function setupIdentity(): void {
        setupJiraIdentity({ email: EMAIL, tokenFile }, { home, pathEnv: pathEnv(), run: fakeRun() });
    }
    function fakeFetch(log: Array<{ url: string; method?: string; body?: string; auth?: string }>, over: { search?: number; put?: number } = {}) {
        return async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
            log.push({ url, method: init?.method, body: init?.body, auth: init?.headers?.Authorization });
            if (url.includes('/search/jql')) return { ok: (over.search ?? 200) < 400, status: over.search ?? 200, json: async () => ({ issues: [issue('XT-1'), issue('XT-2')] }) };
            if (url.endsWith('/myself')) return { ok: true, status: 200, json: async () => ({ accountId: 'bot-id' }) };
            return { ok: (over.put ?? 204) < 400, status: over.put ?? 204, json: async () => ({}) };
        };
    }

    it('lists the bot-reported unassigned tickets and changes nothing without --apply', async () => {
        setupIdentity();
        const log: Array<{ url: string; method?: string; body?: string; auth?: string }> = [];
        const rows = await sweepUnassigned({ apply: false, days: 14 }, { home, fetch: fakeFetch(log) });
        expect(rows.map(r => r.key)).toEqual(['XT-1', 'XT-2']);
        expect(rows.every(r => !r.assigned)).toBe(true);
        expect(log).toHaveLength(1);
        const jql = decodeURIComponent(log[0]!.url);
        expect(jql).toContain('reporter = currentUser() AND assignee is EMPTY AND created >= -14d');
        expect(log[0]!.auth).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`);
    });

    it('assigns each ticket to the bot with --apply and reports a failed assignment', async () => {
        setupIdentity();
        const log: Array<{ url: string; method?: string; body?: string; auth?: string }> = [];
        const ok = await sweepUnassigned({ apply: true, days: 3 }, { home, fetch: fakeFetch(log) });
        expect(ok.every(r => r.assigned)).toBe(true);
        const puts = log.filter(l => l.method === 'PUT');
        expect(puts.map(l => l.url.split('/rest/api/3')[1])).toEqual(['/issue/XT-1/assignee', '/issue/XT-2/assignee']);
        expect(JSON.parse(puts[0]!.body!)).toEqual({ accountId: 'bot-id' });
        const bad = await sweepUnassigned({ apply: true, days: 3 }, { home, fetch: fakeFetch([], { put: 403 }) });
        expect(bad.some(r => r.assigned)).toBe(false);
    });

    it('fails clearly without an identity or when the search is rejected', async () => {
        await expect(sweepUnassigned({ apply: false, days: 1 }, { home, fetch: fakeFetch([]) })).rejects.toThrow(/no identity/);
        setupIdentity();
        await expect(sweepUnassigned({ apply: false, days: 1 }, { home, fetch: fakeFetch([], { search: 401 }) })).rejects.toThrow(/HTTP 401/);
    });
});

describe('jira.py default assignee', () => {
    const script = path.resolve(__dirname, '../../../.xtrm/skills/optional/programme/programme-coordination/scripts');
    const code = `
import sys, json, io, urllib.request
sys.path.insert(0, ${JSON.stringify(script)})
import jira
sent = []
class R:
    def __init__(s, d): s.d = d; s.status = 200
    def read(s): return json.dumps(s.d).encode()
    def __enter__(s): return s
    def __exit__(s, *a): return False
def fake(req, *a, **k):
    body = json.loads(req.data) if req.data else None
    sent.append((req.get_method(), req.full_url.split('/rest/api/3')[1], body))
    return R({'accountId': 'bot-id'} if req.full_url.endswith('/myself') else {'key': 'XT-9'})
urllib.request.urlopen = fake
fields = json.loads(sys.argv[1])
jira.call('POST', '/rest/api/3/issue', {'fields': fields})
print(json.dumps([s for s in sent if s[0] == 'POST'][0][2]['fields'].get('assignee')))
`;
    const py = (fields: object, extra: Record<string, string>) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extra };
        for (const k of ['JIRA_EMAIL', 'JIRA_TOKEN_FILE', 'SUBSTRATE_HOLDER', 'XTRM_JIRA_AS', 'XTRM_JIRA_WALK_FROM']) if (!(k in extra)) delete env[k];
        return spawnSync('python3', ['-I', '-c', code, JSON.stringify(fields)], { env, encoding: 'utf8' });
    };

    beforeEach(() => {
        const paths = jiraIdentityPaths(home);
        fs.ensureDirSync(paths.identityDir);
        fs.writeJsonSync(paths.identityFile, { site: 's', email: EMAIL, tokenFile, home: paths.agentHome });
    });

    it('assigns a create made by the agent identity to the bot, unless the caller names an assignee', () => {
        expect(py({ summary: 'S' }, { SUBSTRATE_HOLDER: 'w' }).stdout.trim()).toBe('{"accountId": "bot-id"}');
        expect(py({ summary: 'S', assignee: { accountId: 'someone' } }, { SUBSTRATE_HOLDER: 'w' }).stdout.trim()).toBe('{"accountId": "someone"}');
    });

    it('leaves the operator identity and explicit credentials alone', () => {
        const opTok = path.join(home, 'op.txt');
        fs.writeFileSync(opTok, 'x', { mode: 0o600 });
        expect(py({ summary: 'S' }, { SUBSTRATE_HOLDER: 'w', XTRM_JIRA_AS: 'operator', JIRA_TOKEN_FILE: opTok }).stdout.trim()).toBe('null');
        expect(py({ summary: 'S' }, { SUBSTRATE_HOLDER: 'w', JIRA_EMAIL: 'x@y.z', JIRA_TOKEN_FILE: tokenFile }).stdout.trim()).toBe('null');
    });
});

// CORE-2537: attribution on agent writes. Header, label and holder fallback for the shim (real bash,
// fake "real" acli that logs its arguments) and for jira.py (fake transport).

const RUN_ID = /^[0-9a-f]{6}$/;
const PY_ACLI = `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
files = {}
for i, x in enumerate(a):
    flag, eq, inline = x.partition('=')
    if flag in ('--body-file', '-F', '--from-json'):
        f = inline if eq else (a[i + 1] if i + 1 < len(a) else '')
        if f and os.path.isfile(f):
            files[f] = open(f).read()
with open(os.environ['FAKE_LOG'], 'a') as log:
    log.write(json.dumps({'args': a, 'files': files, 'home': os.environ.get('HOME')}) + '\\n')
if len(a) > 2 and a[2] == 'edit':
    print('EDIT-OUTPUT')
    sys.exit(int(os.environ.get('FAKE_EXIT_EDIT', '0')))
sys.exit(int(os.environ.get('FAKE_EXIT', '0')))
`;

interface AcliCall { args: string[]; files: Record<string, string>; home: string }

describe('shim attribution (real bash)', () => {
    let shim = '';
    let agentHome = '';
    let log = '';
    let worktree = '';

    beforeEach(() => {
        agentHome = path.join(home, 'agent-home');
        fs.ensureDirSync(path.join(agentHome, '.config', 'acli'));
        fs.writeFileSync(path.join(agentHome, '.config', 'acli', 'jira_config.yaml'), 'version: 1\n');
        const fakeReal = path.join(home, 'fake-real-acli');
        fs.writeFileSync(fakeReal, PY_ACLI, { mode: 0o755 });
        shim = path.join(home, 'shim');
        fs.writeFileSync(shim, shimSource(fakeReal), { mode: 0o755 });
        log = path.join(home, 'acli.log');
        worktree = path.join(home, 'core-xt-foo');
        fs.ensureDirSync(path.join(worktree, '.git'));
    });

    function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
        const base: NodeJS.ProcessEnv = { ...process.env, HOME: path.join(home, 'operator'), XTRM_JIRA_AGENT_HOME: agentHome, FAKE_LOG: log, SUBSTRATE_HOLDER: 'w', SUBSTRATE_RUN_ID: 'abc123', ...extra };
        for (const k of ['XTRM_JIRA_AS', 'XTRM_JIRA_WALK_FROM', 'FAKE_EXIT', 'FAKE_EXIT_EDIT']) if (!(k in extra)) delete base[k];
        return base;
    }
    const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(shim, args, { env: env(extra), cwd: worktree, encoding: 'utf8' });
    const calls = (): AcliCall[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as AcliCall) : []);
    const leftovers = () => fs.readdirSync(agentHome).filter(f => f.startsWith('.rewrite.'));
    const comment = (...rest: string[]) => ['jira', 'workitem', 'comment', 'create', '--key', 'XT-1', ...rest];
    const HEADER = '[agent:w | run:abc123]';

    /**
     * Runs `cmd` as a child of a process named claude, without SUBSTRATE_HOLDER (the ancestor rule). The
     * script needs a direct #!/bin/bash shebang: `#!/usr/bin/env bash` would make the process name "bash".
     */
    function underClaude(cmd: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> {
        const claude = path.join(home, 'claude');
        fs.writeFileSync(claude, '#!/bin/bash\n"$@"\n', { mode: 0o755 });
        const e = env(extra);
        delete e.SUBSTRATE_HOLDER;
        if (!('SUBSTRATE_RUN_ID' in extra)) delete e.SUBSTRATE_RUN_ID;
        return spawnSync(claude, cmd, { env: e, cwd: worktree, encoding: 'utf8' });
    }

    describe('comment create', () => {
        it('prefixes --body in each spelling', () => {
            for (const args of [comment('--body', 'hello'), comment('-b', 'hello'), comment('--body=hello'), comment('-b=hello')]) {
                fs.removeSync(log);
                expect(run(args).status).toBe(0);
                const body = calls()[0]!.args.join('\u0000');
                expect(body).toContain(`${HEADER}\n\nhello`);
                expect(body).not.toMatch(/--body\u0000hello|-b\u0000hello/);
            }
        });

        it('prefixes a --body-file copy and leaves the original file and no temp file behind', () => {
            const src = path.join(home, 'c.txt');
            fs.writeFileSync(src, 'from file\n');
            for (const args of [comment('--body-file', src), comment('-F', src), comment(`--body-file=${src}`)]) {
                fs.removeSync(log);
                expect(run(args).status).toBe(0);
                const [only] = calls();
                const copy = Object.keys(only!.files)[0]!;
                expect(copy).not.toBe(src);
                expect(only!.files[copy]).toBe(`${HEADER}\n\nfrom file\n`);
            }
            expect(fs.readFileSync(src, 'utf8')).toBe('from file\n');
            expect(leftovers()).toEqual([]);
        });

        it('adds no second header and keeps an ADF body valid', () => {
            run(comment('--body', '[agent:other | run:1]\n\nhi'));
            expect(calls()[0]!.args).toContain('[agent:other | run:1]\n\nhi');
            fs.removeSync(log);
            const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] };
            run(comment('--body', JSON.stringify(adf)));
            const posted = JSON.parse(calls()[0]!.args[calls()[0]!.args.indexOf('--body') + 1]!);
            expect(posted.content).toHaveLength(2);
            expect(posted.content[0].content[0].text).toBe(HEADER);
            expect(posted.content[1]).toEqual(adf.content[0]);
            fs.removeSync(log);
            run(comment('--body', JSON.stringify(posted)));
            expect(JSON.parse(calls()[0]!.args[calls()[0]!.args.indexOf('--body') + 1]!).content).toHaveLength(2);
        });

        it('keeps --edit-last and every other flag, and leaves non-create commands, help, --editor and operators alone', () => {
            run(comment('--edit-last', '--json', '--body', 'x'));
            expect(calls()[0]!.args).toEqual(expect.arrayContaining(['--edit-last', '--json', '--key', 'XT-1']));
            expect(calls()[0]!.args.slice(0, 4)).toEqual(['jira', 'workitem', 'comment', 'create']);
            for (const args of [['jira', 'workitem', 'comment', 'list', '--key', 'XT-1'], comment('--help'), comment('--editor'), ['jira', 'workitem', 'view', 'XT-1']]) {
                fs.removeSync(log);
                run(args);
                expect(calls()[0]!.args).toEqual(args);
            }
            fs.removeSync(log);
            run(comment('--body', 'x'), { XTRM_JIRA_AS: 'operator' });
            expect(calls()[0]!.args).toEqual(comment('--body', 'x'));
        });

        it('falls back to <runtime>-<worktree dir> marked as fallback when there is no SUBSTRATE_HOLDER, and still posts', () => {
            const r = underClaude([shim, ...comment('--body', 'hi')], { SUBSTRATE_RUN_ID: 'abc123' });
            expect(r.status).toBe(0);
            expect(calls()[0]!.args).toContain('[agent:claude-core-xt-foo | run:abc123 | fallback]\n\nhi');
        });

        it('failing to rewrite never blocks the write', () => {
            const r = run(comment('--body-file', path.join(home, 'nope.txt')));
            expect(r.status).toBe(0);
            expect(r.stderr).toContain('running the command unchanged');
            expect(calls()[0]!.args).toContain(path.join(home, 'nope.txt'));
            expect(leftovers()).toEqual([]);
        });
    });

    describe('run id', () => {
        const header = () => calls().at(-1)!.args.find(a => a.startsWith('[agent:'))!.split('\n')[0]!;
        const runIdOf = () => /run:([^ \]]+)/.exec(header())![1]!;

        it('is SUBSTRATE_RUN_ID when set', () => {
            run(comment('--body', 'x'), { SUBSTRATE_RUN_ID: 'r-42' });
            expect(header()).toBe('[agent:w | run:r-42]');
        });

        it('is 6 hex chars, stable inside one agent process and different for another', () => {
            const once = () => { fs.removeSync(log); underClaude([shim, ...comment('--body', 'x')]); return runIdOf(); };
            const one = once();
            expect(one).toMatch(RUN_ID);
            const claude = path.join(home, 'claude');
            fs.writeFileSync(claude, `#!/bin/bash\n${shim} ${comment('--body', 'a').join(' ')}\n${shim} ${comment('--body', 'b').join(' ')}\n`, { mode: 0o755 });
            fs.removeSync(log);
            const e = env();
            delete e.SUBSTRATE_HOLDER;
            delete e.SUBSTRATE_RUN_ID;
            spawnSync(claude, [], { env: e, cwd: worktree, encoding: 'utf8' });
            const [a, b] = calls().map(c => /run:([^ \]]+)/.exec(c.args.find(x => x.startsWith('[agent:'))!)![1]!);
            expect(a).toMatch(RUN_ID);
            expect(a).toBe(b);
            expect(once()).not.toBe(a);
        });

        it('is the same string jira.py computes inside the same agent process', () => {
            const script = path.resolve(__dirname, '../../../.xtrm/skills/optional/programme/programme-coordination/scripts');
            for (const holder of ['', 'w']) {
                fs.removeSync(log);
                const claude = path.join(home, 'claude');
                const py = `import sys; sys.path.insert(0, ${JSON.stringify(script)}); import jira; print(jira.agent_header())`;
                fs.writeFileSync(claude, `#!/bin/bash\n${shim} ${comment('--body', 'x').join(' ')}\npython3 -I -c '${py}'\n`, { mode: 0o755 });
                const e = env();
                delete e.SUBSTRATE_RUN_ID;
                if (holder) e.SUBSTRATE_HOLDER = holder; else delete e.SUBSTRATE_HOLDER;
                const r = spawnSync(claude, [], { env: e, cwd: worktree, encoding: 'utf8' });
                const fromShim = calls()[0]!.args.find(a => a.startsWith('[agent:'))!.split('\n')[0];
                expect(r.stdout.trim()).toBe(fromShim);
            }
        });
    });

    describe('create labels', () => {
        const create = (...rest: string[]) => ['jira', 'workitem', 'create', '--summary', 'S', '--project', 'XT', '--type', 'Task', ...rest];

        it('adds actor=agent and keeps the caller labels', () => {
            run(create());
            expect(calls()[0]!.args.slice(-4)).toEqual(['--assignee', '@me', '--label', 'actor=agent']);
            for (const labels of [['--label', 'a,b'], ['-l', 'a'], ['--label=a'], ['--label', 'a', '--label', 'b']]) {
                fs.removeSync(log);
                run(create(...labels));
                expect(calls()[0]!.args).toEqual(expect.arrayContaining([...labels, '--label', 'actor=agent']));
            }
        });

        it('does not repeat the label, and leaves help, generate-json and operators alone', () => {
            run(create('--label', 'x,actor=agent', '--assignee', 'someone@x.test'));
            expect(calls()[0]!.args.filter(a => a === 'actor=agent' || a.includes('actor=agent'))).toHaveLength(1);
            for (const args of [create('--help'), ['jira', 'workitem', 'create', '--generate-json']]) {
                fs.removeSync(log);
                run(args);
                expect(calls()[0]!.args).toEqual(args);
            }
            fs.removeSync(log);
            run(create(), { XTRM_JIRA_AS: 'operator' });
            expect(calls()[0]!.args).toEqual(create());
        });

        it('merges the label into a private --from-json copy, with or without an assignee flag', () => {
            const src = path.join(home, 'wi.json');
            fs.writeJsonSync(src, { projectKey: 'XT', summary: 'S', labels: ['keep'] });
            run(['jira', 'workitem', 'create', '--from-json', src]);
            const [only] = calls();
            const copy = JSON.parse(Object.values(only!.files)[0]!);
            expect(copy.labels).toEqual(['keep', 'actor=agent']);
            expect(copy.assignee).toBe('@me');
            expect(fs.readJsonSync(src).labels).toEqual(['keep']);
            fs.removeSync(log);
            fs.writeJsonSync(src, { projectKey: 'XT', summary: 'S' });
            run(['jira', 'workitem', 'create', `--from-json=${src}`, '-a', 'someone@x.test']);
            const second = JSON.parse(Object.values(calls()[0]!.files)[0]!);
            expect(second.labels).toEqual(['actor=agent']);
            expect(second).not.toHaveProperty('assignee');
            expect(leftovers()).toEqual([]);
        });
    });

    describe('transition label step', () => {
        const edit = (...selectors: string[]) => ['jira', 'workitem', 'edit', ...selectors, '--labels', 'actor=agent', '--yes'];
        const transition = (...rest: string[]) => ['jira', 'workitem', 'transition', ...rest, '--status', 'Done', '--yes'];

        it('labels the same tickets first, then runs the transition unchanged', () => {
            for (const selector of [['--key', 'XT-1,XT-2'], ['-k', 'XT-1'], ['--key=XT-1'], ['--jql', 'project = XT'], ['--filter', '10001']]) {
                fs.removeSync(log);
                const r = run(transition(...selector));
                expect(r.status).toBe(0);
                expect(r.stdout).not.toContain('EDIT-OUTPUT');
                expect(calls().map(c => c.args)).toEqual([edit(...selector), transition(...selector)]);
                expect(calls().every(c => c.home === agentHome)).toBe(true);
            }
        });

        it('does nothing extra for help, a missing selector or the operator, and a failing label step never blocks', () => {
            for (const args of [['jira', 'workitem', 'transition', '--help'], ['jira', 'workitem', 'transition', '--status', 'Done']]) {
                fs.removeSync(log);
                run(args);
                expect(calls().map(c => c.args)).toEqual([args]);
            }
            fs.removeSync(log);
            run(transition('--key', 'XT-1'), { XTRM_JIRA_AS: 'operator' });
            expect(calls()).toHaveLength(1);
            fs.removeSync(log);
            const r = run(transition('--key', 'XT-1'), { FAKE_EXIT_EDIT: '1', FAKE_EXIT: '3' });
            expect(calls()).toHaveLength(2);
            expect(r.status).toBe(3);
            expect(r.stderr).toContain('label step failed');
            expect(leftovers()).toEqual([]);
        });
    });
});

describe('jira.py attribution', () => {
    const script = path.resolve(__dirname, '../../../.xtrm/skills/optional/programme/programme-coordination/scripts');
    const code = `
import os, sys, json, io, runpy, urllib.request, urllib.error
sys.path.insert(0, ${JSON.stringify(script)})
import jira
sent = []
class R:
    def __init__(s, d): s.d = d; s.status = 200
    def read(s): return json.dumps(s.d).encode()
    def __enter__(s): return s
    def __exit__(s, *a): return False
def fake(req, *a, **k):
    body = json.loads(req.data) if req.data else None
    path = req.full_url.split('/rest/api/3')[1]
    sent.append([req.get_method(), path, body])
    if req.get_method() == 'PUT' and os.environ.get('FAKE_LABEL_FAIL'):
        raise urllib.error.HTTPError(req.full_url, 403, 'no', {}, io.BytesIO(b'denied'))
    if path.endswith('/myself'): return R({'accountId': 'bot-id'})
    if path.endswith('/transitions') and req.get_method() == 'GET': return R({'transitions': [{'id': '31', 'to': {'name': 'Done'}}]})
    return R({'id': '1'})
urllib.request.urlopen = fake
def flat(adf):
    return '\\n\\n'.join(''.join('\\n' if n['type'] == 'hardBreak' else n['text'] for n in p['content']) for p in adf['content'])
mode, arg = sys.argv[1], sys.argv[2]
if mode == 'comment':
    st, out, posted = jira.post_comment('XT-1', arg)
    print(json.dumps({'status': st, 'posted': posted, 'sent': flat(sent[-1][2]['body'])}))
elif mode == 'create':
    jira.call('POST', '/rest/api/3/issue', {'fields': json.loads(arg)})
    print(json.dumps([s for s in sent if s[0] == 'POST'][0][2]['fields'].get('labels')))
elif mode == 'transition':
    st, out = jira.transition('XT-1', 'Done')
    print(json.dumps([s for s in sent if s[0] != 'GET']))
elif mode == 'cli':
    sys.argv = ['jira.py', 'comment', 'XT-1', arg]
    runpy.run_path(${JSON.stringify(path.join(script, 'jira.py'))}, run_name='__main__')
`;
    const py = (mode: string, arg: string, extra: Record<string, string> = {}) => {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SUBSTRATE_HOLDER: 'w', SUBSTRATE_RUN_ID: 'abc123', ...extra };
        for (const k of ['JIRA_EMAIL', 'JIRA_TOKEN_FILE', 'XTRM_JIRA_AS', 'XTRM_JIRA_WALK_FROM', 'FAKE_LABEL_FAIL']) if (!(k in extra)) delete env[k];
        return spawnSync('python3', ['-I', '-c', code, mode, arg], { env, encoding: 'utf8' });
    };
    const comment = (text: string, extra: Record<string, string> = {}) => JSON.parse(py('comment', text, extra).stdout) as { status: number; posted: string; sent: string };

    beforeEach(() => {
        const paths = jiraIdentityPaths(home);
        fs.ensureDirSync(paths.identityDir);
        fs.writeJsonSync(paths.identityFile, { site: 's', email: EMAIL, tokenFile, home: paths.agentHome });
    });

    it('prefixes the header and returns exactly the text that went into the ADF body', () => {
        const r = comment('first line\nsecond line\n\n\n\nthird \n');
        expect(r.posted).toBe('[agent:w | run:abc123]\n\nfirst line\nsecond line\n\nthird');
        expect(r.sent).toBe(r.posted);
        expect(r.status).toBe(200);
    });

    it('adds no second header and does not post a header for an empty text', () => {
        const r = comment('[agent:other | run:1]\n\nbody');
        expect(r.posted).toBe('[agent:other | run:1]\n\nbody');
        expect(r.sent).toBe(r.posted);
        expect(comment('  \n\n ').posted).toBe('');
    });

    it('leaves the text of a non-agent process alone but still returns what it posted', () => {
        const r = comment('plain\n\nnext', { XTRM_JIRA_AS: 'operator', JIRA_TOKEN_FILE: tokenFile });
        expect(r.posted).toBe('plain\n\nnext');
        expect(r.sent).toBe('plain\n\nnext');
    });

    it('falls back to <runtime>-<worktree dir> with a fallback mark when there is no SUBSTRATE_HOLDER', () => {
        const wt = path.join(home, 'core-xt-foo');
        fs.ensureDirSync(path.join(wt, '.git'));
        const claude = path.join(home, 'claude');
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SUBSTRATE_RUN_ID: 'abc123' };
        for (const k of ['SUBSTRATE_HOLDER', 'JIRA_EMAIL', 'JIRA_TOKEN_FILE', 'XTRM_JIRA_AS', 'XTRM_JIRA_WALK_FROM']) delete env[k];
        fs.writeFileSync(claude, '#!/bin/bash\n"$@"\n', { mode: 0o755 });
        const r = spawnSync(claude, ['python3', '-I', '-c', code, 'comment', 'hi'], { env, cwd: wt, encoding: 'utf8' });
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout).posted).toBe('[agent:claude-core-xt-foo | run:abc123 | fallback]\n\nhi');
    });

    it('keeps SUBSTRATE_HOLDER and SUBSTRATE_RUN_ID inside the header grammar', () => {
        expect(comment('x', { SUBSTRATE_HOLDER: 'a b|c]', SUBSTRATE_RUN_ID: 'r 1' }).posted.split('\n')[0]).toBe('[agent:a-b-c- | run:r-1]');
    });

    it('still posts, marked as fallback, when the holder is blank and no agent process is above', () => {
        const r = comment('x', { SUBSTRATE_HOLDER: ' ', XTRM_JIRA_WALK_FROM: '1' });
        expect(r.status).toBe(200);
        expect(r.posted.split('\n')[0]).toMatch(/^\[agent:agent-\S+ \| run:abc123 \| fallback\]$/);
    });

    it('CLI keeps the HTTP line and the JSON and adds POSTED_TEXT with the exact text', () => {
        const file = path.join(home, 'c.txt');
        fs.writeFileSync(file, 'cli text\n');
        const lines = py('cli', file).stdout.trimEnd().split('\n');
        expect(lines[0]).toBe('HTTP 200');
        expect(JSON.parse(lines.slice(1, -1).join('\n'))).toEqual({ id: '1' });
        expect(lines.at(-1)).toBe(`POSTED_TEXT ${JSON.stringify('[agent:w | run:abc123]\n\ncli text')}`);
    });

    it('adds actor=agent to an agent create and keeps the caller labels once', () => {
        expect(JSON.parse(py('create', '{"summary":"S"}').stdout)).toEqual(['actor=agent']);
        expect(JSON.parse(py('create', '{"summary":"S","labels":["keep"]}').stdout)).toEqual(['keep', 'actor=agent']);
        expect(JSON.parse(py('create', '{"summary":"S","labels":["actor=agent"]}').stdout)).toEqual(['actor=agent']);
    });

    it('leaves a create by the operator without a label', () => {
        expect(py('create', '{"summary":"S"}', { XTRM_JIRA_AS: 'operator', JIRA_TOKEN_FILE: tokenFile }).stdout.trim()).toBe('null');
    });

    it('labels before it transitions, and a refused label does not block the transition', () => {
        const ok = JSON.parse(py('transition', '').stdout) as Array<[string, string, unknown]>;
        expect(ok.map(s => [s[0], s[1]])).toEqual([['PUT', '/issue/XT-1'], ['POST', '/issue/XT-1/transitions']]);
        expect(ok[0]![2]).toEqual({ update: { labels: [{ add: 'actor=agent' }] } });
        const refused = py('transition', '', { FAKE_LABEL_FAIL: '1' });
        expect(JSON.parse(refused.stdout).map((s: unknown[]) => s[0])).toEqual(['PUT', 'POST']);
        expect(refused.stderr).toContain('HTTP 403');
        expect(refused.stderr).not.toContain('denied');
    });

    it('does not label a transition by the operator', () => {
        const out = JSON.parse(py('transition', '', { XTRM_JIRA_AS: 'operator', JIRA_TOKEN_FILE: tokenFile }).stdout) as Array<[string]>;
        expect(out.map(s => s[0])).toEqual(['POST']);
    });
});
