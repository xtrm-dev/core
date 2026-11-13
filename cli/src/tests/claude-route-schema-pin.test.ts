/**
 * Pin between core's mirrored `claude_bridge` grammar (CORE-2632) and the copy
 * `@jaggerxtrm/specialists` owns (SPECIALISTS-4442).
 *
 * What this file can and cannot prove:
 *
 * - Layer 1 (always runs): core's exported constants and core's schema decisions
 *   match a vendored contract fixture that carries provenance. It catches an
 *   accidental edit to core's grammar. It does NOT detect upstream drift.
 * - Layer 2 (runs when a specialists package build exposes the schema, i.e. when
 *   `SPECIALISTS_PACKAGE_DIR` names a directory holding
 *   `dist/specialist/global-config.js`): compares DECISIONS against the live
 *   schema. The PUBLISHED bundle (`@jaggerxtrm/specialists@4.2.0`) ships only
 *   `dist/index.js` with no named `ClaudeBridgeBlockSchema`, so this layer cannot
 *   resolve from `node_modules` — it needs a package build or nothing.
 * - Layer 3 (runs when `SPECIALISTS_SOURCE_DIR` points at a specialists
 *   checkout): reads `src/specialist/global-config.ts` and asserts the three
 *   literals core mirrors are present verbatim. This is a LITERAL TRIPWIRE, not
 *   decision parity: removing `.strict()`, the `default(false)` or the
 *   "every listed name resolves a model" refinement still passes it. Treat a
 *   green run as "the identifiers still match", nothing more.
 *
 * Every layer that cannot run prints WHY on the console, so core CI shows the
 * skip instead of silently reporting green. No layer here detects upstream
 * DECISION drift in core CI; what keeps a stale mirror from destroying operator
 * data is `disableClaudeRoute` refusing to rewrite a block it cannot validate.
 * Refresh the fixture and this file when a specialists change touches the block
 * grammar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    CLAUDE_ROUTE_BLOCK_KEYS,
    CLAUDE_ROUTE_BLOCK_KEY,
    CLAUDE_ROUTE_MODEL_PREFIX,
    CLAUDE_ROUTE_SPECIALIST_NAME_PATTERN_SOURCE,
    ClaudeRouteBlockSchema,
} from '../core/claude-route.js';

interface VendoredContract {
    blockKey: string;
    modelPrefix: string;
    specialistNamePattern: string;
    blockKeys: string[];
    source: { repo: string; path: string; commit: string; issue: string };
}

const contractPath = path.join(__dirname, 'fixtures', 'claude-route-schema-contract.json');
const vendored = JSON.parse(fs.readFileSync(contractPath, 'utf-8')) as VendoredContract;

/** Resolve a built specialists package that actually exports the schema. */
function resolveSpecialistsModule(): string | null {
    const candidates: string[] = [];
    const explicit = process.env.SPECIALISTS_PACKAGE_DIR?.trim();
    if (explicit) candidates.push(path.join(explicit, 'dist', 'specialist', 'global-config.js'));
    for (const base of [process.cwd(), path.join(process.cwd(), 'cli')]) {
        const requireFrom = createRequire(path.join(base, 'noop.js'));
        try {
            candidates.push(requireFrom.resolve('@jaggerxtrm/specialists/package.json'));
        } catch { /* not installed here */ }
    }
    for (const candidate of candidates) {
        const entry = candidate.endsWith('package.json')
            ? path.join(path.dirname(candidate), 'dist', 'specialist', 'global-config.js')
            : candidate;
        if (fs.existsSync(entry)) return entry;
    }
    return null;
}

/** The specialists source file core mirrors, when a checkout is named. */
function resolveSpecialistsSource(): string | null {
    const dir = process.env.SPECIALISTS_SOURCE_DIR?.trim();
    if (!dir) return null;
    const candidate = path.join(dir, 'src', 'specialist', 'global-config.ts');
    return fs.existsSync(candidate) ? candidate : null;
}

