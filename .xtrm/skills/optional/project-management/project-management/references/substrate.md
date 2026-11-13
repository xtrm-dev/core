# Substrate (sb) for the manager, leads and workers

Verified against sb 0.2.6 (source: the substrate package's `cli/sb.ts` help table and `docs/`).
Before a verb you have not used this session, read its group help (SKILL.md rule 55). `sb help <group>` works (`sb help issue`, `sb help journal`, `sb help plan`). Per-verb help
(`sb help issue create`) fails in 0.2.6: read the group help. Check `sb --version` before trusting
this page. Run `sb` inside a git checkout of the repo or pass `--project <id>`.

The linkage and renewal surface (`sb links check|sync`, `sb issue renew`, the close gate) needs
substrate at or above the release after 0.2.6 (XTRM-747): `sb 0.2.6` does not have those verbs,
so an older `sb` answers `unknown help topic`. The merge guard, `xt identity marker-check` and the
`gh` shim ship with `xt` 0.15.3 and later.

## Issue kinds and hierarchy

Kinds `epic | task | bug | decision | research | followup`; epics nest (project > theme > worker task); locators like `CORE-2377.2.3`.
`sb issue tree --root <epic>`, `children <ref>`, `query --project <id> --kind task --lifecycle open --search <q>`, `ready`.
`relate --from A --to B --kind blocks` blocks B until A is done; `relates_to`, `discovered_from`, `supersedes`, `duplicates` do not.

## Create the tree in one step

`sb plan check`, then `sb plan apply` (one transaction; pipe the plan, keep no file; the same `planKey` is a no-op).

```
sb plan apply --file /dev/stdin <<'JSON'
{"planKey": "prog-<name>-1", "issues": [
 {"key": "prog",  "projectId": "<project-id>", "title": "...", "kind": "epic",
  "scrutiny": "MEDIUM", "contract": {"problem": "...", "success": "...", "scope": ["..."],
  "nonGoals": ["..."], "constraints": ["..."], "validation": [{"check": "..."}],
  "output": [{"artifact": "..."}]}},
 {"key": "theme", "projectId": "<project-id>", "title": "...", "kind": "epic", "parentKey": "prog",
  "scrutiny": "MEDIUM", "contract": {"...": "..."}},
 {"key": "t1", "projectId": "<project-id>", "title": "...", "kind": "task", "parentKey": "theme",
  "scrutiny": "MEDIUM", "contract": {"...": "..."}}],
 "edges": [{"fromKey": "t1", "toKey": "t2", "kind": "blocks"}]}
JSON
```

`parentKey` is a draft key or an existing issue id. Scrutiny: `LOW MEDIUM HIGH CRITICAL`. Add one issue later:
`sb issue create --kind task --parent <theme> ...`. `validation` and `output` must be objects, else the issue stays DRAFT (`data.reasons`). Verify all
7 headers and scope correctness by reading the body; `contract=ready` is not evidence, to avoid burning a worker cycle.

## Lifecycle of one contract

1. Created issues are DRAFT and not claimable. Attest:
   `sb issue attest <ref> --outcome ready --policy default --attested-by <you>`.
   (`--policy contract-baseline` is accepted but denies every scrutiny level.) If still draft:
   `sb --json issue show <ref>` and read `data.reasons`.
2. `sb issue edit <ref> --contract <json> --expected-revision N` changes what the work IS: it bumps
   the revision and needs a new attestation. Title and priority do not. `--context-refs` binds a durable
   document that defines the work (`path@sha`); it makes a new revision too, so bind at planning time
   (`sb help issue` for the syntax).
3. The owner claims: `sb issue claim <ref> --holder <name>`. Claim is ownership, not progress.
   A claim is a lease of about 15 minutes by default. Pass `--ttl-ms <n>` to cover the checkpoint
   interval, and renew it at every checkpoint with `sb issue renew <ref>` (below). A same-holder
   re-claim returns ok but keeps the old `expiresAt` and generation (sb 0.2.x, verified 2026-10-25
   and 2026-10-28), so it renews nothing. A worker once closed its issue after its claim had
   lapsed, and `sb` accepted the close with no warning, so the lease is not a safety net. Release
   a live claim from its holder before claiming it yourself, because anti-steal refuses direct
   takes (`sb issue release <ref> --holder <who>`; it has no `--reason` flag).
4. Work, journal, checkpoint (below). Resume after a restart: `sb issue resume <ref>`.
5. Close: `sb issue close <ref> --outcome completed|superseded|duplicate|wont_fix|invalid|cancelled|abandoned
   --reason "..." --result <journal-entry-ref> --validation ... --artifact ...`.
   Closure is immutable; a mistake is `sb issue reopen`. Releasing a claim is not a close.
6. Do not commit while a claim is open on the issue: release or close first.

## Renew a claim

`sb issue renew <ref> [--holder <who>] [--ttl-ms <n>]` extends a lease that is still live. The
expiry moves; the generation does not, so a renewal can never look like a new claim. `--holder`
defaults to `SUBSTRATE_HOLDER`, exactly as for claim and release. An already-expired lease is not
renewable — claim it again, which records a new generation and is the honest signal that ownership
lapsed.

## Links and the close gate

Two rows carry a closed issue's evidence: `created_from` (this issue's work produced the PR, T1)
and `mentioned` (the issue is named but owns nothing). A trailer on the PR's commits (T2) counts
as delivery where the merged message keeps it.

