import { describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
    prompts: vi.fn(),
}));

vi.mock('prompts', () => ({
    default: mocked.prompts,
}));

import { interactivePlan } from '../src/core/interactive-plan.js';
import type { PreflightPlan } from '../src/core/preflight.js';

describe('interactivePlan', () => {
    it('keeps only preselected defaults when yes=true', async () => {
        const plan: PreflightPlan = {
            repoRoot: '/repo',
            syncMode: 'copy',
            targets: [
                {
                    target: '/repo/.claude',
                    label: 'claude',
                    agent: 'claude',
                    changeSet: {} as PreflightPlan['targets'][number]['changeSet'],
                    files: [
                        { name: 'missing.ts', status: 'missing', category: 'src' },
                        { name: 'outdated.ts', status: 'outdated', category: 'src' },
                        { name: 'drifted.ts', status: 'drifted', category: 'src' },
                    ],
                    mcpCore: [
                        { name: 'serena', installed: false },
                        { name: 'old-server', installed: true },
                    ],
                },
            ],
            optionalServers: [
                { name: 'optional', description: 'optional server' },
            ],
        };

        const result = await interactivePlan(plan, { yes: true });

        expect(result).not.toBeNull();
        expect(result).toMatchObject({
            repoRoot: '/repo',
            syncMode: 'copy',
            files: [
                { name: 'missing.ts', status: 'missing' },
                { name: 'outdated.ts', status: 'outdated' },
            ],
            mcpCore: [
                { name: 'serena', agent: 'claude' },
            ],
            optionalServers: [],
        });
    });
});
