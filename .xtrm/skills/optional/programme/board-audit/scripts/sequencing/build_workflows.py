#!/usr/bin/env python3
"""Generate the four AgentRun workflows and the pinned rubrics for programme sequencing (MMD-2909).

One template, four closed verdict sets. Each workflow is: escalate on empty rows, then `map` of one `decide` per row.
No code node, no tool call, no extract node: the output is the map's own array of typed verdicts, so no model transcribes or
counts verdicts. Counts and majorities are computed in Python (aggregate_plan.py).

  python3 build_workflows.py        # writes workflows/*.json and rubrics.json next to this file
"""
import json
import pathlib

HERE = pathlib.Path(__file__).parent
VERSION = 'v1'

COMMON = """Facts are precomputed in code and are the only authority on relations, dates, counts and overlaps: read them, never recompute them and never invent a ref, key, date or number. Every value you cite must appear in the row evidence. Steps run in order; stop at the first step that returns a verdict, and set `rule` to that step id. The row carries oracle=<verdict> from the same steps computed in code. Return the oracle verdict unless a semantic step (J1) applies or a named evidence field contradicts it; when you differ from the oracle, begin `rule` with OVERRIDE: and name the field or quote the words that justify it. `note` must quote at least one evidence value you relied on."""

RUBRICS = {
    'bundles': """Rubric K (bundles) - one candidate bundle of programme units (booked windows and open PRs) linked by a shared PR, a shared or adjacent Substrate ref, or a symbol overlap. Verdict set: bundle | partial | split.
Meaning: bundle = merge every member into one production window and one promotion. partial = merge only the core, the other members keep their own windows. split = merge nothing; every member keeps its window.
Output: `verdict`, `rule`, `note`, and `in_keys` (bundle: all member keys; partial: the core keys; split: an empty list). Copy keys exactly as written in the evidence. The oracle is written verdict|keys: when you keep the oracle verdict, in_keys is exactly that key list (none means an empty list); when you override, build in_keys from the members= list.
K1 SOLO. If destructive_members names two or more windows, each keeps its own window: a destructive step needs watcher verification between steps, and each MCP window needs its own allowlist rotation. The core is every member that is not destructive, not blocked and not halt-only. Two or more core members: partial. Fewer than two: split.
K2 HALT. If halt_only_members is not none and does not cover every member, the ingestor image changes only in the CME halt, so those members stay out of the core. The core is every member that is not halt-only and not blocked; a single destructive member stays in the core here (only K1 removes destructive members). Two or more core members: partial. Fewer: split.
K3 BLOCKED. If blocked_members is not none, those members stay out of the core. The core is every member that is not blocked. Two or more core members: partial. Fewer: split.
K4 CLEAN. If K1, K2 and K3 did not apply, return bundle with every member.
J1 SEMANTIC (the only step that may change the result of K1-K4). Read members_detail. If two or more members are the same operation repeated per window by design, for example one MCP allowlist rotation for each separate MCP window, and edges contain a note: line saying so, return split. Set rule J1. Otherwise keep the result of K1-K4.
""" + COMMON,
    'pairs': """Rubric P (rewrite-risk pairs) - A is a change that already landed or is scheduled earlier; B is an open PR that touches the same code. Question: can B, merged later, rewrite or revert what A put in place? Verdict set: real-conflict | needs-order | benign | needs-review.
Meaning: needs-order = A must land and deploy before B, and B must be rebased on A and retested; real-conflict = B as titled undoes, replaces or removes what A introduced; benign = the overlap is additive or independent; needs-review = the facts cannot tell.
P0 NO OVERLAP. If shared_symbols, shared_config_keys and shared_sql are all none and migration_chain=no, return benign.
P1 UNRELIABLE. If footprint_unreliable=yes and shared_symbols, shared_config_keys and shared_sql are all none, return needs-review.
P2 REVERT WORDS. If b_revert_words=yes, shared_files is not none and title_shared_subject is not none, return real-conflict.
P3 STRONG OVERLAP. If shared_symbols, shared_config_keys or shared_sql is not none, or migration_chain=yes, and A is still open or a_in_b_history=no, return needs-order. In the note state order_holds, and when A is landed and b_predates_a=yes say that B must be rebased on current master and retested before it merges.
P5 ALREADY IN HISTORY. If A is landed (not open), a_in_b_history=yes and no revert step fired, return benign: B was cut from a history that already contains A, so later code evolves A, it does not undo it.
P6 UNKNOWN HISTORY. If A is landed, a_in_b_history=unknown, and the overlap is strong, return needs-review.
P4 OTHERWISE return benign.
J1 SEMANTIC (the only step that may change the result of P0-P4). Read the A title and the B title. (a) If the step result is needs-order and B's title states that it replaces, removes or undoes the subject named in A's title (the same subject, not merely the same file), return real-conflict. (b) If the step result is real-conflict because of revert words but B's title shows the revert words belong to a different subject than A's subject, return needs-order. (c) If the step result is needs-order but the two titles concern unrelated subjects and every shared symbol is a generic helper name, return benign. Set rule J1a, J1b or J1c. Otherwise keep the result.
""" + COMMON,
    'items': """Rubric I (unwindowed programme items) - one open Substrate issue under the programme with no production window. Verdict set: bundle-into | own-window | defer-after-11-05 | zombie-close | no-window-needed. The programme hard stop is 2026-11-05: nothing is planned after it, so defer-after-11-05 means the item leaves the programme.
Output: `verdict`, `rule`, `note`, and `target`: for bundle-into the window key from bundle_candidates (the first entry whose tags satisfy I4); for every other verdict the word none.
I1 ZOMBIE. If done_evidence=yes (a merged PR whose title shares a subject word with the item, no open PR, no live window naming the ref, no open child; done_evidence=partial is NOT enough, read done_gaps), or dup_or_superseded is not none, or (parent_state is done or cancelled and claim=none and idle_days is greater than 3 and open_prs is none), return zombie-close.
I2 NO WINDOW. If ships=no, return no-window-needed.
I3 DEFER. If readiness is draft or blocked, or of_which_without_window_or_pr is not none, or deferUntil is a date after 2026-11-05, return defer-after-11-05.
I4 BUNDLE. If bundle_candidates has an entry whose tags include shared_pr, declared_file_overlap, window_names_ref, sibling_ref or blocks, return bundle-into with target = that window key.
I5 OWN WINDOW. If ships is yes or likely, or ships=unknown and open_prs is not none, return own-window.
I7 VALUE. If blocks_count is 3 or more, return own-window.
I6 OTHERWISE return defer-after-11-05.
J1 SEMANTIC (the only step that may change the result of I1-I7). The ships field comes from a keyword rule. Read title and problem. If ships is yes, likely or unknown but the text plainly describes analysis, review, a decision, documentation or reporting with no code change and no deploy (for example "Review PR 1010", "Audit X"), return no-window-needed with rule J1. Do not use J1 to override I1, I3 or I4.
""" + COMMON,
    'days': """Rubric D (day capacity) - one calendar day between 2026-10-26 and 2026-11-05 as booked, plus the proposed own-window items. Verdict set: fits | over-capacity. The day is code arithmetic; there is no semantic step.
D1 HALT. If halt_slot_changes shows a count above 1 (folded tickets are already excluded), return over-capacity.
D2 EVENING. If evening_band_violations is not none, return over-capacity.
D3 OVERLAP. If same_target_overlaps is not none, return over-capacity.
D4 LOAD. If working_day_utilization is above the limit printed beside it, return over-capacity.
D5 VERIFICATION. If verification_squeezed lists two or more entries, return over-capacity.
D7 COUNT. If prod_changes is above the limit printed beside it, return over-capacity.
D6 OTHERWISE return fits.
In the note name each rule that fired, or state that D1-D5 were checked and none fired, and quote the values. Do not override the oracle: if you differ, begin `rule` with OVERRIDE: and quote the contradicting field.
""" + COMMON,
}

