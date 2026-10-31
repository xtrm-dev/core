import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow, validateWorkflow, inspectWorkflow, workflowSha256 } from '@parcha/agentrun-dsl';
import { createJevRunner } from '@parcha/agentrun-jev';
import { prCoverageGapsWorkflow } from './workflows/pr-coverage-gaps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTDIR = join(HERE, 'results-prs');
const KEY_FILE = join(process.env.HOME, '.secrets', 'typesafe_api_key.txt');
const PI_MODELS = join(process.env.HOME, '.pi', 'agent', 'models.json');
const RUNNODE = { provider: 'commandcode', model: 'z-ai/glm-5.3-flash', maxTokens: 2000 };
const REPO = process.env.SK_REPO || process.cwd();
const REG = '.xtrm/skills/market-data/service-knowledge/service-registry.json';
const meter = { jevCalls: 0, jevIn: 0, jevOut: 0, jevCostUsd: null, jevElapsedMs: 0, nodeCalls: 0, nodeIn: 0, nodeOut: 0, nodeReasoning: 0, nodeCostUsd: 0 };

async function makeJudge() {
  const apiKey = (await readFile(KEY_FILE, 'utf8')).trim();
  const run = createJevRunner({ apiKey, timeoutMs: 120000, maxAttempts: 3 });
  return async (params) => {
    meter.jevCalls += 1;
    const t0 = Date.now();
    const r = await run(params);
    meter.jevElapsedMs += Date.now() - t0;
    meter.jevIn += r.usage?.input_tokens ?? 0;
    meter.jevOut += r.usage?.output_tokens ?? 0;
    if (typeof r.cost_usd === 'number') meter.jevCostUsd = (meter.jevCostUsd ?? 0) + r.cost_usd;
    return r;
  };
}

async function makeRunNode() {
  const cfg = JSON.parse(await readFile(PI_MODELS, 'utf8')).providers[RUNNODE.provider];
  if (!cfg?.apiKey) throw new Error(`Provider ${RUNNODE.provider} has no configured key.`);
  return async ({ system, user, schema, signal }) => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        meter.nodeCalls += 1;
        const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify({ model: RUNNODE.model, response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: [...system, 'Reply with one JSON object and nothing else. It must satisfy this JSON Schema exactly: ' + JSON.stringify(schema)].join('\n\n') }, { role: 'user', content: user }],
            max_tokens: RUNNODE.maxTokens }),
          signal,
        });
        if (!res.ok) throw new Error(`runNode HTTP ${res.status}`);
        const body = await res.json();
        const usage = body.usage ?? {};
        meter.nodeIn += usage.prompt_tokens ?? 0; meter.nodeOut += usage.completion_tokens ?? 0;
        meter.nodeReasoning += usage.completion_tokens_details?.reasoning_tokens ?? 0;
        const text = (body.choices?.[0]?.message?.content ?? '').trim();
        if (!text) throw new Error('runNode empty response text');
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        return JSON.parse(fenced ? fenced[1] : text);
      } catch (e) {
        lastErr = e;
        await new Promise(r => setTimeout(r, 4000 * attempt));
      }
    }
    throw lastErr;
  };
}

