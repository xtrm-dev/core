// CORE-2811: one separator rule for every tmux listing in the CLI.
//
// A tmux format argument must use a separator tmux keeps (a control character is
// rewritten to '_' under a non-UTF-8 locale, CORE-2802), and the separator alone
// cannot delimit a field because '|' is legal inside a session name, a window
// name, a branch name and a path. So every field is quoted with tmux's `q:`
// modifier and every reader splits only on separators outside a quoted value.
//
// These tests pin both halves: the decoder (both quoting shapes tmux has used) and
// the invariant every shipped format must keep. The invariant is asserted against
// the exported format STRINGS, not against source text, so a separator constant
// reverted to a TAB, or a field left unquoted, fails here — the two mutations that
// a line-local source scan missed (CORE-2811 review).

import { describe, expect, it } from 'vitest';

import {
    TMUX_FIELD_SEP,
    assertQuotedFormat,
    formatExpansions,
    hasControlCharacter,
    splitTmuxFields,
    tmuxField,
} from '../core/tmux-format.js';
import { LIVE_SESSION_LISTING_FORMAT } from '../core/launch-outcome.js';
import { PANE_FORMAT as RELEASE_PANE_FORMAT } from '../core/worktree-release-pane.js';
import { READ_ONLY_COMMANDS } from '../core/topology-projection.js';
import { PANE_LISTING_FORMAT } from '../utils/worktree-pane-issue.js';

describe('splitTmuxFields: one row, back to the values tmux held', () => {
    it('decodes the backslash quoting tmux 3.x emits', () => {
        // Exactly what `#{q:...}` printed on this host's tmux for these values.
        expect(splitTmuxFields('a\\|b|\\$7')).toEqual({ fields: ['a|b', '$7'], ok: true });
        expect(splitTmuxFields('a\\ b|it\\\'s|a\\\\b')).toEqual({ fields: ['a b', "it's", 'a\\b'], ok: true });
        expect(splitTmuxFields('\\%3|plain|c\\;d')).toEqual({ fields: ['%3', 'plain', 'c;d'], ok: true });
    });

    it('decodes the single-quote quoting older tmux emits', () => {
        expect(splitTmuxFields("'a|b'|'$7'")).toEqual({ fields: ['a|b', '$7'], ok: true });
        // A quote inside the value is the shell idiom tmux uses: 'it'\''s'.
        expect(splitTmuxFields("'it'\\''s'|x")).toEqual({ fields: ["it's", 'x'], ok: true });
        expect(splitTmuxFields("'/repo/a|b'|'/repo/a|b/.xtrm/worktrees/x'|''|''")).toEqual({
            fields: ['/repo/a|b', '/repo/a|b/.xtrm/worktrees/x', '', ''],
            ok: true,
        });
    });

    it('keeps an empty field empty and a value holding the separator intact', () => {
        expect(splitTmuxFields('||')).toEqual({ fields: ['', '', ''], ok: true });
        expect(splitTmuxFields('a\\||b')).toEqual({ fields: ['a|', 'b'], ok: true });
        expect(splitTmuxFields('')).toEqual({ fields: [''], ok: true });
    });

    it('reports an unbalanced row instead of slicing it into shifted fields', () => {
        expect(splitTmuxFields("'a|b")).toEqual({ fields: ['a|b'], ok: false });
    });

    it('reads an unquoted fixture in the same shape', () => {
        // Fixtures written before this rule (and rows from a format without quoting)
        // decode unchanged: the decoder only acts on a quote or a backslash.
        expect(splitTmuxFields('pi-json|$3')).toEqual({ fields: ['pi-json', '$3'], ok: true });
        expect(splitTmuxFields('/repo|xt/a|CORE-1|')).toEqual({ fields: ['/repo', 'xt/a', 'CORE-1', ''], ok: true });
    });
});

describe('the CORE-2811 format invariant', () => {
    const shipped: Array<[string, string]> = [
        ['launch-outcome.LIVE_SESSION_LISTING_FORMAT', LIVE_SESSION_LISTING_FORMAT],
        ['worktree-pane-issue.PANE_LISTING_FORMAT', PANE_LISTING_FORMAT],
        ['worktree-release-pane.PANE_FORMAT', RELEASE_PANE_FORMAT],
        ['topology-projection.READ_ONLY_COMMANDS.tmux', READ_ONLY_COMMANDS.tmux.args.at(-1) as string],
    ];

    it('uses a printable separator, never a control character', () => {
        expect(hasControlCharacter(TMUX_FIELD_SEP)).toBe(false);
        expect(TMUX_FIELD_SEP.length).toBe(1);
        for (const [label, format] of shipped) {
            expect(hasControlCharacter(format), label).toBe(false);
        }
    });

    it('quotes every field, so a value holding the separator cannot split the row', () => {
        for (const [label, format] of shipped) {
            expect(() => assertQuotedFormat(format, label), label).not.toThrow();
            expect(formatExpansions(format).every((f) => f.startsWith('q:')), label).toBe(true);
        }
    });

    it('catches the mutations a line-local source scan missed', () => {
        // A separator constant reverted to a TAB: the format string itself now holds
        // the control character the reviewer's `const SEP = '\t'` mutation produced.
        expect(() => assertQuotedFormat(['#{q:a}', '#{q:b}'].join('\t'), 'tab-separated')).toThrow(/control character/);
        // A field left unquoted, which a hard split would slice when it holds '|'.
        expect(() => assertQuotedFormat('#{session_name}|#{q:session_id}', 'unquoted')).toThrow(/#\{session_name\}/);
        // A literal TAB byte, not the escape text: same failure, no regex loophole.
        expect(() => assertQuotedFormat('#{q:session_name}\t#{q:session_id}', 'literal')).toThrow(/control character/);
    });

    it('builds a field expression that tmux quotes', () => {
        expect(tmuxField('session_name')).toBe('#{q:session_name}');
        expect(formatExpansions(tmuxField('@agent_worktree'))).toEqual(['q:@agent_worktree']);
    });
});