| Need | Command |
|---|---|
| Attach the PR that is the outcome (T1) | `sb provenance attach <ref> pr <github:org/repo#n\|org/repo#n\|url\|#n>` |
| Write a mention, or T2 evidence from trailers | `sb issue link pr <ref> --repo <owner/name> --number <n> [--commit <sha>]... [--commits-range <base>..<head>]` |
| Withdraw a wrong row (the evidence row stays) | `sb issue unlink pr <ref> --repo <o/r> --number <n>` |
| List T2 candidates and link problems (read-only) | `sb links check [--project <id>] [--repo <owner/name>] [--limit <n>]` |
| Reconcile PR state and links in one pass | `sb links sync [<pr>] [--repo <owner/name>] [--since <ISO>] [--dry-run]` |

`sb links sync` reads GitHub conditionally (`If-None-Match`, `If-Modified-Since`; a 304 writes
nothing), then writes the trailer-first links, the mentions it found in titles, branches and bodies,
and the PR state. `--since` records the run as a backfill. A `gh pr create` made through the shim
attaches its own PR, best effort; a PR created another way is attached by hand.

The close gate reads rows, not prose. `sb issue close --outcome completed` and a bare
`sb issue state <ref> done` are gated; the other close outcomes are not. `XTRM_LINK_GATE` is `warn`
by default (`enforce` and `off` are opt-in). A refusal names its codes: `gate_mentioned_only` (a
mention is not delivery) and `gate_orphan_link` (a link with no live artifact). `--gate-override
<reason>` records why the gate was passed anyway. `sb links check` shows each verdict, so a
closer reads it before closing a slice and not after.

## Merges: the review at the exact head

With the merge guard on, a PR merges only with the reviewer App's review at its **current** head:

- `gh pr review` through the shim posts one formal review pinned to the reviewed head
  (`xt identity review-post` in a bare shell; the body's first line names role, model and head, and
  one `- Verdict:` line). PASS -> APPROVE, PARTIAL -> COMMENT, FAIL -> REQUEST_CHANGES.
- `gh pr merge` through the shim runs `xt identity merge-check` first, then the real merge with
  `--match-head-commit`, then writes the merge ref to the Journal. A review at an older head, a
  missing review, an active CHANGES_REQUESTED, or no resolvable Issue refuses the merge. A push
  after the review makes it stale: review the head you are about to merge.
- The guard runs only when `XTRM_MERGE_GUARD` is `on`, `1`, `true` or `yes`; a launched agent gets
  the value forwarded explicitly, so the launcher's `off` is not silently overridden. The
  manager/operator override is `XTRM_MERGE_GUARD_OVERRIDE=<reason>`, which is logged and
  journals a decision on the Issue.
- `xt identity setup` installs the `gh` shim and the role map; `xt identity doctor` reports their
  state. The shim refuses a `gh pr create` whose xtrm marker puts a tmux session id in `run=`
  (`xt identity marker-check`, CORE-2619). `XTRM_SESSION_ID` is shared by every window in one tmux
  session, so it attributes nothing: use `PI_SESSION_ID` on Pi or the Claude session id.

Full identity picture (roles, App tokens, review routing): `using-xtrm`,
`references/agent-identities.md`.

## Journal: the project's memory

Kinds: `decision` (course plus reason; operator rulings), `finding`, `blocker` (answer with a later `decision`), `milestone`, `result`, `handoff`,
`checkpoint` (`sb journal checkpoint <ref>`, mechanical row first), `compaction` (hook), `note`.
- `result` needs `--result '{"resultVersion":1,"summary":"..."}'`, else "requires a bounded result payload (§29)".
- `sb issue note <ref> "text" --kind decision` is the fast path. Structured: `sb journal append <ref> --kind <k> --semantic '{"summary": "..."}'`
  (file or JSON; plain text fails; a bare `"text"` stores NOTHING and does not fail: check for a `summary:` line).
- Read: `show`, `since <ref> <cursor>`, `latest --kind <k>`, `timeline --limit n`, `render <ref>`. Text views preview about 60 characters; `--json`
  gives the full entry. One fact per entry; the journal never changes contract or readiness.

## Pin a worker's name on every entry

- Identity: `SUBSTRATE_HOLDER` becomes `participantId`; `XTRM_SESSION_NAME`, `XTRM_SESSION_ID` stamp the session; without them `(none recorded)`. `xt`
  exports `SUBSTRATE_HOLDER=<worker>` on every launch since CORE-2390 (specialists get `specialist::<role>`); export it yourself otherwise, in every
  Bash call that writes with `sb`. The worker name is the holder.

- Commit and PR evidence: `sb provenance dispatch <ref> --participant <name>` before work, then `allocate` and `bind <receipt> <sha>`;
  `sb provenance trace <ref>` shows the spine, `sb provenance session <id>` what one session touched.

## Journal pitfalls

A bare `"text"` append stores NOTHING and does not fail; close outcomes are never "done".
A `result` entry can hold its whole payload in `result.summary` with `hasSemantic:false`: read results with `--json` before claiming "it did not run"
(11-04). A drift check that reads semantic text only misses it: fix the check before trusting its counts.

## Epic and Story contracts

The seven fields carry the Jira brief: problem = context, state, evidence, origin; success = outcomes; scope = workstreams and covering Stories;
nonGoals = adjacent boundaries and owners; constraints = decisions, rejected alternatives, rules; validation = gates; output = deliverables. A leaf
task: 1-3 sentence problem, testable success, files and symbols. `success` is a string; any other shape leaves readiness at DRAFT.

## Not available

`sb` has no Jira sync command (a mapping design exists in `src/projections/jira/mapping.ts`): Jira is written through `scripts/jira.py`.
