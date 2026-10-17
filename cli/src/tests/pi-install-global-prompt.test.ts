import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const {
  runPiRuntimeSyncMock,
  syncGlobalPromptsMock,
  printGlobalPromptSyncSummaryMock,
  isPiInstalledMock,
  isPnpmInstalledMock,
  spawnSyncMock,
} = vi.hoisted(() => ({
  runPiRuntimeSyncMock: vi.fn(),
  syncGlobalPromptsMock: vi.fn(),
  printGlobalPromptSyncSummaryMock: vi.fn(),
  isPiInstalledMock: vi.fn(),
  isPnpmInstalledMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

// Deterministic external-binary responses: runPiInstall shells out for
// `pi --version` / `pnpm --version` after the install checks. Never rely on
// the real binary (absent on CI runners) or on other suites' child_process
// mocks (xtrm-3ljgz.2) — the mock is scoped to this file and reset per test,
// so the suite cannot depend on global test order.
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

vi.mock('../core/pi-runtime.js', () => ({
  runPiRuntimeSync: runPiRuntimeSyncMock,
  // CORE-2412: pi-install.ts resolves the agent dir lazily; the mock must
  // provide it so runPiInstall never touches the real ~/.pi/agent.
  resolvePiAgentDir: () => process.env.PI_AGENT_DIR ?? '/tmp/pi-agent-test',
}));

vi.mock('../core/global-prompt-sync.js', () => ({
  syncGlobalPrompts: syncGlobalPromptsMock,
  printGlobalPromptSyncSummary: printGlobalPromptSyncSummaryMock,
}));

vi.mock('../core/machine-bootstrap.js', () => ({
  isPiInstalled: isPiInstalledMock,
  isPnpmInstalled: isPnpmInstalledMock,
}));

import { runPiInstall } from '../commands/pi-install.js';

describe('runPiInstall global prompt sync wiring (xtrm-3ljgz.2)', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '0.0.0\n', stderr: '' });
    runPiRuntimeSyncMock.mockReset();
    runPiRuntimeSyncMock.mockResolvedValue({
      extensionsAdded: [],
      extensionsUpdated: [],
      extensionsRemoved: [],
      packagesInstalled: [],
      failed: [],
      changed: false,
    });
    syncGlobalPromptsMock.mockReset();
    syncGlobalPromptsMock.mockResolvedValue({ targets: [] });
    printGlobalPromptSyncSummaryMock.mockReset();
    isPiInstalledMock.mockReset();
    isPiInstalledMock.mockReturnValue(true);
    isPnpmInstalledMock.mockReset();
    isPnpmInstalledMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the global prompt sync exactly once per invocation on init/install', async () => {
    await runPiInstall(false, false, path.join('/tmp', 'project'));

    expect(syncGlobalPromptsMock).toHaveBeenCalledTimes(1);
    expect(syncGlobalPromptsMock).toHaveBeenCalledWith({ dryRun: false });
    expect(printGlobalPromptSyncSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('propagates dry-run to the prompt sync without mutating', async () => {
    await runPiInstall(true, false, path.join('/tmp', 'project'));

    expect(syncGlobalPromptsMock).toHaveBeenCalledTimes(1);
    expect(syncGlobalPromptsMock).toHaveBeenCalledWith({ dryRun: true });
  });

  it('skips the prompt sync when the update flow already ran it once', async () => {
    await runPiInstall(false, false, path.join('/tmp', 'project'), { skipGlobalPromptSync: true });

    expect(syncGlobalPromptsMock).not.toHaveBeenCalled();
    expect(printGlobalPromptSyncSummaryMock).not.toHaveBeenCalled();
  });
});
