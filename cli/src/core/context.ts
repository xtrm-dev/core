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
    const activeConfig = getConfig();
    const selectedPaths = candidates.map(c => c.path);

    if (createMissingDirs) {
        for (const target of selectedPaths) {
            await fs.ensureDir(target);
        }
    }

    return {
        targets: selectedPaths,
        syncMode: activeConfig.get('syncMode'),
        config: activeConfig,
    };
}
export function resetContext(): void {
    getConfig().clear();
    console.log(kleur.yellow('Configuration cleared.'));
}
