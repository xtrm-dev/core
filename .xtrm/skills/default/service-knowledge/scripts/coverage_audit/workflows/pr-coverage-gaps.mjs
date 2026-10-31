export const TEXT = { type: "string", minLength: 1 };

export const prPrepCode = `s => {
  const prs = Array.isArray(s.prs) ? s.prs : [];
  const isTestDoc = (f) => f.startsWith('tests/') || f.startsWith('docs/') || f.startsWith('data/') || f.startsWith('.xtrm/') || f.indexOf('/') === -1;
  const items = prs.map(p => {
    const files = Array.isArray(p.files) ? p.files : [];
    const core = Array.isArray(p.coreFiles) ? p.coreFiles : files.filter(f => !isTestDoc(f));
    const oc = p.coreOwners || p.ownerCounts || {};
    const ranked = Object.entries(oc).sort((a, b) => b[1] - a[1]);
    const voted = p.titleVote && oc[p.titleVote] ? p.titleVote : '';
    const primary = voted || (ranked.length ? ranked[0][0] : '');
    const shown = core.slice(0, 15);
    const tests = files.length - core.length;
    return { pr: p.pr, title: p.title || '', count: p.fileCount || files.length,
      filesShown: shown, filesTruncated: core.length > shown.length,
      coreCount: core.length, testDocCount: tests,
      rankedOwners: ranked.slice(0, 3).map(([k, v]) => k + ':' + v).join(','),
      candidatePrimary: primary, votedBy: voted ? 'title' : 'registry-order',
      multiOwners: ranked.length > 1,
      codeFlags: [
        core.length ? 'has_core_files:' + core.length : 'test_doc_only',
        ranked.length ? 'core_owned_by:' + ranked.map(([k]) => k).join(',') : 'core_unowned',
        ranked.length > 1 ? 'multi_owner_core' : 'single_owner_core',
        'tests:' + tests,
      ].join('+') };
  });
  return { prItems: items };
}`;

export const prEvidenceCode = `s => {
  const j = s.prJudge || {};
  const it0 = s.item || {};
  const label = j.verdict || 'unclear';
  const linn = (it0.filesShown || []).some(f => f.indexOf('linnsoft') !== -1 || f.indexOf('LinnSoft') !== -1 || f.indexOf('linnsoft') !== -1);
  const sess = (it0.filesShown || []).some(f => f.indexOf('session_authority') !== -1 || f.indexOf('session_profiles') !== -1 || f.indexOf('session_map') !== -1 || f.indexOf('cme_holiday') !== -1);
  const newCandidate = linn ? 'linnsoft-rollover' : (sess ? 'session-authority' : '');
  return { prLabel: label, prCandidate: it0.candidatePrimary || '', prVotedBy: it0.votedBy || '', prRanked: (it0.rankedOwners || ''), prNewCandidate: newCandidate,
    prKey: it0.pr || '', prTitle: it0.title || '', prFiles: (it0.filesShown || []).join(', '),
    prFlags: it0.codeFlags || '', prCount: it0.count || 0 };
}`;

export const prEmitCode = `s => {
  const label = s.prLabel || 'unclear';
  const cat = label === 'extend_territory' ? (s.prConfirmed === false ? 'unclear' : 'extend_territory') : label;
  const tgt = label === 'extend_territory' ? (s.prConfirmed === false ? '' : (s.prCandidate || '')) : (label === 'new_skill' ? (s.prNewCandidate || '') : '');
  const note = label === 'extend_territory'
    ? (s.prConfirmed === false ? 'Primary contested: ' + (s.prCandidate || '?') + ' rejected by confirm judge.' : 'Primary owner ' + (s.prCandidate || '?') + ' confirmed.')
    : (label === 'new_skill'
      ? ((s.prNewCandidate || '') ? 'Flagship evidence for new ' + s.prNewCandidate + '.' : 'New subsystem but no candidate mapped.')
      : (label === 'leave_unowned' ? 'Tests, fixtures, docs, or root config: evidence, not living surface.' : 'Group evidence fits more than one owner or none cleanly.'));
  return { outcome: { action: 'emit', item: { key: s.prKey || '', category: cat,
    target: tgt, evidence: 'files=' + (s.prCount || 0) + ' flags=' + (s.prFlags || ''),
    quote: (s.prTitle + ' :: ' + note).slice(0, 220), decided_by: 'jev' } } };
}`;

export const prSplitCode = `s => {
  const outs = s.prOutcomes || [];
  const emitted = outs.filter(o => o && o.action === 'emit').map(o => o.item);
  const counts = {};
  for (const e of emitted) counts[e.category] = (counts[e.category] || 0) + 1;
  return { prFindings: emitted, prCounts: counts, prChecked: outs.length };
}`;

export const prSummaryCode = `s => {
  const checked = s.prChecked || 0;
  const counts = s.prCounts || {};
  const findings = s.prFindings || [];
  const L = [];
  L.push('Checked ' + checked + ' PRs over the sync range.');
  L.push('By verdict: ' + (Object.entries(counts).map(([k, v]) => k + ': ' + v).join('; ') || 'none') + '.');
  for (const f of findings) L.push('- ' + f.key + ' [' + f.category + (f.target ? ' -> ' + f.target : '') + ']: ' + (f.quote || '').slice(0, 160));
  return { summary: { summary_markdown: L.join('\\n') } };
}`;

