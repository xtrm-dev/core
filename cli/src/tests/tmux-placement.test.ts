import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    parseLaunchPlacementConfig,
    resolvePlacement,
    validateLayout,
} from '../utils/tmux-placement.js';
import type { PlacementDeps } from '../utils/tmux-placement.js';

// CORE-2802: the target session is resolved in one order (docs/tmux-placement.md). Every
// case passes the environment explicitly, so a test never depends on whether the host that
// runs it is inside tmux.
const NO_TMUX: NodeJS.ProcessEnv = {};

afterEach(() => {
    vi.restoreAllMocks();
});

function config(value: unknown): Pick<PlacementDeps, 'exists' | 'readFile'> {
    return { exists: () => true, readFile: () => JSON.stringify(value) };
}

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
            env: NO_TMUX,
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, placement: { worker: 'workers' } }),
            tmux: () => ({ status: 0, stdout: 'dev' }),
        });
        expect(result.kind).toBe('pane');
        expect(result.target).toBe('%7');
    });

    it('resolves a configured pane target against the selected session', () => {
        const result = resolvePlacement({ role: 'board-helper', insideTmux: true }, {
            env: NO_TMUX,
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, session: 'project', placement: { 'board-helper': 'pane:manager' } }),
        });
        expect(result).toMatchObject({ kind: 'pane', session: 'project', target: 'project:manager', layout: 'tiled' });
    });

    it('selects a workers window with capacity and lays it out', () => {
        const result = resolvePlacement({ workers: true, session: 'project', insideTmux: true, layout: 'even-horizontal' }, {
            env: NO_TMUX,
            exists: () => false,
            tmux: (args) => args[0] === 'list-windows'
                ? { status: 0, stdout: '@1|workers|2\n@2|workers-2|4' }
                : { status: 0, stdout: '' },
        });
        expect(result).toMatchObject({ kind: 'workers', target: '@1', existingWindow: true, layout: 'even-horizontal' });
    });

    it('honors --session as the target while keeping workers placement', () => {
        const result = resolvePlacement({ role: 'worker', workers: true, session: 'project', insideTmux: false }, {
            env: NO_TMUX,
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, placement: { worker: 'workers' } }),
            tmux: (args) => args[0] === 'list-windows' ? { status: 0, stdout: '@1|workers|1' } : { status: 0, stdout: '' },
        });
        expect(result).toMatchObject({ kind: 'workers', session: 'project', target: '@1' });
    });

    it('creates the base workers window before numbered rollover windows', () => {
        const result = resolvePlacement({ workers: true, session: 'project', insideTmux: true }, {
            env: NO_TMUX,
            exists: () => false,
            tmux: (args) => args[0] === 'list-windows' ? { status: 0, stdout: '@1|main|1' } : { status: 0, stdout: '' },
        });
        expect(result).toMatchObject({ kind: 'workers', target: 'project:', windowName: 'workers', existingWindow: false });
    });

    it('makes --new-session override configured workers placement', () => {
        const result = resolvePlacement({ role: 'worker', newSession: true, insideTmux: true }, {
            env: NO_TMUX,
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, placement: { worker: 'workers' } }),
        });
        expect(result.kind).toBe('session');
    });

    it('rolls over to workers-2 and workers-3 at the cap', () => {
        const deps = { env: NO_TMUX, exists: () => false, tmux: () => ({ status: 0, stdout: '@1|workers|4\n@2|other|1' }) };
        expect(resolvePlacement({ workers: true, session: 'project', insideTmux: true }, deps)).toMatchObject({ windowName: 'workers-2' });
        const deps3 = { env: NO_TMUX, exists: () => false, tmux: () => ({ status: 0, stdout: '@1|workers|4\n@2|workers-2|4' }) };
        expect(resolvePlacement({ workers: true, session: 'project', insideTmux: true }, deps3)).toMatchObject({ windowName: 'workers-3' });
    });

    it('resolves current placement without reading the host config', () => {
        expect(resolvePlacement({ insideTmux: true }, { env: NO_TMUX, exists: () => false })).toMatchObject({ kind: 'current' });
    });

    it('rejects bad config naming the file', () => {
        expect(() => resolvePlacement({ insideTmux: true }, { env: NO_TMUX, exists: () => true, readFile: () => '{bad', home: '/tmp/test-home' })).toThrow(/invalid launch config/);
    });

    it('honors workersMaxPanes', () => {
        const result = resolvePlacement({ workers: true, session: 'project', insideTmux: true }, {
            env: NO_TMUX,
            exists: () => true,
            readFile: () => JSON.stringify({ version: 1, workersMaxPanes: 2, placement: {} }),
            tmux: () => ({ status: 0, stdout: '@1|workers|2' }),
        });
        expect(result.windowName).toBe('workers-2');
    });

    it('preserves outside-tmux defaults unless an explicit session exists', () => {
        expect(resolvePlacement({ window: true, insideTmux: false }, { env: NO_TMUX, exists: () => false })).toMatchObject({ kind: 'session' });
        expect(resolvePlacement({ role: 'lead', insideTmux: false }, {
            env: NO_TMUX,
            ...config({ version: 1, placement: { lead: 'window' } }),
        })).toMatchObject({ kind: 'session' });
        expect(resolvePlacement({ role: 'lead', insideTmux: false }, { env: NO_TMUX, exists: () => false })).toMatchObject({ kind: 'session' });
        expect(resolvePlacement({ role: 'lead', insideTmux: false }, {
            env: NO_TMUX,
            ...config({ version: 1, session: 'project', placement: { lead: 'window' } }),
        })).toMatchObject({ kind: 'window', session: 'project' });
    });

    it('validates layouts', () => {
        expect(() => validateLayout('tiled')).not.toThrow();
        expect(() => validateLayout('bad layout')).toThrow(/invalid tmux layout/);
    });
});

