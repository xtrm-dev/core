import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getXtManagedPiPackages } from '../src/core/pi-runtime.js';

const ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_JSON_PATH = path.resolve(ROOT, 'package.json');
const INSTALL_SCHEMA_PATH = path.resolve(ROOT, '.xtrm', 'config', 'pi', 'install-schema.json');
const SETTINGS_TEMPLATE_PATH = path.resolve(ROOT, '.xtrm', 'config', 'pi', 'settings.json.template');

type SurfaceName = 'package.json' | 'install-schema' | 'settings';

type PackageParityException = {
    package: string;
    missingFrom: ReadonlyArray<SurfaceName>;
    reason: string;
};

const EXCEPTIONS: Array<PackageParityException> = [
    {
        package: 'npm:@jaggerxtrm/pi-extensions',
        missingFrom: ['package.json', 'install-schema', 'settings'],
        reason: 'project-local package, not a Pi-managed install target',
    },
    {
        package: 'npm:@robhowley/pi-structured-return',
        missingFrom: ['install-schema', 'settings'],
        reason: 'runtime-managed only; not mirrored in Pi setup templates',
    },
    {
        package: 'npm:pi-mcp-adapter',
        missingFrom: ['package.json', 'settings'],
        reason: 'runtime override repair handles it instead of static package lists',
    },
];

function assertStringArray(value: unknown, filePath: string, fieldName: string): asserts value is string[] {
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
        throw new Error(`Expected ${filePath} to define ${fieldName} as an array of strings`);
    }
}

function readJsonFile(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readSurfacePackages(filePath: string, surfaceName: SurfaceName): string[] {
    const parsed = readJsonFile(filePath);
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`Expected ${surfaceName} JSON object in ${filePath}`);
    }

    const packages = surfaceName === 'package.json'
        ? (parsed as { pi?: { packages?: unknown } }).pi?.packages
        : (parsed as { packages?: unknown }).packages;

    assertStringArray(packages, filePath, 'packages');
    return packages;
}

function exceptionForPackage(packageId: string): PackageParityException | undefined {
    return EXCEPTIONS.find(exception => exception.package === packageId);
}

function assertParity(
    surfaceName: SurfaceName,
    expected: readonly string[],
    actual: readonly string[],
): void {
    for (const packageId of expected) {
        const exception = exceptionForPackage(packageId);
        if (actual.includes(packageId)) continue;
        if (exception?.missingFrom.includes(surfaceName)) continue;
        const reason = exception ? ` Allowed exception: ${exception.reason}.` : '';
        throw new Error(`Missing ${packageId} from ${surfaceName}.${reason}`);
    }

    for (const packageId of actual) {
        const exception = exceptionForPackage(packageId);
        if (expected.includes(packageId)) continue;
        if (exception?.missingFrom.includes(surfaceName)) continue;
        const reason = exception ? ` Allowed exception: ${exception.reason}.` : '';
        throw new Error(`Unexpected ${packageId} in ${surfaceName}.${reason}`);
    }
}

describe('Pi package-list parity', () => {
    it('keeps runtime-managed packages aligned with package.json and Pi setup templates', () => {
        const runtimePackages = getXtManagedPiPackages().map(pkg => pkg.id);
        const packageJsonPackages = readSurfacePackages(PACKAGE_JSON_PATH, 'package.json');
        const installSchemaPackages = readSurfacePackages(INSTALL_SCHEMA_PATH, 'install-schema');
        const settingsTemplatePackages = readSurfacePackages(SETTINGS_TEMPLATE_PATH, 'settings');

        assertParity('package.json', runtimePackages, packageJsonPackages);
        assertParity('install-schema', runtimePackages, installSchemaPackages);
        assertParity('settings', runtimePackages, settingsTemplatePackages);
    });
});
