export const TEXT = { type: "string", minLength: 1 };

export const coveragePrepCode = `s => {
  const groups = Array.isArray(s.groups) ? s.groups : [];
  const isTestDoc = (f) => f.startsWith('tests/') || f.startsWith('docs/') || f.startsWith('data/') || f.indexOf('/') === -1;
  const items = groups.map(g => {
    const files = Array.isArray(g.files) ? g.files : [];
    const core = files.filter(f => !isTestDoc(f));
    const ownedCore = core.filter(f => g.ownerHits && g.ownerHits[f]);
    const shown = files.slice(0, 25);
    return { id: g.id, count: g.count || files.length, theme: g.theme || '',
      filesShown: shown, filesTruncated: files.length > shown.length,
      coreCount: core.length, ownedCoreCount: ownedCore.length,
      ownedCoreSample: ownedCore.slice(0, 5),
      codeFlags: [
        core.length ? 'has_core_files:' + core.length : 'test_doc_only',
        ownedCore.length ? 'territory_overlap:' + ownedCore.length : 'no_territory_overlap',
      ].join('+') };
  });
  return { coverageItems: items };
}`;

export const coverageEvidenceCode = `s => {
  const j = s.coverageJudge || {};
  const it0 = s.item || {};
  return { coverageLabel: j.verdict || 'unclear',
    evGroup: it0.id || '', evFiles: (it0.filesShown || []).join(', '),
    evTheme: it0.theme || '', evFlags: it0.codeFlags || '' };
}`;

export const coverageTranscribeCode = `s => {
  const it0 = s.item || {};
  const v = (s.coverageJudge || {}).verdict || 'unclear';
  const first = (it0.filesShown || [])[0] || 'no files';
  const notes = {
    'new:session-authority': 'Session-window authority chain (generator, yaml/json artifacts, verifier, golden tests) owned by no service; see ' + first,
    'new:linnsoft-rollover': 'Fetch-to-cutover LinnSoft chain (timer job, shadow report, interim rulings) spans four skills with no single owner; see ' + first,
    'extend:serving-mcp-tools': 'Core serving implementation already documented by this skill; see ' + first,
    'extend:computing-snapshots': 'Pure shared library consumed by the snapshot feed alongside owned siblings; see ' + first,
    'extend:ingesting-tick-data': 'Artifact or reference supporting the documented bar pipeline; see ' + first,
    'extend:repository-ci-cd': 'CI/eval surface run by lanes this skill owns; see ' + first,
    'leave': 'Tests, fixtures, audits, proposals, or root config: evidence, not living service surface.',
    'unclear': 'Group evidence fits more than one owner or none cleanly.',
  };
  const parts = v.split(':');
  const cls = parts[0] === 'new' ? 'new_skill' : (parts[0] === 'extend' ? 'extend_territory' : (parts[0] === 'leave' ? 'leave_unowned' : 'unclear'));
  return { outcome: { action: 'emit', item: { key: it0.id, category: cls,
    target: parts.length > 1 ? parts.slice(1).join(':') : '',
    evidence: 'files=' + (it0.count || 0) + ' core=' + (it0.coreCount || 0) + ' flags=' + (it0.codeFlags || ''),
    quote: (notes[v] || notes['unclear']).slice(0, 200), decided_by: 'jev' } } };
}`;

export const splitCoverageCode = `s => {
  const outs = s.coverageOutcomes || [];
  const emitted = outs.filter(o => o && o.action === 'emit').map(o => o.item);
  const counts = {};
  for (const e of emitted) counts[e.category] = (counts[e.category] || 0) + 1;
  return { coverageFindings: emitted, coverageCounts: counts, coverageChecked: outs.length };
}`;

export const summaryCode = `s => {
  const checked = s.coverageChecked || 0;
  const counts = s.coverageCounts || {};
  const findings = s.coverageFindings || [];
  const L = [];
  L.push('Checked ' + checked + ' gap groups over the sync range.');
  L.push('By verdict: ' + (Object.entries(counts).map(([k, v]) => k + ': ' + v).join('; ') || 'none') + '.');
  for (const f of findings) L.push('- ' + f.key + ' [' + f.category + (f.target ? ' -> ' + f.target : '') + ']: ' + (f.quote || '').slice(0, 160));
  return { summary: { summary_markdown: L.join('\\n') } };
}`;

