/**
 * Claude Code channel-wake host state for `xt doctor` (advisory, read-only).
 *
 * The wake path depends on two host facts (XTRM-249, CORE-2285): the launcher
 * passes `--channels plugin:specialists@xtrm` only when
 * `specialistsPluginInstalled()` finds `specialists@xtrm` in the user's plugin
 * manifest, and Claude Code silently drops that entry unless the root-owned
 * host policy file carries `channelsEnabled: true` plus an
 * `allowedChannelPlugins` object entry `{ plugin: "specialists",
 * marketplace: "xtrm" }`. Every step fails soft, so this check only reports.
 *
 * Read-only and fail-soft by construction: missing files, permission errors
 * and malformed JSON all produce a diagnostic state, never a throw. Paths are
 * injected so tests never touch `/etc`, `/Library`, or the real `~/.claude`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { specialistsPluginInstalled } from '../utils/worktree-session.js';

export type ClaudeChannelState =
  | 'not_applicable'
  | 'allowlist_missing'
  | 'gate_armed_without_channels_enabled'
  | 'allowlist_entry_missing'
  | 'malformed'
  | 'configured';

export interface ClaudeChannelStatus {
  state: ClaudeChannelState;
  /** Same answer the launcher uses to decide on `--channels`. */
  pluginInstalled: boolean;
  managedSettingsPath: string;
  installedPluginsPath: string;
  /** One-line human diagnosis; also rendered by `xt doctor`. */
  detail: string;
}

export interface ClaudeChannelPaths {
  managedSettingsPath: string;
  installedPluginsPath: string;
}

/** Host policy path Claude Code actually reads (no per-user override exists). */
export function defaultManagedSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/** Plugin manifest path the launcher consults via `specialistsPluginInstalled()`. */
export function defaultInstalledPluginsPath(homeDir: string = homedir()): string {
  return path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
}

/**
 * Exact policy content `docs/xt-claude-channels.md` prescribes (root-owned).
 * Printed verbatim by `xt doctor` whenever the state is not `configured`.
 */
export const CLAUDE_CHANNEL_POLICY_JSON = `{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{ "plugin": "specialists", "marketplace": "xtrm" }]
}`;

function status(
  state: ClaudeChannelState,
  pluginInstalled: boolean,
  paths: ClaudeChannelPaths,
  detail: string,
): ClaudeChannelStatus {
  return { state, pluginInstalled, ...paths, detail };
}

/**
 * Pure read-only diagnosis over injected paths. Never throws: unexpected
 * failures degrade to `malformed`, never a crash.
 */
export function getClaudeChannelStatus(paths: ClaudeChannelPaths): ClaudeChannelStatus {
  // The manifest path mirrors the standard `<home>/.claude/plugins/…
  // installed_plugins.json` layout, so the home dir is its third ancestor;
  // `specialistsPluginInstalled()` stays the single definition of "the
  // launcher will pass the flag" — manifest parsing is not re-implemented.
  let pluginInstalled = false;
  try {
    pluginInstalled = specialistsPluginInstalled(path.resolve(paths.installedPluginsPath, '..', '..', '..'));
  } catch {
    pluginInstalled = false;
  }
  if (!pluginInstalled) {
    return status(
      'not_applicable',
      false,
      paths,
      'specialists plugin not installed — launcher omits --channels; channel wake not applicable',
    );
  }

  let raw: string;
  try {
    raw = readFileSync(paths.managedSettingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return status(
        'allowlist_missing',
        true,
        paths,
        `plugin installed (launcher will pass --channels) but no host policy file at ${paths.managedSettingsPath} — Claude Code falls back to the server default allowlist, which refuses this plugin`,
      );
    }
    return status(
      'malformed',
      true,
      paths,
      `host policy file at ${paths.managedSettingsPath} is unreadable (${(err as Error)?.message ?? err})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return status(
      'malformed',
      true,
      paths,
      `host policy file at ${paths.managedSettingsPath} is not valid JSON`,
    );
  }

  const settings: Record<string, unknown> =
    typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (settings.channelsEnabled !== true) {
    return status(
      'gate_armed_without_channels_enabled',
      true,
      paths,
      `host policy file at ${paths.managedSettingsPath} exists but channelsEnabled !== true — writing the file armed a gate that absence left open; set channelsEnabled: true alongside the allowlist`,
    );
  }

  const allowlist = settings.allowedChannelPlugins;
  const admitted =
    Array.isArray(allowlist) &&
    allowlist.some(
      entry =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as Record<string, unknown>).plugin === 'specialists' &&
        (entry as Record<string, unknown>).marketplace === 'xtrm',
    );
  if (!admitted) {
    return status(
      'allowlist_entry_missing',
      true,
      paths,
      `host policy at ${paths.managedSettingsPath} enables channels but allowedChannelPlugins has no { "plugin": "specialists", "marketplace": "xtrm" } object entry (string entries never match)`,
    );
  }

  return status(
    'configured',
    true,
    paths,
    'launcher will pass --channels plugin:specialists@xtrm and the host policy admits it — channel wake configured',
  );
}
