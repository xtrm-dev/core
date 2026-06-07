/**
 * Convert a free-text title to a stable kebab-case slug.
 * Output: lowercase ASCII, hyphenated, max 60 chars.
 * Always non-empty (falls back to "spec" if input is empty/non-ASCII).
 */
export function slugify(input: string): string {
    const normalized = input
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '') // strip diacritics
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const truncated = normalized.slice(0, 60).replace(/-+$/, '');
    return truncated.length > 0 ? truncated : 'spec';
}
