#!/usr/bin/env node
// Regenerates the Markdown body of docs/plans/xtrm-build-order/PRD.md from the page
// source docs/plans/xtrm-build-order/index.html. The hand-written preamble above the
// marker line is never touched. Stdlib only, no network, deterministic output.
//
//   node scripts/plan-to-md.mjs          # write the body
//   node scripts/plan-to-md.mjs --check  # fail when PRD.md body is stale or a step is missing

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planDir = path.join(repoRoot, 'docs/plans/xtrm-build-order');
const SRC = path.join(planDir, 'index.html');
const OUT = path.join(planDir, 'PRD.md');

const MARKER = '<!-- BEGIN GENERATED BODY: scripts/plan-to-md.mjs -->';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00b7' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? match;
  });
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  let match;
  while ((match = re.exec(source))) attrs[match[1].toLowerCase()] = match[2] === undefined ? '' : decodeEntities(match[2]);
  return attrs;
}

// Minimal tolerant parser: enough of HTML to walk this page and to keep raw offsets so
// figures can be copied verbatim.
function parseHtml(source) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null, start: 0, end: source.length };
  let current = root;
  let i = 0;
  const pushText = (end) => {
    if (end <= i) return;
    const raw = source.slice(i, end);
    if (raw) current.children.push({ tag: '#text', text: raw, children: [], parent: current, start: i, end });
  };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      pushText(source.length);
      break;
    }
    pushText(lt);
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      i = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const close = source.indexOf('>', lt);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/.exec(source.slice(lt, lt + 4096));
    if (!tagMatch) {
      current.children.push({ tag: '#text', text: '<', children: [], parent: current, start: lt, end: lt + 1 });
      i = lt + 1;
      continue;
    }
    const [whole, name, tail] = tagMatch;
    const tag = name.toLowerCase();
    const selfClosing = /\/\s*$/.test(tail);
    const start = lt;
    const end = lt + whole.length;
    if (whole.startsWith('</')) {
      let node = current;
      while (node && node.tag !== tag) node = node.parent;
      if (node && node.parent) {
        node.end = end;
        current = node.parent;
      }
      i = end;
      continue;
    }
    const node = {
      tag,
      attrs: parseAttributes(selfClosing ? tail.replace(/\/\s*$/, '') : tail),
      children: [],
      parent: current,
      start,
      end,
    };
    current.children.push(node);
    i = end;
    if (RAW_TEXT.has(tag) && !selfClosing) {
      const close = source.toLowerCase().indexOf(`</${tag}`, i);
      const stop = close === -1 ? source.length : close;
      node.children.push({ tag: '#text', text: source.slice(i, stop), children: [], parent: node, start: i, end: stop });
      const gt = close === -1 ? source.length : source.indexOf('>', close) + 1;
      node.end = gt;
      i = gt;
      continue;
    }
    if (VOID.has(tag) || selfClosing) continue;
    current = node;
  }
  return root;
}

