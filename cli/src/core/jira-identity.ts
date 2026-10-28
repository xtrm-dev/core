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
 * The shim. "Agent" = SUBSTRATE_HOLDER is set OR a claude/pi/codex process is an
 * ancestor: a session resumed without the env var is still an agent.
 * XTRM_JIRA_AS=operator forces the operator profile. XTRM_JIRA_WALK_FROM is a test hook.
 * jira.py implements the same rule; keep the two in step.
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
  HOME="$h" exec "$real" "$@"
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
    const firstAcli = pathEnv.split(':').filter(Boolean).map(d => path.join(d, 'acli')).find(c => fs.existsSync(c));
    add('shim first on PATH', firstAcli === paths.shimPath, firstAcli ? `first acli on PATH: ${firstAcli}` : 'no acli on PATH');
    return checks;
}