export const prAssembleCode = `s => ({ result: {
  findings: s.prFindings || [], counts: s.prCounts || {},
  checked: s.prChecked || 0,
  summary_markdown: (s.summary && s.summary.summary_markdown) || '' } })`;

export const prCoverageGapsWorkflow = {
  v: 2,
  name: "pr-coverage-gaps",
  schemas: {
    PrInput: {
      type: "object", additionalProperties: false,
      required: ["prs", "snapshotAt"],
      properties: {
        prs: { type: "array", items: { type: "object", additionalProperties: true } },
        snapshotAt: { type: "string", minLength: 1 },
      },
    },
    ClassVerdict: {
      type: "object", additionalProperties: false, required: ["verdict"],
      properties: { verdict: { type: "string",
        enum: ["new_skill", "extend_territory", "leave_unowned", "unclear"],
        description: "Given the PR title, its changed files, and the deterministic ownership flags, how should service-knowledge cover this PR? Prefer extending an owning skill; a new skill needs a coherent unowned subsystem; tests and docs stay unowned.",
        criteria: {
          new_skill: "Four or more core files outside every registered territory forming one subsystem with runtime or operational identity (own job, timer, artifact pipeline, generator-to-consumer chain) across at least two of code, config-or-artifact, tests. A one-to-three-file change is a one-off script with its own docs: leave_unowned, never new_skill.",
          extend_territory: "Core files fall inside, or directly extend, a registered territory whose skill already documents the behavior. When one shared file (for example the snapshot feed) sits in stacked umbrella territories, break the tie with the PR title: prefer the leaf service that documents the named behavior over the umbrella that merely contains the file.",
          leave_unowned: "Only tests, fixtures, docs, root config, or dependency pins changed - evidence, not living service surface.",
          unclear: "Two or more services own core code files in near-equal measure AND the PR title does not name which behavior changed. A multi_owner_core flag alone is not enough: break the tie with the title first, and use unclear only when the title also fails to discriminate.",
        } } },
    },
    ConfirmVerdict: {
      type: "object", additionalProperties: false, required: ["confirmed"],
      properties: { confirmed: { type: "boolean",
        description: "Is the named candidate the primary skill this PR's changes belong to?",
        criteria: {
          true: "The candidate owns core files or documents the behavior the PR title names. A title-voted candidate beats a registry-order winner on stacked-umbrella ties (one shared file in several territories); other owners are incidental (shared workflow files, umbrella mentions).",
          false: "The candidate is incidental, the title names a different behavior, or the PR genuinely spans peers with no primary.",
        } } },
    },
    PrSummary: {
      type: "object", additionalProperties: false, required: ["summary_markdown"],
      properties: { summary_markdown: TEXT },
    },
    PrOut: {
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
  input: { schemaId: "PrInput" },
  output: { schemaId: "PrOut", path: "result" },
  root: {
    node: "chain",
    steps: [
      { node: "code", label: "pr-prep", code: prPrepCode },
      { node: "map", label: "pr-review", itemsPath: "prItems", as: "prOutcomes", resultPath: "outcome", maxConcurrency: 4,
        body: { node: "chain", steps: [
          { node: "judge", label: "pr-judge",
            state: { pr: "{item.pr}", title: "{item.title}", fileCount: "{item.count}",
              coreFiles: "{item.filesShown}", truncated: "{item.filesTruncated}",
              testDocFiles: "{item.testDocCount}", rankedCoreOwners: "{item.rankedOwners}",
              candidatePrimary: "{item.candidatePrimary}", codeFlags: "{item.codeFlags}" },
            out: "ClassVerdict", as: "prJudge" },
          { node: "code", label: "pr-evidence", code: prEvidenceCode },
          { node: "route", label: "pr-route", valuePath: "prLabel", as: "prRouting", otherwise: "other",
            branches: {
              extend_territory: { body: { node: "chain", steps: [
                { node: "judge", label: "pr-confirm",
                  state: { pr: "{prKey}", title: "{prTitle}", files: "{prFiles}",
                    candidate: "{prCandidate}", proposed_by: "{prVotedBy}", coOwners: "{prRanked}", flags: "{prFlags}" },
                  out: "ConfirmVerdict", as: "prConfirm" },
                { node: "code", label: "emit-extend", code: "s => ({ prConfirmed: (s.prConfirm || {}).confirmed !== false, prKey: s.prKey })" },
              ] } },
              other: { body: { node: "code", label: "emit-other", code: "s => ({ prConfirmed: true })" } },
            } },
          { node: "code", label: "pr-emit", code: prEmitCode },
        ] } },
      { node: "code", label: "split-pr", code: prSplitCode },
      { node: "code", label: "summarize-pr", code: prSummaryCode },
      { node: "code", label: "final", code: prAssembleCode },
    ],
  },
};
