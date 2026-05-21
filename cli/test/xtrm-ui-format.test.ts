import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shortenPath,
  shortenCommand,
  diffStats,
  createUnifiedLineDiff,
  renderRichDiffPreview,
  formatDuration,
  formatLineLabel,
  cleanOutputLines,
  joinMeta,
  renderToolSummary,
  TOOL_ROW_MARKER,
  countPrefixedItems,
  lineCount,
  previewLines,
} from '../../packages/pi-extensions/extensions/xtrm-ui/format';

// ── shortenPath ──────────────────────────────────────────────────────────────

describe('shortenPath', () => {
  const HOME = '/home/user';
  beforeEach(() => { process.env.HOME = HOME; });
  afterEach(() => { process.env.HOME = HOME; });

  it('returns short paths unchanged', () => {
    expect(shortenPath('/foo/bar')).toBe('/foo/bar');
  });

  it('replaces home prefix with ~', () => {
    expect(shortenPath(`${HOME}/projects/foo`)).toBe('~/projects/foo');
  });

  it('shortens deep paths to ~/parent/leaf form', () => {
    const long = `${HOME}/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q`;
    const result = shortenPath(long);
    expect(result.length).toBeLessThanOrEqual(56);
    expect(result).toMatch(/^~\//);
  });

  it('does not shorten a path that is exactly at max length', () => {
    const path = 'a'.repeat(56);
    expect(shortenPath(path, 56)).toBe(path);
  });

  it('shortens a path beyond max to …/parent/leaf', () => {
    const path = '/very/deep/nested/path/that/exceeds/the/maximum/allowed/length/here';
    const result = shortenPath(path, 30);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result.startsWith('…') || result.startsWith('~')).toBe(true);
  });
});

// ── shortenCommand ───────────────────────────────────────────────────────────

describe('shortenCommand', () => {
  it('returns short commands unchanged', () => {
    expect(shortenCommand('ls -la')).toBe('ls -la');
  });

  it('collapses newlines and extra spaces to single space', () => {
    expect(shortenCommand('echo\n  hello\n  world')).toBe('echo hello world');
  });

  it('truncates commands over max with …', () => {
    const long = 'a'.repeat(80);
    const result = shortenCommand(long, 72);
    expect(result.length).toBeLessThanOrEqual(72);
    expect(result.endsWith('…')).toBe(true);
  });

  it('does not truncate commands exactly at max', () => {
    const cmd = 'x'.repeat(72);
    expect(shortenCommand(cmd, 72)).toBe(cmd);
  });
});

// ── diffStats ────────────────────────────────────────────────────────────────

describe('diffStats', () => {
  it('counts added lines', () => {
    expect(diffStats('+added line\n+another add')).toEqual({ additions: 2, removals: 0 });
  });

  it('counts removed lines', () => {
    expect(diffStats('-removed line\n-another remove')).toEqual({ additions: 0, removals: 2 });
  });

  it('skips +++ header lines', () => {
    expect(diffStats('+++ b/file.ts\n+real add')).toEqual({ additions: 1, removals: 0 });
  });

  it('skips --- header lines', () => {
    expect(diffStats('--- a/file.ts\n-real remove')).toEqual({ additions: 0, removals: 1 });
  });

  it('handles mixed diff correctly', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '-old line 1',
      '-old line 2',
      '+new line 1',
      ' context line',
    ].join('\n');
    expect(diffStats(diff)).toEqual({ additions: 1, removals: 2 });
  });

  it('returns zeros for empty diff', () => {
    expect(diffStats('')).toEqual({ additions: 0, removals: 0 });
  });
});

// ── createUnifiedLineDiff ────────────────────────────────────────────────────

describe('createUnifiedLineDiff', () => {
  it('returns empty when content is unchanged', () => {
    expect(createUnifiedLineDiff('same', 'same')).toBe('');
  });

  it('builds unified diff for changed content', () => {
    const diff = createUnifiedLineDiff('const a = 1;\nconst b = 2;', 'const a = 1;\nconst b = 3;');
    expect(diff).toContain('@@ -1,2 +1,2 @@');
    expect(diff).toContain('-const b = 2;');
    expect(diff).toContain('+const b = 3;');
  });
});

// ── renderRichDiffPreview ────────────────────────────────────────────────────

describe('renderRichDiffPreview', () => {
  const theme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };

  it('renders line-numbered diff output', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,2 @@',
      ' const value = 1;',
      '-const label = "old";',
      '+const label = "new";',
    ].join('\n');

    const rendered = renderRichDiffPreview(theme, diff, 12);
    expect(rendered).toContain('[muted:   1    1 │]');
    expect(rendered).toContain('[toolDiffRemoved:-const label = "**old**";]');
    expect(rendered).toContain('[toolDiffAdded:+const label = "**new**";]');
  });

  it('adds truncation indicator when maxLines is hit', () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,4 +1,4 @@',
      '-a',
      '+b',
      '-c',
      '+d',
    ].join('\n');

    const rendered = renderRichDiffPreview(theme, diff, 4);
    expect(rendered).toContain('more');
  });
});

// ── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('returns undefined for undefined input', () => {
    expect(formatDuration(undefined)).toBeUndefined();
  });

  it('returns undefined for negative values', () => {
    expect(formatDuration(-1)).toBeUndefined();
  });

  it('formats sub-second as ms', () => {
    expect(formatDuration(500)).toBe('500ms');
  });

  it('formats 1-10 seconds with one decimal', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  it('formats >= 10 seconds as rounded integer', () => {
    expect(formatDuration(65000)).toBe('65s');
  });

  it('rounds 10s boundary correctly', () => {
    expect(formatDuration(10000)).toBe('10s');
    expect(formatDuration(9999)).toBe('10.0s');
  });
});

// ── formatLineLabel ──────────────────────────────────────────────────────────

describe('formatLineLabel', () => {
  it('uses singular for count 1', () => {
    expect(formatLineLabel(1, 'line')).toBe('1 line');
  });

  it('uses plural for count != 1', () => {
    expect(formatLineLabel(0, 'line')).toBe('0 lines');
    expect(formatLineLabel(2, 'match')).toBe('2 matchs');
  });
});

// ── cleanOutputLines ─────────────────────────────────────────────────────────

describe('cleanOutputLines', () => {
  it('filters empty lines', () => {
    expect(cleanOutputLines('a\n\nb\n')).toEqual(['a', 'b']);
  });

  it('filters "exit code: 0" lines', () => {
    expect(cleanOutputLines('output\nexit code: 0')).toEqual(['output']);
  });

  it('filters "exit code: -1" lines', () => {
    expect(cleanOutputLines('output\nexit code: -1')).toEqual(['output']);
  });

  it('preserves non-empty, non-exit lines', () => {
    expect(cleanOutputLines('line1\nline2')).toEqual(['line1', 'line2']);
  });

  it('is case-insensitive for exit code pattern', () => {
    expect(cleanOutputLines('Exit Code: 0\nkeep me')).toEqual(['keep me']);
  });
});

// ── joinMeta ─────────────────────────────────────────────────────────────────

describe('joinMeta', () => {
  it('joins non-empty strings with " · "', () => {
    expect(joinMeta(['a', 'b', 'c'])).toBe('a · b · c');
  });

  it('filters out undefined values', () => {
    expect(joinMeta(['a', undefined, 'c'])).toBe('a · c');
  });

  it('filters out false values', () => {
    expect(joinMeta(['a', false, 'b'])).toBe('a · b');
  });

  it('filters out empty strings', () => {
    expect(joinMeta(['a', '', 'b'])).toBe('a · b');
  });

  it('returns undefined when all parts are filtered', () => {
    expect(joinMeta([undefined, false, ''])).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    expect(joinMeta([])).toBeUndefined();
  });
});

// ── renderToolSummary ────────────────────────────────────────────────────────

describe('renderToolSummary', () => {
  const theme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `**${text}**`,
  };

  it('uses accent color for pending status', () => {
    const result = renderToolSummary(theme, 'pending', 'bash');
    expect(result).toContain(`[accent:${TOOL_ROW_MARKER}]`);
  });

  it('uses success color for success status', () => {
    const result = renderToolSummary(theme, 'success', 'read');
    expect(result).toContain(`[success:${TOOL_ROW_MARKER}]`);
  });

  it('uses error color for error status', () => {
    const result = renderToolSummary(theme, 'error', 'edit');
    expect(result).toContain(`[error:${TOOL_ROW_MARKER}]`);
  });

  it('includes subject when provided', () => {
    const result = renderToolSummary(theme, 'success', 'read', 'file.ts');
    expect(result).toContain('file.ts');
  });

  it('includes meta with · separator when provided', () => {
    const result = renderToolSummary(theme, 'success', 'bash', undefined, '3 lines · 120ms');
    expect(result).toContain('3 lines · 120ms');
  });

  it('omits subject and meta when not provided', () => {
    const result = renderToolSummary(theme, 'success', 'ls');
    expect(result).not.toContain('undefined');
  });
});

// ── countPrefixedItems ───────────────────────────────────────────────────────

describe('countPrefixedItems', () => {
  it('counts lines starting with any of the given prefixes', () => {
    expect(countPrefixedItems('-- file1\n-- file2\nother', ['-- '])).toBe(2);
  });

  it('returns 0 when no lines match', () => {
    expect(countPrefixedItems('abc\ndef', ['-- '])).toBe(0);
  });
});

// ── lineCount ────────────────────────────────────────────────────────────────

describe('lineCount', () => {
  it('returns 0 for empty string', () => {
    expect(lineCount('')).toBe(0);
  });

  it('counts newline-separated lines', () => {
    expect(lineCount('a\nb\nc')).toBe(3);
  });
});

// ── previewLines ─────────────────────────────────────────────────────────────

describe('previewLines', () => {
  it('returns first N lines', () => {
    expect(previewLines('a\nb\nc\nd', 2)).toEqual(['a', 'b']);
  });

  it('returns all lines when count exceeds total', () => {
    expect(previewLines('a\nb', 10)).toEqual(['a', 'b']);
  });
});
