import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2342 sandbox proof: real `pi install` + real `pi` startup against an
// isolated HOME. `pi install` persists the source into the agent settings, so
// the broken behaviour is only reproducible with the real binary — hence the
// opt-in gate. CI stays fast; the operator runs it explicitly:
//
//   XT_PI_SANDBOX_E2E=1 npx vitest run src/tests/pi-package-duplicate-sandbox.test.ts
//
// The sandbox is always a fresh mktemp -d under /var/tmp seeded with a settings
// file that declares the local dev checkout. The real ~/.pi is never written.

const NPM_EXTENSION_PKG = 'npm:@jaggerxtrm/pi-extensions';
const DEV_PATH = path.resolve(process.cwd(), '..', 'packages', 'pi-extensions');
const sandboxE2eEnabled = process.env.XT_PI_SANDBOX_E2E === '1';
const devCheckoutExists = fs.existsSync(path.join(DEV_PATH, 'src', 'index.ts'));

describe.skipIf(!sandboxE2eEnabled || !devCheckoutExists)('pi package duplicate guard, isolated HOME (CORE-2342)', () => {
  let sandboxHome = '';
  let previousHome: string | undefined;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    sandboxHome = fs.mkdtempSync(path.join('/var/tmp', 'xtrm-core2342-sandbox-'));
    previousHome = process.env.HOME;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = sandboxHome;
    process.env.PI_CODING_AGENT_DIR = path.join(sandboxHome, '.pi', 'agent');
    vi.resetModules();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.removeSync(sandboxHome);
    vi.restoreAllMocks();
  });

  it('leaves one entry and a startable pi after the package sync (isolated HOME)', async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    fs.outputJsonSync(path.join(agentDir, 'settings.json'), { packages: [DEV_PATH] });

    const { ensureAlwaysGlobalPiPackages, runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');
    const realInstalls: string[] = [];

    const result = await ensureAlwaysGlobalPiPackages(
      false,
      undefined,
      agentDir,
      (piPackageId) => {
        realInstalls.push(piPackageId);
        if (piPackageId !== NPM_EXTENSION_PKG) return { status: 0, stdout: '', stderr: '' };
        // Only the package under test installs for real: the others would just
        // add network time, and they are covered by the injected-runner tests.
        const install = spawnSync('pi', ['install', piPackageId], { encoding: 'utf8', stdio: 'pipe' });
        return { status: install.status, stdout: install.stdout ?? '', stderr: install.stderr ?? '' };
      },
      null,
      [],
    );

    const settings = fs.readJsonSync(path.join(agentDir, 'settings.json'));
    const extensionEntries: unknown[] = settings.packages.filter((entry: unknown) => (
      typeof entry === 'string' && entry.includes('pi-extensions')
    ));

    expect(realInstalls).not.toContain(NPM_EXTENSION_PKG);
    expect(result.installed).not.toContain(NPM_EXTENSION_PKG);
    expect(extensionEntries).toEqual([DEV_PATH]);

    const smoke = await runPiStartupSmokeCheck();
    expect(smoke.status).toBe('ok');
    expect(smoke.ok).toBe(true);
    expect(smoke.detail).toContain('startup probe exit 0');
  }, 300_000);

  it('skips the check when pi is not on PATH, without failing the host', async () => {
    const { runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');
    const previousPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const smoke = await runPiStartupSmokeCheck();
      expect(smoke.status).toBe('skipped');
      expect(smoke.detail).toContain('not found on PATH');
    } finally {
      process.env.PATH = previousPath;
    }
  }, 120_000);

  it('still reports a pre-existing duplicate loudly (the failure it would have hidden)', async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    fs.outputJsonSync(path.join(agentDir, 'settings.json'), { packages: [DEV_PATH, NPM_EXTENSION_PKG] });
    const install = spawnSync('pi', ['install', NPM_EXTENSION_PKG], { encoding: 'utf8', stdio: 'pipe' });
    expect(install.status).toBe(0);

    const { runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');
    const smoke = await runPiStartupSmokeCheck();

    expect(smoke.status).toBe('failed');
    expect(smoke.ok).toBe(false);
    expect(smoke.detail).toContain('Failed to load extension');
    expect(smoke.detail).toContain('conflicts with');
    expect(smoke.detail).not.toContain('registered more than once');
  }, 300_000);
});
