# Substrate (sb) for a programme coordinator

Verified against sb 0.2.2 (source: `~/dev/xtrm/packages/substrate`, `cli/sb.ts` help table and
`docs/`). `sb help <group>` works (`sb help issue`, `sb help journal`, `sb help plan`). Per-verb help
(`sb help issue create`) fails in 0.2.2: read the group help. Check `sb --version` before trusting
this page. Run `sb` inside a git checkout of the repo or pass `--project <id>`.

## Issue kinds and hierarchy

Kinds: `epic | task | bug | decision | research | followup`. Any issue can have a parent, so epics
nest: programme epic > theme epic > worker task. Locators are hierarchical (`CORE-2377.2.3`).

| Need | Command |
|---|---|
| Whole programme tree | `sb issue tree --root <epic>` |
| Direct children | `sb issue children <ref>` |
| Find issues | `sb issue query --project <id> --kind task --lifecycle open --search <q>` |
| Dispatchable now | `sb issue ready` |
| Dependency | `sb issue relate --from A --to B --kind blocks` (A blocks B: B is not ready until A is done) |
| Other graph links | kinds `relates_to`, `discovered_from`, `supersedes`, `duplicates` (do not block readiness) |

## Create the tree in one step

`sb plan check` validates, `sb plan apply` commits everything in one transaction. Pipe the plan; keep
no file (`--file /dev/stdin` tested with `plan check`; run `check` before `apply`). The same `planKey` re-applied is a no-op, so a retry cannot duplicate.

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

`parentKey` is a draft key or an existing issue id. `edges` use draft keys. Contract fields:
`problem`, `success` (strings); `scope`, `nonGoals`, `constraints` (string arrays);
`validation` `[{"check": ...}]`; `output` `[{"artifact": ...}]`. Scrutiny is uppercase
(`LOW MEDIUM HIGH CRITICAL`). To add one issue later: `sb issue create --kind task --parent <theme> ...`.

## Lifecycle of one contract

1. Created issues are DRAFT and not claimable. Attest:
   `sb issue attest <ref> --outcome ready --policy default --attested-by <you>`.
   (`--policy contract-baseline` is accepted but denies every scrutiny level.) If still draft:
   `sb --json issue show <ref>` and read `data.reasons`.
2. `sb issue edit <ref> --contract <json> --expected-revision N` changes what the work IS: it bumps
   the revision and needs a new attestation. Title and priority do not.
3. The owner claims: `sb issue claim <ref> --holder <name>`. Claim is ownership, not progress.
4. Work, journal, checkpoint (below). Resume after a restart: `sb issue resume <ref>`.
5. Close: `sb issue close <ref> --outcome completed|superseded|duplicate|wont_fix|invalid|cancelled|abandoned
   --reason "..." --result <journal-entry-ref> --validation ... --artifact ...`.
   Closure is immutable; a mistake is `sb issue reopen`. Releasing a claim is not a close.
6. Do not commit while a claim is open on the issue: release or close first.

## Journal: the programme's memory

Nine kinds. Use the one that says what the entry is.

| Kind | Use on a programme epic |
|---|---|
| `decision` | A chosen course plus the reason. The operator's rulings. |
| `finding` | A discovered fact. |
| `blocker` | An open question or stuck condition. Answer it with a later `decision` that names it. |
| `milestone` | A theme or sprint boundary reached. |
| `result` | A bounded outcome (needs `--result '{"summary": "..."}'`). Cite it when closing. |
| `handoff` | Bounded continuation state: next steps, live workers, timers, the /goal text. |
| `checkpoint` | A resumability boundary (`sb journal checkpoint <ref>`; mechanical row first). |
| `compaction` | Written by the compaction hook. |
| `note` | Anything else. |

- Fast path: `sb issue note <ref> "text" --kind decision` (`--file -` reads stdin).
- Structured: `sb journal append <ref> --kind <k> --semantic '{"summary": "..."}'`.
- Read: `show` (full bodies), `since <ref> <cursor>` (delta), `latest --kind <k>`,
  `timeline --limit n`, `render <ref>` (latest checkpoint as text).
- Entries truncate near 2 KB with no error: one fact per entry, or split.
- The journal never changes the contract, revision or readiness.

## Pin a worker's name on every entry

Journal writes take identity from the environment: `SUBSTRATE_HOLDER` becomes `participantId`;
`XTRM_SESSION_NAME` and `XTRM_SESSION_ID` stamp the session; `--session '<tmux id>'` overrides
(quote `$2`). Verified with `sb` run directly (not through `xt claude`): with
`SUBSTRATE_HOLDER=w1 XTRM_SESSION_NAME=w1`, a new entry reads
`participantId: w1, xtrmSessionName: w1`. Without them the participant is `(none recorded)`.

`xt` already publishes `XTRM_SESSION_ID` and `XTRM_SESSION_NAME` at launch
(`cli/src/core/session-identity.ts`), so no one types session ids. It does not publish a participant.
Specialists get theirs automatically (`specialist::<role>`, activation and attempt too). A worker
launched by `xt claude` needs `SUBSTRATE_HOLDER` set by hand until `xt` does it.

Workers share the coordinator's tmux session, so the session name is the same for all of them.
**The worker name must come from `SUBSTRATE_HOLDER`** (set it in the window command, see
`fleet.md`) and match `sb issue claim --holder`. Check a worker's first entry:
`sb journal latest <ref> --json` shows `participantId`.

For commit and PR evidence use provenance: `sb provenance dispatch <ref> --participant <name>`
before work, then `allocate` and `bind <receipt> <sha>`. `sb provenance trace <ref>` shows the
spine; `sb provenance session <id>` shows what one session touched.

## Epic and Story contracts

The seven fields stay. For an Epic or Story they carry the brief's content (the brief itself is
written in Jira, ADR-style, and is the source for these fields):

| Field | Leaf task | Epic or Story |
|---|---|---|
| problem | 1-3 sentences | context, current state, trigger evidence, origin |
| success | a testable condition | outcomes the epic commits to |
| scope | files and symbols | workstreams, and the Stories or children that cover them |
| nonGoals | exclusions | boundaries with adjacent epics and their owners |
| constraints | technical limits | decisions, rejected alternatives, governing rules |
| validation | commands and checks | completion gates and the evidence standard |
| output | artifacts | deliverables |

## Not available

- `sb` has no Jira sync command. Substrate ships a Jira mapping design
  (`src/projections/jira/mapping.ts`, epic to Epic, roots only by default) but no verb runs it.
  Jira is written through `scripts/jira.py`.
