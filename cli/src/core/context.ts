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

let config: Conf<ConfigShape> | null = null;

function getConfig(): Conf<ConfigShape> {
    if (!config) {
        config = new Conf<ConfigShape>({
            projectName: 'xtrm-cli',
            defaults: {
                syncMode: 'copy',
            },
        });
    }

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
