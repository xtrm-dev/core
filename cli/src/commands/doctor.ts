import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import kleur from 'kleur';

interface CheckJson {
  managed_sections: Array<{ name: string; version: string; canonical_version: string | null }>;
  drift: Array<{ name: string; kind: string; current_version: string | null; canonical_version: string | null }>;
  known_fragments: string[];
}

function ok(msg: string) { console.log(`  ${kleur.green('✓')} ${msg}`); }
function warn(msg: string) { console.log(`  ${kleur.yellow('○')} ${msg}`); }
function fix(msg: string) { console.log(`    ${kleur.dim('→ fix:')} ${kleur.yellow(msg)}`); }
function section(label: string) {
  const line = '─'.repeat(Math.max(0, 38 - label.length));
  console.log(`\n${kleur.bold(`── ${label} ${line}`)}`);
}

function runSelfCheck(cwd: string): CheckJson | null {
  const cliEntry = process.argv[1];
  if (!cliEntry) return null;
  const result = spawnSync(process.execPath, [cliEntry, 'claude-sync', '--check', '--json', '--cwd', cwd], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout) as CheckJson;
  } catch {
    return null;
  }
}

function checkClaudeMdFragments(cwd: string): boolean {
  section('CLAUDE.md fragments');
  const claudeMd = path.join(cwd, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    warn('No CLAUDE.md in this directory — skipping fragment check');
    return true;
  }
  const parsed = runSelfCheck(cwd);
  if (!parsed) {
    warn('claude-sync self-invoke failed — skipping fragment drift check');
    return true;
  }
  const sections = parsed.managed_sections ?? [];
  const drift = parsed.drift ?? [];
  if (sections.length === 0) {
    warn('CLAUDE.md has no XTRM-MANAGED sentinels — fragments not initialized');
    fix('xt claude-sync --add bd-workflow  (and other fragments)');
    return false;
  }
  const driftByName = new Map(drift.map(d => [d.name, d]));
  let allOk = true;
  for (const s of sections) {
    const d = driftByName.get(s.name);
    if (!d) {
      ok(`${s.name.padEnd(20)} current (v${s.version})`);
      continue;
    }
    allOk = false;
    if (d.kind === 'version-mismatch') {
      warn(`${s.name.padEnd(20)} project v${d.current_version}; canonical v${d.canonical_version}`);
      fix('xt claude-sync --apply --accept-overwrite');
    } else if (d.kind === 'body-mismatch') {
      warn(`${s.name.padEnd(20)} body diverges from canonical v${d.canonical_version}`);
      fix('xt claude-sync --apply --accept-overwrite');
    } else if (d.kind === 'unknown-fragment') {
      warn(`${s.name.padEnd(20)} not a known canonical fragment`);
    }
  }
  return allOk;
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Health check for the xtrm-managed surfaces of the current project')
    .option('--cwd <path>', 'Operate on this directory (default: process.cwd())')
    .action(async (opts: { cwd?: string }) => {
      const cwd = path.resolve(opts.cwd ?? process.cwd());
      console.log(`\n${kleur.bold('xt doctor')}\n`);
      const fragmentsOk = checkClaudeMdFragments(cwd);
      console.log('');
      if (fragmentsOk) {
        console.log(`  ${kleur.green('✓')} ${kleur.bold('All checks passed')}`);
      } else {
        console.log(`  ${kleur.yellow('○')} ${kleur.bold('Some checks failed')}  — follow the fix hints above`);
        process.exitCode = 1;
      }
      console.log('');
    });
}