VERDICTS = {
    'bundles': ['bundle', 'partial', 'split'],
    'pairs': ['real-conflict', 'needs-order', 'benign', 'needs-review'],
    'items': ['bundle-into', 'own-window', 'defer-after-11-05', 'zombie-close', 'no-window-needed'],
    'days': ['fits', 'over-capacity'],
}
EXTRA = {
    'bundles': {'in_keys': {'type': 'array', 'items': {'type': 'string'}}},
    'items': {'target': {'type': 'string', 'minLength': 1}},
}

DECIDE = {
    'bundles': 'You receive rubric (the pinned decision procedure) and row (one candidate bundle with its precomputed facts in evidence). Follow the rubric steps in order and stop at the first that returns a verdict. Return key unchanged, the verdict, the rule id, a note that quotes an evidence value, and in_keys.',
    'pairs': 'You receive rubric (the pinned decision procedure) and row (one A>B pair with its precomputed overlap facts in evidence). Follow the rubric steps in order and stop at the first that returns a verdict. Return key unchanged, the verdict, the rule id and a note that quotes an evidence value.',
    'items': 'You receive rubric (the pinned decision procedure) and row (one unwindowed Substrate issue with its precomputed facts in evidence). Follow the rubric steps in order and stop at the first that returns a verdict. Return key unchanged, the verdict, the rule id, a note that quotes an evidence value, and target.',
    'days': 'You receive rubric (the pinned decision procedure) and row (one calendar day with its precomputed capacity facts in evidence). Follow the rubric steps in order and stop at the first that returns a verdict. Return key unchanged, the verdict, the rule id and a note that quotes an evidence value.',
}


