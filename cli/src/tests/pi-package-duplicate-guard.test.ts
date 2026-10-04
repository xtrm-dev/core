import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// CORE-2342: `pi install <source>` persists the source into the agent settings.
// Installing a package the settings already provide under another source (the
// local dev checkout, or a same-named npm/git source) registers one extension
// twice, and pi then refuses to start:
//   Failed to load extension .../npm/node_modules/@jaggerxtrm/pi-extensions/src/index.ts:
//     Tool "find" conflicts with /home/dawid/dev/core/packages/pi-extensions/src/index.ts
// The installer must skip such installs and say so in the update result.

const NPM_EXTENSION_PKG = 'npm:@jaggerxtrm/pi-extensions';
const DEV_PATH = '/home/dawid/dev/core/packages/pi-extensions';

let tempRoot = '';
let previousPiAgentDir: string | undefined;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xtrm-core2342-'));
  previousPiAgentDir = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = path.join(tempRoot, 'pi-agent');
  vi.resetModules();
});

afterEach(async () => {
  if (previousPiAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = previousPiAgentDir;
  await fs.remove(tempRoot);
  vi.restoreAllMocks();
});

async function seedAgentSettings(packages: readonly unknown[]) {
  const agentDir = process.env.PI_AGENT_DIR as string;
  await fs.outputJson(path.join(agentDir, 'settings.json'), { packages });
  return agentDir;
}

describe('pi package duplicate detection by package name (CORE-2342)', () => {
  it('treats a local dev checkout and the npm package as the same package', async () => {
    const { findDuplicatePiPackageProvider, resolvePiPackageEntryIdentity } = await import('../core/pi-runtime.js');

    expect(resolvePiPackageEntryIdentity(NPM_EXTENSION_PKG)).toBe('npm:@jaggerxtrm/pi-extensions');
    expect(resolvePiPackageEntryIdentity(DEV_PATH)).toBe('npm:@jaggerxtrm/pi-extensions');
    expect(findDuplicatePiPackageProvider(NPM_EXTENSION_PKG, ['npm:pi-gitnexus', DEV_PATH])).toBe(DEV_PATH);
  });

  it('reads the package name of a local checkout instead of guessing from its path', async () => {
    const { findDuplicatePiPackageProvider } = await import('../core/pi-runtime.js');
    const checkout = path.join(tempRoot, 'vendor', 'my-extensions');
    await fs.outputJson(path.join(checkout, 'package.json'), { name: 'my-extensions' });

    expect(findDuplicatePiPackageProvider('npm:my-extensions', [checkout])).toBe(checkout);
    expect(findDuplicatePiPackageProvider('npm:other-extensions', [checkout])).toBeNull();
  });

  it('matches the same npm package under a different npm version selector', async () => {
    const { findDuplicatePiPackageProvider } = await import('../core/pi-runtime.js');
    expect(findDuplicatePiPackageProvider(NPM_EXTENSION_PKG, ['npm:@jaggerxtrm/pi-extensions@0.15.1'])).toBe('npm:@jaggerxtrm/pi-extensions@0.15.1');
  });

  it('matches a scoped npm package against its own git repository', async () => {
    const { findDuplicatePiPackageProvider } = await import('../core/pi-runtime.js');
    expect(findDuplicatePiPackageProvider(NPM_EXTENSION_PKG, ['git:github.com/jaggerxtrm/pi-extensions']))
      .toBe('git:github.com/jaggerxtrm/pi-extensions');
  });

  it('strips an @ref as well as a #ref from a git source', async () => {
    const { findDuplicatePiPackageProvider, resolveGitSourceIdentity } = await import('../core/pi-runtime.js');
    expect(resolveGitSourceIdentity('git:github.com/jaggerxtrm/pi-extensions@v1.2.3')).toBe('npm:@jaggerxtrm/pi-extensions');
    expect(resolveGitSourceIdentity('git:github.com/jaggerxtrm/pi-extensions#main')).toBe('npm:@jaggerxtrm/pi-extensions');
    expect(resolveGitSourceIdentity('git:https://github.com/jaggerxtrm/pi-extensions.git')).toBe('npm:@jaggerxtrm/pi-extensions');
    expect(findDuplicatePiPackageProvider(NPM_EXTENSION_PKG, ['git:github.com/jaggerxtrm/pi-extensions@v1.2.3']))
      .toBe('git:github.com/jaggerxtrm/pi-extensions@v1.2.3');
  });

  it('matches a git source against a local checkout of the same package', async () => {
    const { findDuplicatePiPackageProvider } = await import('../core/pi-runtime.js');
    const checkout = path.join(tempRoot, 'jaggerxtrm-pi-extensions');
    await fs.outputJson(path.join(checkout, 'package.json'), { name: '@jaggerxtrm/pi-extensions' });
    expect(findDuplicatePiPackageProvider('git:github.com/jaggerxtrm/pi-extensions', [checkout])).toBe(checkout);
  });

  it('does not match a same-named repo owned by somebody else', async () => {
    const { findDuplicatePiPackageProvider } = await import('../core/pi-runtime.js');
    // The owner is part of the identity: `other/ponytail` is not `ponytail`.
    expect(findDuplicatePiPackageProvider('npm:ponytail', ['git:github.com/other/ponytail'])).toBeNull();
    expect(findDuplicatePiPackageProvider('npm:@jaggerxtrm/pi-extensions', ['git:github.com/impostor/pi-extensions'])).toBeNull();
    expect(findDuplicatePiPackageProvider('npm:pi-gitnexus', ['npm:pi-gitnexus', DEV_PATH])).toBeNull();
  });

  it('never reports the identical source as its own duplicate', async () => {
    const { findDuplicatePiPackageProvider } = await import('../core/pi-runtime.js');
    expect(findDuplicatePiPackageProvider(NPM_EXTENSION_PKG, [NPM_EXTENSION_PKG])).toBeNull();
  });
});

describe('the installer skips packages a configured source already provides (CORE-2342)', () => {
  it('does not pi install the npm package when the dev path is configured', async () => {
    const { ensureAlwaysGlobalPiPackages, getXtManagedPiPackages } = await import('../core/pi-runtime.js');
    const agentDir = await seedAgentSettings(['npm:pi-gitnexus', DEV_PATH]);
    const installCalls: string[] = [];

    const result = await ensureAlwaysGlobalPiPackages(
      false,
      undefined,
      agentDir,
      (piPackageId) => {
        installCalls.push(piPackageId);
        return { status: 0, stdout: '', stderr: '' };
      },
      null,
      [],
    );

    expect(installCalls).not.toContain(NPM_EXTENSION_PKG);
    expect(result.installed).not.toContain(NPM_EXTENSION_PKG);
    // Every other managed package is still installed: the guard is not a blanket skip.
    expect(installCalls).toEqual(getXtManagedPiPackages().map(pkg => pkg.id).filter(id => id !== NPM_EXTENSION_PKG));
    const settings = await fs.readJson(path.join(agentDir, 'settings.json'));
    expect(settings.packages.filter((entry: string) => entry.includes('pi-extensions'))).toEqual([DEV_PATH]);
  });

  it('reports an outdated npm package as provided instead of refreshing it', async () => {
    const { assureXtManagedPiPackages } = await import('../core/pi-runtime.js');
    const agentDir = await seedAgentSettings([DEV_PATH]);
    const installCalls: string[] = [];

    const result = await assureXtManagedPiPackages(
      false,
      undefined,
      agentDir,
      (piPackageId) => {
        installCalls.push(piPackageId);
        return { status: 0, stdout: '', stderr: '' };
      },
      async (_id: string, npmPackageName: string) => (
        npmPackageName === '@jaggerxtrm/pi-extensions'
          ? { installedVersion: '0.1.0', expectedVersion: '99.0.0' }
          : { installedVersion: '1.0.0', expectedVersion: '1.0.0' }
      ),
    );

    expect(installCalls).not.toContain(NPM_EXTENSION_PKG);
    expect(result.provided).toContain(NPM_EXTENSION_PKG);
    expect(result.outdated.map(status => status.pkg.id)).not.toContain(NPM_EXTENSION_PKG);
    expect(result.failed).not.toContain(NPM_EXTENSION_PKG);
  });

  it('honours a project-scoped settings duplicate too', async () => {
    const { findDeclaredDuplicatePiPackageProvider } = await import('../core/pi-runtime.js');
    const agentDir = await seedAgentSettings([]);
    const projectRoot = path.join(tempRoot, 'project');
    await fs.outputJson(path.join(projectRoot, '.pi', 'settings.json'), { packages: [DEV_PATH] });

    expect(await findDeclaredDuplicatePiPackageProvider(NPM_EXTENSION_PKG, agentDir, projectRoot)).toEqual({
      entry: DEV_PATH,
      file: path.join(projectRoot, '.pi', 'settings.json'),
    });
  });
});

describe('pi startup smoke check verdict (CORE-2342)', () => {
  const conflictLine = 'Error: Failed to load extension "/home/.pi/agent/npm/node_modules/@jaggerxtrm/pi-extensions/src/index.ts": Tool "find" conflicts with /home/dawid/dev/core/packages/pi-extensions/src/index.ts';

  it('fails with the exact extension-load cause', async () => {
    const { runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');

    const result = await runPiStartupSmokeCheck(() => ({ status: 1, stdout: '', stderr: conflictLine }));

    expect(result).toEqual({ status: 'failed', ok: false, detail: conflictLine });
  });

  it('passes only on a clean exit with no load failure', async () => {
    const { runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');

    expect(await runPiStartupSmokeCheck(() => ({ status: 0, stdout: '', stderr: 'Warning: Extension package "x": heads up' })))
      .toEqual({ status: 'ok', ok: true, detail: 'pi loaded every configured extension (startup probe exit 0)' });
  });

  it('never reports ok when the probe times out', async () => {
    const { runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');

    const result = await runPiStartupSmokeCheck(() => ({ status: null, stdout: '', stderr: '', timedOut: true }));

    expect(result.status).toBe('inconclusive');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('timed out');
  });

  it('never reports ok on a non-zero exit without a load failure', async () => {
    const { runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');

    const result = await runPiStartupSmokeCheck(() => ({ status: 3, stdout: '', stderr: 'Error: terminal is unavailable' }));

    expect(result.status).toBe('inconclusive');
    expect(result.detail).toContain('exited 3');
    expect(result.detail).toContain('terminal is unavailable');
  });

  it('skips when pi cannot be executed at all', async () => {
    const { runPiStartupSmokeCheck } = await import('../core/pi-runtime.js');

    expect(await runPiStartupSmokeCheck(() => ({ status: null, stdout: '', stderr: '', spawnError: 'pi executable not found on PATH' })))
      .toEqual({ status: 'skipped', ok: false, detail: 'pi startup smoke check skipped: pi executable not found on PATH' });
  });

  it('runs pi with no prompt and no session, so no model call can happen', async () => {
    // The probe contract itself: `pi --offline`, stdin ignored. A probe that
    // can answer a prompt is a bug (review 719 finding 1).
    const { spawnSync } = await import('node:child_process');
    const source = await fs.readFile(new URL('../core/pi-runtime.ts', import.meta.url), 'utf8');
    const probeBlock = source.slice(source.indexOf('function runPiStartupSmokeProbe'));
    expect(probeBlock).toContain("spawnSync('pi', ['--offline']");
    expect(probeBlock).not.toContain("'-p'");
    expect(probeBlock).not.toContain('xt-startup-smoke-probe');
    expect(spawnSync).toBeTypeOf('function');
  });
});
