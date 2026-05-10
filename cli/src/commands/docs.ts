import { Command } from 'commander';
import kleur from 'kleur';
import fs from 'fs-extra';
import path from 'path';
import { findProjectRoot } from '../utils/repo-root.js';
import { t, sym } from '../utils/theme.js';
import { parseFrontmatter, DocEntry, scanDocFiles } from '../utils/docs-scanner.js';
import { readCache, writeCache, isCacheValid } from '../utils/docs-cache.js';
import { isGhAvailable, fetchRecentPrs, fetchRecentIssues } from './docs-cross-check-gh.js';
import { isBdAvailable, fetchClosedBdIssues } from './docs-cross-check-bd.js';
import { detectStaleDocs, detectCoverageGaps, validateIssueReferences, buildReport } from './docs-cross-check-core.js';
import type { CrossCheckFinding } from './docs-cross-check-types.js';

const REQUIRED_FIELDS = new Set(['title', 'type', 'status', 'updated_at', 'version']);

/** Collect all target doc files in a repo. */
async function collectDocFiles(repoRoot: string, filterPattern?: string): Promise<DocEntry[]> {
    const candidates: string[] = [];

    // docs/ directory (top-level only — no subdirs, no other paths)
    const docsDir = path.join(repoRoot, 'docs');
    if (await fs.pathExists(docsDir)) {
        const entries = await fs.readdir(docsDir);
        for (const entry of entries) {
            if (entry.endsWith('.md')) candidates.push(path.join(docsDir, entry));
        }
    }

    const results: DocEntry[] = [];
    for (const filePath of candidates) {
        const rel = path.relative(repoRoot, filePath);

        // Apply filter if provided
        if (filterPattern && !rel.includes(filterPattern) && !path.basename(filePath).includes(filterPattern)) {
            continue;
        }

        let entry: DocEntry;
        try {
            const stat = await fs.stat(filePath);
            const content = await fs.readFile(filePath, 'utf8');
            const frontmatter = parseFrontmatter(content);
            entry = {
                filePath,
                relativePath: rel,
                frontmatter,
                sizeBytes: stat.size,
                lastModified: stat.mtime,
            };
        } catch (err: any) {
            entry = {
                filePath,
                relativePath: rel,
                frontmatter: null,
                sizeBytes: 0,
                lastModified: new Date(0),
                parseError: err.message,
            };
        }
        results.push(entry);
    }

    return results;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
}

function formatDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function printEntry(entry: DocEntry, raw: boolean): void {
    const header = kleur.bold().white(entry.relativePath);
    const meta = kleur.gray(`  ${formatSize(entry.sizeBytes)}  modified ${formatDate(entry.lastModified)}`);
    console.log(`\n${header}${meta}`);

    if (entry.parseError) {
        console.log(kleur.red(`  ✗ Error reading file: ${entry.parseError}`));
        return;
    }

    if (!entry.frontmatter || Object.keys(entry.frontmatter).length === 0) {
        console.log(kleur.gray('  (no frontmatter)'));
        return;
    }

    if (raw) {
        console.log(kleur.gray('  ---'));
        for (const [k, v] of Object.entries(entry.frontmatter)) {
            console.log(`  ${k}: ${v}`);
        }
        console.log(kleur.gray('  ---'));
        return;
    }

    for (const [k, v] of Object.entries(entry.frontmatter)) {
        const keyStr = REQUIRED_FIELDS.has(k)
            ? kleur.cyan(k.padEnd(14))
            : kleur.gray(k.padEnd(14));
        const valStr = v ?? '';
        console.log(`  ${keyStr}  ${valStr}`);
    }
}

/** Print human-readable cross-check report. */
function printCrossCheckReport(findings: CrossCheckFinding[], docsChecked: number, total: number): void {
    console.log(t.bold(`\n  Docs cross-check\n`));
    console.log(kleur.gray(`  ${docsChecked} docs checked, ${total} finding${total !== 1 ? 's' : ''}\n`));

    if (findings.length === 0) {
        console.log(`  ${sym.ok} All docs current\n`);
        return;
    }

    // Group by severity
    const bySeverity = {
        critical: findings.filter(f => f.severity === 'critical'),
        warning: findings.filter(f => f.severity === 'warning'),
        info: findings.filter(f => f.severity === 'info'),
    };

    // Print critical
    for (const f of bySeverity.critical) {
        console.log(`  ${kleur.red('✗')} ${kleur.red(f.docPath || '(coverage gap)')}  ${f.message}`);
        if (f.detail) console.log(kleur.gray(`      ${f.detail}`));
    }

    // Print warnings
    for (const f of bySeverity.warning) {
        console.log(`  ${kleur.yellow('⚠')} ${kleur.yellow(f.docPath || '(coverage gap)')}  ${f.message}`);
        if (f.detail) console.log(kleur.gray(`      ${f.detail}`));
    }

    // Print info
    for (const f of bySeverity.info) {
        console.log(`  ${kleur.gray('ℹ')} ${kleur.gray(f.docPath)}  ${kleur.gray(f.message)}`);
    }

    // Summary
    const parts: string[] = [];
    if (bySeverity.critical.length > 0) parts.push(kleur.red(`${bySeverity.critical.length} critical`));
    if (bySeverity.warning.length > 0) parts.push(kleur.yellow(`${bySeverity.warning.length} warning${bySeverity.warning.length > 1 ? 's' : ''}`));
    if (bySeverity.info.length > 0) parts.push(kleur.gray(`${bySeverity.info.length} info`));

    console.log(kleur.gray(`\n  ${parts.join(', ')}\n`));
}

