import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const cliSrc = resolve(import.meta.dirname, '..');

/**
 * Guard: `xt spec apply` must NEVER bypass the composition gate.
 * No production code path under cli/src/{spec,commands/spec} may invoke:
 *   - `sp chain approve …`
 *   - `bd update <id> --claim`
 *
 * These are operator-only actions. xt spec apply produces input + dispatch +
 * reconcile + handoff; the operator decides when to approve and when to claim.
 *
 * Test sources (this file + __tests__) are excluded.
 */

const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
    { name: 'sp chain approve', re: /\bsp\s+chain\s+approve\b/ },
    { name: 'bd update --claim', re: /bd\s+update[^\n;]*--claim/ },
];

const ALLOWED_DIRS = ['spec', 'commands/spec'];

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
            if (name === 'tests' || name === '__tests__' || name === 'node_modules') continue;
            out.push(...walk(p));
        } else if (st.isFile() && (p.endsWith('.ts') || p.endsWith('.tsx'))) {
            out.push(p);
        }
    }
    return out;
}

describe('xt spec composition-gate guard', () => {
    for (const sub of ALLOWED_DIRS) {
        it(`no forbidden bypass under ${sub}/`, () => {
            const files = walk(resolve(cliSrc, sub));
            for (const f of files) {
                const src = readFileSync(f, 'utf8');
                for (const p of FORBIDDEN_PATTERNS) {
                    if (p.re.test(src)) {
                        throw new Error(`forbidden pattern "${p.name}" found in ${f}`);
                    }
                }
            }
            expect(files.length).toBeGreaterThan(0);
        });
    }
});
