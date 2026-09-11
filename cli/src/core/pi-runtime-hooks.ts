import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { appendHookLog, hashValue, resolveGlobalHooksConfigPath, resolveGlobalHooksRoot } from './global-hooks-bootstrap.js';
import { readGlobalHooksConfig, resolveHooksForGlobalRuntime, safeMergeOwnedHookSettings, type HookRuntimeSettingsShape } from './claude-runtime-sync.js';
import { writeJsonAtomic } from '../utils/atomic-write.js';

// SEAM (xtrm-6qu.6): Pi hook successors for the retired beads-* gates are
// owned by the hook-successor bead. This reconciler stays generic — it merges
// whatever the canonical template (.xtrm/config/hooks.json) declares, which no
// longer includes beads-* hooks.
export interface ReconcileGlobalPiHooksResult {
  readonly settingsPath: string;
  readonly changed: boolean;
  readonly hooksEntries: number;
}

export async function reconcileGlobalPiHooks(opts: { dryRun?: boolean } = {}): Promise<ReconcileGlobalPiHooksResult> {
  const { dryRun = false } = opts;
  const startedAt = Date.now();
  const settingsPath = path.join(os.homedir(), '.pi', 'agent', 'settings.json');
  const hooksConfig = await readGlobalHooksConfig(resolveGlobalHooksConfigPath());
  const generatedHooks = resolveHooksForGlobalRuntime(hooksConfig.hooks ?? {}, resolveGlobalHooksRoot());

  await appendHookLog({
    timestamp: new Date().toISOString(),
    component: 'hooks-migration',
    event: 'hook.reconcile.start',
    source: hashValue(settingsPath),
    action: 'pi',
    outcome: 'ok',
    durationMs: 0,
  });

  const currentSettings = await readPiHookSettings(settingsPath);
  const result = await safeMergeOwnedHookSettings(currentSettings, generatedHooks, { dryRun });

  if (!result.changed) {
    await appendHookLog({
      timestamp: new Date().toISOString(),
      component: 'hooks-migration',
      event: 'hook.reconcile.ok',
      source: hashValue(settingsPath),
      action: 'pi',
      outcome: 'skipped',
      durationMs: Date.now() - startedAt,
    });
    return { settingsPath, changed: false, hooksEntries: result.hooksEntries };
  }

  if (!dryRun) {
    await writeJsonAtomic(settingsPath, result.settings);
  }

  await appendHookLog({
    timestamp: new Date().toISOString(),
    component: 'hooks-migration',
    event: 'hook.reconcile.ok',
    source: hashValue(settingsPath),
    action: 'pi',
    outcome: 'ok',
    durationMs: Date.now() - startedAt,
  });

  return { settingsPath, changed: !dryRun, hooksEntries: result.hooksEntries };
}

async function readPiHookSettings(settingsPath: string): Promise<HookRuntimeSettingsShape> {
  if (!await fs.pathExists(settingsPath)) {
    return {};
  }

  try {
    return await fs.readJson(settingsPath) as HookRuntimeSettingsShape;
  } catch {
    return {};
  }
}