export function createDocsCommand(): Command {
    const docs = new Command('docs')
        .description('Documentation inspection and drift-check commands');

    docs
        .command('show [filter]')
        .description('Display frontmatters for README, CHANGELOG, and docs/ files')
        .option('--raw', 'Output raw YAML frontmatter', false)
        .option('--json', 'Output JSON', false)
        .action(async (filter: string | undefined, opts: { raw: boolean; json: boolean }) => {
            const repoRoot = await findProjectRoot();
            const entries = await collectDocFiles(repoRoot, filter);

            if (entries.length === 0) {
                console.log(kleur.yellow('\n  No documentation files found.\n'));
                return;
            }

            if (opts.json) {
                const output = entries.map(e => ({
                    path: e.relativePath,
                    sizeBytes: e.sizeBytes,
                    lastModified: e.lastModified.toISOString(),
                    frontmatter: e.frontmatter,
                    parseError: e.parseError ?? null,
                }));
                console.log(JSON.stringify(output, null, 2));
                return;
            }

            for (const entry of entries) {
                printEntry(entry, opts.raw);
            }

            const without = entries.filter(e => !e.frontmatter || Object.keys(e.frontmatter).length === 0).length;
            console.log(
                `\n  ${sym.ok} ${entries.length} file${entries.length !== 1 ? 's' : ''}` +
                (without > 0 ? kleur.gray(`  (${without} without frontmatter)`) : '') +
                '\n'
            );
        });

    docs
        .command('list')
        .description('List markdown docs with metadata summary, filters, and optional cache bypass')
        .option('--dir <path>', 'Filter to files under this directory')
        .option('--pattern <glob>', 'Filter by filename substring')
        .option('--filter <field=value>', 'Filter by frontmatter field, e.g. --filter type=service')
        .option('--json', 'Output JSON array', false)
        .option('--no-cache', 'Bypass cache and force fresh scan')
        .action(async (opts: { dir?: string; pattern?: string; filter?: string; json: boolean; cache: boolean }) => {
            const repoRoot = await findProjectRoot();

            // Parse --filter field=value
            let fmFilter: { field: string; value: string } | undefined;
            if (opts.filter) {
                const sep = opts.filter.indexOf('=');
                if (sep !== -1) {
                    fmFilter = { field: opts.filter.slice(0, sep), value: opts.filter.slice(sep + 1) };
                }
            }

            const scanOpts = { dir: opts.dir ?? 'docs', pattern: opts.pattern, filter: fmFilter, recursive: false };

            // Try cache first
            let entries: DocEntry[] = [];
            let fromCache = false;

            if (opts.cache !== false) {
                const cached = await readCache(repoRoot);
                const fresh = await scanDocFiles(repoRoot, scanOpts);
                if (cached && isCacheValid(cached, fresh)) {
                    entries = fresh; // mtime-checked entries are already fresh
                    fromCache = true;
                } else {
                    entries = fresh;
                    await writeCache(repoRoot, fresh);
                }
            } else {
                entries = await scanDocFiles(repoRoot, scanOpts);
            }

            if (entries.length === 0) {
                console.log(kleur.yellow('\n  No documentation files found.\n'));
                return;
            }

            if (opts.json) {
                const output = entries.map(e => ({
                    path: e.relativePath,
                    sizeBytes: e.sizeBytes,
                    lastModified: e.lastModified.toISOString(),
                    frontmatter: e.frontmatter,
                    parseError: e.parseError ?? null,
                }));
                console.log(JSON.stringify(output, null, 2));
                return;
            }

            const Table = require('cli-table3');
            const table = new Table({
                head: [
                    kleur.bold('Path'),
                    kleur.bold('Size'),
                    kleur.bold('Modified'),
                    kleur.bold('Title'),
                    kleur.bold('Type'),
                ],
                style: { head: [], border: [] },
            });

            let withoutFm = 0;
            for (const e of entries) {
                const hasFm = e.frontmatter && Object.keys(e.frontmatter).length > 0;
                if (!hasFm) withoutFm++;
                const row = [
                    hasFm ? e.relativePath : kleur.gray(e.relativePath),
                    kleur.dim(formatSize(e.sizeBytes)),
                    kleur.dim(formatDate(e.lastModified)),
                    hasFm ? (e.frontmatter?.title ?? kleur.gray('—')) : kleur.gray('—'),
                    hasFm ? (e.frontmatter?.type ?? kleur.gray('—')) : kleur.gray('—'),
                ];
                table.push(row);
            }

            console.log('\n' + table.toString());

            const cacheNote = fromCache ? kleur.dim('  (cached)') : '';
            const withoutNote = withoutFm > 0 ? kleur.gray(`  (${withoutFm} without frontmatter)`) : '';
            console.log(`\n  ${sym.ok} ${entries.length} file${entries.length !== 1 ? 's' : ''}${withoutNote}${cacheNote}\n`);
        });

    // ── cross-check subcommand ────────────────────────────────────────────────
    docs
        .command('cross-check')
        .description('Validate docs against recent PR activity, issue coverage, and open issue refs')
        .option('--days <n>', 'Look-back window in days', '30')
        .option('--json', 'Output JSON', false)
        .action(async (opts: { days: string; json: boolean }) => {
            try {
                const days = parseInt(opts.days, 10) || 30;
                const repoRoot = await findProjectRoot();

                // Check availability of external tools
                const ghOk = isGhAvailable();
                const bdOk = isBdAvailable();

                if (!ghOk) {
                    console.error(kleur.yellow('[gh] GitHub CLI not available, PR data will be empty'));
                }
                if (!bdOk) {
                    console.error(kleur.yellow('[bd] bd CLI not available, issue data will be empty'));
                }

                // Collect doc files
                const docEntries = await collectDocFiles(repoRoot);

                // Read doc contents for reference scanning
                const docContents = new Map<string, string>();
                for (const doc of docEntries) {
                    try {
                        const content = await fs.readFile(doc.filePath, 'utf8');
                        docContents.set(doc.relativePath, content);
                    } catch {
                        // Skip files that can't be read
                    }
                }

                // Fetch data from gh and bd in parallel
                const [prs, issues] = await Promise.all([
                    Promise.resolve(fetchRecentPrs(repoRoot, days)),
                    Promise.resolve(fetchClosedBdIssues(days)),
                ]);

                // Run detectors
                const staleFindings = detectStaleDocs(docEntries, prs, days);
                const gapFindings = detectCoverageGaps(docEntries, issues, docContents);
                const refFindings = validateIssueReferences(docEntries, issues, docContents);

                // Build report
                const report = buildReport([...staleFindings, ...gapFindings, ...refFindings], docEntries.length);

                // Output
                if (opts.json) {
                    console.log(JSON.stringify(report, null, 2));
                } else {
                    printCrossCheckReport(report.findings, report.docsChecked, report.findingsTotal);
                }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(kleur.red(`✗ Cross-check failed: ${msg}`));
                process.exit(1);
            }
        });

    // ── verify subcommand ─────────────────────────────────────────────────────
    docs
        .command('verify [filter]')
        .description('Verify frontmatter schema compliance and detect drift across doc files')
        .option('--fix', 'Auto-fix simple issues (add missing updated_at)', false)
        .option('--json', 'Output JSON', false)
        .action(async (filter: string | undefined, opts: { fix: boolean; json: boolean }) => {
            const repoRoot = await findProjectRoot();
            const entries = await collectDocFiles(repoRoot, filter);

            if (entries.length === 0) {
                console.log(kleur.yellow('\n  No documentation files found.\n'));
                return;
            }

            const VERIFY_REQUIRED = ['title', 'description', 'updated_at'];
            const VALID_TYPES = new Set(['api', 'architecture', 'guide', 'overview', 'plan', 'reference']);

            interface VerifyFinding {
                severity: 'error' | 'warning' | 'info';
                file: string;
                message: string;
                fix?: string;
            }

            const findings: VerifyFinding[] = [];
            const autoFixed: string[] = [];

            // Collect all relative paths for internal link validation
            const knownPaths = new Set(entries.map(e => e.relativePath));

            for (const entry of entries) {
                const rel = entry.relativePath;

                if (entry.parseError) {
                    findings.push({ severity: 'error', file: rel, message: `Parse error: ${entry.parseError}` });
                    continue;
                }

                const fm = entry.frontmatter;

                // ── Missing required fields ───────────────────────────────────
                for (const field of VERIFY_REQUIRED) {
                    if (!fm || !fm[field]) {
                        if (opts.fix && field === 'updated_at') {
                            try {
                                const content = await fs.readFile(entry.filePath, 'utf8');
                                const today = new Date().toISOString().slice(0, 10);
                                let fixed: string;
                                if (content.startsWith('---')) {
                                    fixed = content.replace(/^(---[\s\S]*?)(---)/m, `$1updated_at: ${today}\n$2`);
                                } else {
                                    fixed = `---\nupdated_at: ${today}\n---\n\n${content}`;
                                }
                                await fs.writeFile(entry.filePath, fixed, 'utf8');
                                autoFixed.push(`${rel}: added updated_at: ${today}`);
                            } catch {
                                findings.push({ severity: 'error', file: rel, message: `Missing required field: ${field}` });
                            }
                        } else {
                            findings.push({
                                severity: 'error',
                                file: rel,
                                message: `Missing required field: ${field}`,
                                fix: field === 'updated_at' ? 'Run with --fix to auto-add updated_at' : undefined,
                            });
                        }
                    }
                }

                // ── Drift: updated_at older than file mtime ───────────────────
                if (fm?.updated_at) {
                    const fmDate = new Date(fm.updated_at);
                    const mtime = entry.lastModified;
                    const diffDays = (mtime.getTime() - fmDate.getTime()) / (1000 * 60 * 60 * 24);
                    if (!isNaN(fmDate.getTime()) && diffDays > 1) {
                        findings.push({
                            severity: 'warning',
                            file: rel,
                            message: `updated_at (${fm.updated_at}) is older than file mtime (${formatDate(mtime)})`,
                            fix: `Update updated_at to ${formatDate(mtime)}`,
                        });
                    }
                }

                // ── Type vocabulary ───────────────────────────────────────────
                if (fm?.type && !VALID_TYPES.has(fm.type)) {
                    findings.push({
                        severity: 'warning',
                        file: rel,
                        message: `Unknown type: "${fm.type}" — valid: ${[...VALID_TYPES].join(', ')}`,
                    });
                }

                // ── Broken internal .md links ─────────────────────────────────
                try {
                    const content = await fs.readFile(entry.filePath, 'utf8');
                    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
                    let m: RegExpExecArray | null;
                    while ((m = linkRe.exec(content)) !== null) {
                        const href = m[2];
                        if (href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto:')) continue;
                        const target = href.split('#')[0];
                        if (!target.endsWith('.md')) continue;
                        const resolved = path.join(path.dirname(rel), target).replace(/\\/g, '/');
                        if (!knownPaths.has(resolved)) {
                            findings.push({
                                severity: 'warning',
                                file: rel,
                                message: `Broken internal link: [${m[1]}](${href})`,
                            });
                        }
                    }
                } catch { /* skip link check if unreadable */ }
            }

            // ── Output ────────────────────────────────────────────────────────
            if (opts.json) {
                console.log(JSON.stringify({ files: entries.length, autoFixed, findings }, null, 2));
                process.exit(findings.length > 0 ? 1 : 0);
            }

            console.log(t.bold(`\n  xtrm docs verify\n`));
            console.log(kleur.gray(`  ${entries.length} file${entries.length !== 1 ? 's' : ''} checked\n`));

            if (autoFixed.length > 0) {
                console.log(kleur.green(`  ${sym.ok} Auto-fixed ${autoFixed.length} issue${autoFixed.length !== 1 ? 's' : ''}:`));
                for (const msg of autoFixed) console.log(kleur.dim(`    ${msg}`));
                console.log('');
            }

            if (findings.length === 0) {
                console.log(`  ${sym.ok} All docs pass frontmatter verification\n`);
                return;
            }

            const errors = findings.filter(f => f.severity === 'error');
            const warnings = findings.filter(f => f.severity === 'warning');

            for (const f of errors) {
                console.log(`  ${kleur.red('✗')} ${kleur.red(f.file)}`);
                console.log(kleur.gray(`      ${f.message}`));
                if (f.fix) console.log(kleur.dim(`      → ${f.fix}`));
            }
            for (const f of warnings) {
                console.log(`  ${kleur.yellow('⚠')} ${kleur.yellow(f.file)}`);
                console.log(kleur.gray(`      ${f.message}`));
                if (f.fix) console.log(kleur.dim(`      → ${f.fix}`));
            }

            const parts: string[] = [];
            if (errors.length > 0) parts.push(kleur.red(`${errors.length} error${errors.length !== 1 ? 's' : ''}`));
            if (warnings.length > 0) parts.push(kleur.yellow(`${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`));
            console.log(kleur.gray(`\n  ${parts.join(', ')}\n`));

            if (errors.length > 0) process.exit(1);
        });

    return docs;
}
