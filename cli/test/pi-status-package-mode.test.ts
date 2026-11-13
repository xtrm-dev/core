import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN = path.join(__dirname, '../dist/index.cjs');
const CLI_ROOT = path.dirname(path.dirname(CLI_BIN));
const PKG = 'npm:@jaggerxtrm/pi-extensions';

/** Escape every regex metacharacter, backslash included: a partial escape
 *  class still interpolates raw regex syntax (CodeQL
 *  js/incomplete-sanitization, CORE-2694). */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let tempHome = '';
let stubBin = '';

beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xt-pi-status-pkgmode-'));
    await fs.ensureDir(path.join(tempHome, '.pi', 'agent'));
    // Global settings declares the package.
    await fs.writeJson(path.join(tempHome, '.pi', 'agent', 'settings.json'), { packages: [PKG] });
    // Deliberately do NOT populate ~/.pi/agent/extensions — this is the correct
    // steady state in global package mode. Codex P2: absence must not be flagged.
    // Stub `pi --version` so the status command runs past its "pi installed?"
    // gate on CI runners that don't have the real pi binary.
    stubBin = path.join(tempHome, 'bin');
    await fs.ensureDir(stubBin);
    const stubPi = path.join(stubBin, 'pi');
    await fs.writeFile(stubPi, '#!/bin/sh\necho "0.99.0-test-stub"\nexit 0\n');
    await fs.chmod(stubPi, 0o755);
});

afterEach(async () => {
    await fs.remove(tempHome);
});

function runStatus(cwd: string) {
    return spawnSync('node', [CLI_BIN, 'pi', 'status'], {
        encoding: 'utf8',
        timeout: 20000,
        env: {
            ...process.env,
            HOME: tempHome,
            PI_AGENT_DIR: path.join(tempHome, '.pi', 'agent'),
            PATH: `${stubBin}:${process.env.PATH ?? ''}`,
        },
        cwd,
    });
}

describe('xt pi status — global package mode without mirrors (xtrm-xnymw, Codex P2)', () => {
    it('does not flag missing/stale extensions when there are no ~/.pi/agent/extensions mirrors', () => {
        const r = runStatus(CLI_ROOT);
        const combined = (r.stdout ?? '') + (r.stderr ?? '');

        // The pre-fix regression: package-mode ran the mirror inventory and
        // reported every managed extension as missing under the "Missing:"
        // extension label. Under the fix, the mirror inventory is skipped
        // entirely and no such line is emitted. (npm package installation is
        // a separate concern; that line uses the "Packages:" label and is
        // unaffected by this fix.)
        expect(combined).not.toMatch(/Missing:\s+\w/);
        expect(combined).not.toMatch(/Stale:\s+\w/);
        // Scope line reflects package mode.
        expect(combined).toMatch(/Scope:\s+global \(package mode\)/);
        // Registration line confirms the global entry is what the diagnostic
        // now bases extension health on.
        expect(combined).toMatch(new RegExp(`Registration:\\s+${escapeRegExp(PKG)} \\(global\\)`));
    });
});