def workflow(node):
    props = {
        'key': {'type': 'string', 'minLength': 1},
        'verdict': {'type': 'string', 'enum': VERDICTS[node]},
        'rule': {'type': 'string', 'minLength': 2},
        'note': {'type': 'string', 'minLength': 12},
    }
    props.update(EXTRA.get(node, {}))
    return {
        'v': 2,
        'name': f'programme-seq-{node}-{VERSION}',
        'input': {'schemaId': 'Input'},
        'output': {'path': 'verdicts', 'schemaId': 'Verdicts'},
        'schemas': {
            'Input': {'type': 'object', 'additionalProperties': False, 'required': ['batch_id', 'rubric', 'rows'],
                      'properties': {'batch_id': {'type': 'string', 'minLength': 1}, 'rubric': {'type': 'string', 'minLength': 1},
                                     'rows': {'type': 'array', 'maxItems': 45, 'items': {'$ref': '#/definitions/Row'}}}},
            'Row': {'type': 'object', 'additionalProperties': False, 'required': ['key', 'summary', 'oracle', 'evidence'],
                    'properties': {'key': {'type': 'string', 'minLength': 1}, 'summary': {'type': 'string', 'minLength': 1},
                                   'oracle': {'type': 'string', 'minLength': 1}, 'evidence': {'type': 'string', 'minLength': 1}}},
            'Verdict': {'type': 'object', 'additionalProperties': False, 'required': ['key', 'verdict', 'rule', 'note'] + list(EXTRA.get(node, {})),
                        'properties': props},
            'Verdicts': {'type': 'array', 'items': {'$ref': '#/definitions/Verdict'}},
        },
        'root': {'node': 'chain', 'steps': [
            {'node': 'escalate', 'label': 'require-rows', 'kind': 'needs_input', 'stage': 'input',
             'summary': 'No rows supplied. Supply rows: [{key, summary, oracle, evidence}] built by facts_plan.py.',
             'when': {'predicate': 'empty', 'path': 'rows'}},
            {'node': 'map', 'label': f'judge-{node}', 'itemsPath': 'rows', 'as': 'verdicts', 'maxConcurrency': 8,
             'body': {'node': 'decide', 'label': f'decide-{node}', 'as': 'verdict', 'out': 'Verdict', 'thinking': 'low', 'tools': [],
                      'instructions': DECIDE[node], 'state': {'row': '{item}', 'rubric': '{rubric}'}, 'requires': ['rubric']}},
        ]},
    }


def main():
    out = HERE / 'workflows'
    out.mkdir(exist_ok=True)
    for node in VERDICTS:
        (out / f'programme-seq-{node}-{VERSION}.json').write_text(json.dumps(workflow(node), indent=1) + '\n')
    (HERE / 'rubrics.json').write_text(json.dumps(RUBRICS, indent=1) + '\n')
    print('wrote', [p.name for p in sorted(out.glob('*.json'))], 'and rubrics.json')


if __name__ == '__main__':
    main()
