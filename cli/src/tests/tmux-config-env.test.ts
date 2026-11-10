// CORE-2528 review item 1: the tmux `-e` list must be self-consistent.
//
// A pane does not inherit xt's environment. If xt appends at the inherited
// GIT_CONFIG_COUNT but forwards only its own keys, the pane sees COUNT=6 with
// keys 1..5 and no key 0, and every `git` command fails with
// "missing config key GIT_CONFIG_KEY_0". This test runs real tmux on a private
// socket with a pre-existing server, base 0, 1 and 3, and asserts that
// `git config --list` exits 0 and shows the inherited entry plus all five
// transport entries.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveLaunchIdentity } from '../core/launch-identity.js';

const socket = path.join(os.tmpdir(), `xtrm-tmux-cfg-${process.pid}.sock`);
let home = '';
// Computed at collection time: `it.skipIf` is evaluated before any hook runs.
const tmuxAvailable = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

function tmux(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('tmux', ['-S', socket, ...args], { encoding: 'utf8', input, timeout: 10000 });
    return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function writeFile(file: string, body: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

beforeAll(() => {
    if (!tmuxAvailable) return;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'xtrm-tmux-cfg-home-'));
    writeFile(path.join(home, '.xtrm', 'config', 'identity-role-map.json'), JSON.stringify({
        version: 1, default: 'worker', specialists: { 'pr-reviewer': 'reviewer' },
        apps: { worker: 'xtrm-worker', reviewer: 'xtrm-reviewer', coordinator: 'xtrm-coord' },
    }));
    writeFile(path.join(home, '.xtrm', 'identities', 'github-apps', 'xtrm-reviewer', 'app.json'), JSON.stringify({
        slug: 'xtrm-reviewer', appId: '12345', owner: 'xtrm-dev', installations: { 'xtrm-dev': '42' },
    }));
    // A pre-existing server on the private socket: the failure needs a running
    // server whose environment does NOT carry xt's variables.
    tmux(['new-session', '-d', '-s', 'seed', 'sleep 60']);
});

afterAll(() => {
    if (!tmuxAvailable) return;
    if (fs.existsSync(socket)) tmux(['kill-server']);
    if (fs.existsSync(socket)) fs.rmSync(socket, { force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('tmux -e forwards the inherited GIT_CONFIG entries', () => {
    for (const base of [0, 1, 3]) {
        // An explicit skip with a reason: a silent return would hide the whole
        // property on a machine without tmux (M29b).
        it.skipIf(!tmuxAvailable)(`git config --list succeeds in the pane with base ${base} (skipped without tmux)`, async () => {
            const inherited: Record<string, string> = {};
            if (base > 0) {
                inherited.GIT_CONFIG_COUNT = String(base);
                for (let index = 0; index < base; index += 1) {
                    inherited[`GIT_CONFIG_KEY_${index}`] = index === 0 ? 'http.proxy' : `credential.helper${index}`;
                    inherited[`GIT_CONFIG_VALUE_${index}`] = index === 0 ? 'http://proxy:3128' : 'store';
                }
            }
            const identity = resolveLaunchIdentity({
                holder: 'probe',
                roleName: 'reviewer',
                cwd: home,
                env: inherited,
                deps: { home, repo: 'xtrm-dev/core' },
                forwardInherited: true,
            });
            expect(identity.exported).toBe(true);
            const envArgs = Object.entries(identity.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
            const session = `probe${base}`;
            const outFile = path.join(os.tmpdir(), `xtrm-tmux-cfg-out-${process.pid}-${base}.txt`);
            fs.rmSync(outFile, { force: true });
            const script = `git config --list > ${outFile} 2>&1; echo "EXIT:$?" >> ${outFile}`;
            const created = tmux(['new-session', '-d', '-s', session, ...envArgs, 'sh', '-c', script]);
            expect(created.status).toBe(0);
            let output = '';
            for (let attempt = 0; attempt < 100; attempt += 1) {
                if (fs.existsSync(outFile)) {
                    output = fs.readFileSync(outFile, 'utf8');
                    if (output.includes('EXIT:')) break;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            fs.rmSync(outFile, { force: true });
            expect(output, output).toContain('EXIT:0');
            // git lower-cases the key names it lists from the command scope.
            const listed = output.toLowerCase();
            if (base > 0) expect(listed).toContain('http.proxy=http://proxy:3128');
            expect(listed).toContain('url.https://github.com/.insteadof');
            expect(listed).toContain('credential.https://github.com.usehttppath');
            tmux(['kill-session', '-t', session]);
        }, 20000);
    }
});
