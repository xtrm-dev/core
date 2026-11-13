import { describe, it, expect } from 'vitest';
import { parseFrontmatter, FrontmatterFilter } from '../src/utils/docs-scanner.js';

describe('parseFrontmatter', () => {
    it('returns null for empty string', () => {
        expect(parseFrontmatter('')).toBeNull();
    });

    it('returns null when no frontmatter block', () => {
        expect(parseFrontmatter('# No frontmatter\n\nJust a body.')).toBeNull();
    });

    it('parses basic key/value pairs', () => {
        const fm = parseFrontmatter('---\ntitle: Foo\ntype: service\n---\n');
        expect(fm).not.toBeNull();
        expect(fm!.title).toBe('Foo');
        expect(fm!.type).toBe('service');
    });

    it('unquotes double-quoted values', () => {
        const fm = parseFrontmatter('---\ntitle: "Foo Bar"\n---\n');
        expect(fm!.title).toBe('Foo Bar');
    });

    it('unquotes single-quoted values', () => {
        const fm = parseFrontmatter("---\ntitle: 'Hello World'\n---\n");
        expect(fm!.title).toBe('Hello World');
    });

    it('handles CRLF line endings', () => {
        const fm = parseFrontmatter('---\r\ntitle: CRLFDoc\r\ntype: guide\r\n---\r\n');
        expect(fm!.title).toBe('CRLFDoc');
        expect(fm!.type).toBe('guide');
    });

    it('returns empty string for key with no value', () => {
        const fm = parseFrontmatter('---\nkey:\n---\n');
        expect(fm!.key).toBe('');
    });

    it('parses more than 10 fields', () => {
        const lines = Array.from({ length: 12 }, (_, i) => `field${i}: value${i}`).join('\n');
        const fm = parseFrontmatter(`---\n${lines}\n---\n`);
        expect(Object.keys(fm!).filter(k => k !== 'summary').length).toBe(12);
        expect(fm!.field0).toBe('value0');
        expect(fm!.field11).toBe('value11');
    });

    it('extracts summary from first paragraph after frontmatter', () => {
        const content = '---\ntitle: Foo\n---\n\nThis is the summary paragraph.\n\nSecond paragraph.';
        const fm = parseFrontmatter(content);
        expect(fm!.summary).toBe('This is the summary paragraph.');
    });

    it('truncates summary to 120 chars', () => {
        const longPara = 'A'.repeat(200);
        const fm = parseFrontmatter(`---\ntitle: X\n---\n\n${longPara}`);
        expect(fm!.summary!.length).toBe(120);
    });

    it('skips heading as summary', () => {
        const fm = parseFrontmatter('---\ntitle: X\n---\n\n# Heading\n\nReal summary.');
        expect(fm!.summary).toBeUndefined();
    });

    it('skips HTML comment block before real summary', () => {
        const content = '---\ntitle: X\n---\n\n<!-- INDEX: some metadata -->\n\nReal summary paragraph.';
        const fm = parseFrontmatter(content);
        expect(fm!.summary).toBe('Real summary paragraph.');
    });

    it('skips multiline HTML comment block before real summary', () => {
        const content = '---\ntitle: X\n---\n\n<!-- INDEX:\n  key: value\n  other: stuff\n-->\n\nActual content.';
        const fm = parseFrontmatter(content);
        expect(fm!.summary).toBe('Actual content.');
    });

    it('strips a --!> comment close as well as -->', () => {
        const content = '---\ntitle: X\n---\n\n<!-- INDEX: meta --!> Real summary.';
        const fm = parseFrontmatter(content);
        expect(fm!.summary).toBe('Real summary.');
    });

    it('strips stray HTML comment delimiters in one pass', () => {
        const content = '---\ntitle: X\n---\n\n<!-- stray --> Real summary.';
        const fm = parseFrontmatter(content);
        expect(fm!.summary).toBe('Real summary.');
    });

    it('FrontmatterFilter type is exported and structurally correct', () => {
        const filter: FrontmatterFilter = { field: 'type', value: 'service' };
        expect(filter.field).toBe('type');
        expect(filter.value).toBe('service');
    });
});
