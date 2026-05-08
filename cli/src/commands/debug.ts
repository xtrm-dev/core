import { Command } from 'commander';
import kleur from 'kleur';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

interface XtrmEvent {
  id: number;
  ts: number;
  session_id: string;
  runtime: string;
  worktree: string | null;
  kind: string;
  tool_name: string | null;
  outcome: string | null;
  issue_id: string | null;
  duration_ms: number | null;
  data: string | null;
}

interface DebugOptions {
  all: boolean;
  follow: boolean;
  session: string | undefined;
  type: string | undefined;
  json: boolean;
}

// ── Kind labels ───────────────────────────────────────────────────────────────

type ColorFn = (s: string) => string;

type OutcomeFn = (outcome: string | null) => string;

interface KindLabelDef {
  label: string | OutcomeFn;
  color: ColorFn | OutcomeFn;
}

const committedLabel: OutcomeFn = (outcome: string | null) => outcome === 'error' ? 'ACMT-' : 'ACMT+';
const committedColor: ColorFn = (s: string) => (s === 'ACMT-' ? kleur.red(s) : kleur.cyan(s));

// Gate and lifecycle events: fixed 5-char label + fixed color
const KIND_LABELS: Record<string, KindLabelDef> = {
  'session.start':         { label: 'SESS+', color: kleur.green  },
  'session.end':           { label: 'SESS-', color: kleur.white  },
  'gate.edit.allow':       { label: 'EDIT+', color: kleur.green  },
  'gate.edit.block':       { label: 'EDIT-', color: kleur.red    },
  'gate.commit.allow':     { label: 'CMIT+', color: kleur.green  },
  'gate.commit.block':     { label: 'CMIT-', color: kleur.red    },
  'gate.stop.block':       { label: 'STOP-', color: kleur.red    },
  'gate.memory.triggered': { label: 'MEMO-', color: kleur.yellow },
  'gate.memory.acked':     { label: 'MEMO+', color: kleur.green  },
  'gate.worktree.block':   { label: 'WTRE-', color: kleur.red    },
  'bd.claimed':            { label: 'CLMD ', color: kleur.cyan   },
  'bd.closed':             { label: 'CLSD ', color: kleur.green  },
  'bd.committed':          { label: committedLabel, color: committedColor },
};

// Tool call events: derive 5-char abbrev from tool_name
const TOOL_ABBREVS: Record<string, string> = {
  Bash: 'BASH', bash: 'BASH', execute_shell_command: 'BASH',
  Read: 'READ', Write: 'WRIT', Edit: 'EDIT', MultiEdit: 'EDIT', NotebookEdit: 'NTED',
  Glob: 'GLOB', Grep: 'GREP',
  WebFetch: 'WBFT', WebSearch: 'WSRC',
  Agent: 'AGNT', Task: 'TASK',
  LSP: 'LSP ',
};

function toolAbbrev(toolName: string): string {
  if (TOOL_ABBREVS[toolName]) return TOOL_ABBREVS[toolName];
  if (toolName.startsWith('mcp__serena__'))   return 'SRNA';
  if (toolName.startsWith('mcp__gitnexus__')) return 'GTNX';
  if (toolName.startsWith('mcp__deepwiki__')) return 'WIKI';
  if (toolName.startsWith('mcp__'))           return 'MCP ';
  return toolName.slice(0, 4).toUpperCase();
}

function getLabel(event: XtrmEvent): string {
  if (event.kind === 'tool.call') {
    const abbrev = toolAbbrev(event.tool_name ?? '').padEnd(5);
    return event.outcome === 'error' ? kleur.red(abbrev) : kleur.dim(abbrev);
  }
  const def = KIND_LABELS[event.kind];
  if (!def) {
    // Unknown kind: derive from last segment + outcome marker
    const seg = (event.kind.split('.').pop() ?? 'UNKN').slice(0, 4).toUpperCase();
    const label = `${seg}${event.outcome === 'block' ? '-' : '+'}`.padEnd(5);
    return event.outcome === 'block' ? kleur.red(label) : kleur.dim(label);
  }
  // bd.committed has dynamic label/color
  if (event.kind === 'bd.committed') {
    const label = event.outcome === 'error' ? 'ACMT-' : 'ACMT+';
    return event.outcome === 'error' ? kleur.red(label) : kleur.cyan(label);
  }
  return typeof def.color === 'function' && typeof def.label === 'string'
    ? def.color(def.label)
    : kleur.dim('UNKN ');
}

// ── Session color map ─────────────────────────────────────────────────────────

const SESSION_COLORS: ColorFn[] = [
  kleur.blue, kleur.green, kleur.yellow, kleur.cyan, kleur.magenta,
];

function buildColorMap(events: XtrmEvent[]): Map<string, ColorFn> {
  const map = new Map<string, ColorFn>();
  for (const ev of events) {
    if (!map.has(ev.session_id)) {
      map.set(ev.session_id, SESSION_COLORS[map.size % SESSION_COLORS.length]);
    }
  }
  return map;
}

