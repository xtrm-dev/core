// CORE-2801: the agent identity schema (docs/agent-identity.md) — ownership options,
// legacy fallbacks, child launch identity and the exited-agent state.
import { describe, expect, it } from 'vitest';
import { applyPaneOptions, buildAgentEnv, relationshipPaneOptions, stripInheritedLaunchEnv } from '../utils/worktree-session.js';
import { restoredAttachPaneOptions, RESTORED_PANE_KEYS } from '../commands/attach.js';
import { issueFromPaneListing } from '../utils/worktree-pane-issue.js';
import { effectiveAgentState, parsePanes } from '../core/topology-projection.js';


describe('relationshipPaneOptions', () => {
    it('writes holder, dispatcher participant and parent pane', () => {
        expect(relationshipPaneOptions({
            holder: 'w1',
            dispatcherEnv: { XTRM_DISPATCHER_PARTICIPANT: 'lead-a', XTRM_DISPATCHER_NAME: 'Lead A', XTRM_PARENT_PANE_ID: '%7' },
        })).toEqual([
            { key: '@agent_holder', value: 'w1' },
            { key: '@agent_dispatcher', value: 'lead-a' },
            { key: '@agent_parent_pane', value: '%7' },
        ]);
    });
    it('keeps unknown values absent', () => {
        expect(relationshipPaneOptions({ holder: 'w1', dispatcherEnv: {} })).toEqual([{ key: '@agent_holder', value: 'w1' }]);
    });
    it('exports the options under the XTMUX_AGENT_ names, never the legacy BEAD name', () => {
        const env = buildAgentEnv([{ key: '@agent_issue', value: 'CORE-1' }, { key: '@agent_holder', value: 'w1' }]);
        expect(env).toEqual({ XTMUX_AGENT_ISSUE: 'CORE-1', XTMUX_AGENT_HOLDER: 'w1' });
    });
});

describe('relationshipPaneOptions dispatcher', () => {
    it('writes only the Substrate participant, never the display name', () => {
        expect(relationshipPaneOptions({ holder: 'w1', dispatcherEnv: { XTRM_DISPATCHER_NAME: 'Lead A' } }))
            .toEqual([{ key: '@agent_holder', value: 'w1' }]);
    });
});

describe('applyPaneOptions', () => {
    it('unsets every identity key the launch does not write, legacy included', () => {
        const calls: string[][] = [];
        applyPaneOptions('%5', [{ key: '@agent_issue', value: 'CORE-1' }, { key: '@agent_role', value: 'worker' }], (_c, args) => { calls.push(args); });
        const unset = calls.filter(a => a.includes('-u')).map(a => a[a.length - 1]);
        expect(unset.sort()).toEqual(['@agent_bead', '@agent_dispatcher', '@agent_holder', '@agent_parent_pane']);
        expect(calls.filter(a => !a.includes('-u')).map(a => a.slice(-2))).toEqual([['@agent_issue', 'CORE-1'], ['@agent_role', 'worker']]);
    });
});

describe('child launch identity', () => {
    it('drops the parent agent identity from the inherited environment', () => {
        const env = stripInheritedLaunchEnv({
            XTMUX_AGENT_ROLE: 'lead', XTMUX_AGENT_ISSUE: 'CORE-1', XTMUX_AGENT_BEAD: 'CORE-1', XTMUX_AGENT_HOLDER: 'lead-a',
            XTMUX_AGENT_PARENT_PANE: '%1', XTMUX_AGENT_RUNTIME: 'claude', PATH: '/bin',
        });
        expect(env).toEqual({ XTMUX_AGENT_RUNTIME: 'claude', PATH: '/bin' });
    });
});

describe('attach restore', () => {
    it('restores holder and dispatcher, never a parent pane, and clears the legacy option', () => {
        const options = restoredAttachPaneOptions({
            launch: null, worktreePath: '/r/.xtrm/worktrees/r-xt-claude-w1', branch: 'xt/w1', issue: 'CORE-1',
            holder: 'w1', dispatcher: 'lead-a',
        });
        expect(options).toEqual(expect.arrayContaining([
            { key: '@agent_issue', value: 'CORE-1' },
            { key: '@agent_holder', value: 'w1' },
            { key: '@agent_dispatcher', value: 'lead-a' },
        ]));
        expect(options.some(option => option.key === '@agent_parent_pane')).toBe(false);
        expect(options.some(option => option.key === '@agent_bead')).toBe(false);
        expect(RESTORED_PANE_KEYS).toContain('@agent_bead');
    });
});

describe('pane listing legacy fallback', () => {
    it('reads @agent_issue first and @agent_bead for a pane launched before the rename', () => {
        expect(issueFromPaneListing('/w\t/w\tCORE-2\tXTRM-9\n', '/w')).toBe('CORE-2');
        expect(issueFromPaneListing('/w\t/w\t\tXTRM-9\n', '/w')).toBe('XTRM-9');
    });
});

describe('topology pane rows', () => {
    const SEP = '\t';
    const row = (cmd: string, state: string, issue: string, legacy: string) =>
        ['%1', '$1', 's', '@1', cmd, '/r', state, 'worker', 't', issue, legacy, '', '', '', '', '', '0', '0', '1', '1', 'w'].join(SEP);
    it('reads the legacy bead column when @agent_issue is empty', () => {
        expect(parsePanes(row('claude', 'running', '', 'XTRM-9'))[0]?.agent?.bead_id).toBe('XTRM-9');
        expect(parsePanes(row('claude', 'running', 'CORE-2', 'XTRM-9'))[0]?.agent?.bead_id).toBe('CORE-2');
    });
    it('publishes a live state on a login shell as exited', () => {
        expect(effectiveAgentState('running', 'zsh')).toBe('exited');
        expect(effectiveAgentState('needs-input', 'bash')).toBe('exited');
        expect(effectiveAgentState('running', 'claude')).toBe('running');
        expect(effectiveAgentState('done', 'zsh')).toBe('done');
        expect(effectiveAgentState('', 'zsh')).toBeNull();
        expect(parsePanes(row('zsh', 'running', 'CORE-2', ''))[0]?.agent?.state).toBe('exited');
    });
});