export const assembleCoverageCode = `s => ({ result: {
  findings: s.coverageFindings || [], counts: s.coverageCounts || {},
  checked: s.coverageChecked || 0,
  summary_markdown: (s.summary && s.summary.summary_markdown) || '' } })`;

export const skCoverageGapsWorkflow = {
  v: 2,
  name: "sk-coverage-gaps",
  schemas: {
    CoverageInput: {
      type: "object", additionalProperties: false,
      required: ["groups", "snapshotAt"],
      properties: {
        groups: { type: "array", items: { type: "object", additionalProperties: true } },
        snapshotAt: { type: "string", minLength: 1 },
      },
    },
    CoverageVerdict: {
      type: "object", additionalProperties: false, required: ["verdict"],
      properties: { verdict: { type: "string",
        enum: ["new:session-authority", "new:linnsoft-rollover", "extend:serving-mcp-tools", "extend:computing-snapshots", "extend:ingesting-tick-data", "extend:repository-ci-cd", "leave", "unclear"],
        description: "Given the gap group's files, deterministic code flags, and theme, route it. The create flow prefers extending an owning skill; a new label needs a coherent unowned subsystem with runtime or operational identity.",
        criteria: {
          "new:session-authority": "Session-window authority chain: generator scripts, yaml/json artifacts, verifier, golden fixtures and tests, owned by no service. Generator-to-consumer chain with operational identity (artifact expiry is loud, consumers in two languages).",
          "new:linnsoft-rollover": "Fetch-to-cutover LinnSoft chain: fetch job, host timer units, shadow report, interim rulings, research data. Crosses four skills with no single owner for the cadence and timer.",
          "extend:serving-mcp-tools": "Core MCP serving implementation whose behavior that skill already documents in detail.",
          "extend:computing-snapshots": "Pure shared library consumed by the snapshot feed alongside sibling files that skill already owns.",
          "extend:ingesting-tick-data": "Artifact, generator, reference implementation or golden vectors supporting the shadow bar pipeline that skill documents.",
          "extend:repository-ci-cd": "CI lane, eval harness, or doc-gate surface run by lanes that skill owns.",
          "leave": "Tests, fixtures, audit reports, proposals, repo-root config, or point-in-time docs - evidence, not living service surface. codeFlags test_doc_only supports this.",
          "unclear": "Evidence fits more than one label or none cleanly. Prefer this over forcing a named label on thin evidence.",
        } } },
    },
    CoverageSummary: {
      type: "object", additionalProperties: false, required: ["summary_markdown"],
      properties: { summary_markdown: TEXT },
    },
    CoverageOut: {
      type: "object", additionalProperties: false,
      required: ["findings", "counts", "checked", "summary_markdown"],
      properties: {
        findings: { type: "array", items: { type: "object", additionalProperties: true } },
        counts: { type: "object", additionalProperties: true },
        checked: { type: "integer", minimum: 0 },
        summary_markdown: TEXT,
      },
    },
  },
  input: { schemaId: "CoverageInput" },
  output: { schemaId: "CoverageOut", path: "result" },
  root: {
    node: "chain",
    steps: [
      { node: "code", label: "coverage-prep", code: coveragePrepCode },
      { node: "map", label: "coverage-review", itemsPath: "coverageItems", as: "coverageOutcomes", resultPath: "outcome", maxConcurrency: 4,
        body: { node: "chain", steps: [
          { node: "judge", label: "coverage-judge",
            state: { group: "{item.id}", fileCount: "{item.count}", coreCount: "{item.coreCount}",
              files: "{item.filesShown}", truncated: "{item.filesTruncated}",
              ownedCore: "{item.ownedCoreSample}", codeFlags: "{item.codeFlags}", theme: "{item.theme}" },
            out: "CoverageVerdict", as: "coverageJudge" },
          { node: "code", label: "coverage-transcribe", code: coverageTranscribeCode },
        ] } },
      { node: "code", label: "split-coverage", code: splitCoverageCode },
      { node: "code", label: "summarize-coverage", code: summaryCode },
      { node: "code", label: "final", code: assembleCoverageCode },
    ],
  },
};
