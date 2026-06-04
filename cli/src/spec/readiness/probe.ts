import fs from 'fs-extra';
import path from 'node:path';
import { CAPABILITY_MATRIX, type Capability, type CapabilityProbeResult } from './matrix.js';

export interface ProbeReport {
    schema: 'xt.spec.readiness.v1';
    repo_root: string;
    results: CapabilityProbeResult[];
    ready: boolean;
}

/**
 * Probe each capability against deployed skill / config files.
 * Read-only; no network; <1s; pure function of the filesystem.
 */
export async function probe(repoRoot: string): Promise<ProbeReport> {
    const results: CapabilityProbeResult[] = [];
    for (const capability of CAPABILITY_MATRIX) {
        results.push(await probeOne(capability, repoRoot));
    }
    const ready = results.every((r) => r.present);
    return { schema: 'xt.spec.readiness.v1', repo_root: repoRoot, results, ready };
}

async function probeOne(capability: Capability, repoRoot: string): Promise<CapabilityProbeResult> {
    const sourcePath = path.resolve(repoRoot, capability.source);
    if (!(await fs.pathExists(sourcePath))) {
        return {
            capability,
            present: false,
            detail: `source not found: ${capability.source}`,
        };
    }
    const text = await fs.readFile(sourcePath, 'utf8');
    const match = capability.marker.exec(text);
    if (!match) {
        return {
            capability,
            present: false,
            detail: `marker ${capability.marker.source} absent from ${capability.source}`,
        };
    }
    return {
        capability,
        present: true,
        detail: `matched at offset ${match.index}`,
    };
}
