import { describe, expect, it } from 'vitest';
import { buildFreshLaunchOptions, freshOnlyOptions, readFreshPrompt } from '../commands/attach.js';
import { withRestoredDispatcher } from '../core/dispatcher-identity.js';
import type { WorktreeInfo } from '../commands/worktree.js';

// CORE-2775: the pure part of `xt attach --fresh`.
const wt = (over: Partial<WorktreeInfo> = {}): WorktreeInfo => ({
  path: '/r/.xtrm/worktrees/core-xt-claude-lead-a', branch: 'refs/heads/xt/lead-a', runtime: 'claude', ...over,
}) as WorktreeInfo;

describe('buildFreshLaunchOptions', () => {
  it('takes slug, branch, bead and the restored dispatcher from the worktree, flags from the caller', () => {
    const o = buildFreshLaunchOptions(wt(), { role: 'lead', model: 'opus', prompt: 'go', attach: false, newSession: true, parent: '$2' }, {
      issue: { ref: 'CORE-1', source: 'meta', bindingId: 'b1' },
      dispatcher: { XTRM_DISPATCHER_PARTICIPANT: 'g04z' },
    });
    expect(o).toMatchObject({ runtime: 'claude', role: 'lead', model: 'opus', prompt: 'go', bead: 'CORE-1', attach: false, newSession: true, parent: '$2' });
    expect(o.existingWorktree).toEqual({
      path: '/r/.xtrm/worktrees/core-xt-claude-lead-a', branch: 'xt/lead-a', slug: 'lead-a',
      dispatcher: { XTRM_DISPATCHER_PARTICIPANT: 'g04z' },
    });
  });
  it('an explicit --bead wins; no issue and no bead leaves it absent', () => {
    expect(buildFreshLaunchOptions(wt(), { bead: 'X-2' }, { issue: { ref: 'CORE-1', source: 'meta', bindingId: null }, dispatcher: {} }).bead).toBe('X-2');
    expect(buildFreshLaunchOptions(wt(), {}, { issue: null, dispatcher: {} }).bead).toBeUndefined();
  });
  it('rejects a worktree whose name carries no holder', () => {
    expect(() => buildFreshLaunchOptions(wt({ path: '/r/odd-dir' }), {}, { issue: null, dispatcher: {} })).toThrow(/cannot derive its holder/);
  });
});

describe('readFreshPrompt', () => {
  it('reads @file, passes text through', () => {
    expect(readFreshPrompt('plain')).toBe('plain');
    expect(readFreshPrompt('@/x/y', (f) => `body of ${f}`)).toBe('body of /x/y');
    expect(readFreshPrompt(undefined)).toBeUndefined();
  });
});

describe('withRestoredDispatcher', () => {
  it('drops the caller-resolved dispatcher keys and keeps only the restored ones; other keys stay', () => {
    const env = { SUBSTRATE_HOLDER: 'h', XTRM_DISPATCHER_NAME: 'caller', XTRM_DISPATCHER_ADDRESS: 'uds:/c', XTRM_DISPATCHER_PARTICIPANT: 'caller', XTRM_PARENT_PANE_ID: '%1' };
    expect(withRestoredDispatcher(env, { XTRM_DISPATCHER_PARTICIPANT: 'lead', EVIL: 'x' })).toEqual({
      SUBSTRATE_HOLDER: 'h', XTRM_PARENT_PANE_ID: '%1', XTRM_DISPATCHER_PARTICIPANT: 'lead',
    });
    expect(withRestoredDispatcher(env, {})).toEqual({ SUBSTRATE_HOLDER: 'h', XTRM_PARENT_PANE_ID: '%1' });
  });
});

describe('freshOnlyOptions', () => {
  it('names every fresh-only option that was given, and nothing for a plain attach', () => {
    expect(freshOnlyOptions({ attach: true })).toEqual([]);
    // CORE-2792 review item 1: --role is NOT fresh-only any more. A resume drops a
    // role no launch ledger names, and `xt attach <name> --role <name>` is how the
    // operator restores it, so the flag must be accepted without --fresh.
    expect(freshOnlyOptions({ role: 'r', model: 'm', prompt: 'p', bead: 'b', window: true, newSession: true, pane: 's:w', workers: true, windowName: 'workers', session: 's', layout: 'tiled', parent: '$1', attach: false, yolo: false }))
      .toEqual(['--model', '--prompt', '--bead', '--window', '--new-session', '--pane', '--workers', '--window-name', '--session', '--layout', '--parent', '--no-attach', '--no-yolo']);
  });
});
