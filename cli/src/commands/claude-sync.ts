import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'node:path';
import { execSync } from 'node:child_process';
import kleur from 'kleur';

declare const __dirname: string;

interface Fragment {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly body: string;
  readonly templateVars: readonly string[];
}

interface ManagedSection {
  readonly name: string;
  readonly version: string;
  readonly bodyStart: number;
  readonly bodyEnd: number;
  readonly body: string;
  readonly fullStart: number;
  readonly fullEnd: number;
}

interface RepoContext {
  readonly repo_name: string;
  readonly repo_stats: string;
}

const SENTINEL_RE = /<!-- XTRM-MANAGED:(\S+) start v=(\S+) -->\n([\s\S]*?)\n<!-- XTRM-MANAGED:\1 end -->/g;

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith('---\n')) {
    return { frontmatter: {}, body: text };
  }
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) {
    return { frontmatter: {}, body: text };
  }
  const fmText = text.slice(4, end);
  const body = text.slice(end + 5);
  const fm: Record<string, unknown> = {};
  const lines = fmText.split('\n');
  let currentList: string | null = null;
  for (const line of lines) {
    if (currentList && line.startsWith('  - ')) {
      const arr = (fm[currentList] as string[]) ?? [];
      arr.push(line.slice(4).trim());
      fm[currentList] = arr;
      continue;
    }
    currentList = null;
    const m = /^([a-z_][a-z0-9_]*):\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (val === '') {
      fm[key] = [];
      currentList = key;
    } else {
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body };
}

function findTemplatesDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'templates', 'claude-md-fragments');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Cannot locate templates/claude-md-fragments/. Run xt claude-sync from inside an xtrm-tools checkout, or set XTRM_FRAGMENTS_DIR.");
}

function loadFragments(): Map<string, Fragment> {
  const dir = process.env.XTRM_FRAGMENTS_DIR ?? findTemplatesDir();
  const map = new Map<string, Fragment>();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const { frontmatter, body } = parseFrontmatter(text);
    const name = String(frontmatter.name ?? file.replace(/\.md$/, ''));
    const version = String(frontmatter.version ?? '0.0.0');
    const description = String(frontmatter.description ?? '');
    const templateVars = Array.isArray(frontmatter.template_vars)
      ? (frontmatter.template_vars as string[])
      : [];
    map.set(name, { name, version, description, body: body.replace(/\n+$/, ''), templateVars });
  }
  return map;
}

function findManagedSections(content: string): ManagedSection[] {
  const out: ManagedSection[] = [];
  SENTINEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTINEL_RE.exec(content)) !== null) {
    const name = m[1];
    const version = m[2];
    const body = m[3];
    const fullStart = m.index;
    const fullEnd = m.index + m[0].length;
    const bodyStart = fullStart + `<!-- XTRM-MANAGED:${name} start v=${version} -->\n`.length;
    const bodyEnd = bodyStart + body.length;
    out.push({ name, version, body, bodyStart, bodyEnd, fullStart, fullEnd });
  }
  return out;
}

function renderFragmentBody(frag: Fragment, ctx: RepoContext): string {
  let out = frag.body;
  for (const v of frag.templateVars) {
    const val = (ctx as unknown as Record<string, string>)[v] ?? '';
    out = out.split(`{{${v}}}`).join(val);
  }
  return out;
}

function detectRepoContext(cwd: string): RepoContext {
  let repoName = path.basename(cwd);
  try {
    const top = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top) repoName = path.basename(top);
  } catch { /* fall through */ }
  let repoStats = '';
  const metaPath = path.join(cwd, '.gitnexus', 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const s = meta.stats ?? {};
      const symbols = s.nodes ?? s.symbols ?? s.symbol_count ?? '?';
      const rels = s.edges ?? s.relationships ?? s.relationship_count ?? '?';
      const flows = s.processes ?? s.execution_flows ?? s.flow_count ?? '?';
      repoStats = `${symbols} symbols, ${rels} relationships, ${flows} execution flows`;
    } catch { /* ignore */ }
  }
  return { repo_name: repoName, repo_stats: repoStats };
}

interface DriftEntry {
  readonly name: string;
  readonly kind: 'version-mismatch' | 'body-mismatch' | 'missing-fragment' | 'unknown-fragment';
  readonly currentVersion?: string;
  readonly canonicalVersion?: string;
  readonly section?: ManagedSection;
}

function checkDrift(content: string, fragments: Map<string, Fragment>, ctx: RepoContext): DriftEntry[] {
  const sections = findManagedSections(content);
  const seen = new Set<string>();
  const out: DriftEntry[] = [];
  for (const sec of sections) {
    seen.add(sec.name);
    const frag = fragments.get(sec.name);
    if (!frag) {
      out.push({ name: sec.name, kind: 'unknown-fragment', currentVersion: sec.version, section: sec });
      continue;
    }
    if (sec.version !== frag.version) {
      out.push({
        name: sec.name,
        kind: 'version-mismatch',
        currentVersion: sec.version,
        canonicalVersion: frag.version,
        section: sec,
      });
      continue;
    }
    const expected = renderFragmentBody(frag, ctx);
    if (sec.body !== expected) {
      out.push({
        name: sec.name,
        kind: 'body-mismatch',
        currentVersion: sec.version,
        canonicalVersion: frag.version,
        section: sec,
      });
    }
  }
  return out;
}

