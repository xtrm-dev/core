#!/usr/bin/env node
// Deterministic OCR delegation helper. It never calls an LLM and never judges code:
// `preflight` runs `ocr delegate preview` + `ocr delegate rule` and prints a digest;
// `check` proves the delegation coverage invariant (delegate.md Step 6) instead of
// trusting a self-reported summary.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CATEGORIES = ['bug', 'security', 'performance', 'maintainability', 'test', 'style', 'documentation', 'other'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const REF_FLAGS = ['--repo', '--from', '--to', '--commit', '--exclude', '--rule'];

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  ocr-preflight.mjs preflight [--repo <path>] [--from <ref> --to <ref> | --commit <sha>] [--exclude <globs>] [--rule <file>] [--out <dir>]
  ocr-preflight.mjs check --preview <preview.json> --ledger <ledger.json> [--findings <findings.json>]
  ocr-preflight.mjs selftest

ledger.json: { "files": [{ "path", "status", "state": "reviewed"|"skipped", "reason"? }],
               "summary"?: { "total_files", "reviewed_files", "skipped_files", "coverage_rate" } }
findings.json: [{ "path", "content", "start_line"?, "end_line"?, "category"?, "severity"? }]
Outputs JSON. check exits 1 on any violation. Requires ocr >= 1.9 (--format json) for preflight.`);
  process.exit(message ? 64 : 0);
}

function parseArgs(argv) {
  const args = { cmd: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const value = argv[i];
    const next = argv[++i];
    if (!value.startsWith('--') || next === undefined) usage(`bad argument: ${value}`);
    args[value.slice(2)] = next;
  }
  return args;
}

function ocrJson(sub, args, extra = []) {
  const flags = REF_FLAGS.flatMap((f) => (args[f.slice(2)] ? [f, args[f.slice(2)]] : []));
  const out = execFileSync('ocr', ['delegate', sub, '--format', 'json', ...flags, ...extra], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function preflight(args) {
  const out = args.out || mkdtempSync(path.join(tmpdir(), 'ocr-preflight-'));
  const preview = ocrJson('preview', args);
  const paths = preview.reviewable_files.map((f) => f.path);
  // ponytail: one rule call for all paths; batch it if a diff ever exceeds ARG_MAX.
  const rules = paths.length ? ocrJson('rule', args, paths) : { groups: [] };
  writeFileSync(path.join(out, 'preview.json'), JSON.stringify(preview, null, 2));
  writeFileSync(path.join(out, 'rules.json'), JSON.stringify(rules, null, 2));
  const excluded = {};
  for (const f of preview.excluded_files) excluded[f.exclude_reason] = (excluded[f.exclude_reason] || 0) + 1;
  return {
    mode: preview.mode,
    refs: { from: preview.from, to: preview.to, commit: preview.commit, merge_base: preview.merge_base },
    reviewable: preview.reviewable_files.map((f) => `${f.status} ${f.path}`),
    excluded_by_reason: excluded,
    rule_groups: rules.groups.map((g) => ({
      group_id: g.group_id,
      source: g.source,
      pattern: g.pattern,
      files: g.files,
      rule_head: g.rule.split('\n').find((l) => l.trim()) || '',
    })),
    files: { preview: path.join(out, 'preview.json'), rules: path.join(out, 'rules.json') },
  };
}

export function validate(preview, ledger, findings = []) {
  const violations = [];
  const key = (f) => `${f.path}\u0000${f.status}`;
  const expected = new Set(preview.reviewable_files.map(key));
  const seen = new Map();
  for (const entry of ledger.files || []) {
    const k = key(entry);
    if (seen.has(k)) violations.push({ code: 'duplicate', path: entry.path, status: entry.status });
    seen.set(k, entry);
    if (!expected.has(k)) violations.push({ code: 'extra', path: entry.path, status: entry.status });
    if (entry.state !== 'reviewed' && entry.state !== 'skipped') violations.push({ code: 'bad_state', path: entry.path, state: entry.state });
    if (entry.state === 'skipped' && !String(entry.reason || '').trim()) violations.push({ code: 'skip_without_reason', path: entry.path });
  }
  for (const f of preview.reviewable_files) {
    if (!seen.has(key(f))) violations.push({ code: 'missing', path: f.path, status: f.status });
  }

  const total = preview.reviewable_files.length;
  const accounted = [...seen.values()].filter((e) => expected.has(key(e)));
  const reviewed = accounted.filter((e) => e.state === 'reviewed').length;
  const skipped = accounted.filter((e) => e.state === 'skipped').length;
  const rate = total ? reviewed / total : 1;
  const s = ledger.summary;
  if (s) {
    // coverage_rate is accepted as a fraction (0..1) or a percentage; the contract does not fix the unit.
    const reported = s.coverage_rate > 1 ? s.coverage_rate / 100 : s.coverage_rate;
    if (s.total_files !== total || s.reviewed_files !== reviewed || s.skipped_files !== skipped || !Number.isFinite(reported) || Math.abs(reported - rate) > 0.005) {
      violations.push({ code: 'summary_mismatch', reported: s, recomputed: { total_files: total, reviewed_files: reviewed, skipped_files: skipped, coverage_rate: rate } });
    }
  }

  const reviewable = new Set(preview.reviewable_files.map((f) => f.path));
  findings.forEach((c, i) => {
    const at = { index: i, path: c.path };
    if (typeof c.path !== 'string' || !reviewable.has(c.path)) violations.push({ code: 'finding_path_not_reviewable', ...at });
    if (typeof c.content !== 'string' || !c.content.trim()) violations.push({ code: 'finding_without_content', ...at });
    if (c.category !== undefined && !CATEGORIES.includes(c.category)) violations.push({ code: 'bad_category', ...at, value: c.category });
    if (c.severity !== undefined && !SEVERITIES.includes(c.severity)) violations.push({ code: 'bad_severity', ...at, value: c.severity });
    const { start_line: a = 0, end_line: b = a } = c;
    // 0/0 is OCR's "unanchored" signal; anchoring may use old-side or full-file lines, so no hunk check.
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || (a === 0) !== (b === 0) || b < a) {
      violations.push({ code: 'bad_line_range', ...at, start_line: a, end_line: b });
    }
  });

  const excluded = preview.excluded_files.length;
  return {
    ok: violations.length === 0,
    violations,
    coverage: { total_files: total, reviewed_files: reviewed, skipped_files: skipped, coverage_rate: rate, excluded_files: excluded, changed_files: total + excluded },
  };
}

function selftest() {
  const preview = {
    reviewable_files: [{ path: 'a.ts', status: 'modified' }, { path: 'b.go', status: 'added' }],
    excluded_files: [{ path: 'README.md', status: 'modified', exclude_reason: 'unsupported_ext' }],
  };
  const good = {
    files: [{ path: 'a.ts', status: 'modified', state: 'reviewed' }, { path: 'b.go', status: 'added', state: 'skipped', reason: 'generated' }],
    summary: { total_files: 2, reviewed_files: 1, skipped_files: 1, coverage_rate: 50 },
  };
  const finding = { path: 'a.ts', content: 'x', start_line: 3, end_line: 4, category: 'bug', severity: 'high' };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const cases = [
    ['baseline', good, [finding], []],
    ['unanchored finding', good, [{ ...finding, start_line: 0, end_line: 0 }], []],
    ['missing', { ...clone(good), files: good.files.slice(0, 1), summary: undefined }, [], ['missing']],
    ['extra', { ...clone(good), files: [...good.files, { path: 'c.py', status: 'added', state: 'reviewed' }] }, [], ['extra']],
    ['duplicate', { ...clone(good), files: [...good.files, good.files[0]] }, [], ['duplicate']],
    ['status differs', { ...clone(good), files: [{ ...good.files[0], status: 'added' }, good.files[1]], summary: undefined }, [], ['extra', 'missing']],
    ['bad state', { ...clone(good), files: [{ ...good.files[0], state: 'done' }, good.files[1]], summary: undefined }, [], ['bad_state']],
    ['skip without reason', { ...clone(good), files: [good.files[0], { ...good.files[1], reason: ' ' }] }, [], ['skip_without_reason']],
    ['summary mismatch', { ...clone(good), summary: { ...good.summary, coverage_rate: 100 } }, [], ['summary_mismatch']],
    ['summary without rate', { ...clone(good), summary: { ...good.summary, coverage_rate: undefined } }, [], ['summary_mismatch']],
    ['summary non-numeric rate', { ...clone(good), summary: { ...good.summary, coverage_rate: 'x' } }, [], ['summary_mismatch']],
    ['finding outside set', good, [{ ...finding, path: 'README.md' }], ['finding_path_not_reviewable']],
    ['finding without content', good, [{ ...finding, content: '' }], ['finding_without_content']],
    ['bad category', good, [{ ...finding, category: 'nit' }], ['bad_category']],
    ['bad severity', good, [{ ...finding, severity: 'blocker' }], ['bad_severity']],
    ['inverted lines', good, [{ ...finding, start_line: 9, end_line: 2 }], ['bad_line_range']],
    ['half anchored', good, [{ ...finding, start_line: 0, end_line: 4 }], ['bad_line_range']],
  ];
  const failures = [];
  for (const [name, ledger, findings, want] of cases) {
    const got = validate(preview, ledger, findings).violations.map((v) => v.code).sort();
    if (JSON.stringify(got) !== JSON.stringify([...want].sort())) failures.push({ name, want, got });
  }
  const cov = validate(preview, good).coverage;
  if (cov.excluded_files !== 1 || cov.changed_files !== 3) failures.push({ name: 'excluded counts', got: cov });
  return { ok: failures.length === 0, cases: cases.length + 1, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  let result;
  if (args.cmd === 'preflight') result = preflight(args);
  else if (args.cmd === 'check') {
    if (!args.preview || !args.ledger) usage('check needs --preview and --ledger');
    const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
    result = validate(read(args.preview), read(args.ledger), args.findings ? read(args.findings) : []);
  } else if (args.cmd === 'selftest') result = selftest();
  else usage(args.cmd ? `unknown command: ${args.cmd}` : undefined);
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exit(1);
}
