#!/usr/bin/env node
// Fail when packages/pi-extensions resolves the host-provided Pi SDK from
// outside this repo or below the supported version (XTRM-586).
//
// Pi supplies these packages to extensions at runtime, so pi-extensions
// declares them as "*" peers plus pinned devDependencies for types. Without
// an in-repo copy, Node and tsc walk up past the repo root and silently pick
// whatever a parent directory holds (for example a stray Pi 0.84 install).
//
// The lookup mirrors Node's node_modules walk (package location only), since
// the Pi packages are ESM-only and expose no require-resolvable package.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PI_SDK_PACKAGES = {
    '@earendil-works/pi-coding-agent': '1.0.0',
    '@earendil-works/pi-ai': '1.0.0',
    '@earendil-works/pi-tui': '1.0.0',
    typebox: '1.0.0',
};

export function locatePackage(name, fromDir) {
    let dir = path.resolve(fromDir);
    for (;;) {
        const manifest = path.join(dir, 'node_modules', name, 'package.json');
        if (fs.existsSync(manifest)) return manifest;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function parseVersion(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    return match ? match.slice(1, 4).map(Number) : null;
}

export function isAtLeast(version, minimum) {
    const have = parseVersion(version);
    const want = parseVersion(minimum);
    if (!have || !want) return false;
    for (let i = 0; i < 3; i += 1) {
        if (have[i] !== want[i]) return have[i] > want[i];
    }
    return true;
}

export function checkPiSdkResolution({ fromDir, repoRoot, packages = PI_SDK_PACKAGES }) {
    const root = path.resolve(repoRoot) + path.sep;
    const errors = [];
    const resolved = [];
    for (const [name, minimum] of Object.entries(packages)) {
        const manifest = locatePackage(name, fromDir);
        if (!manifest) {
            errors.push(`${name}: not installed (run npm install at the repo root)`);
            continue;
        }
        const { version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        const location = path.dirname(manifest);
        resolved.push({ name, version, location });
        if (!manifest.startsWith(root)) {
            errors.push(`${name}@${version}: resolved outside the repo at ${location}`);
        }
        if (!isAtLeast(version, minimum)) {
            errors.push(`${name}@${version}: below required ${minimum} (${location})`);
        }
    }
    return { errors, resolved };
}

function main() {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const fromDir = path.join(repoRoot, 'packages', 'pi-extensions');
    const { errors, resolved } = checkPiSdkResolution({ fromDir, repoRoot });
    for (const entry of resolved) {
        console.log(`${entry.name}@${entry.version} ${path.relative(repoRoot, entry.location) || '.'}`);
    }
    if (errors.length) {
        console.error('Pi SDK resolution check failed:');
        for (const error of errors) console.error(`  - ${error}`);
        process.exit(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
