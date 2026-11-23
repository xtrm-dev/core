import { describe, expect, it } from 'vitest';
import {
    parseLaunchPlacementConfig,
    resolvePlacement,
    validateLayout,
} from '../utils/tmux-placement.js';

describe('tmux placement', () => {
    it('parses the versioned launch config and rejects invalid values', () => {
        expect(parseLaunchPlacementConfig({ version: 1, placement: { worker: 'workers' } })).toMatchObject({
            version: 1,
            workersMaxPanes: 4,
            placement: { worker: 'workers' },
        });
        expect(() => parseLaunchPlacementConfig({ version: 2, placement: {} })).toThrow(/version must be 1/);
        expect(() => parseLaunchPlacementConfig({ version: 1, placement: { worker: 'bogus' } })).toThrow(/unsupported value/);
    });

    it('gives explicit placement precedence over role defaults', () => {
        const result = resolvePlacement({ role: 'worker', pane: '%7', insideTmux: true }, {
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, placement: { worker: 'workers' } }),
            tmux: () => ({ status: 0, stdout: 'dev' }),
        });
        expect(result.kind).toBe('pane');
        expect(result.target).toBe('%7');
    });

    it('resolves a configured pane target against the selected session', () => {
        const result = resolvePlacement({ role: 'board-helper', insideTmux: true }, {
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, session: 'project', placement: { 'board-helper': 'pane:manager' } }),
        });
        expect(result).toMatchObject({ kind: 'pane', session: 'project', target: 'project:manager', layout: 'tiled' });
    });

    it('selects a workers window with capacity and lays it out', () => {
        const result = resolvePlacement({ workers: true, session: 'project', insideTmux: true, layout: 'even-horizontal' }, {
            exists: () => false,
            tmux: (args) => args[0] === 'list-windows'
                ? { status: 0, stdout: '@1\tworkers\t2\n@2\tworkers-2\t4' }
                : { status: 0, stdout: '' },
        });
        expect(result).toMatchObject({ kind: 'workers', target: '@1', existingWindow: true, layout: 'even-horizontal' });
    });

    it('honors --session as the target while keeping workers placement', () => {
        const result = resolvePlacement({ role: 'worker', workers: true, session: 'project', insideTmux: false }, {
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, placement: { worker: 'workers' } }),
            tmux: (args) => args[0] === 'list-windows' ? { status: 0, stdout: '@1\tworkers\t1' } : { status: 0, stdout: '' },
        });
        expect(result).toMatchObject({ kind: 'workers', session: 'project', target: '@1' });
    });

    it('creates the base workers window before numbered rollover windows', () => {
        const result = resolvePlacement({ workers: true, session: 'project', insideTmux: true }, {
            exists: () => false,
            tmux: (args) => args[0] === 'list-windows' ? { status: 0, stdout: '@1\tmain\t1' } : { status: 0, stdout: '' },
        });
        expect(result).toMatchObject({ kind: 'workers', target: 'project:', windowName: 'workers', existingWindow: false });
    });

    it('makes --new-session override configured workers placement', () => {
        const result = resolvePlacement({ role: 'worker', newSession: true, insideTmux: true }, {
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, placement: { worker: 'workers' } }),
        });
        expect(result.kind).toBe('session');
    });

    it('rolls over to workers-2 and workers-3 at the cap', () => {
        const deps = { exists: () => false, tmux: () => ({ status: 0, stdout: '@1\tworkers\t4\n@2\tother\t1' }) };
        expect(resolvePlacement({ workers: true, session: 'project', insideTmux: true }, deps)).toMatchObject({ windowName: 'workers-2' });
        const deps3 = { exists: () => false, tmux: () => ({ status: 0, stdout: '@1\tworkers\t4\n@2\tworkers-2\t4' }) };
        expect(resolvePlacement({ workers: true, session: 'project', insideTmux: true }, deps3)).toMatchObject({ windowName: 'workers-3' });
    });

    it('resolves current placement without reading the host config', () => {
        expect(resolvePlacement({ insideTmux: true }, { exists: () => false })).toMatchObject({ kind: 'current' });
    });

    it('rejects bad config naming the file', () => {
        expect(() => resolvePlacement({ insideTmux: true }, { exists: () => true, readFile: () => '{bad', home: '/tmp/test-home' })).toThrow(/invalid launch config/);
    });

    it('honors workersMaxPanes', () => {
        const result = resolvePlacement({ workers: true, session: 'project', insideTmux: true }, {
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, workersMaxPanes: 2, placement: {} }),
            tmux: () => ({ status: 0, stdout: '@1\tworkers\t2' }),
        });
        expect(result.windowName).toBe('workers-2');
    });

    it('preserves outside-tmux defaults unless an explicit session exists', () => {
        expect(resolvePlacement({ window: true, insideTmux: false }, { exists: () => false })).toMatchObject({ kind: 'session' });
        expect(resolvePlacement({ role: 'lead', insideTmux: false }, {
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, placement: { lead: 'window' } }),
        })).toMatchObject({ kind: 'session' });
        expect(resolvePlacement({ role: 'lead', insideTmux: false }, { exists: () => false })).toMatchObject({ kind: 'session' });
        expect(resolvePlacement({ role: 'lead', insideTmux: false }, {
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, session: 'project', placement: { lead: 'window' } }),
        })).toMatchObject({ kind: 'window', session: 'project' });
    });

    it('validates layouts', () => {
        expect(() => validateLayout('tiled')).not.toThrow();
        expect(() => validateLayout('bad layout')).toThrow(/invalid tmux layout/);
    });
});
