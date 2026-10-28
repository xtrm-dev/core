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