function applyDrift(content: string, fragments: Map<string, Fragment>, ctx: RepoContext): string {
  const sections = findManagedSections(content);
  if (sections.length === 0) return content;
  let out = '';
  let cursor = 0;
  for (const sec of sections) {
    out += content.slice(cursor, sec.fullStart);
    const frag = fragments.get(sec.name);
    if (!frag) {
      out += content.slice(sec.fullStart, sec.fullEnd);
    } else {
      const body = renderFragmentBody(frag, ctx);
      out += `<!-- XTRM-MANAGED:${frag.name} start v=${frag.version} -->\n${body}\n<!-- XTRM-MANAGED:${frag.name} end -->`;
    }
    cursor = sec.fullEnd;
  }
  out += content.slice(cursor);
  return out;
}

function describeDrift(d: DriftEntry): string {
  switch (d.kind) {
    case 'version-mismatch':
      return `${kleur.yellow('VERSION')} ${d.name}  ${d.currentVersion} -> ${d.canonicalVersion}`;
    case 'body-mismatch':
      return `${kleur.yellow('BODY')}    ${d.name}  v${d.currentVersion} (canonical v${d.canonicalVersion})`;
    case 'unknown-fragment':
      return `${kleur.red('UNKNOWN')} ${d.name}  v${d.currentVersion} (no canonical fragment)`;
    case 'missing-fragment':
      return `${kleur.red('MISSING')} ${d.name}`;
  }
}

function resolveClaudeMd(cwd: string): string {
  const p = path.join(cwd, 'CLAUDE.md');
  if (!fs.existsSync(p)) {
    throw new Error(`CLAUDE.md not found at ${p}`);
  }
  return p;
}

export function createClaudeSyncCommand(): Command {
  const cmd = new Command('claude-sync')
    .description('Sync managed CLAUDE.md fragments (XTRM-MANAGED:* sentinels)')
    .option('--check', 'Report drift between CLAUDE.md sentinels and canonical fragments (exit 1 on drift)')
    .option('--apply', 'Rewrite managed sections from canonical fragments')
    .option('--accept-overwrite', 'Required with --apply to confirm overwrite of managed sections')
    .option('--list', 'List known canonical fragments + versions')
    .option('--add <fragment>', 'Append sentinels for <fragment> to end of CLAUDE.md (use when migrating)')
    .option('--cwd <path>', 'Operate on CLAUDE.md in this directory (default: process.cwd())')
    .option('--repo-name <name>', 'Override repo name for gitnexus template substitution')
    .option('--repo-stats <stats>', 'Override repo stats for gitnexus template substitution')
    .action(async (opts: {
      check?: boolean;
      apply?: boolean;
      acceptOverwrite?: boolean;
      list?: boolean;
      add?: string;
      cwd?: string;
      repoName?: string;
      repoStats?: string;
    }) => {
      const fragments = loadFragments();
      const cwd = path.resolve(opts.cwd ?? process.cwd());

      if (opts.list) {
        console.log(kleur.bold('Canonical CLAUDE.md fragments:\n'));
        for (const frag of [...fragments.values()].sort((a, b) => a.name.localeCompare(b.name))) {
          const vars = frag.templateVars.length ? `  ${kleur.dim(`(vars: ${frag.templateVars.join(', ')})`)}` : '';
          console.log(`  ${kleur.cyan(frag.name.padEnd(20))} v${frag.version}  ${kleur.dim(frag.description)}${vars}`);
        }
        return;
      }

      const claudeMd = resolveClaudeMd(cwd);
      const content = fs.readFileSync(claudeMd, 'utf8');
      const detected = detectRepoContext(cwd);
      const ctx: RepoContext = {
        repo_name: opts.repoName ?? detected.repo_name,
        repo_stats: opts.repoStats ?? detected.repo_stats,
      };

      if (opts.add) {
        const frag = fragments.get(opts.add);
        if (!frag) {
          console.error(kleur.red(`✗ Unknown fragment: ${opts.add}`));
          process.exit(1);
        }
        const sections = findManagedSections(content);
        if (sections.some(s => s.name === frag.name)) {
          console.error(kleur.yellow(`! Fragment ${frag.name} already present; nothing to add.`));
          return;
        }
        const body = renderFragmentBody(frag, ctx);
        const block = `\n<!-- XTRM-MANAGED:${frag.name} start v=${frag.version} -->\n${body}\n<!-- XTRM-MANAGED:${frag.name} end -->\n`;
        const next = content.replace(/\n*$/, '\n') + block;
        fs.writeFileSync(claudeMd, next, 'utf8');
        console.log(kleur.green(`✓ Appended ${frag.name} v${frag.version} to ${path.relative(cwd, claudeMd)}`));
        return;
      }

      if (opts.apply) {
        if (!opts.acceptOverwrite) {
          console.error(kleur.red('✗ --apply requires --accept-overwrite'));
          process.exit(1);
        }
        const next = applyDrift(content, fragments, ctx);
        if (next === content) {
          console.log(kleur.green(`✓ Already canonical: ${path.relative(cwd, claudeMd)}`));
          return;
        }
        fs.writeFileSync(claudeMd, next, 'utf8');
        const drift = checkDrift(content, fragments, ctx);
        console.log(kleur.green(`✓ Updated ${path.relative(cwd, claudeMd)} (${drift.length} section${drift.length === 1 ? '' : 's'})`));
        for (const d of drift) console.log(`  ${describeDrift(d)}`);
        return;
      }

      // Default: --check
      const drift = checkDrift(content, fragments, ctx);
      if (drift.length === 0) {
        const sections = findManagedSections(content);
        console.log(kleur.green(`✓ Clean: ${path.relative(cwd, claudeMd)}  (${sections.length} managed section${sections.length === 1 ? '' : 's'})`));
        return;
      }
      console.log(kleur.yellow(`! Drift in ${path.relative(cwd, claudeMd)}:\n`));
      for (const d of drift) console.log(`  ${describeDrift(d)}`);
      console.log(kleur.dim(`\nRun: xt claude-sync --apply --accept-overwrite`));
      process.exit(1);
    });
  return cmd;
}
