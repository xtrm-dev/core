/**
 * tmux listing formats: how Core builds a multi-field tmux format and how it
 * reads the row back (CORE-2811).
 *
 * Two constraints decide this shape.
 *
 * 1. The separator must be printable. Under a non-UTF-8 locale tmux rewrites a
 *    control character inside a format argument to '_' (CORE-2802), so a
 *    TAB-separated row arrives collapsed and every reader skips the row or, worse,
 *    reads one field where there were several.
 *
 * 2. The separator alone cannot delimit a field. '|' is legal inside everything
 *    these formats carry: a session name, a window name, a git branch name and a
 *    filesystem path. A hard split on it shifts every later column without an
 *    error, so a topology row reports another pane's command and a release
 *    decides on another pane's branch (CORE-2811 review).
 *
 * So every field is emitted through tmux's `q:` modifier and the reader splits
 * only on separators that sit outside a quoted value. tmux 3.x escapes with a
 * backslash (`a\|b`, `it\'s`); older versions shell-quote the value
 * (`'a|b'`, `'it'\''s'`). Both shapes are read, and a row whose quoting is
 * unbalanced is reported as unreadable instead of being sliced into shifted
 * fields. An empty value stays empty, so adjacent separators mean "absent" and
 * never "a quoted empty value".
 */

/**
 * The field separator. A printable character, decided by constraint 1 above; the
 * quoting decided by constraint 2 does the real work.
 */
export const TMUX_FIELD_SEP = '|';

/** One tmux format field, quoted so that its value cannot split the row. */
export function tmuxField(name: string): string {
    return `#{q:${name}}`;
}

export interface TmuxRow {
    /** The decoded field values, in format order. */
    fields: string[];
    /** False when a quote was opened and never closed: the row cannot be trusted. */
    ok: boolean;
}

/**
 * Split one tmux listing row into decoded field values.
 *
 * The row is what tmux printed for a format built out of `tmuxField()` joined by
 * `sep`. A separator inside a quoted value is data, not a field boundary, so a
 * value holding the separator no longer shifts its neighbours. Rows written
 * without quoting (a test fixture, or a format that predates this helper) still
 * decode unchanged as long as they hold neither a quote nor a backslash.
 */
export function splitTmuxFields(row: string, sep: string = TMUX_FIELD_SEP): TmuxRow {
    const fields: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < row.length; i += 1) {
        const char = row[i] as string;
        if (quoted) {
            if (char !== "'") {
                current += char;
                continue;
            }
            // tmux < 3.0 closes, escapes and reopens a single quote: 'it'\''s'.
            if (row[i + 1] === '\\' && row[i + 2] === "'" && row[i + 3] === "'") {
                current += "'";
                i += 3;
                continue;
            }
            quoted = false;
            continue;
        }
        // tmux >= 3.0 escapes one character with a backslash: a\|b, a\ b, a\\b.
        if (char === '\\' && i + 1 < row.length) {
            current += row[i + 1] as string;
            i += 1;
            continue;
        }
        if (char === sep) {
            fields.push(current);
            current = '';
            continue;
        }
        if (char === "'") {
            quoted = true;
            continue;
        }
        current += char;
    }
    fields.push(current);
    return { fields, ok: !quoted };
}

/**
 * True when a string carries a character tmux rewrites or a terminal hides. A
 * format template may hold escape text; a raw control character is what breaks
 * the row (CORE-2802/CORE-2811).
 */
export function hasControlCharacter(value: string): boolean {
    return /[\u0000-\u001F\u007F]/.test(value);
}

/** Every `#{...}` expansion in a format string, in order. */
export function formatExpansions(format: string): string[] {
    return [...format.matchAll(/#\{([^}]*)\}/g)].map((match) => match[1] as string);
}

/**
 * A format that keeps the CORE-2811 invariant: printable separator, every field
 * quoted. Throws at construction time, so a format that would shift columns fails
 * the suite that builds it rather than a release decision months later.
 */
export function assertQuotedFormat(format: string, label: string): string {
    if (hasControlCharacter(format)) {
        throw new Error(`${label}: tmux format contains a control character`);
    }
    for (const expansion of formatExpansions(format)) {
        if (!expansion.startsWith('q:')) {
            throw new Error(`${label}: tmux format field #{${expansion}} is not quoted (#{q:...})`);
        }
    }
    return format;
}