function repoProof() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const regBytes = execFileSync('git', ['show', 'HEAD:' + REG], { cwd: REPO, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const regHash = createHash('sha256').update(regBytes).digest('hex').slice(0, 16);
  return { head: head.slice(0, 12), registryHeadHash: regHash };
}

async function main() {
  const onlyInspect = process.argv.includes('--inspect-only');
  await mkdir(OUTDIR, { recursive: true });
  const sha = workflowSha256(prCoverageGapsWorkflow);
  const inspection = inspectWorkflow(prCoverageGapsWorkflow);
  const validation = validateWorkflow(prCoverageGapsWorkflow, { executeCode: false });
  console.log(`INSPECT sha=${sha.slice(0, 12)} nodes=${inspection.nodes.length} validate=${validation.ok ? 'ok' : 'FAILED'}`);
  for (const n of inspection.nodes) console.log('  ' + n.path + ' ' + n.kind + ':' + n.label);
  console.log('  requires=' + JSON.stringify(inspection.requires));
  if (!validation.ok) { console.log('VALIDATION ERRORS: ' + JSON.stringify(validation.errors).slice(0, 3000)); process.exit(2); }
  if (onlyInspect) return;

  const snap = JSON.parse(await readFile(join(OUTDIR, 'pr-files.json'), 'utf8'));
  const snapAgeMs = Date.now() - Date.parse(snap.ranAt);
  if (!Number.isFinite(snapAgeMs) || snapAgeMs > 3600000 || snapAgeMs < 0) {
    console.log(`STALE SNAPSHOT ranAt=${snap.ranAt}; re-run snapshot-prs.mjs within 1h of the run.`);
    process.exit(2);
  }
  const pre = repoProof();
  const input = { prs: snap.prs, snapshotAt: snap.ranAt };
  console.log(`input snapshot=${snap.ranAt} prs=${input.prs.length} base=${snap.baseRef.slice(0, 12)} head=${snap.headRef.slice(0, 12)}`);

  const runJudge = await makeJudge();
  const runNode = await makeRunNode();
  const t0 = Date.now();
  const result = await runWorkflow(prCoverageGapsWorkflow, input, { runJudge, runNode });
  const elapsedMs = Date.now() - t0;
  if (result.status !== 'complete') {
    console.log('RUN STATUS: ' + result.status + ' ' + JSON.stringify(result.escalation ?? null).slice(0, 800));
    process.exit(3);
  }
  const post = repoProof();
  const readOnly = pre.head === post.head && pre.registryHeadHash === post.registryHeadHash;
  const HOLDOUTS = { '#936': { category: 'extend_territory', target: 'computing-snapshots' }, '#884': { category: 'leave_unowned', target: '' }, '#933': { category: 'extend_territory', target: 'computing-snapshots' } };
  const byKey = Object.fromEntries((result.output.findings || []).map(f => [f.key, f]));
  const heldout = Object.entries(HOLDOUTS).map(([k, e]) => ({ key: k, expected: e.category + '/' + (e.target || '-'), got: byKey[k] ? byKey[k].category + '/' + (byKey[k].target || '-') : 'missing' }));
  const heldoutPass = heldout.every(h => { const [ec, et] = h.expected.split('/'); const [gc, gt] = h.got.split('/'); return ec === gc && et === gt; });
  const record = { ranAt: new Date().toISOString(), snapshotAt: snap.ranAt, baseRef: snap.baseRef, headRef: snap.headRef,
    prCount: snap.prCount, rangeFiles: snap.rangeFiles,
    heldout, heldoutPass,
    workflowSha256: sha, runNode: RUNNODE,
    effectAllowlist: ['git rev-parse/diff/show (repo reads via child_process in runner)', 'POST typesafe Jev classify (judge nodes only)', 'no extract/call nodes in this workflow'],
    elapsedMs, jev: { calls: meter.jevCalls, inTokens: meter.jevIn, outTokens: meter.jevOut, costUsd: meter.jevCostUsd, elapsedMs: meter.jevElapsedMs },
    node: { calls: meter.nodeCalls, inTokens: meter.nodeIn, outTokens: meter.nodeOut, reasoningTokens: meter.nodeReasoning, costUsd: meter.nodeCostUsd },
    ...result.output,
    readOnlyProof: { pre, post, readOnly } };
  await writeFile(join(OUTDIR, 'pr-coverage-gaps.json'), JSON.stringify(record, null, 2));
  const L = [];
  L.push('# Service-knowledge PR coverage (sync range 780d4afb..c3b27bd, read-only AgentRun)');
  L.push('');
  L.push(`- Ran at: ${record.ranAt}; snapshot at: ${record.snapshotAt} (freshness gate: <1h)`);
  L.push(`- Workflow sha: ${sha.slice(0, 12)}; checked: ${record.checked}`);
  L.push(`- runNode: ${RUNNODE.provider}/${RUNNODE.model}; Jev calls: ${meter.jevCalls}; runNode calls: ${meter.nodeCalls}`);
  L.push(`- Effects: ${record.effectAllowlist.join('; ')} (no repo/Substrate/GitHub writes)`);
  L.push('');
  L.push('## Operator summary');
  L.push('');
  L.push(record.summary_markdown);
  L.push('');
  L.push('## Counts');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(record.counts, null, 2));
  L.push('```');
  L.push('');
  L.push('## Findings');
  for (const f of (record.findings || [])) L.push(`- ${f.key} [${f.category}${f.target ? ' -> ' + f.target : ''}] ${f.evidence} :: ${f.quote}`);
  L.push('');
  L.push('## Holdout gate');
  L.push(`heldoutPass=${record.heldoutPass} ` + record.heldout.map(h => `${h.key} expected=${h.expected} got=${h.got}`).join('; '));
  L.push('');
  L.push('## Read-only proof');
  L.push(`readOnly=${readOnly} head=${post.head} registryHeadHash=${post.registryHeadHash}`);
  await writeFile(join(OUTDIR, 'pr-coverage-gaps.md'), L.join('\n') + '\n');
    console.log(`DONE findings=${record.findings.length} checked=${record.checked} snapshot=${record.snapshotAt} readOnly=${readOnly} heldoutPass=${record.heldoutPass} elapsedMs=${elapsedMs}`);
  if (!record.heldoutPass) { console.log('HOLDOUT GATE FAILED - batch discarded'); process.exit(4); }
}

await main();