// The resolution order: explicit --session, the caller's own session (pane id, then $TMUX,
// then the launcher's exports), the configured session, a new session announced on stderr.
describe('placement session resolution order (CORE-2802)', () => {
    const sessionProbe = (valid: string[], answer = '$3') => {
        const calls: string[][] = [];
        const tmux = (args: string[]): { status: number | null; stdout?: string } => {
            calls.push(args);
            if (args[0] === 'list-windows') return { status: 0, stdout: '@1|workers|1' };
            const at = args.indexOf('-t');
            if (at === -1) return { status: 0, stdout: answer };
            const target = args[at + 1];
            return valid.includes(target) ? { status: 0, stdout: answer } : { status: 1, stdout: '' };
        };
        return { calls, tmux };
    };

    it('places a caller without $TMUX in its pane session, in the workers window of that session', () => {
        const { calls, tmux } = sessionProbe(['%5']);
        const result = resolvePlacement({ role: 'worker', insideTmux: false }, {
            env: { TMUX_PANE: '%5' },
            ...config({ version: 1, session: 'fallback', placement: { worker: 'workers' } }),
            tmux,
        });
        expect(result).toMatchObject({ kind: 'workers', session: '$3', target: '@1' });
        expect(calls[0]).toEqual(['display-message', '-p', '-t', '%5', '#{session_id}']);
    });

    it('places a caller without $TMUX in a window of its pane session when no role rule applies', () => {
        const { tmux } = sessionProbe(['%5']);
        expect(resolvePlacement({ insideTmux: false }, { env: { TMUX_PANE: '%5' }, exists: () => false, tmux }))
            .toMatchObject({ kind: 'window', session: '$3' });
    });

    it('prefers the caller pane over $TMUX and over the exported identity', () => {
        const calls: string[][] = [];
        const tmux = (args: string[]): { status: number | null; stdout?: string } => {
            calls.push(args);
            if (args[0] === 'list-windows') return { status: 0, stdout: '@1|workers|1' };
            const target = args[args.indexOf('-t') + 1];
            if (target === '%5') return { status: 0, stdout: '$3' };
            if (target === undefined) return { status: 0, stdout: '$4' };
            return { status: 0, stdout: '$9' };
        };
        const result = resolvePlacement({ workers: true, insideTmux: true }, {
            env: { TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%5', XTRM_SESSION_ID: '$9' },
            exists: () => false,
            tmux,
        });
        expect(result).toMatchObject({ kind: 'workers', session: '$3' });
        expect(calls.some(args => args.includes('%5'))).toBe(true);
    });

    it('falls back to $TMUX, then XTRM_SESSION_ID, XTRM_SESSION_NAME and XTRM_PARENT_SESSION_ID', () => {
        const tmuxSession = sessionProbe(['$4'], '$4');
        expect(resolvePlacement({ window: true, insideTmux: false }, {
            env: { TMUX: '/tmp/tmux-1000/default,1,0' },
            exists: () => false,
            tmux: tmuxSession.tmux,
        })).toMatchObject({ kind: 'window', session: '$4' });

        const fromId = sessionProbe(['$9'], '$9');
        expect(resolvePlacement({ window: true, insideTmux: false }, {
            env: { XTRM_SESSION_ID: '$9' },
            exists: () => false,
            tmux: fromId.tmux,
        })).toMatchObject({ kind: 'window', session: '$9' });

        const fromName = sessionProbe(['lead'], '$4');
        expect(resolvePlacement({ window: true, insideTmux: false }, {
            env: { XTRM_SESSION_ID: '$9', XTRM_SESSION_NAME: 'lead' },
            exists: () => false,
            tmux: fromName.tmux,
        })).toMatchObject({ kind: 'window', session: '$4' });

        const fromParent = sessionProbe(['$2'], '$2');
        expect(resolvePlacement({ window: true, insideTmux: false }, {
            env: { XTRM_PARENT_SESSION_ID: '$2' },
            exists: () => false,
            tmux: fromParent.tmux,
        })).toMatchObject({ kind: 'window', session: '$2' });
    });

    it('resolves the dispatcher session from the parent pane id a worker shell carries', () => {
        const { calls, tmux } = sessionProbe(['%12']);
        expect(resolvePlacement({ role: 'worker', insideTmux: false }, {
            env: { XTRM_PARENT_PANE_ID: '%12' },
            ...config({ version: 1, placement: { worker: 'workers' } }),
            tmux,
        })).toMatchObject({ kind: 'workers', session: '$3' });
        expect(calls[0]).toEqual(['display-message', '-p', '-t', '%12', '#{session_id}']);
    });

    it('ignores a stale identity and uses the configured session instead', () => {
        const { calls, tmux } = sessionProbe(['$9']);
        const result = resolvePlacement({ role: 'worker', insideTmux: false }, {
            env: { XTRM_SESSION_ID: '$8' },
            ...config({ version: 1, session: 'project', placement: { worker: 'workers' } }),
            tmux,
        });
        expect(result).toMatchObject({ kind: 'workers', session: 'project', target: '@1' });
        expect(calls).toEqual([['display-message', '-p', '-t', '$8', '#{session_id}'], ['list-windows', '-t', 'project', '-F', '#{window_id}|#{window_name}|#{window_panes}']]);
    });

    it('uses the configured session without probing tmux when the caller has no identity', () => {
        const calls: string[][] = [];
        const result = resolvePlacement({ role: 'worker', insideTmux: false }, {
            env: NO_TMUX,
            ...config({ version: 1, session: 'project', placement: { worker: 'workers' } }),
            tmux: (args) => {
                calls.push(args);
                return { status: 0, stdout: '@1|workers|1' };
            },
        });
        expect(result).toMatchObject({ kind: 'workers', session: 'project', target: '@1' });
        expect(calls.every(args => args[0] === 'list-windows')).toBe(true);
    });

    it('gives the explicit --session flag the last word over the caller identity', () => {
        const calls: string[][] = [];
        resolvePlacement({ workers: true, session: 'explicit', insideTmux: false }, {
            env: { TMUX_PANE: '%5' },
            exists: () => false,
            tmux: (args) => {
                calls.push(args);
                return { status: 0, stdout: '@1|workers|1' };
            },
        });
        expect(calls.some(args => args.includes('%5'))).toBe(false);
    });

    it('turns the current-pane rule into a window of the caller session when $TMUX is absent', () => {
        const { tmux } = sessionProbe(['%5']);
        expect(resolvePlacement({ role: 'worker', insideTmux: false }, {
            env: { TMUX_PANE: '%5' },
            ...config({ version: 1, placement: { worker: 'current' } }),
            tmux,
        })).toMatchObject({ kind: 'window', session: '$3' });
    });

    it('announces the new session on stderr only as a last resort', () => {
        const written: string[] = [];
        vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
            written.push(String(chunk));
            return true;
        }) as never);
        const result = resolvePlacement({ workers: true, insideTmux: false }, { env: NO_TMUX, exists: () => false });
        expect(result.kind).toBe('session');
        expect(written.join('')).toContain('no tmux session to place this launch in');
    });
});
