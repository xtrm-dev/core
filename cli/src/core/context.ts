import os from 'os';
import path from 'path';
import fs from 'fs-extra';
// @ts-ignore
import Conf from 'conf';
import kleur from 'kleur';
import type { SyncMode } from '../types/config.js';


export interface Context {
    targets: string[];
    syncMode: 'copy' | 'symlink' | 'prune';
    config: any;
}

export interface GetContextOptions {
    createMissingDirs?: boolean;
    isGlobal?: boolean;
    projectRoot?: string;
}

type ConfigShape = {
    syncMode: SyncMode;
};

// CORE-2630: key the cached Conf on the HOME/XDG it was built under. The
// store path is resolved at construction time, so a cached instance is only
// valid while HOME and XDG_CONFIG_HOME are unchanged. Without this key the first
// call freezes the store location for the whole process.
let config: Conf<ConfigShape> | null = null;
let configKey: string | null = null;

function configIdentity(): string {
    // Align with resolveConfCwd and env-paths semantics: XDG_CONFIG_HOME is
    // used verbatim (no trim) so a value with surrounding whitespace is treated
    // as set, matching env-paths on Linux.
    return `${process.env.XDG_CONFIG_HOME ?? ''}\u0000${os.homedir()}`;
}

// CORE-2630: pass `cwd` explicitly so Conf does not fall back to env-paths,
// which caches os.homedir() at module load and freezes the store location.
// Resolve the config dir from the current HOME/XDG on every cache miss.
// CORE-2630: mirror env-paths so macOS users keep their existing store.
// env-paths on darwin uses ~/Library/Preferences/<name> and ignores
// XDG_CONFIG_HOME entirely; on Linux it uses XDG_CONFIG_HOME or ~/.config.
export function resolveConfCwd(): string {
    const home = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Preferences', 'xtrm-cli-nodejs');
    }
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg ? xdg : path.join(home, '.config');
    return path.join(base, 'xtrm-cli-nodejs');
}

function getConfig(): Conf<ConfigShape> {
    const key = configIdentity();
    if (config && configKey === key) {
        return config;
    }
    config = new Conf<ConfigShape>({
        cwd: resolveConfCwd(),
        configName: 'config',
        defaults: {
            syncMode: 'copy',
        },
    });
    configKey = key;
    return config;
}

/**
 * Default Conf store path without instantiating Conf — constructing it
 * writes the file on first access, which would turn every read-only path
 * (preflight, dry-run, fail-closed gates) into a HOME mutation.
 * Unknown platforms fail open (assume present → old behavior).
 */
function defaultConfigFilePresent(): boolean {
    try {
        if (process.platform === 'win32') return true;
        const dir = process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Preferences', 'xtrm-cli-nodejs')
            : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'xtrm-cli-nodejs');
        return fs.pathExistsSync(path.join(dir, 'config.json'));
    } catch {
        return true;
    }
}

/**
 * Returns install targets for registry-driven xtrm scaffold.
 * Primary target is .xtrm (project-local or ~/.xtrm for global installs).
 */
export function getCandidatePaths(isGlobal: boolean = false, projectRoot?: string): Array<{ label: string; path: string }> {
    const home = os.homedir();
    const xtrmPath = isGlobal || !projectRoot
        ? path.join(home, '.xtrm')
        : path.join(projectRoot, '.xtrm');
    const xtrmLabel = isGlobal ? '~/.xtrm' : '.xtrm';

    return [{ label: xtrmLabel, path: xtrmPath }];
}

export async function getContext(options: GetContextOptions = {}): Promise<Context> {
    const { createMissingDirs = true, isGlobal = false, projectRoot } = options;
    const candidates = getCandidatePaths(isGlobal, projectRoot);
    // Read-only when the store file is absent: defaults without creating it.
    // Mutation paths (createMissingDirs) keep the real store.
    const activeConfig = defaultConfigFilePresent() || createMissingDirs ? getConfig() : null;
    const selectedPaths = candidates.map(c => c.path);

    if (createMissingDirs) {
        for (const target of selectedPaths) {
            await fs.ensureDir(target);
        }
    }

    return {
        targets: selectedPaths,
        syncMode: activeConfig?.get('syncMode') ?? 'copy',
        config: activeConfig,
    };
}
export function resetContext(): void {
    getConfig().clear();
    console.log(kleur.yellow('Configuration cleared.'));
}
