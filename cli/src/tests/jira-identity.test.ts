// CORE-2526: Jira agent identity. setup order and idempotence, doctor, and the shim's routing rule
// run for real under bash; jira.py is checked against the same rule.

import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
        fs.writeFileSync(claude, `#!/usr/bin/env bash\n${shim} x\n`, { mode: 0o755 });
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
    const leftovers = () => fs.readdirSync(agentHome).filter(f => f.startsWith('.assignee.'));

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