const classesOf = (node) => (node.attrs?.class ? node.attrs.class.split(/\s+/).filter(Boolean) : []);
const hasClass = (node, name) => classesOf(node).includes(name);
const isElement = (node) => node.tag !== '#text';
const elements = (node) => node.children.filter(isElement);
const find = (node, tag) => elements(node).find((child) => child.tag === tag);
const findAll = (node, predicate) => {
  const out = [];
  const walk = (n) => {
    for (const child of elements(n)) {
      if (predicate(child)) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
};
const rawText = (node) => node.children.map((child) => (child.tag === '#text' ? child.text : '')).join('');

function collapse(text) {
  return text.replace(/[ \t\r\n]+/g, ' ').trim();
}

function inlineCode(text) {
  const body = collapse(text);
  const fence = body.includes('`') ? '``' : '`';
  return `${fence}${body}${fence}`;
}

// Inline rendering: chips, badges, refs, code, emphasis. Everything else recurses.
function inline(node) {
  if (node.tag === '#text') return decodeEntities(node.text);
  const kids = () => node.children.map(inline).join('');
  switch (node.tag) {
    case 'br':
      return ' ';
    case 'code':
      return inlineCode(decodeEntities(rawText(node)));
    case 'b':
    case 'strong':
      return `**${collapse(kids())}**`;
    case 'em':
    case 'i':
      return `*${collapse(kids())}*`;
    case 'span': {
      const cls = classesOf(node);
      const body = collapse(kids());
      if (cls.includes('chip')) return `[${body}]`;
      if (cls.includes('new-badge')) return `(${body})`;
      if (cls.includes('refs')) return inlineCode(decodeEntities(rawText(node)));
      if (cls.includes('eyebrow')) return `*${body}*`;
      return body;
    }
    default:
      return kids();
  }
}

const inlineOf = (node) => collapse(node.children.map(inline).join(''));

// Heading and table labels: the text as a reader says it, with no emphasis markup.
function plainText(node) {
  const walk = (n) => (n.tag === '#text' ? decodeEntities(n.text) : n.children.map(walk).join(''));
  return collapse(walk(node));
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function renderTable(table) {
  const rows = findAll(table, (n) => n.tag === 'tr').map((tr) => elements(tr).filter((cell) => cell.tag === 'th' || cell.tag === 'td'));
  if (!rows.length) return [];
  const headIndex = rows.findIndex((cells) => cells.some((cell) => cell.tag === 'th'));
  const head = headIndex === -1 ? rows[0] : rows[headIndex];
  const body = rows.filter((_, index) => index !== (headIndex === -1 ? 0 : headIndex));
  const cells = (row) => row.map((cell) => escapeCell(inlineOf(cell)));
  const line = (row) => `| ${cells(row).join(' | ')} |`;
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => {
    const filled = cells(row);
    while (filled.length < width) filled.push('');
    return `| ${filled.join(' | ')} |`;
  };
  const out = [
    pad(head),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map(pad),
  ];
  return out;
}

// A run of name patterns is one code block: two adjacent fences read as two alternatives.
function takePatternRun(children, index) {
  const run = [];
  let i = index;
  while (i < children.length && hasClass(children[i], 'rule-k')) {
    run.push(decodeEntities(rawText(children[i])).trim());
    i += 1;
  }
  return { run, next: i };
}

function renderRules(node) {
  const out = [];
  const children = elements(node);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (hasClass(child, 'rule-k')) {
      const { run, next } = takePatternRun(children, i);
      out.push('```', ...run, '```', '');
      i = next - 1;
      continue;
    }
    if (child.tag === 'h3') {
      out.push(`### ${inlineOf(child)}`, '');
      continue;
    }
    if (child.tag === 'p') {
      out.push(inlineOf(child), '');
      continue;
    }
    out.push(...renderBlocks([child]));
  }
  return out;
}

function renderNoteBox(node) {
  const out = [];
  const children = elements(node);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (hasClass(child, 'rule-k')) {
      const { run, next } = takePatternRun(children, i);
      out.push('```', ...run, '```', '');
      i = next - 1;
      continue;
    }
    if (child.tag === 'h3') {
      out.push(`### ${inlineOf(child)}`, '');
      continue;
    }
    if (child.tag === 'p') {
      out.push(inlineOf(child), '');
      continue;
    }
    out.push(...renderBlocks([child]));
  }
  return out;
}

function renderRuling(node) {
  const out = [];
  const label = find(node, 'span');
  if (label && hasClass(label, 'ruling-k')) out.push(`> **${inlineOf(label)}**`);
  const list = find(node, 'ul');
  if (list) {
    for (const li of elements(list)) {
      if (li.tag === 'li') out.push(`> - ${inlineOf(li)}`);
    }
  }
  out.push('');
  return out;
}

function stepEntries(root) {
  return findAll(root, (n) => n.tag === 'li' && hasClass(n, 'step')).map((li) => {
    const numEl = elements(li).find((child) => hasClass(child, 'num'));
    const body = elements(li).find((child) => hasClass(child, 'step-body'));
    const titleEl = body ? elements(body).find((child) => hasClass(child, 'step-title')) : null;
    const titleBold = titleEl ? find(titleEl, 'b') : null;
    const inPhase = (() => {
      let n = li.parent;
      while (n) {
        if (n.tag === 'section' && hasClass(n, 'phase')) return true;
        n = n.parent;
      }
      return false;
    })();
    return {
      num: numEl ? plainText(numEl) : '',
      title: titleBold ? plainText(titleBold) : '',
      inPhase,
    };
  });
}

function renderStep(li) {
  const out = [];
  const numEl = elements(li).find((child) => hasClass(child, 'num'));
  const body = elements(li).find((child) => hasClass(child, 'step-body'));
  const num = numEl ? plainText(numEl) : '';
  const titleEl = body ? elements(body).find((child) => hasClass(child, 'step-title')) : null;
  const titleBold = titleEl ? find(titleEl, 'b') : null;
  const title = titleBold ? plainText(titleBold) : '';
  out.push(title ? `### Step ${num} — ${title}` : `### Step ${num}`, '');

  if (titleEl) {
    const meta = elements(titleEl)
      .filter((child) => child !== titleBold)
      .map((child) => collapse(inline(child)))
      .filter(Boolean);
    if (meta.length) out.push(meta.join(' '), '');
  }

  for (const child of body ? elements(body) : []) {
    if (child.tag === 'p') {
      out.push(inlineOf(child), '');
      continue;
    }
    if (hasClass(child, 'step-title')) continue;
    if (child.tag === 'dl') {
      for (const dt of elements(child).filter((n) => n.tag === 'dt')) {
        const dd = elements(child)[elements(child).indexOf(dt) + 1];
        out.push(`- **${inlineOf(dt)}** — ${dd ? inlineOf(dd) : ''}`);
      }
      out.push('');
      continue;
    }
    if (hasClass(child, 'ruling')) {
      out.push(...renderRuling(child));
      continue;
    }
    if (child.tag === 'table') {
      out.push(...renderTable(child), '');
      continue;
    }
    if (hasClass(child, 'notes')) continue;
    out.push(...renderBlocks([child]));
  }
  return out;
}

function renderSteps(node) {
  const out = [];
  for (const li of elements(node)) {
    if (li.tag !== 'li') continue;
    if (elements(li).some((child) => hasClass(child, 'num'))) {
      out.push(...renderStep(li));
      continue;
    }
    out.push(`- ${inlineOf(li)}`);
  }
  if (out.length && out[out.length - 1] !== '') out.push('');
  return out;
}

function renderFigure(node, source) {
  // The diagram is kept verbatim (SVG plus its figcaption): it is content, not decoration.
  const raw = source.slice(node.start, node.end);
  const aria = find(node, 'svg')?.attrs?.['aria-label'];
  const out = [];
  if (aria) out.push(`<!-- figure: ${collapse(decodeEntities(aria))} -->`);
  out.push(raw.trimEnd(), '');
  return out;
}

function renderHeader(node) {
  const out = [];
  for (const child of elements(node)) {
    if (child.tag === 'h1') {
      out.push(`## ${inlineOf(child)}`, '');
      continue;
    }
    if (child.tag === 'p' && hasClass(child, 'lede')) {
      out.push(inlineOf(child), '');
      continue;
    }
    if (hasClass(child, 'note')) {
      out.push(...renderNoteBox(child));
      continue;
    }
    if (hasClass(child, 'eyebrow')) {
      out.push(`${collapse(inline(child))}`, '');
      continue;
    }
    out.push(...renderBlocks([child]));
  }
  return out;
}

function renderSection(node, source) {
  const out = [];
  const phase = hasClass(node, 'phase');
  const head = elements(node).find((child) => hasClass(child, 'phase-head'));
  if (phase && head) {
    const tag = elements(head).find((child) => hasClass(child, 'tag'));
    const h2 = find(head, 'h2');
    const label = [tag ? plainText(tag) : '', h2 ? plainText(h2) : ''].filter(Boolean).join(' — ');
    out.push(`## ${label}`, '');
  } else {
    const h2 = find(node, 'h2');
    if (h2) out.push(`## ${inlineOf(h2)}`, '');
  }
  for (const child of elements(node)) {
    if (child === head) continue;
    if (child.tag === 'h2') continue;
    out.push(...renderBlocks([child], source));
  }
  return out;
}

function renderBlocks(nodes, source) {
  const out = [];
  const block = (child) => {
    if (child.tag === '#text') return;
    if (child.tag === 'script' || child.tag === 'style' || child.tag === 'button') return;
    if (child.attrs?.id === 'nxp') return;
    if (child.tag === 'header') {
      out.push(...renderHeader(child));
      return;
    }
    if (child.tag === 'footer') {
      for (const p of elements(child).filter((n) => n.tag === 'p')) out.push(inlineOf(p), '');
      return;
    }
    if (child.tag === 'section') {
      out.push(...renderSection(child, source));
      return;
    }
    if (child.tag === 'h2') {
      out.push(`## ${inlineOf(child)}`, '');
      return;
    }
    if (child.tag === 'h3') {
      out.push(`### ${inlineOf(child)}`, '');
      return;
    }
    if (child.tag === 'p') {
      out.push(inlineOf(child), '');
      return;
    }
    if (child.tag === 'figure') {
      out.push(...renderFigure(child, source));
      return;
    }
    if (child.tag === 'table') {
      out.push(...renderTable(child), '');
      return;
    }
    if (child.tag === 'ol' || child.tag === 'ul') {
      if (hasClass(child, 'steps')) {
        out.push(...renderSteps(child));
        return;
      }
      const items = elements(child).filter((n) => n.tag === 'li');
      for (const li of items) out.push(`- ${inlineOf(li)}`);
      out.push('');
      return;
    }
    if (hasClass(child, 'tablewrap')) {
      const table = find(child, 'table');
      if (table) out.push(...renderTable(table), '');
      return;
    }
    if (hasClass(child, 'why-order')) {
      for (const note of elements(child)) out.push(...renderNoteBox(note));
      return;
    }
    if (hasClass(child, 'rules')) {
      out.push(...renderRules(child));
      return;
    }
    if (hasClass(child, 'legend')) {
      for (const span of elements(child)) out.push(`- ${inlineOf(span)}`);
      out.push('');
      return;
    }
    if (hasClass(child, 'note')) {
      out.push(...renderNoteBox(child));
      return;
    }
    if (hasClass(child, 'notes')) return;
    if (child.tag === 'div') {
      out.push(...renderBlocks(elements(child), source));
      return;
    }
    // Unknown element with text: keep the text, never drop prose silently.
    const text = inlineOf(child);
    if (text) out.push(text, '');
  };
  for (const child of nodes) block(child);
  return out;
}

// Collapse the blank-line noise the emitters produce into exactly one blank line between blocks.
function tidy(lines) {
  const out = [];
  for (const line of lines) {
    const text = line.replace(/[ \t]+$/, '');
    if (text === '') {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(text);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}

function phaseSteps(root) {
  return stepEntries(root).filter((step) => step.inPhase);
}

export function renderBody(source) {
  const tree = parseHtml(source);
  const body = find(tree, 'body') ?? tree;
  const wrap = findAll(body, (n) => hasClass(n, 'wrap'))[0] ?? body;
  const lines = [];
  for (const child of elements(wrap)) lines.push(...renderBlocks([child], source));
  return tidy(lines);
}

export function coverageReport(source, markdown) {
  const tree = parseHtml(source);
  const steps = phaseSteps(tree);
  const order = [];
  const re = /^### Step (\S+?)(?: — (.+))?$/gm;
  let match;
  while ((match = re.exec(markdown))) order.push({ num: match[1], title: (match[2] ?? '').trim() });
  const expected = steps.map((step) => ({ num: step.num, title: step.title }));
  const missing = expected.filter((step) => !order.some((entry) => entry.num === step.num && entry.title === step.title));
  const sequence = expected.map((step) => `${step.num} ${step.title}`).join('\n');
  const actual = order
    .filter((entry) => expected.some((step) => step.num === entry.num))
    .map((entry) => `${entry.num} ${entry.title}`)
    .join('\n');
  return {
    expected,
    order,
    missing,
    inOrder: sequence === actual,
    counts: { phaseSteps: expected.length, headings: order.length, allSteps: stepEntries(tree).length },
  };
}

export function splitDocument(markdown) {
  const index = markdown.indexOf(MARKER);
  if (index === -1) throw new Error(`PRD.md has no marker line: ${MARKER}`);
  const preamble = markdown.slice(0, index + MARKER.length);
  const body = markdown.slice(index + MARKER.length).replace(/^\n+/, '');
  return { preamble, body };
}

function main() {
  const check = process.argv.includes('--check');
  const source = fs.readFileSync(SRC, 'utf8');
  const body = renderBody(source);

  let existing = null;
  if (fs.existsSync(OUT)) existing = fs.readFileSync(OUT, 'utf8');
  if (existing === null) {
    console.error(`missing ${path.relative(repoRoot, OUT)}; create it with the hand-written preamble and the marker line first`);
    process.exit(1);
  }
  const { preamble } = splitDocument(existing);
  const next = `${preamble}\n\n${body}`;
  const report = coverageReport(source, body);

  if (report.missing.length) {
    console.error(`step coverage FAILED: ${report.missing.length} step(s) from index.html are absent from the generated body`);
    for (const step of report.missing.slice(0, 10)) console.error(`  - ${step.num} ${step.title}`);
    process.exit(1);
  }
  if (!report.inOrder) {
    console.error('step coverage FAILED: step headings are not in page order');
    process.exit(1);
  }

  if (check) {
    const current = splitDocument(existing);
    const same = current.body === body && existing === next;
    const currentReport = coverageReport(source, current.body);
    if (currentReport.missing.length) {
      console.error(`stale: PRD.md is missing ${currentReport.missing.length} step(s) that index.html carries (absent or changed)`);
      for (const step of currentReport.missing.slice(0, 10)) console.error(`  - ${step.num} ${step.title}`);
      process.exit(1);
    }
    if (!same) {
      console.error('stale: PRD.md body does not match docs/plans/xtrm-build-order/index.html');
      console.error('run: npm run plan:md');
      process.exit(1);
    }
    console.log(`ok: PRD.md body matches index.html (${report.counts.phaseSteps} phase steps, ${report.counts.allSteps} step entries)`);
    return;
  }

  fs.writeFileSync(OUT, next);
  console.log(`wrote ${path.relative(repoRoot, OUT)} (${report.counts.phaseSteps} phase steps, ${report.counts.allSteps} step entries)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
