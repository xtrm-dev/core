import fs from 'fs-extra';
import path from 'path';

export interface Frontmatter {
    [key: string]: string | undefined;
    summary?: string;
}

export interface DocEntry {
    filePath: string;
    relativePath: string;
    frontmatter: Frontmatter | null;
    sizeBytes: number;
    lastModified: Date;
    parseError?: string;
}

export type FrontmatterFilter = { field: string; value: string };

export interface ScanOptions {
    dir?: string;
    pattern?: string;
    filter?: FrontmatterFilter;
    recursive?: boolean;
}

/** Parse YAML frontmatter from a markdown file (--- delimited block). */
export function parseFrontmatter(content: string): Frontmatter | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const fm: Frontmatter = {};
    for (const line of match[1].split('\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
        if (key) fm[key] = value;
    }

    // Extract summary: first non-empty paragraph after the closing --- block,
    // skipping HTML comment blocks (e.g. <!-- INDEX: ... --> from sync-docs)
    const afterFrontmatter = content.slice(match[0].length).replace(/^\r?\n/, '');
    const stripped = afterFrontmatter.replace(/<!--[\s\S]*?(?:-->|--!>|$)|<!--|-->/g, '').trimStart();
    const firstPara = stripped.split(/\r?\n\r?\n/)[0].replace(/\r?\n/g, ' ').trim();
    if (firstPara && !firstPara.startsWith('#')) {
        fm.summary = firstPara.slice(0, 120);
    }

    return fm;
}

// ── .gitignore support ────────────────────────────────────────────────────────

const ALWAYS_SKIP = new Set(['node_modules', '.git', 'dist', '.xtrm']);

function parseGitignorePatterns(content: string): string[] {
    return content
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
}

function matchesGitignore(relativePath: string, patterns: string[]): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    const basename = normalized.split('/').pop() ?? '';

    for (const raw of patterns) {
        const p = raw.endsWith('/') ? raw.slice(0, -1) : raw;

        if (p.includes('*')) {
            // Simple glob: convert * to [^/]* for filename patterns
            const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
            // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
            const regex = new RegExp('^' + escaped.replace(/\*/g, '[^/]*') + '$');
            if (regex.test(normalized) || regex.test(basename)) return true;
        } else {
            // Exact, prefix, or segment match
            if (normalized === p || normalized.startsWith(p + '/') || basename === p) return true;
        }
    }
    return false;
}

// ── Scanner ───────────────────────────────────────────────────────────────────

export async function scanDocFiles(repoRoot: string, options: ScanOptions = {}): Promise<DocEntry[]> {
    const { dir, pattern, filter, recursive = true } = options;

    let gitignorePatterns: string[] = [];
    try {
        const raw = await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8');
        gitignorePatterns = parseGitignorePatterns(raw);
    } catch { /* no .gitignore — proceed without */ }

    const results: DocEntry[] = [];
    const startDir = dir ? path.join(repoRoot, dir) : repoRoot;

    async function walk(dirPath: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await (fs.readdir as any)(dirPath, { withFileTypes: true }) as fs.Dirent[];
        } catch { return; }

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');

            if (entry.isDirectory()) {
                if (ALWAYS_SKIP.has(entry.name)) continue;
                if (matchesGitignore(relPath, gitignorePatterns)) continue;
                if (recursive) await walk(fullPath);
                continue;
            }

            if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
            if (matchesGitignore(relPath, gitignorePatterns)) continue;

            // dir filter: prefix match on relativePath
            if (dir && !relPath.startsWith(dir.replace(/\\/g, '/'))) continue;

            // pattern filter: substring match on filename
            if (pattern && !entry.name.includes(pattern)) continue;

            let docEntry: DocEntry;
            try {
                const stat = await fs.stat(fullPath);
                const content = await fs.readFile(fullPath, 'utf8');
                const frontmatter = parseFrontmatter(content);

                // FrontmatterFilter: skip if field doesn't match
                if (filter && (!frontmatter || frontmatter[filter.field] !== filter.value)) continue;

                docEntry = {
                    filePath: fullPath,
                    relativePath: relPath,
                    frontmatter,
                    sizeBytes: stat.size,
                    lastModified: stat.mtime,
                };
            } catch (err: any) {
                if (filter) continue; // can't verify filter — exclude
                docEntry = {
                    filePath: fullPath,
                    relativePath: relPath,
                    frontmatter: null,
                    sizeBytes: 0,
                    lastModified: new Date(0),
                    parseError: err.message,
                };
            }

            results.push(docEntry);
        }
    }

    await walk(startDir);
    return results;
}
