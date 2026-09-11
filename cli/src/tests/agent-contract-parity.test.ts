import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const CONTRACT = path.join(repoRoot, '.xtrm', 'config', 'instructions', 'agent-contract.md');
const AGENTS_TOP = path.join(repoRoot, '.xtrm', 'config', 'instructions', 'agents-top.md');
const CLAUDE_TOP = path.join(repoRoot, '.xtrm', 'config', 'instructions', 'claude-top.md');
const ROOT_AGENTS = path.join(repoRoot, 'AGENTS.md');
const ROOT_CLAUDE = path.join(repoRoot, 'CLAUDE.md');
const START = '<!-- contract:start -->';
const END = '<!-- contract:end -->';
const MAX_SUFFIX_LINES = 12;

function markerLineIndex(lines: string[], marker: string, from = 0): number {
  return lines.findIndex((line, index) => index >= from && line.trim() === marker);
}

function section(file: string): string {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const i = markerLineIndex(lines, START);
  const j = markerLineIndex(lines, END, i + 1);
  if (i === -1 || j === -1 || j <= i) throw new Error(`${file}: contract markers missing or unordered`);
  return lines.slice(i + 1, j).join('\n').trim();
}

function suffixLines(file: string): number {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const i = markerLineIndex(lines, END);
  if (i === -1) throw new Error(`${file}: contract end marker missing`);
  const tail = lines.slice(i + 1).join('\n').trim();
  return tail ? tail.split('\n').length : 0;
}

describe('agent-contract parity (ISSUE-136 + skills-v4 + substrate doctrine)', () => {
  it('canonical source exists and every managed copy embeds it byte-for-byte', () => {
    expect(fs.existsSync(CONTRACT)).toBe(true);
    expect(section(AGENTS_TOP)).toBe(section(CONTRACT));
    expect(section(CLAUDE_TOP)).toBe(section(CONTRACT));
    // ADR section 47: generated copies sync from the canonical source.
    expect(section(ROOT_AGENTS)).toBe(section(CONTRACT));
    expect(section(ROOT_CLAUDE)).toBe(section(CONTRACT));
  });

  it('keeps session start targeted and Substrate-native (no normative bd/bv)', () => {
    for (const file of [CONTRACT, AGENTS_TOP, CLAUDE_TOP, ROOT_AGENTS, ROOT_CLAUDE]) {
      const text = section(file);
      expect(text).toMatch(/targeted/i);
      expect(text).toMatch(/sb issue claim/i);
      expect(text).toMatch(/sb issue resume/i);
      expect(text).not.toMatch(/bd (list|ready|search|show|update|close|prime)/i);
      expect(text).not.toMatch(/bd ?prime/i);
      expect(text).not.toMatch(/\bbv\b/);
      expect(text).not.toMatch(/\bbead\b/i);
      expect(text).not.toMatch(/Beads owns/i);
    }
  });

  it('root guides do not reintroduce mandatory legacy diagnostics outside the managed block', () => {
    for (const file of [ROOT_AGENTS, ROOT_CLAUDE]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/run `bd ?prime`[^\n]{0,100}(?:before starting work|at session start)/i);
      expect(text).not.toMatch(/`bd ?prime`[^\n]{0,100}(?:required|mandatory|automatic at session start)/i);
    }
  });

  it('routes only through the skills-v4 universal surface', () => {
    const body = section(CONTRACT);
    for (const skill of [
      '/using-xtrm', '/starting-and-resuming-work', '/multiplexing', '/planning',
      '/engineering-quality', '/using-specialists', '/gitnexus', '/skill-creator', '/find-skills',
    ]) {
      expect(body).toContain(skill);
    }
    for (const retired of [
      '/test-planning', '/sync-docs', '/xt-end', '/session-close-report', '/xt-merge',
      '/using-quality-gates', '/using-tdd', '/gitnexus-debugging', '/gitnexus-exploring',
      '/multiplexing-team', '/issue-triage',
    ]) {
      expect(body).not.toContain(retired);
    }
  });

  it('declares Substrate authority while allowing runtime-local execution tracking', () => {
    const body = section(CONTRACT);
    expect(body).toMatch(/Substrate owns durable work/i);
    expect(body).toMatch(/Git owns code truth/i);
    expect(body).toMatch(/ephemeral execution tracking/i);
    expect(body).toMatch(/Issue is the prompt/i);
    expect(body).toMatch(/not dispatchable/i);
    expect(body).toMatch(/Journal preserves continuity/i);
    expect(body).toMatch(/Resume Capsule/i);
  });

  it('does not reintroduce tmux-first coordination doctrine', () => {
    const body = section(CONTRACT);
    expect(body).toMatch(/Prefer native\/runtime communication surfaces over tmux scraping/);
    expect(body).toContain('/multiplexing');
  });

  it('managed tops never point the fleet at a core-only file unconditionally', () => {
    for (const file of [AGENTS_TOP, CLAUDE_TOP]) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('XTRM-GUIDE.md')) {
        expect(text).toMatch(/XTRM-GUIDE\.md` where present/);
        expect(text).toMatch(/Full reference: `\/using-xtrm` skill/);
      }
    }
  });

  it('contract body never defers to the other file', () => {
    const body = section(AGENTS_TOP);
    expect(body).not.toMatch(/see AGENTS\.md/i);
    expect(body).not.toMatch(/see CLAUDE\.md/i);
    expect(body).not.toMatch(/read AGENTS\.md/i);
  });

  it('common contract body stays compact (ISSUE-136 c.12969 — compact routing, not manuals)', () => {
    const body = section(CONTRACT).trim().split('\n');
    expect(body.length).toBeGreaterThanOrEqual(15);
    expect(body.length).toBeLessThanOrEqual(55);
  });

  it('per-runtime suffixes stay small and additive', () => {
    for (const file of [AGENTS_TOP, CLAUDE_TOP]) {
      const n = suffixLines(file);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(MAX_SUFFIX_LINES);
    }
  });
});
