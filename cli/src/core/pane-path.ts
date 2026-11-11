// CORE-2524.4: a launched pane must resolve `gh` to the xtrm shim.
//
// `tmux new-session` starts the pane with the tmux SERVER's environment, not the
// launcher's (see the comment at LAUNCH_FORWARDED_ENV in utils/worktree-session.ts),
// and tmux's `update-environment` list does not include PATH. So a launcher whose
// PATH holds `~/.local/bin` can still produce a pane whose PATH does not, and the
// pane's `gh` is the real binary: a review then posts under the operator identity.
//
// The launcher therefore computes the pane PATH here and forwards it with `-e`.
// Current-pane and direct spawns inherit this process's environment and need no
// change.

import os from 'node:os';
import path from 'node:path';

import { defaultGhShimPath } from './gh-shim.js';

/** The directory `xt identity setup` installs the `gh` shim into: one source. */
export function shimBinDir(env: NodeJS.ProcessEnv = process.env): string {
    return path.dirname(defaultGhShimPath({ home: env.HOME || os.homedir() }));
}

/**
 * The PATH a launched pane gets: the launcher's PATH with the shim directory
 * first. Empty segments are dropped (an empty entry means "the current
 * directory") and duplicates are removed, so a PATH that already starts with the
 * shim keeps exactly one entry.
 */
export function panePath(env: NodeJS.ProcessEnv = process.env): string {
    const shim = shimBinDir(env);
    const seen = new Set<string>([shim]);
    const entries = [shim];
    for (const raw of (env.PATH ?? '').split(path.delimiter)) {
        const entry = raw.trim();
        if (!entry || seen.has(entry)) continue;
        seen.add(entry);
        entries.push(entry);
    }
    return entries.join(path.delimiter);
}