/** Every decision rule the two schemas must share. */
const FIXTURES: ReadonlyArray<{ name: string; block: unknown; accepted: boolean }> = [
    { name: 'explicit list with a default model', block: { enabled: true, specialists: ['worker'], default_model: 'claude-bridge/a' }, accepted: true },
    { name: 'empty list', block: { enabled: true, specialists: [] }, accepted: true },
    { name: 'empty object', block: {}, accepted: true },
    { name: 'per-name models', block: { enabled: true, specialists: ['worker'], models: { worker: 'claude-bridge/a' } }, accepted: true },
    { name: 'wildcard entry', block: { specialists: ['*'], default_model: 'claude-bridge/a' }, accepted: false },
    { name: 'glob entry', block: { specialists: ['work*'], default_model: 'claude-bridge/a' }, accepted: false },
    { name: 'non-kebab-case name', block: { specialists: ['Worker'], default_model: 'claude-bridge/a' }, accepted: false },
    { name: 'unbridged model', block: { specialists: ['worker'], default_model: 'anthropic/x' }, accepted: false },
    { name: 'listed name without a model', block: { specialists: ['worker'] }, accepted: false },
    { name: 'unknown key', block: { enabled: true, extra: 1 }, accepted: false },
    { name: 'non-boolean enabled', block: { enabled: 'yes' }, accepted: false },
];

const specialistsModule = resolveSpecialistsModule();
const specialistsSource = resolveSpecialistsSource();

if (specialistsModule === null) {
    console.warn(
        '[claude-route pin] layer 2 skipped: no build exposes dist/specialist/global-config.js. ' +
        'The published @jaggerxtrm/specialists bundle does not export ClaudeBridgeBlockSchema, so this layer ' +
        'requires a package build and SPECIALISTS_PACKAGE_DIR pointing at it. Upstream decision drift is NOT ' +
        'detected by this run.',
    );
}
if (specialistsSource === null) {
    console.warn(
        '[claude-route pin] layer 3 skipped: set SPECIALISTS_SOURCE_DIR to a specialists checkout to verify the ' +
        'mirrored literals against src/specialist/global-config.ts.',
    );
}

describe('claude-route schema pin (CORE-2632 vs SPECIALISTS-4442)', () => {
    it('core mirrors the vendored specialists contract', () => {
        expect(CLAUDE_ROUTE_BLOCK_KEY).toBe(vendored.blockKey);
        expect(CLAUDE_ROUTE_MODEL_PREFIX).toBe(vendored.modelPrefix);
        expect(CLAUDE_ROUTE_SPECIALIST_NAME_PATTERN_SOURCE).toBe(vendored.specialistNamePattern);
        expect([...CLAUDE_ROUTE_BLOCK_KEYS].sort()).toEqual([...vendored.blockKeys].sort());
        // Provenance must stay citable: a refresh updates both fields together.
        expect(vendored.source.repo).toBe('xtrm-dev/specialists');
        expect(vendored.source.path).toBe('src/specialist/global-config.ts');
        expect(vendored.source.commit).toMatch(/^[0-9a-f]{7,40}$/);
    });

    it('core enforces the fixture decisions', () => {
        for (const fixture of FIXTURES) {
            expect(ClaudeRouteBlockSchema.safeParse(fixture.block).success, fixture.name).toBe(fixture.accepted);
        }
    });

    it.skipIf(specialistsSource === null)('the mirrored literals are present in the specialists source', () => {
        const source = fs.readFileSync(specialistsSource as string, 'utf-8');
        expect(source).toContain(`'${CLAUDE_ROUTE_BLOCK_KEY}'`);
        expect(source).toContain(`'${CLAUDE_ROUTE_MODEL_PREFIX}'`);
        expect(source).toContain(CLAUDE_ROUTE_SPECIALIST_NAME_PATTERN_SOURCE);
        for (const key of CLAUDE_ROUTE_BLOCK_KEYS) {
            expect(source).toContain(`${key}:`);
        }
    });

    it.skipIf(specialistsModule === null)(
        'core and the built specialists schema make the same decisions',
        async () => {
            const mod = await import(pathToFileURL(specialistsModule as string).href) as Record<string, any>;
            expect(mod.CLAUDE_BRIDGE_SWITCH_KEY).toBe(CLAUDE_ROUTE_BLOCK_KEY);
            expect(mod.CLAUDE_BRIDGE_MODEL_PREFIX).toBe(CLAUDE_ROUTE_MODEL_PREFIX);
            const specialistsSchema = mod.ClaudeBridgeBlockSchema;
            expect(specialistsSchema, 'specialists module must export ClaudeBridgeBlockSchema').toBeDefined();
            for (const fixture of FIXTURES) {
                expect(
                    specialistsSchema.safeParse(fixture.block).success,
                    `specialists disagrees on: ${fixture.name}`,
                ).toBe(fixture.accepted);
            }
        },
    );
});
