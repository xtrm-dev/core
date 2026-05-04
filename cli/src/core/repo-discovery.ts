import fs from 'fs-extra';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const REGISTRY_MARKER = path.join('.xtrm', 'registry.json');

export async function findManagedRepos(rootDir: string): Promise<string[]> {
    const discovered = new Set<string>();
    await walk(rootDir, discovered);
    return [...discovered].sort();
}

async function walk(currentDir: string, discovered: Set<string>): Promise<void> {
    const registryPath = path.join(currentDir, REGISTRY_MARKER);
    if (await fs.pathExists(registryPath)) {
        discovered.add(currentDir);
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [] as Array<{ isDirectory(): boolean; name: string }>);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(currentDir, entry.name), discovered);
    }
}
