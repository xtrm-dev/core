import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionIdentityEnv,
  resolveCurrentTmuxSessionIdentity,
  resolveTmuxSessionId,
  XTRM_SESSION_ID_VAR,
  XTRM_SESSION_NAME_VAR,
} from '../core/session-identity.js';

describe('buildSessionIdentityEnv (same values across, unknown absent)', () => {
  it('carries both observed values unchanged', () => {
    expect(buildSessionIdentityEnv({ sessionId: '$7', sessionName: 'pi-abc1' })).toEqual({
      [XTRM_SESSION_ID_VAR]: '$7',
      [XTRM_SESSION_NAME_VAR]: 'pi-abc1',
    });
  });

  it('carries a lone name or id without inventing the other half', () => {
    expect(buildSessionIdentityEnv({ sessionName: 'pi-abc1' })).toEqual({
      [XTRM_SESSION_NAME_VAR]: 'pi-abc1',
    });
    expect(buildSessionIdentityEnv({ sessionId: '$7' })).toEqual({
      [XTRM_SESSION_ID_VAR]: '$7',
    });
  });

  it('omits empty, whitespace-only, null and undefined values (non-fabrication)', () => {
    expect(buildSessionIdentityEnv({})).toEqual({});
    expect(buildSessionIdentityEnv({ sessionId: '', sessionName: '' })).toEqual({});
    expect(buildSessionIdentityEnv({ sessionId: '   ', sessionName: '\n' })).toEqual({});
    expect(buildSessionIdentityEnv({ sessionId: null, sessionName: undefined })).toEqual({});
  });

  it('trims surrounding whitespace instead of propagating it', () => {
    expect(buildSessionIdentityEnv({ sessionId: '  $7\n', sessionName: '\tpi-abc1 ' })).toEqual({
      [XTRM_SESSION_ID_VAR]: '$7',
      [XTRM_SESSION_NAME_VAR]: 'pi-abc1',
    });
  });
});

describe('resolveCurrentTmuxSessionIdentity', () => {
  const REAL_TMUX = process.env.TMUX;
  afterEach(() => {
    if (REAL_TMUX === undefined) delete process.env.TMUX;
    else process.env.TMUX = REAL_TMUX;
    vi.restoreAllMocks();
  });

  it('returns absent identity outside tmux without probing', () => {
    delete process.env.TMUX;
    const probe = vi.fn();
    expect(resolveCurrentTmuxSessionIdentity(probe)).toEqual({ sessionId: null, sessionName: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns both values when tmux answers', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    const probe = vi.fn((args: string[]) => (
      args.includes('#{session_id}')
        ? { status: 0, stdout: '$3\n' }
        : { status: 0, stdout: 'cur-sess\n' }
    ));
    expect(resolveCurrentTmuxSessionIdentity(probe)).toEqual({ sessionId: '$3', sessionName: 'cur-sess' });
  });

  it('leaves a failed half absent instead of fabricating it', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    const probe = vi.fn((args: string[]) => (
      args.includes('#{session_id}')
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: 'cur-sess\n' }
    ));
    expect(resolveCurrentTmuxSessionIdentity(probe)).toEqual({ sessionId: null, sessionName: 'cur-sess' });
  });

  it('treats blank tmux output as absent', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    const probe = vi.fn(() => ({ status: 0, stdout: '  \n' }));
    expect(resolveCurrentTmuxSessionIdentity(probe)).toEqual({ sessionId: null, sessionName: null });
  });
});

describe('resolveTmuxSessionId', () => {
  it('returns the server-assigned id for the named session', () => {
    const probe = vi.fn((args: string[]) => {
      expect(args).toEqual(['display-message', '-p', '-t', 'pi-abc1', '-F', '#{session_id}']);
      return { status: 0, stdout: '$7\n' };
    });
    expect(resolveTmuxSessionId('pi-abc1', probe)).toBe('$7');
  });

  it('returns null on probe failure, blank output, or throw (never invented)', () => {
    expect(resolveTmuxSessionId('pi-abc1', () => ({ status: 1, stdout: '' }))).toBeNull();
    expect(resolveTmuxSessionId('pi-abc1', () => ({ status: 0, stdout: '  ' }))).toBeNull();
    expect(resolveTmuxSessionId('pi-abc1', () => { throw new Error('no tmux'); })).toBeNull();
  });
});