function extendColorMap(map: Map<string, ColorFn>, events: XtrmEvent[]): void {
  for (const ev of events) {
    if (!map.has(ev.session_id)) {
      map.set(ev.session_id, SESSION_COLORS[map.size % SESSION_COLORS.length]);
    }
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}

function buildDetail(event: XtrmEvent): string {
  const parts: string[] = [];

  // Parse data JSON if present
  let d: Record<string, string> | null = null;
  if (event.data) {
    try { d = JSON.parse(event.data); } catch { /* ignore */ }
  }

  if (event.kind === 'tool.call') {
    if (d?.cmd)     parts.push(kleur.dim(d.cmd.slice(0, 72)));
    if (d?.file)    parts.push(kleur.dim(basename(d.file)));
    if (d?.pattern) parts.push(kleur.dim(`/${d.pattern}/`));
    if (d?.url)     parts.push(kleur.dim(d.url.slice(0, 72)));
    if (d?.query)   parts.push(kleur.dim(d.query.slice(0, 72)));
    if (d?.prompt)  parts.push(kleur.dim(d.prompt.slice(0, 72)));
  } else {
    if (event.issue_id)  parts.push(kleur.yellow(event.issue_id));
    if (d?.file)         parts.push(kleur.dim(basename(d.file)));
    if (d?.reason_code)  parts.push(kleur.dim(`[${d.reason_code}]`));
    if (event.worktree)  parts.push(kleur.dim(`wt:${event.worktree}`));
  }

  return parts.join('  ') || kleur.dim('—');
}

function formatLine(event: XtrmEvent, colorMap: Map<string, ColorFn>): string {
  const time    = kleur.dim(fmtTime(event.ts));
  const colorFn = colorMap.get(event.session_id) ?? kleur.white;
  const session = colorFn(event.session_id.slice(0, 8));
  const label   = getLabel(event);
  const detail  = buildDetail(event);
  return `${time} ${label} ${session}  ${detail}`;
}

// ── SQLite queries ────────────────────────────────────────────────────────────

function findDbPath(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.beads'))) return join(dir, '.xtrm', 'debug.db');
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function buildWhere(opts: DebugOptions, base: string): string {
  const clauses: string[] = [];
  if (base) clauses.push(base);
  if (opts.session) {
    const s = opts.session.replace(/'/g, "''");
    clauses.push(`session_id LIKE '${s}%'`);
  }
  if (opts.type) {
    const t = opts.type.replace(/'/g, "''");
    clauses.push(`kind LIKE '${t}.%' OR kind = '${t}'`);
  }
  return clauses.length ? clauses.join(' AND ') : '';
}

function queryEvents(dbPath: string, where: string, limit: number): XtrmEvent[] {
  const sql = `SELECT id,ts,session_id,runtime,worktree,kind,tool_name,outcome,issue_id,duration_ms,data FROM events${where ? ` WHERE ${where}` : ''} ORDER BY id ASC LIMIT ${limit}`;

  const result = spawnSync('sqlite3', [dbPath, '-json', sql], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 5000,
  });

  if (result.status !== 0 || !result.stdout.trim()) return [];
  try { return JSON.parse(result.stdout); } catch { return []; }
}

// ── Follow mode ───────────────────────────────────────────────────────────────

function follow(dbPath: string, opts: DebugOptions): void {
  const sinceTs = Date.now() - 5 * 60 * 1000;
  const initial = queryEvents(dbPath, buildWhere(opts, `ts >= ${sinceTs}`), 200);

  const colorMap = buildColorMap(initial);
  let lastId = 0;

  for (const ev of initial) {
    if (ev.id > lastId) lastId = ev.id;
    opts.json ? console.log(JSON.stringify(ev)) : console.log(formatLine(ev, colorMap));
  }

  // Poll every 2s — clean integer comparison, no datetime overlap needed
  const interval = setInterval(() => {
    const events = queryEvents(dbPath, buildWhere(opts, `id > ${lastId}`), 50);
    if (events.length > 0) {
      extendColorMap(colorMap, events);
      for (const ev of events) {
        if (ev.id > lastId) lastId = ev.id;
        opts.json ? console.log(JSON.stringify(ev)) : console.log(formatLine(ev, colorMap));
      }
    }
  }, 2000);

  process.on('SIGINT', () => { clearInterval(interval); process.exit(0); });
}

// ── Command ───────────────────────────────────────────────────────────────────

export function createDebugCommand(): Command {
  return new Command('debug')
    .description('Watch xtrm events: tool calls, gate decisions, bd lifecycle')
    .option('-f, --follow',      'Follow new events (default)', false)
    .option('--all',             'Show full history and exit',  false)
    .option('--session <id>',    'Filter by session ID (prefix match)')
    .option('--type <domain>',   'Filter by domain: tool | gate | bd | session')
    .option('--json',            'Output raw JSON lines', false)
    .action((opts: DebugOptions) => {
      const cwd    = process.cwd();
      const dbPath = findDbPath(cwd);

      if (!dbPath || !existsSync(dbPath)) return;

      if (opts.all) {
        const events = queryEvents(dbPath, buildWhere(opts, ''), 1000);
        const colorMap = buildColorMap(events);
        for (const ev of events) {
          opts.json ? console.log(JSON.stringify(ev)) : console.log(formatLine(ev, colorMap));
        }
        return;
      }

      follow(dbPath, opts);
    });
}
