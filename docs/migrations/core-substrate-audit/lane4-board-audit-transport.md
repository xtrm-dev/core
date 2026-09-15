# Lane 4 — Board-audit / external-review transport vs Substrate projections

Read-only audit. Baseline: Core `e3c09927f115a9ad551953ede2262c91a9bbb431` (`xtrm-tools@0.12.0`),
worktree `xt/7awr`. Substrate snapshot `/tmp/audit/xtrm-main` @ `12e71d743a32c7b27af6c3e792574cfa08e7b81a`.
Rule enforced in this report: **Git branch/artifact = transport/projection; Substrate = authority.**
No second board database is proposed.

> Scope note (VERIFIED, changes the framing): the six `.githooks/board-audit-*` files in Core are the
> **gen-1** copies from the single commit `487e6074` (PR #592). The live **gen-2** implementation is
> `xtrm/packages/board-audit/**` in the xtrm repo (snapshot `/tmp/audit/xtrm-main/packages/board-audit`).
> Gen-2 is the canonical publication path; gen-1 handoff/reconcile + PR-checkpoint are documented as
> retained-but-superseded (`packages/board-audit/README.md:5-7,278-280`). Both are audited below.

---

## 1. Capability matrix

`Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence`

| Current surface | Current behavior | Current owner | Target owner | Target primitive | Evidence | Action | Upstream dependency | Ordering | Acceptance proof | Migration hazard | Release impact | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Full board acquisition (`bd export --all`) | One canonical acquisition; derives all projections from it | Core (gen-1/core, gen-2 export-wt) | Substrate | Substrate DB read + `sb export project` | `.githooks/board-audit-core:131-152`; `cli/sb.ts:2154-2160` | REPLACE | none (`sb export project` exists) | after Beads→Substrate import | `sb export project --project <id>` emits snapshot | Beads/Dolt and `~/.xtrm/state.db` coexist during migration | none | VERIFIED |
| Work-package projection (per-root hierarchy, relations, diagnostics, `content_sha256`) | Derives deterministic per-root packages from the raw snapshot | Core | Substrate + Core renderer | `IssueService.exportProject` (tree/edges/closures) + Core-owned per-root renderer | `.githooks/board-audit-core:444-476`; `src/service/issue-service.ts:754-809` | ADAPT | `sb export project` exists; per-root package renderer has no upstream equivalent | now | package JSON validates against schema/tests | per-root grouping semantics differ from Substrate locator tree | none | VERIFIED |
| Snapshot manifest (`raw_sha256`, counts, diagnostics) | Records one acquisition digest and selection counts | Core | Substrate | `exportProject` payload + content hash over snapshot | `.githooks/board-audit-core:479-505` | REPLACE | none | now | manifest recomputable from snapshot | none | none | VERIFIED |
| Legacy audit bundle (`beads.jsonl` + `prs.md` + prompt) | One-shot ChatGPT review bundle under `.xtrm/board-audit/audits/` | Core | Substrate | `sb export project`; `sb provenance bundle` | `.githooks/board-audit-core:519-753`; `src/service/provenance-service.ts:710-720` | DELETE | none | after snapshot replace | `sb provenance bundle` artifact exists | prompt text becomes stale | none | VERIFIED |
| Per-bead transport branch `board-audit/<id>` | Handoff artifact branch rooted on current origin default | Core (gen-1) | Substrate projection transport (a Git artifact branch is an allowed projection surface) | provider projection outbox; or Core-owned artifact branch over `sb export project` | `.githooks/board-audit-flow.py:80-81`; `.githooks/board-audit-transport.py:171-225`; `src/projections/types.ts:31-45` | DELETE | outbox CLI + sender missing (WAIT) | after R07 | branch absent from `git ls-remote` | orphan branch dirs left in origin | none if provider projection lands first | VERIFIED |
| Gen-2 permanent orphan export branch `board-audit-export-do-not-cancel` + fanout timer | flock-serialized export → byte-compare `raw-beads.jsonl` → commit/push; systemd timer every 15 min | Core (gen-2) | Core-owned UX (projection transport) | retarget `board-audit-core` to `sb export project` + filesystem renderer | `packages/board-audit/board-audit-export-wt:48-143`; `board-audit-fanout:1-25`; `README.md:11-33` | ADAPT | filesystem projection CLI writer missing (WAIT) | now | checkpoint writes `tree.md` + `issues.json` | branch must never be treated as authority | minor | VERIFIED |
| Transport index `.xtrm/board-audit/index.json` (`packages`, `open_issues`, `pr_checkpoints`) | Deterministic lookup surface for packages/handoffs | Core | Substrate | `external_bindings` + provenance bindings; no second index | `.githooks/board-audit-flow.py:23,204-239`; `.githooks/board-audit-pr.py:506-543`; `src/store/migrations/002_projections_sync.ts:7-22` | DELETE | binding-read CLI verb missing (WAIT) | after gen-2 retarget | lookup only through `sb` queries | stale index becomes de-facto authority if trusted | none | VERIFIED |
| PR-checkpoint binding to exact remote PR head | Fetches implementation branch, requires fetched head == `gh` `headRefOid`; records `transport_head_sha` | Core | Substrate | execution bindings + receipts; `sb provenance pr/commit` | `.githooks/board-audit-pr.py:170-193,546-571`; `src/service/provenance-service.ts:651-670` | REPLACE | none | now | `sb provenance pr <ref>` resolves a receipt | none | none | VERIFIED |
| PR locator comment (idempotent PATCH/create) | Posts compact handoff locator on the code PR | Core | Substrate projection outbox → GitHub | outbox upsert-comment op (`ProjectionSender`) | `.githooks/board-audit-pr.py:596-624`; `src/service/integration-service.ts:242-273` | REPLACE | sender + outbox CLI missing (WAIT) | after R15 | comment posted by sender | none | none | VERIFIED |
| `pr-status` freshness (`FRESH`/`STALE_CODE_HEAD`/`STALE_SNAPSHOT`/`NO_HANDOFF`) | Compares handoff head/snapshot against live PR head | Core | Substrate | `ExternalBinding.syncState` + `projection.drift` events | `.githooks/board-audit-pr.py:941-997`; `src/projections/types.ts:12-13`; `integration-service.ts:455-461` | REPLACE | projection status read verb missing (WAIT) | now | sync_state queryable via `sb` | none | none | VERIFIED |
| Editable handoff (`handoff <bead>`, `desired_issues`/`new_comments`) | Publishes editable desired-state artifact for remote editing | Core (gen-1) | — | none — Substrate refuses untrusted inbound mutation | `.githooks/board-audit-flow.py:281-326`; `.githooks/board-audit-roundtrip.py:179-208`; ADR §61 `docs/substrate/sbcloseout4-adr.md:1822-1838` | DELETE | none | after index delete | command removed | remote edits lose their write path | none | VERIFIED |
| Three-way reconcile/apply (`reconcile`, `bd import`) | base/current/desired merge; fail-closed on overlap; apply via `bd import` + native `bd` | Core (gen-1) | Substrate | `importProject` (whole-snapshot only); inbound edits → drift, never merge | `.githooks/board-audit-roundtrip.py:634-755,1216-1285`; `integration-service.ts:436-462` | DELETE | none | after editable-handoff delete | no reconcile/merge path remains | trusted inbound package currently mutates Beads | none | VERIFIED |
| Native Beads mutation (`bd import`, `bd dep`, `bd comments add`) | Compiler emits Beads JSONL + post-import commands | Core | Substrate | `sb issue edit/relate/note`, `sb journal append` | `.githooks/board-audit-roundtrip.py:788-814,1237-1252`; `cli/sb.ts:789-821` | DELETE | none | after reconcile delete | `bd` not required by Core | Beads remains authority pre-migration | none | VERIFIED |
| Transport path fence + `--no-verify` + `[skip ci]` | Force-stages only `.xtrm/board-audit/**`; bypasses code hooks/CI | Core | Core-owned UX (only if an artifact branch is retained) | none upstream | `.githooks/board-audit-transport.py:64-82,228-289` | ADAPT | none | with gen-2 retarget | fence rejects non-artifact paths | blanket hook bypass if misapplied | none | VERIFIED |
| Force-with-lease transport rewrite | `--force-with-lease=refs/heads/<branch>:<observed-sha>` on repeat publish | Core | Core-owned UX | none upstream | `.githooks/board-audit-transport.py:274-289`; fallback FF comment `:33-36` | ADAPT | none | with gen-2 retarget | push fails on concurrent edit | reconcile path falls back to plain FF | none | VERIFIED |
| PR-checkpoint pre-push adapter + detached poller | Defers push, polls remote ref+PR head, publishes checkpoint | Core | — | none | `.githooks/board-audit-pr-adapter.sh:104-134`; `README.md:278-280` | DELETE | none | now | hook removed | double-push/race documented in adapter | none | VERIFIED |
| Gen-2 memory sanitizer (`_type:memory` → `memory-slug-v2`) | Rewrites memory records so gitleaks does not false-positive | Core (gen-2) | — | Substrate export contains no Beads memory records | `packages/board-audit/board-audit-core` (sanitizer block); `tests/test_gitleaks_transport.py` | DELETE | none | after snapshot replace | export has no `key` slug field | none | none | VERIFIED |
| Dolt sync hooks (`bd dolt commit/pull/push`) | pre-push + post-merge sync `refs/dolt/data` | Core | Substrate | Substrate SQLite transactions; no Dolt remote | `.githooks/pre-push.bd-sync:1-39`; `.githooks/post-merge.bd-sync:1-19` | DELETE | none | after Beads sunset | hooks removed | none | none | VERIFIED |
| pre-commit `git add -f .beads/issues.jsonl` | Stages exported board snapshot into every commit | Core | — | Substrate DB is authoritative | `.githooks/pre-commit:82-88` | DELETE | none | after Beads sunset | block removed | none | none | VERIFIED |
| `board-audit doctor` | Checks git/bd/gh/python, auth, workspace, hooks, PR freshness | Core | Substrate | `sb doctor` (repository identity/binding) | `.githooks/board-audit-pr.py:1030-1155`; `cli/sb.ts:617-670` | REPLACE | none | now | `sb doctor` passes | scope differs (no gh/bd checks) | none | VERIFIED |
| `board-audit init` additive hook install | Refreshes bd shims, writes dolt-sync, chains adapter | Core | Core-owned UX + Substrate hooks | ADR §76 hooks; provenance `trailersForCommit` | `.githooks/board-audit-pr.py:1293-1389`; ADR `:2186-2205` | ADAPT | none | with dolt-hook delete | init idempotent | currently installs Beads/Dolt hooks | none | VERIFIED |
| Board authority | Beads/Dolt is source of truth; Git is transport | Beads/Dolt | Substrate | Substrate DB `~/.xtrm/state.db` | `packages/board-audit/README.md:421-423`; `cli/sb.ts:853` | REPLACE | none | migration ordering | `sb issue` is authority | dual authority while board-audit still mutates Beads | release-blocking if shipped as-is | VERIFIED |
| Portable review artifact (snapshot JSON) | Lossless snapshot of base records per package | Core | Substrate | `sb export project` (revision-preserving, G47) | `src/service/issue-service.ts:754-809`; `cli/sb.ts:2154-2160` | KEEP | none | now | snapshot round-trips | none | none | VERIFIED |
| Portable review tree (markdown) | Core has none; renderer exists in Substrate | — | Substrate | `writeFilesystemProjection` (`tree.md` + `issues.json`) | `src/projections/filesystem/render.ts:8-30` | ADAPT | CLI writer missing (WAIT) | after snapshot keep | tree.md + issues.json written | none | none | VERIFIED |
| Selective projectable Journal kinds | not present in board-audit | Substrate | Substrate | `PROJECTABLE_JOURNAL_KINDS` + `shouldProjectJournalEntry` | `src/projections/policy.ts:15-46,66-84`; ADR §60 `:1794-1820` | KEEP | none | now | non-projectable entries refused | none | none | VERIFIED |
| Untrusted inbound content refusal | not present in board-audit (round-trip trusts inbound package) | Substrate | Substrate | `isUntrustedRef` + untrusted note ref | `policy.ts:102-107`; `integration-service.ts:524-560`; ADR §61 | KEEP | none | now | untrusted note never projects | round-trip bypass would leak/authority-escalate | none | VERIFIED |
| GitHub/Jira native mapping | not present in board-audit | Substrate | Substrate | `mapIssueToGitHub` / `mapIssueToJira` + content hash | `src/projections/github/mapping.ts:29-88`; `jira/mapping.ts:50-69` | KEEP | sender missing (WAIT) | after locator replace | mapping unit-tested | none | none | VERIFIED |
| External binding store | not present in board-audit | Substrate | Substrate | `external_bindings` table + `bindExternal` | `migrations/002_projections_sync.ts:7-22`; `integration-service.ts:190-238` | KEEP | CLI verb missing (WAIT) | now | binding persists (service level) | none | none | VERIFIED |
| Projection outbox/inbox engine | not present in board-audit | Substrate | Substrate | outbox/inbox tables + `drainOutbox`/`receiveInbound` | `migrations/002:24-52`; `integration-service.ts:242-395` | KEEP | sender + CLI missing (WAIT) | after locator replace | idempotency tests pass | none | none | VERIFIED |
| Retired audit skill resource (`issue-triage/resources/board-audit`) | Old one-shot exporter; already retired | Core | — | planning reference superseded | `docs/skills.md:159`; `.xtrm/skills/default/planning/references/board-triage.md:17-45` | DELETE | none | now | docs updated | none | none | VERIFIED |

### Counts by Action

| Action | Count | Rows |
|---|---|---|
| KEEP | 6 | snapshot JSON, projectable kinds, untrusted refusal, GitHub/Jira mapping, external binding store, outbox/inbox engine |
| ADAPT | 6 | work-package render, gen-2 export surface, path fence/no-verify, force-with-lease, `init`, portable review tree |
| REPLACE | 7 | board acquisition, manifest, PR-head binding, locator comment, pr-status, doctor, board authority |
| DELETE | 11 | audit bundle, per-bead branch, index, editable handoff, reconcile/apply, native bd mutation, PR adapter, sanitizer, dolt hooks, pre-commit staging, retired skill |
| COMPAT | 0 | — |
| TOTAL | 30 | — |

(The per-row `Action` values are authoritative; the `ADAPT`/`REPLACE`/`DELETE` boundary is a
RECOMMENDATION-level judgement on the handful of surfaces where a Core-owned artifact transport may
be retained.)

---

## 2. Beads board assumptions embedded in the scripts (requirement 1)

VERIFIED, all in source:

- **Single canonical acquisition.** Everything derives from exactly one `bd export --all`, written as
  JSONL (`board-audit-core:131-134`). A `--from-raw` flag reuses an acquisition without `bd`
  (`board-audit-core:147-152`; gen-2 relaxes the `bd` PATH requirement accordingly).
- **Record wrapper tolerance.** Readers accept JSONL, a JSON list, or `{issues|beads|records:[...]}`
  (`board-audit-core:171-195`, `board-audit-roundtrip.py:114-149`, `board-audit-pr.py:246-275`).
  This is a defensive read of an unstable `bd export` format (INFERENCE: format drift is a real risk).
- **Status model.** `TERMINAL = {closed, done, completed, cancelled, canceled, tombstone, deleted}`
  (`board-audit-core:167`, `board-audit-pr.py:63`); "open" = not terminal (`board-audit-pr.py:405`).
- **Relation model.** `PARENT_TYPES = {parent-child, parent, child-of}`
  (`board-audit-core:168`, `board-audit-pr.py:64`). Dependency target is `depends_on_id` first, never
  the edge row surrogate `id` (`board-audit-core:210-223`). Dotted-ID ancestry (`parent.1`) is a
  fallback when no explicit parent resolves (`board-audit-core:308-326`, `board-audit-pr.py:360-376`).
- **Issue IDs.** Bead IDs `[A-Za-z0-9][A-Za-z0-9._-]*` (`board-audit-flow.py:74-77`); package/root
  naming `{root}__{slug}.json` (`board-audit-core:291-295,462`).
- **Mutability contract.** `PROTECTED_EXISTING_FIELDS` (id/created/updated/closed/started),
  `EDITABLE_EXISTING_FIELDS` (title/description/design/acceptance/notes/spec_id/priority/issue_type/
  estimated_minutes/external_ref/metadata/labels/dependencies) (`board-audit-roundtrip.py:34-67`).
  Assignment/status/lease/scheduling/persistence are deliberately read-only in v1 (`:45-49`).
- **Creation defaults.** New Beads rows default `status=open`, `priority=2`, `issue_type=task`
  (`board-audit-roundtrip.py:672-679`).
- **Dolt.** Hooks sync `refs/dolt/data` (`pre-push.bd-sync`, `post-merge.bd-sync`); `bd dolt commit/
  pull/push` (`pre-push.bd-sync:20-39`).
- **bd worktree.** Worktree lifecycle delegates to `bd worktree create/remove`
  (`board-audit-flow.py:120-126`).

## 3. Worktrees, editable packages, transport layout (requirement 2)

- **Worktree creation.** Ephemeral worktree under
  `$XDG_CACHE_HOME/xtrm/board-audit/worktrees/<repo>/<id>-<ts>-<pid>` via `bd worktree create`
  (`board-audit-flow.py:102-126`). `bd` sees the same authoritative Beads DB through Git
  common-directory discovery (README `:151`).
- **Staging branch.** `board-audit-staging/<id>-<pid>-<HHMMSS>` created from `origin/HEAD`
  (`board-audit-flow.py:113-117`); transport branch is `board-audit/<id>` (`:24,80-81`).
- **Editable work package.** `prepare` deep-copies selected `issues.<id>.source` into
  `desired_issues` and adds `new_comments`, plus `roundtrip.base_record_sha256` and `base_package_sha256`
  (`board-audit-roundtrip.py:179-208`). Contract text: "`issues.*.source` is immutable base state"
  (`:202-205`).
- **Export layout.** `.xtrm/board-audit/exports/export-<ts>/{raw-beads.jsonl,manifest.json,
  work-packages/<root>__<title>.json,<...>.editable.json}` (`board-audit-core:140-144,462-465`;
  README `:484-489`). Index at `.xtrm/board-audit/index.json`, schema `xtrm.board-audit.index.v1`
  (`board-audit-flow.py:23,204-213`).
- **Transport branch layout (sampled live).** `origin/board-audit/pr-649` carries full origin-default
  tree plus 443 files under `.xtrm/board-audit/**` (exports 217 manifests+packages pairs, `index.json`,
  `handoffs/pr-649.json`, `snapshots/<id>/**`). Commit pair:
  `chore(board-audit): pr #649 checkpoint [skip ci]` + `... seal pr #649 transport head [skip ci]`
  (`git log origin/board-audit/pr-649`). 20 `board-audit/pr-*` refs exist on Core origin
  (`git ls-remote --heads origin 'board-audit*'`).
- **Orphan-branch handling (gen-2).** `board-audit-export-do-not-cancel` is a true orphan
  (`git checkout --orphan` + `git rm -rf`, `board-audit-export-wt:58-75`), artifact-only, never a code
  base. Gen-1 instead re-roots a staging branch on current `origin/HEAD` and restores only
  `.xtrm/board-audit/**` (`board-audit-transport.py:187-214`) to avoid stale code ancestry.
- **Cleanup.** Normal `bd worktree remove` only after proving local HEAD == fetched remote transport
  HEAD and re-pointing the staging upstream (`board-audit-transport.py:102-168`). Failure retains the
  worktree + staging branch (`board-audit-flow.py:148-154`, `board-audit-pr.py:887-896`).

## 4. Round-trip reconciliation and authority (requirement 3)

- **What comes back.** A remote-edited `*.editable.json` with `desired_issues` and `new_comments`
  (README `:197-220`). `reconcile` fetches `board-audit/<id>` into a second isolated worktree
  (`board-audit-flow.py:329-357`).
- **Validation.** `validate_package` rejects tampered base hashes, deletions of selected beads, edits
  to context-only ancestors, protected provenance-field edits, and unsupported fields
  (`board-audit-roundtrip.py:266-361`).
- **Three-way merge.** base = package source, current = fresh `bd export --all`, desired = edited
  artifact. Disjoint changes merge; overlapping same-field changes append to `conflicts`; `safe = not
  conflicts` (`board-audit-roundtrip.py:413-597,634-755`). Metadata/labels/dependencies have dedicated
  merge functions (`:413-500`). Historical comments ride through unchanged (`:569-573`).
- **Conflict behavior.** `compile_plan` refuses to produce a plan when `safe` is false and writes
  `changes.json` (`board-audit-roundtrip.py:829-834`); `apply` exits 3 via `validate`/`diff`.
- **Apply.** `bd import --dry-run` → `bd import` → native `bd dep remove/add`, `bd update
  --remove-label`, `bd comments add` → cycle delta check (introduced cycles exit 4) → fresh export →
  `verify_intent` (`board-audit-roundtrip.py:788-814,1216-1285,977-1097`).
- **Mutation authority.** Beads/Dolt remains the only authority; Git is transport
  (`packages/board-audit/README.md:421-423`). **No second board database exists or is proposed.**
  However there IS **dual authority in flight**: the gen-1 round-trip writes Beads while the target
  Substrate DB would separately hold authority (HAZARD, see §7).
- **Inbound trust.** The editable package is fetched from a Git branch and applied after shape
  validation; there is **no authorship/provenance attestation of the remote editor** beyond the branch
  itself. This is exactly what Substrate replaces: inbound remote edits become `drift`, never a
  mutation (`integration-service.ts:436-462`), and external comments become untrusted notes
  (`:524-560`; ADR §61).

## 5. PR/web review path and adapter contract (requirement 4)

- **Publish.** `pr-checkpoint` verifies the remote PR head (`pr.py:170-193`), acquires one snapshot,
  derives per-Bead projections (`:390-485`), writes changed files only (`:627-650`), commits artifacts
  then seals with the exact transport SHA (`:838-857`), pushes under lease (`:859-867`).
- **Trigger.** `board-audit-pr-adapter.sh` is wired into `pre-push` (`pre-push:99-107` references the
  main-repo absolute path `/home/dawid/dev/core/.githooks/board-audit-pr-adapter.sh`). It defers to
  git's own push and starts a detached poller that waits for remote ref + `gh` `headRefOid` == pushed
  SHA, then checkpoints (`pr-adapter.sh:104-134`).
- **Adapter contract.** stdin pre-push refspec protocol; `$1` remote; numeric first/second arg =
  explicit PR; never blocks the push; failures only warn; `BOARD_AUDIT_PR_JSON` is the test seam
  (`pr-adapter.sh:23-51,79-90`; `pr.py:139-167`).
- **Review consumption.** Web agent resolves `.xtrm/board-audit/index.json`, reads the per-Bead
  projection (read model only), and edits only `desired_issues`/`new_comments` (README `:392-394`).
- **Discovery.** Idempotent locator comment on the PR (`pr.py:574-624`); `pr-status --check` exits 3
  when not `FRESH` (`:995-996`).
- **Gen-2 status.** Documented superseded: "the pre-push checkpoint hook cannot bind a fresh head
  because client pre-push fires before `xt end` creates the PR" (`README.md:6,280`).

## 6. Failure modes (requirement 5)

VERIFIED unless marked:

- **Partial transport.** Publication is two commits + one push (`pr.py:838-867`). A failure after the
  artifacts commit but before push leaves local-only state; failure keeps the worktree/staging branch
  (`:887-896`). `commit_transport` returns False when nothing is staged (`transport.py:255-256`).
  The raw acquisition lives outside the worktree and is kept on failure (`pr.py:728-731`).
- **Orphan branches.** Per-bead/per-PR branches carry full default-branch ancestry; stale code
  ancestry is contained by re-rooting (`transport.py:171-214`). Gen-2 uses a true orphan. No branch
  is ever merged into product code (README `:191`). 20 stale `board-audit/pr-*` refs already exist on
  Core origin with no reaper (OBSERVATION).
- **Force-push.** Repeat publish uses exact `--force-with-lease` tied to the SHA observed after fetch
  (`transport.py:274-289`). `reconcile --execute` has no lease and falls back to a plain fast-forward
  push (`:33-36`) — a concurrent writer causes a non-fast-forward failure, not an overwrite
  (INFERENCE from code path).
- **Stale export.** NO_CHANGES gate compares PR head + `snapshot_id` + `work_package_count`
  (`pr.py:745-761`); gen-2 compares `raw-beads.jsonl` bytes only (`export-wt:96-107`). `pr-status`
  distinguishes `STALE_CODE_HEAD` vs `STALE_SNAPSHOT` (`pr.py:967-996`). Adapter poller gives up after
  ~60 s and checkpoint may then bind a stale head (`pr-adapter.sh:114-132`).
- **Untrusted inbound content.** The remote editable package is applied through `bd import` after
  validation but without editor provenance; only structural/immutability checks apply
  (`roundtrip.py:266-361`). A compromised transport branch can therefore propose board mutations that
  the operator's `reconcile --execute` will apply. Substrate's ADR §61 untrusted-ref refusal closes
  this class (`policy.ts:102-107`).
- **Confidentiality.** Transport is lossless (`[skip ci]`, hook bypass) and the gen-2 sanitizer only
  rewrites memory-record key shape; it does not redact issue content
  (`board-audit-core` sanitizer; `tests/test_gitleaks_transport.py`). Confidentiality remains an
  operator precondition (README `:193`).

---

## Board-audit capability → Substrate primitive map

| Board-audit capability | Substrate primitive (path:line) |
|---|---|
| Whole-board snapshot / read model | `IssueService.exportProject` `issue-service.ts:754-809`; `sb export project` `sb.ts:2154-2160` |
| Portable tree/markdown review | `writeFilesystemProjection` `projections/filesystem/render.ts:23-30`; `renderTreeMarkdown` `:8-19` |
| Per-root work packages | No upstream equivalent — Core renderer over `exportProject` |
| Board state published outward | `IntegrationService.enqueueProjection` + `drainOutbox` `integration-service.ts:242-332`; `mapIssueToGitHub/Jira` |
| Selective publication | `PROJECTABLE_JOURNAL_KINDS`/`shouldProjectJournalEntry` `policy.ts:15-84`; ADR §60 |
| PR/commit evidence binding | `ProvenanceService.dispatch/allocateReceipt/bindCommit` `provenance-service.ts:119-320`; `findByPr` `:651`; `sb provenance pr/commit` |
| Portable evidence bundle | `ProvenanceService.generateBundle` `provenance-service.ts:710-720`; `attachArtifact` `:354-376` |
| Freshness / conflict state | `ExternalBinding.syncState` `types.ts:12-13`; `projection.drift` `integration-service.ts:455-461` |
| Lookup surface (replaces `index.json`) | `external_bindings` `migrations/002:7-22`; `listBindings` `integration-service.ts:226-238`; provenance queries |
| Inbound external input (replaces editable handoff) | `receiveInbound(issue-intake|remote-edit)` `integration-service.ts:338-462` → unready draft / drift |
| Untrusted external comment | `receiveComment` `integration-service.ts:524-560` + `isUntrustedRef` `policy.ts:102-107`; ADR §61 |
| Beads JSONL import (migration) | `sb import beads` `sb.ts:599-608`; `importProject` `issue-service.ts:839` |
| Transport hook bypass / lease / index / round-trip / `bd` mutation | No Substrate equivalent (DELETE) — Substrate has no Git-artifact transport or inbound desired-state compiler |

---

## Missing upstream primitives

Verbatim findings (VERIFIED by reading `cli/sb.ts`, `cli/schema.json`, services, migrations):

1. **`sb export project` EXISTS.** `runExport` (`sb.ts:2154-2160`), verb allowlist `"export.project"`
   (`sb.ts:837-838`), help `sb export project --project <id> [--file <path>]` (`sb.ts:605-608`).
   `sb export` (no verb) is also accepted.
2. **`sb import beads` EXISTS** (one-way Beads migration, `--dry-run`) `sb.ts:599-604`.
3. **Stable external binding STORE EXISTS**: `external_bindings` table `migrations/002:7-22`;
   `bindExternal/getBinding/listBindings/findBindingByRemote` `integration-service.ts:190-238`.
4. **Outbox/inbox engine EXISTS**: `projection_outbox`, `integration_inbox`
   `migrations/002:24-52`; `enqueueProjection/listOutbox/drainOutbox/receiveInbound/listInbox`
   `integration-service.ts:242-395`.
5. **`sb projection|external|integration` CLI group is MISSING.** `KNOWN_GROUPS` has only
   `init|issue|project|plan|journal|provenance|import|export` (`sb.ts:841`). `IntegrationService` is
   imported once and instantiated only as `ResumeService`'s `external` provider (`sb.ts:31,1357`).
   No CLI verb reaches `bindExternal`, `enqueueProjection`, `drainOutbox`, `receiveInbound`,
   `receiveComment`, `listOutbox`, or `listInbox`.
6. **No concrete `ProjectionSender` (GitHub/Jira HTTP adapter) is MISSING.** Only the interface
   `ProjectionSender.send` exists (`integration-service.ts:60-62`); repo-wide grep found no
   implementation and no provider HTTP client. `drainOutbox` is called nowhere outside tests.
7. **No CLI to write the filesystem projection (portable review tree) is MISSING.**
   `writeFilesystemProjection` is a library function (`render.ts:23`) with no caller in `src`/`cli`
   outside tests.
8. **No projection status/drift read verb is MISSING.** `syncState`/`projection.drift` are readable
   only through the service API; no `sb` verb surfaces them.
9. **No external-comment intake verb with a trust boundary is MISSING.** `receiveComment` exists in
   the service (`integration-service.ts:524-560`) but is not reachable from the CLI.

**WAIT_SUBSTRATE_RELEASE items** (Core cannot complete the replacement without these):

| ID | Missing primitive | Blocks |
|---|---|---|
| WAIT-1 | `sb integration bind\|unbind\|list-bindings` (stable external binding verbs) | Deleting `index.json`; binding-based PR lookup |
| WAIT-2 | `sb projection outbox list\|retry\|drain` + a concrete `ProjectionSender` | Replacing the PR locator comment and any outward board projection |
| WAIT-3 | `sb integration inbox receive\|list` (inbound external-input intake verb) | Any compliant inbound web review path |
| WAIT-4 | `sb projection status` (sync_state/drift read) | Replacing `pr-status` freshness |
| WAIT-5 | `sb export tree [--out <dir>]` (filesystem projection writer) | Retargeting gen-2 export-wt to produce portable review trees |
| WAIT-6 | `sb integration comment receive` (trust-boundary-preserving comment intake) | Any reusable external-comment ingestion |

Until WAIT-1..6 land, a retained Core-owned Git artifact branch (gen-2 `export-wt`, retargeted to
`sb export project`) is the only end-to-end portable review transport. This is compliant with
"Git artifact = projection; Substrate = authority" **provided** no inbound editable package path
remains (RECOMMENDATION).

---

## Surfaces searched

- Core: `.githooks/board-audit-core`, `board-audit-flow.py`, `board-audit-pr.py`,
  `board-audit-pr-adapter.sh`, `board-audit-roundtrip.py`, `board-audit-transport.py`;
  `.githooks/{post-checkout,post-merge,post-merge.bd-sync,pre-commit,pre-push,pre-push.bd-sync,prepare-commit-msg}`.
- Core docs/config: `docs/skills.md`, `docs/skills-v4-preservation-matrix.md`, `README.md`,
  `CHANGELOG.md`, `.gitleaks.toml`, `.xtrm/skills/default/planning/references/board-triage.md`.
- Core code/CI: `cli/test`, `cli/src`, `.github/workflows`, `scripts` (no board-audit references).
- Core origin refs: `git ls-remote --heads origin 'board-audit*'`; live tree/commits/handoff/index of
  `origin/board-audit/pr-649`; `board-audit-export-do-not-cancel` (absent on Core origin).
- Substrate snapshot: `docs/substrate/{sbcloseout4-adr.md,substrate-issues-v0-prd.md}`;
  `packages/substrate/src/projections/**`; `src/service/{integration,provenance,journal,resume,issue}-service.ts`;
  `src/store/migrations/{002,007}.ts`; `cli/sb.ts`, `cli/schema.json`; `tests/projections.test.ts`,
  `tests/p1-provenance-queries.test.ts`.
- xtrm board-audit package: `packages/board-audit/{README.md,board-audit,board-audit-core,
  board-audit-export-wt,board-audit-fanout}`, `tests/**`, `.github/workflows/board-audit-tests.yml`,
  `.xtrm/board-audit/**`.

## Not inspected

- `packages/board-audit/ROUNDTRIP.md` (full text), `IDEAS.md`, `board-audit-to-jira-and-improvements.md`.
- `board-audit-pr.py` was read in three contiguous ranges (1-120, 120-660, 653-1013, 1013-1437);
  line-level review of all 1437 lines is effectively complete but not claim-by-claim annotated.
- Core `.githooks/pre-commit.local`, `pre-push.local`, `.security-pipeline-baseline`.
- Transport branches other than `pr-649` (sampled one of 20).
- Substrate `sbcloseout2/3-adr.md`, `docs/substrate/{workflow,cli,journal,provenance}.md`.
- GitNexus graph impact analysis (not run; this is a read-only doc audit).
- Specialists snapshot (out of lane scope).

---

## UNRESOLVED (exact questions)

1. Does Core intend to retain a Git artifact branch as a projection transport after Beads sunset?
   If yes, is gen-2 `board-audit-export-wt` retargeted to `sb export project`, or deleted in favor of
   provider projections once WAIT-2 lands?
2. Which release will expose WAIT-1..WAIT-6? Are they owned by Substrate or must Core supply the
   GitHub/Jira `ProjectionSender` adapter?
3. Are portable per-root review work packages still a product requirement, or is `sb export project`
   sufficient? (Determines whether the Core per-root renderer is retained.)
4. Is the `sb export project` snapshot schema versioned/frozen as the external review contract, and
   what is the G47 equivalence guarantee for round-tripping?
5. What replaces PR-level evidence discovery if provider projection (locator comment) is not enabled
   for a repository?
6. When does Core's board migrate via `sb import beads`, and is the resulting Substrate project the
   named authority for the 20 existing `board-audit/pr-*` transport refs (reap or retain)?

## HAZARD (dual authority, must not ship as-is)

The gen-1 round-trip mutates Beads through `bd import` + native `bd` commands while Substrate is
intended to become authority. Running both produces two mutation authorities over the same board.
RECOMMENDATION: delete the editable-handoff/reconcile/apply path before or at the moment Substrate
authority is enabled; do not dual-run. Add a release gate asserting no `.githooks` board-audit path
invokes `bd import`/`bd dep`/`bd comments` after migration.
