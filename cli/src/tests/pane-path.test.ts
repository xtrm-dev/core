// CORE-2524.4: a launched pane must resolve `gh` to the xtrm shim, and a tmux
// pane inherits the server's PATH rather than the launcher's.

import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { defaultGhShimPath } from '../core/gh-shim.js';
import { panePath, shimBinDir } from '../core/pane-path.js';

const D = path.delimiter;

describe('panePath (CORE-2524.4)', () => {
    it('is the directory `xt identity setup` installs the shim into', () => {
        expect(shimBinDir({ HOME: '/home/worker' })).toBe(path.join('/home/worker', '.local', 'bin'));
        expect(shimBinDir({ HOME: '/home/worker' })).toBe(path.dirname(defaultGhShimPath({ home: '/home/worker' })));
    });

    it('falls back to the OS home when HOME is unset', () => {
        expect(shimBinDir({})).toBe(path.join(os.homedir(), '.local', 'bin'));
    });

    it('prepends the shim directory when the PATH does not contain it', () => {
        expect(panePath({ HOME: '/home/worker', PATH: `/usr/bin${D}/bin` })).toBe(`/home/worker/.local/bin${D}/usr/bin${D}/bin`);
    });

    it('keeps exactly one entry when the shim directory is already first', () => {
        const pane = panePath({ HOME: '/home/worker', PATH: `/home/worker/.local/bin${D}/usr/bin` });
        expect(pane).toBe(`/home/worker/.local/bin${D}/usr/bin`);
        expect(pane.split(D).filter((entry) => entry === '/home/worker/.local/bin')).toHaveLength(1);
    });

    it('removes a later duplicate instead of adding a second one', () => {
        const pane = panePath({ HOME: '/home/worker', PATH: `/usr/bin${D}/home/worker/.local/bin${D}/bin` });
        expect(pane).toBe(`/home/worker/.local/bin${D}/usr/bin${D}/bin`);
    });

    it('drops empty segments, which would mean the current directory', () => {
        expect(panePath({ HOME: '/home/worker', PATH: `${D}/usr/bin${D}${D}/bin${D}` })).toBe(`/home/worker/.local/bin${D}/usr/bin${D}/bin`);
    });

    it('returns just the shim directory when PATH is unset or empty', () => {
        expect(panePath({ HOME: '/home/worker' })).toBe('/home/worker/.local/bin');
        expect(panePath({ HOME: '/home/worker', PATH: '' })).toBe('/home/worker/.local/bin');
    });
});
