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

/**
 * CORE-2630: the per-project config directory, mirroring `env-paths` exactly for
 * every platform. This is the single source of truth: the Conf store path, the
 * read-only existence check and the cache identity all derive from it, so they
 * cannot disagree (review finding: three copies drifted, and the win32 base —
 * %APPDATA%/xtrm-cli-nodejs/Config — was missing entirely).
 *
 * env-paths computes its home from `os.homedir()` at module load; resolving here
 * on every call is what makes a later HOME/XDG change take effect.
 */
export function resolveConfProjectDir(): string {
    const name = 'xtrm-cli-nodejs';
    const home = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Preferences', name);
    }
    if (process.platform === 'win32') {
        // env-paths: APPDATA || ~/AppData/Roaming, then <appData>/<name>/Config.
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return path.join(appData, name, 'Config');
    }
    // env-paths uses `||`, so an empty XDG_CONFIG_HOME falls back to ~/.config.
    const base = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return path.join(base, name);
}

// CORE-2630: pass `cwd` explicitly so Conf does not fall back to env-paths,
// which caches os.homedir() at module load and freezes the store location.
export function resolveConfCwd(): string {
    return resolveConfProjectDir();
}

/**
 * The cache key. Derived from the resolved directory rather than from raw env
 * vars, so every input that moves the store (HOME, XDG_CONFIG_HOME, APPDATA,
 * platform base) also invalidates the cached instance.
 */
function configIdentity(): string {
    return resolveConfProjectDir();
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
 * Whether the Conf store exists, checked without instantiating Conf —
 * constructing it writes the file on first access, which would turn every
 * read-only path (preflight, dry-run, fail-closed gates) into a HOME mutation.
 * CORE-2630: uses the same resolver as the store itself, so the check can never
 * look at a different directory than the write. A filesystem error still fails
 * open (assume present → old behavior).
 */
function defaultConfigFilePresent(): boolean {
    try {
        return fs.pathExistsSync(path.join(resolveConfProjectDir(), 'config.json'));
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
