# Lane 9 — Architecture Adversary: attack on the Core Substrate hard-cut plan

Read-only audit. No source, config, board, or runtime state was modified. The only file created is
this report. Every lane claim attacked below was re-checked against source in this worktree, against
`/tmp/audit/xtrm-main`, or against `/tmp/audit/specialists-master`; where I could not re-check, the
finding says so.

Attacked artifact: `docs/migrations/core-substrate-hard-cut-plan.md` (629 lines, `DESIGN_FREEZE`).
Ground truth: Core `e3c09927` (worktree `core-xt-pi-7awr`), Substrate `12e71d74`, Specialists
`31887a4e`.

Statement classes: **VERIFIED** (source read in this session), **INFERENCE**, **RECOMMENDATION**,
**UNRESOLVED**.

---

## 0. The dominant finding: the plan under attack is not a migration plan

**VERIFIED.** `core-substrate-hard-cut-plan.md` ends at line 629 mid-sentence inside §5.7. The
document contains §0–§5.7 only. It has **no §6 (waves), no §7 (implementation gate / release
boundary), no §8 (rollback)** — while five places forward-reference them:

| Forward reference | Line |
|---|---|
| `"This document is the authoritative plan for the future hard cut"` | `core-substrate-hard-cut-plan.md:4` |
| `"Specialists' CHANGELOG section is still `[Unreleased]`. See §7.4."` | `:103` |
| `"§2.5 Target chain shape (normative, **not yet shipped** — see §7.3)"` | `:164` |
| `"These gates are the entry condition for §7."` | `:193` |
| `"G7 \| Any released Chain Runtime \| §2.5 entirely — see §7.3"` | `:247` |
| `"Workflow progression … DESIGN ONLY (§7.3)"` | `:266` |

`grep -c 'lane8\|Lane 8' core-substrate-hard-cut-plan.md` = **0**: the lane-8 report
(`lane8-tests-ci-migration.md`, 575 lines, containing the only deletion order and acceptance suite in
the whole audit) is not incorporated or referenced at all.

Consequences, stated as attacks rather than complaints:

- The plan's own promise — "a cold-start worker needs **only this document** to know … what must
  wait, what gets deleted, what proves completion, and what version boundary ships it"
  (`:8-10`) — is **false**: "what gets deleted" lives in lane 8, "what proves completion" lives in
  lane 8 §D, "what version boundary ships it" was to be §7.4 and does not exist.
- Attack-surface classes 5 (missing recovery path), 9 (lifecycle ordering), 13 (rollout/rollback)
  are **not assessable** against the plan because the sections that would carry them are absent.
  Everything below in sections (E) and (F) is therefore reconstructed from (i) the plan's §4
  ownership matrix, (ii) lane 8's D-1..D-10 order, and (iii) the plan's §3.3 gap list — and that
  reconstruction itself is a defect, because a worker following the plan as written has no order to
  follow.
- The plan is a **digest of lane findings**, not a decision document. Its §5 sections restate lane
  summaries; its §4 matrix restates lane conclusions; its §3.3 gap list is the only original
  synthesis and it is incomplete (§D below).

**RECOMMENDATION:** before any Wave B, author §6/§7/§8 and promote lane 8 §D/§E verbatim into the
plan. Deleting nothing is the only correct action against the current document.

---

## (A) Refutations

### R1 — Plan §4 says Core *derives* project identity. It does not. [HIGH]

- **Claim:** `"Repository / Project identity | Core (derives prefix+name, `sb project create`+`link`) | Substrate"`
  — `core-substrate-hard-cut-plan.md:258`.
- **Counter-evidence:** `cli/src/core/substrate.ts:238-240`:
  > `* Flags verified: `sb project create --prefix <PREFIX> --name <name>`
  > `* [--id <id>]. The caller supplies prefix/name — this module never invents`
  > `* project identity.`
  `cli/src/core/substrate.ts:217-219` (`parseCreateProjectFlag` returns `null` when the shape is
  wrong: "callers report the usage error, never guess"). `cli/src/commands/init.ts:1173-1199`
  prompts the operator ("Project prefix (e.g. PROOF):"). Lane 2 reached the same conclusion
  independently: `lane2-xt-cli-lifecycle.md` Q3 row "Prefix guessing / project-id derivation:
  **None found** … The finding is 'wrong primitive', not 'duplicate algorithm'".
- **Corrected statement:** Core does **not** derive project identity; it owns the *identity decision
  flow* (an interactive prompt plus `--sb-create-project PREFIX:Name`) that ADR §19 assigns to
  `sb init`. The defect is a wrong primitive, not a second derivation algorithm. The plan's own §4
  cell contradicts its own §5.2 evidence, and the contradiction changes the remediation: a rule that
  forbids Core from *deriving* identity is already satisfied and would be a no-op control.

### R2 — Plan §5.2's "26 references to `@xtrm/substrate`" is numerically wrong. [MED]

- **Claim:** `"26 references to `@xtrm/substrate`; **zero** to `@jaggerxtrm/substrate`"` —
  `:341-342`. Lane 2 said only "zero occurrences of `@jaggerxtrm/substrate`" and never claimed 26.
- **Counter-evidence:** `git grep -o '@xtrm/substrate' -- . | wc -l` = **49** (whole repo, tracked);
  excluding `cli/dist` and `docs/migrations` = **20**. Neither figure is 26. Per-file:
  `cli/dist/index.cjs` 12, `cli/src/core/substrate.ts` 4, `dependency-maintenance.ts` 4,
  `commands/init.ts` 3, `machine-bootstrap.ts` 2, `doctor.ts` 2, and 4 test/doc files 1 each.
  The `"zero to @jaggerxtrm/substrate"` half is **VERIFIED** for tracked non-audit files
  (`git grep -n 'jaggerxtrm/substrate' -- . ':!docs/migrations'` = 0).
- **Corrected statement:** 20 source/test/doc references plus 13 in the committed `cli/dist`
  bundle; the zero-new-name half stands.

### R3 — Plan §5.2's `bd`-call-site count and file list are both wrong. [MED]

- **Claim:** `"≥9 direct `spawnSync('bd', …)` sites across 4 files — `end.ts`, `report.ts`,
  `worktree-session.ts`, `codex-worktree-session.ts`, `docs-cross-check-bd.ts`"` — `:371-374`.
  The claim lists **5** files but says 4, and `report.ts` does not contain `spawnSync('bd'`.
- **Counter-evidence:** actual call sites, by grep:
  `spawnSync('bd'` = 7 (`worktree-session.ts:129,181,2937`, `codex-worktree-session.ts:283`,
  `end.ts:55`, `docs-cross-check-bd.ts:15,50`); `spawnSync(bd, …` with an injected binary = 6
  (`spec/drift.ts:99,109,121`, `spec/archive-gate.ts:85,95`, `spec/reconcile.ts:88`); indirect via a
  helper that wraps `spawnSync(cmd, …)` (`report.ts:9`) = 2 (`report.ts:92,122`). **Total 15 sites
  across 8 files.**
- **Corrected statement:** the duplication of Beads authority is *worse* than stated: 15 sites in 8
  files, including three `cli/src/spec/*` modules the plan does not name at all. Lane 2's own
  enumeration (`lane2-xt-cli-lifecycle.md` Q4/Q5) already listed 11 sites across the same 5 files —
  also short of 15, and also missed `spec/`.

### R4 — Plan §5.7 cites `"Substrate has no `CHANGELOG.md`"`. It does. [LOW]

- **Claim:** `"No release boundary for the cut exists yet. Substrate has no `CHANGELOG.md`"` —
  `:102-103`.
- **Counter-evidence:** `/tmp/audit/xtrm-main/CHANGELOG.md` exists, 975 lines, headed
  `## [Unreleased]`.
- **Corrected statement:** Substrate carries a repo-level `CHANGELOG.md`; what it lacks is a
  released section for the post-`0.1.2` work. The conclusion ("no release boundary exists") survives
  on other evidence (`packages/substrate/package.json` still reads `0.1.2` and `0.1.2` is already
  published — `lane2-xt-cli-lifecycle.md` UNRESOLVED-2), but the stated evidence is false.

### R5 — Plan §5.7's "publishes … a CI temp path" is stale for current main. [MED]

- **Claim:** `"prepublish re-vendors and regenerates `.xtrm/registry.json` so the packed registry ≠
  committed **and embeds a CI temp path**"` — `:622-624`, from `lane7-release-packaging.md` F-8.
- **Counter-evidence:** `scripts/vendor-specialists-from-manifest.mjs:36-52` explicitly restores the
  reviewed `repo_path`:
  > `// manifest: ref stays human-readable and repo_path stays stable even when CI`
  > `// supplies SPECIALISTS_REPO_PATH pointing at a temporary checkout.`
  `git blame`-dated `589e67e5 "fix(skills): preserve stable Specialists repo path on vendoring"`
  **2026-09-06**, i.e. two days *after* `v0.12.0` (tagged 2026-09-04). The committed manifest today
  holds `"repo_path": "../specialists"` (`.xtrm/registry.json`).
- **Corrected statement:** F-8 accurately describes the **published `xtrm-tools@0.12.0` tarball**
  (built before the fix) but is **not a live defect on `e3c09927`**. The half that remains true is
  "the packed registry is regenerated at publish time and is not byte-identical to the committed
  registry" (`package.json:82` runs `gen-registry` inside `prepublishOnly`). A freeze document must
  not carry a fixed defect as an open gate; it would block the release on a non-issue.

### R6 — Lane 5's C1 line citation is wrong (fact survives). [LOW]

- **Claim:** `` `session_id` mixes ≥4 namespaces … `beads-gate-utils.mjs:31` `` —
  `lane5-contracts-identity.md` C1, copied into the plan at `:495`.
- **Counter-evidence:** `.xtrm/hooks/beads-gate-utils.mjs:31` is inside `getSessionClaim`
  (`bd kv get "claimed:${sessionId}"`). The cwd-as-session-ID collapse is at
  `beads-gate-utils.mjs:20-21`:
  `export function resolveSessionId(input) { return input?.session_id ?? input?.sessionId ?? resolveCwd(input); }`.
  Similarly `packages/pi-extensions/extensions/beads/index.ts` PIN fallback is at `:14`, not `:13`.
- **Corrected statement:** C1 is **VERIFIED** (four namespaces confirmed: tmux `#{session_id}` at
  `cli/src/core/topology-projection.ts:66`; runtime UUID and PID fallbacks at
  `session-flow/index.ts:18`, `beads/index.ts:14`; filesystem path at `beads-gate-utils.mjs:21`),
  but the primary citation must be corrected — an incorrect `path:line` in the identity section is
  exactly what a downstream implementer will open and not find.

### R7 — Lane 3 overstates `activationId` vs `job_id` as "no counterpart". [MED]

- **Claim:** `"Native dispatch is an in-process activation with `activationId`/`attemptId`/`sessionId`
  … Core's `planner_job_id` sidecar field and `sp result` poll have no counterpart"` —
  `lane3-spec-chain-convergence.md` §7.3.
- **Counter-evidence:** `/tmp/audit/specialists-master/src/activation/types.ts:21-22`:
  > `/** One activation of a participant. Canonical runtime identity; maps to job_id. */`
  > `export type ActivationId = string;`
  Lane 5 read the same line correctly (`lane5-contracts-identity.md` `planner_job_id` row: "Correct
  shape today, wrong name"). Lane 3 and lane 5 contradict each other; lane 3 is wrong.
- **Corrected statement:** `job_id` **has** a named counterpart (`ActivationId`, explicitly defined
  as mapping to `job_id`). What genuinely vanishes on the native path is the *transport*
  (`sp run --background`, `sp result`, `sp chain`), not the identity. Residual real hazard:
  `activationId` is a distinct namespace from `attemptId` and `PiSessionId`
  (`activation/types.ts:19-31`), so a rename of Core's `job_id` → `activationId` must not also
  absorb attempt identity. The plan does not repeat lane 3's error (§5.5 follows lane 5) — this is a
  lane defect, not a plan defect.

### R8 — Plan §2.6's identity-grep evidence cannot produce its own result. [LOW]

- **Claim:** `Verified: grep -c 'participantId|activationId|attemptId|runId' over cli/src, … returns zero`
  — `:184-185`.
- **Counter-evidence:** POSIX `grep` without `-E` treats `|` as a literal, so the cited command can
  only match the literal string `participantId|activationId|attemptId|runId` and is guaranteed to
  print `0` regardless of source content. I verified the *conclusion* independently with separate
  searches: `participantId` 0, `activationId` 0, `attemptId` 0, `runId` 0, `claimId` 0 across
  `cli/src`, `packages/pi-extensions/src`, `packages/contracts/src`.
- **Corrected statement:** the fact is true and the evidence command is invalid. This matters for
  a freeze document whose §0.3 promises that "every high-consequence claim … [was] independently
  re-checked against source … and the checks are recorded inline".

### R9 — Plan §4.1's "consistent with both existing public consumers" is overstated. [MED]

- **Claim:** `"Core must not add a static dependency on Substrate source. The frozen contract must be
  expressed against the **published npm artifact** plus the `sb` process boundary. This … is
  consistent with both existing public consumers"` — `:284-288`.
- **Counter-evidence:** `/tmp/audit/specialists-master/src/activation/workitem-store.ts:54-61`:
  > `* Where Substrate lives, in precedence order: an explicit checkout, then normal`
  > `* module resolution, then nowhere.`
  > `* The explicit path wins deliberately. A developer who points XTRM_SUBSTRATE_DIR at a`
  > `* working tree means it, and an installed copy silently shadowing that checkout …`
  `resolveSubstrateDir` (`:77-86`) prefers the explicit source checkout over
  `require.resolve('@jaggerxtrm/substrate/package.json')`. Specialists also completed the package
  rename (comment at `:37-45`, "Renamed from `@xtrm/substrate` under XTRM-267"); Core did not
  (`cli/src/core/substrate.ts:351-357` still probes `@xtrm/substrate`).
- **Corrected statement:** Core and Specialists consume Substrate through **different** mechanisms,
  neither of which is version-pinned: Core by an unpinned `sb` process; Specialists by an
  operator-selected source checkout with module resolution as fallback. There is therefore no single
  existing "frozen published-artifact contract" that Core can be declared consistent with. The
  plan's own §3.1 Substrate gate ("the artifact version uniquely identifies that implementation")
  is not satisfied by any consumer today, and a Core-only plan cannot satisfy it.

### R10 — Plan §5.1's `manifest.json:5` citation points at the wrong line. [LOW]

- **Claim:** `` `packages/pi-extensions/src/manifest.json:5` still marks `beads` `required: true` ``
  — `:320-321`, copied from `lane1-runtime-enforcement.md` A-13.
- **Counter-evidence:** `packages/pi-extensions/src/manifest.json:5` is `"id": "beads",`;
  `"required": true` is line **7** (block spans `:4-9`; lane 1 cited `:4-9` correctly).
- **Corrected statement:** true statement, imprecise citation.

---

## (B) Confirmations with residue

Each was re-checked; the residue is the nuance the lane or plan omitted.

1. **ADR §100 ownership quote — VERIFIED.**
   `/tmp/audit/xtrm-main/docs/substrate/sbcloseout4-adr.md:2756-2790`, headed at `# 100.
   Implementation ownership` (the file uses `# N.`, not `## N.`; 2932 lines, 108 `#`-headings — the
   plan's "103 sections" is off by the heading count, `:110-111`). Core's assignment and
   `"Core does not reimplement repository identity."` are quoted accurately. *Residue:* §100 assigns
   Core **no** authority to interpret Substrate state — which makes every `spawnSync('bd')` site an
   out-of-charter authority, not merely a duplicate.
2. **ADR N1–N4 — VERIFIED verbatim.** §2 (`:114-165`, "Core must not independently implement
   project identity policy"), §4 (`:190-224`, `"The existence of exactly one project in the global
   database is never evidence that the current repository belongs to it."`), §18 (`:670-694`,
   `"Bare sb project link must not infer the sole Project."`), §19 (`:704-730`, normal flow
   `xt init → provision/enroll → sb init --json → verify`, and `--sb-project` /
   `--sb-create-project PREFIX:Name` "should disappear from the normal operator UX"). All four
   North-Star rule quotes in `:145-153` are faithful. *Residue:* the plan's §2.3 table header says
   "ADR" but `§2`/`§4` are not North-Star *rules*; they are the same document, so this is
   editorial only.
3. **ADR §102 next-action lifecycle — VERIFIED.** `:154-162` quote is accurate; §102 places
   `commit / PR / artifact / evidence → validation → Closure` after the receipt, so
   `"Close-before-commit is not the target lifecycle"` (`:161-162`) is correct.
4. **G2 (Pi stop not wired) — VERIFIED.** `integrations/pi/extension.ts` registers exactly
   `tool_call` (`:183`), `substrate-resume` (a `registerCommand`, `:194`), `session_start` (`:203`),
   `session_before_compact` (`:210`); `evaluateStopContinuity` is exported at
   `integrations/pi/handlers.ts:390` and referenced nowhere else. *Residue:* the plan's phrase
   "registers only … `substrate-resume`" mixes a command with events; substance is right.
5. **G1 (no Substrate git-hook installer) — VERIFIED.** `grep -rn 'core.hooksPath'
   /tmp/audit/xtrm-main/packages/substrate/` = 0 hits; `planCommands`
   (`integrations/setup.ts:307-319`) emits `npm ci`, global link, `sb --version`, `pi install`,
   three `claude plugin` commands, and the Pi load probe — **no** git-hook step.
6. **G3 (no projection CLI group) — VERIFIED.** `packages/substrate/cli/sb.ts:841`
   `KNOWN_GROUPS = new Set(["init","issue","project","plan","journal","provenance","import","export"])`.
   *Residue:* `sb init` is dispatched directly (`:868-874`) and is **not** gated by `KNOWN_GROUPS`,
   so a naive "add a group" fix has a precedent to follow.
7. **G4 (no `ProjectionSender`; `drainOutbox` uncalled outside tests) — VERIFIED.**
   `src/service/integration-service.ts:60` interface only; `:284` implementation;
   `drainOutbox` appears only in `tests/projections.test.ts`.
8. **G6 (board-audit has no `package.json`) — VERIFIED.**
   `ls /tmp/audit/xtrm-main/packages/board-audit/package.json` → no such file (the package is shell
   plus Python scripts).
9. **Hidden `.beads` dependency extends past Core — VERIFIED, and absent from the plan.**
   `scripts/smoke-container/Dockerfile:42-50` downloads a musl `bd` binary and asserts
   `bd version`; `scripts/smoke-container/verify.sh:493` compares against `bd version`;
   `.github/workflows/service-skills-drift-sweep.yml:55-56,350,368` installs `@beads/bd` because
   "service-skills-sync declares bd in `capabilities.external_commands`";
   `test/integration-suite/suite-c-coordinator-lineage.mjs:91,341` requires `bd init`. *Residue:*
   the Dockerfile comment states `bd` is "a hard dependency of **xtmux-events**". The plan's §3.3
   gap table and §4 matrix never mention the smoke container, the drift sweep, the integration
   suite, or an xtmux-side `bd` dependency. Class-11 coverage is therefore incomplete.
10. **Committed build artifacts — VERIFIED, but CI already blocks drift.** `git ls-files cli/dist`
    = `index.cjs`, `index.cjs.map`, `index.d.cts`. *Residue:* `lane7` presents tracked `cli/dist` as
    a silent-drift risk; `.github/workflows/ci.yml:52-53` ("Dist is up to date") already fails on
    `git diff --exit-code cli/dist`. The risk is narrower than stated: drift is caught, staleness of
    the *substrate seam* inside `dist` is not.
11. **Live machine state — VERIFIED.** `~/.claude/settings.json` references `beads-edit-gate`,
    `beads-commit-gate`, `beads-stop-gate`, `beads-claim-sync`, `beads-memory-gate`,
    `project-memory`, `beads-compact-restore` (one each) and `substrate` 0 times;
    `~/.pi/agent/settings.json` has `beads-edit-gate`, `project-memory`, `beads-compact-restore`
    and no substrate package. `~/.xtrm/hooks/` still contains `beads-memory-gate.mjs` and
    `project-memory.mjs`, which `959c7718` deleted from the repo. *Residue:* the two "deleted files"
    are still present in the *installed* global hook root, so the stale wiring may still resolve —
    the plan's phrasing ("wires … files that were deleted") describes repo state and machine state
    in one sentence and should be split; the operative risk is *ambiguity*, not a guaranteed no-op.
12. **`cli/dist` vs lanes: the released surface is unreleased source — VERIFIED.**
    `git cat-file -e v0.12.0:cli/src/core/substrate.ts` fails; the file is 564 lines on main;
    commit `f949b33f` introduced it. The plan's §1.3 asymmetry table is accurate.
13. **Beads semantics preserved under Substrate names — VERIFIED for `claimId`, not assessed for
    the rest.** `.xtrm/hooks/beads-claim-sync.mjs:79` writes
    `bd kv set claimed:${sessionId} <issueId>`; `.xtrm/hooks/beads-gate-core.mjs:70-75` returns that
    string as `claimId`; `.xtrm/hooks/beads-edit-gate.mjs:61` logs `issueId: state?.claimId`;
    upstream `IssueClaim.id` is `number` and carries `generation` + `expiresAt`
    (`/tmp/audit/xtrm-main/packages/substrate/src/domain/claim.ts:31-40`, and `:16-18` states
    "Claimed/in-progress is derived from a live claim row, never a stored flag on the issue").
    Lane 5 C2/C3 are correct. *Residue:* the plan's §4 matrix action for this row is a bare
    `REPLACE` with no gate, while lane 5 rates it CRITICAL — the severity does not survive into
    the plan's matrix.

---

## (C) "Do not build this" — Core components a frozen upstream primitive already owns

Ranked by the size of the mistake. "What Core should do instead" is deliberately terse.

| # | Do not build | Upstream owner and file | Instead |
|---|---|---|---|
| DB-1 | **Any Core-side claim / session-binding / writer-lease store.** The plan §4 row "Execution identity → `ExecutionContext`, `ExecutionBinding`, `activationId`/`attemptId`" invites exactly this. | `packages/substrate/src/domain/claim.ts:12-64` (`IssueClaim`, `WorkspaceLease`, anti-steal, generation, `expiresAt`); `src/domain/execution-binding.ts` | Nothing. Consume `sb issue`/`sb journal` claim state; delete `bd kv` claim emulation. |
| DB-2 | **A Core import/preservation verifier.** `cli/src/core/substrate-verify.ts` is 405 lines that re-derive counts while upstream ships the receipt. | `cli/sb.ts:2123-2134` returns `verifier: { checks }` + `verdict` and exits 1 on FAIL; checks include `2-edge-multiset`, `3-hierarchy-resolves`, `5-provenance-events`, `6-notes-preserved-sample`, `7-edge-row-stability` | Delete the module once `sb import beads` is consumable from a release; do **not** "re-base" it on the receipt (a second implementation of the same verdict is still a second authority). |
| DB-3 | **A Core projection/board transport** (gen-1 fork, per-root renderer, `index.json`, PR locator, `pr-status`). | `IssueService.exportProject` (`src/service/issue-service.ts:754-809`), `sb export project` (`cli/sb.ts:2154-2160`), `external_bindings` + `listBindings` (`src/service/integration-service.ts:190-238`), `packages/board-audit` (gen-2, upstream) | Delete the fork. Do not build a replacement transport until upstream exposes the projection CLI (see BG-6). |
| DB-4 | **A Core git-provenance trailer writer / hook chain.** | `packages/substrate/hooks/{prepare-commit-msg,post-commit,post-rewrite}.ts`; `src/domain/provenance.ts:89` ("Host-owned trailer block appended by prepare-commit-msg") | Do not write trailers in Core. Block on BG-4 (upstream installer gap) and keep the Beads blocks until then. |
| DB-5 | **A Core chain compiler / materializer / scheduler.** Plan §5.3 ("Proposed convergence") edges close to this. | ADR-001: materialization only after freeze, "the materializer must not invent a second dependency graph"; `PlanningService` owns the transaction | Keep `spec.yaml` as intake. Emit one `PlanDraft` and let `sb plan apply` commit it. Build nothing above `PlanDraft`. |
| DB-6 | **A Core `sb` version/comparator layer.** Lane 7 recommends adding Substrate to `runtime-compat.ts` `SIBLINGS`. | `integrations/setup.ts` `check`/`plan` already validates enrollment identity fail-closed (`EXPECTED_PACKAGE_NAME` at `:203`; six-item contract) | Declare a range in `docs/runtime-compatibility.json`; assert `sb --version` + the six-item enrollment contract at the `substrate.ts` boundary. Do not grow a second comparator that resolves packages by name. |
| DB-7 | **A tolerant parser for `sp run`/`sp result`.** The plan's §5.3 correctly rejects the naive rename but leaves the broken parsers in place. | Native path: `specialists-master/src/activation/types.ts`; result channel: Substrate Journal `result` (`src/domain/journal.ts:16-27`) | Delete the scrape (lane 3 S0). Do not ship a parser that accepts both shapes — it perpetuates LLM-authored board mutation. |
| DB-8 | **A Core `.beads`→Substrate alias map.** | `src/service/issue-service.ts:461-488` (`resolveRef` falls through to `issue_aliases`); `src/compatibility/beads/import.ts` (one-shot, no dual-write) | Nothing. |
| DB-9 | **A Core readiness probe over `bd` skill markers.** `cli/src/spec/readiness/matrix.ts:23-88` greps for `bd swarm`, `bd mol pour`, `recommended_template`, typed `bd dep`, `bd gate`; all 8 markers are absent from the deployed skills, so `xt spec apply` refuses today (exit 65). | No upstream equivalent exists (see BG-1/BG-10) | Delete the gate rather than port its vocabulary; or probe `sb`/chain availability once BG-1 lands. |

---

## (D) Blocking gaps — not implementable even after both upstream releases

| # | Missing primitive (evidence) | Blocking consequence |
|---|---|---|
| BG-1 | Chain runtime ships in no package: `ResolvedChain` matches only `experiments/agentsession-sre-chain-vertical-slice/**` plus one doc in `packages/xtrm-app/docs/implementation-packet.md`; `xtrm/packages/` (12 entries) has no chain package. | Plan §2.5 and §5.3's whole convergence and G7 are **not schedulable**. Releasable only by upstream work, not by a Core release. |
| BG-2 | No `ResolvedChain → PlanDraft` binding: `PlanIssueSpec` (`planning-service.ts:19-35`) has `key, projectId, title, kind, contract, scrutiny, ownership, contextRefs, parentKey, updateIssueId, expectedRevision, aliases` — no step class, no blocks-only topology constraint, no chain id. | Even with `sb plan apply`, a frozen chain cannot be materialized without losing step semantics. Plan §5.3 labels this "unresolved (U2)"; it is a hard dependency, not an open question. |
| BG-3 | No bounded home for the materialized id set: `ResultPayload` (`journal.ts:128-139`) has no epic/children field and `validateResultPayload` rejects unknown keys (`:155-160`). | The planner-result ingest cannot be replaced without an upstream schema change. |
| BG-4 | No installer for Substrate's git-provenance hooks: no `core.hooksPath` anywhere in `packages/substrate/`; `planCommands` (`integrations/setup.ts:307-319`) has no hook step. | `.githooks` Beads blocks cannot be deleted without losing trailer writing; `commit-check.ts` guidance becomes unactionable. |
| BG-5 | Pi stop event unwired: `evaluateStopContinuity` exported (`integrations/pi/handlers.ts:390`), no `pi.on("agent_end")` in `integrations/pi/extension.ts` (`:183,194,203,210`). | `beads-stop-gate.mjs` and `session-flow/index.ts:67-95` cannot be retired without a behaviour regression. |
| BG-6 | No projection CLI, sender, inbound CLI, or filesystem writer: `KNOWN_GROUPS` omits any projection group (`sb.ts:841`); `ProjectionSender` is an interface (`integration-service.ts:60`); `drainOutbox` is called only from tests; `writeFilesystemProjection` has no production caller; `receiveInbound`/`receiveComment` are unreachable from the CLI. | Board-audit transport cannot be replaced; only deleted (with loss of external review). |
| BG-7 | No `sb` bulk/status read verb (equivalent of `bd list --all --json`). | `cli/src/core/topology-projection.ts:91` (`{ bin: 'bd', args: ['list','--all','--json'] }`) cannot be repointed; `TopologySourceName` cannot gain `substrate`. |
| BG-8 | No distribution path for upstream board-audit: no `package.json` in `packages/board-audit/`, and it lives in the **private** `xtrm-dev/xtrm`. | A public Core artifact cannot depend on, install, or `xt update`-manage the canonical gen-2. |
| BG-9 | `sb init` is not in any published artifact: present at `cli/sb.ts:730-780,872-875` on main, absent from published `0.1.2` (`KNOWN_GROUPS` in 0.1.2 lacks `init`). | ADR §19's normal flow cannot be adopted; `--sb-create-project` cannot be retired. |
| BG-10 | No upstream chain-availability probe or `recommended_template` emission: `readiness/matrix.ts:48-55` requires the marker, the released planner `output_schema` has four unrelated keys, and 0 of 8 markers exist in any deployed planning skill. | `xt spec apply` is dead weight until either the probe is deleted or upstream ships a compiler. |
| BG-11 | No Substrate equivalent of the Dolt push-sync durability property: `.githooks/pre-push.bd-sync:20-36` currently aborts a Git push when `bd dolt push` fails. | The blocking property "a push cannot succeed while durable state is unsynced" is dropped, not replaced, unless explicitly adjudicated (lane 8 UNRESOLVED-4). No owner is named. |
| BG-12 | Hidden `bd` dependency outside Core: `scripts/smoke-container/Dockerfile:42-50` installs `bd` and the comment names **`xtmux-events`** as a hard `bd` consumer; `service-skills-drift-sweep.yml:55-56,350,368` installs `@beads/bd`; `test/integration-suite/suite-c-coordinator-lineage.mjs:91,341` requires `bd init`. | The hard cut is not completable by Core alone, and the plan's §3.3 gap table does not contain these. A "Core-only" wave will surface them as release blockers. |

---

## (E) Ordering attacks

Reconstructed sequence used for attack: plan §4 matrix (as the de-facto order) + lane 8 §E
D-1..D-10. Where they differ, the plan's order is the unsafe one.

**O1 — No order exists to execute. [violated invariant: "a migration window has a gate"]**
`core-substrate-hard-cut-plan.md` has no §6. Corrected order: author §6/§7/§8; adopt lane 8 §E
D-1 (proofs) → D-2 (git hooks) → D-3 (board) → D-4..D-6 (dead code) → D-7 (board-audit) → D-8..D-9
(deployment, then the live gate) → D-10 (symlink guard, last). Invariant violated by proceeding:
every deletion is ungated, and lane 8 explicitly notes the plan has no coverage for D-7 (board-audit
has **zero tests**: `git grep board-audit` over tests returns nothing).

**O2 — Deleting `beads-*` git-hook blocks before BG-4 lands. [invariant: do not delete a guard
before its replacement is proven]**
Plan §4 row "Claim / edit / commit enforcement → REPLACE (Substrate `claude-code/{edit-gate,
commit-check,stop-gate}.ts`)" is ungated. Corrected order: upstream installer (BG-4) lands → a real
commit is proven to carry XTRM trailers via `post-commit` → *then* delete
`.githooks/prepare-commit-msg`, `.githooks/pre-commit:23-88`, `.githooks/pre-push:24-98`.

**O3 — The plan's own §4 gate applies to the child row, not the parent row. [invariant: one gate per
concern]**
Plan `:260-261`: row "Claim / edit / commit enforcement" = `REPLACE` (no block), row "Stop-gate
continuity" = `BLOCKED on G2`. A worker executing §4 line-by-line deletes the edit and commit gates
(which have no Pi wiring at all — G2 exists precisely because `evaluateStopContinuity` is unwired)
and leaves only the stop gate. Corrected: elevate the G2/enrollment block to the whole enforcement
group; a per-row block on a subsystem split across rows is not a gate.

**O4 — Plan §4 "Durable work records → REPLACE" before the Core release that ships the seam.
[invariant: do not import state after deleting the source]**
Plan §1.3 establishes that the entire Substrate seam is unreleased
(`git cat-file -e v0.12.0:cli/src/core/substrate.ts` fails; `f949b33f` introduced it). Corrected
order: ship a Core release containing the seam first, so a rollback target exists on npm (F-9: the
current artifact has **no `gitHead`** and no retrievable attestation, so rollback-by-content-hash is
the only option). The plan never mentions a Core release before deletions.

**O5 — Board-audit deletion before inbound-editable-path deletion. [invariant: no dual authority]**
Plan §5.4 correctly states the gate ("no board-audit path may invoke `bd import`/`bd dep`/`bd
comments` after the authority cutover") and lane 4 states the hazard, but neither places it in an
order. Corrected: delete the editable-handoff/reconcile/apply path **first**
(`.githooks/board-audit-roundtrip.py:803,809,813,893,902` emit `bd dep remove/add`, `bd comments
add`, `bd import`), verify with an assertion, then retire the read-only transport. Reversed, the
round-trip can mutate Beads after Substrate becomes authority.

**O6 — `substrate-verify.ts` deletion before a released `sb import beads`. [invariant: keep the proof
until the replacement is green]**
Plan §4 classifies provenance/records as `REPLACE`; lane 2 rates the 405-line verifier "P0 (A9
correctness)". Corrected: keep the local verifier as a *cross-check* against
`data.verifier.checks`/`data.verdict` for at least one release, then delete it (DB-2). Deleting
first removes the only preservation proof before the receipt is consumed from a frozen artifact.

**O7 — Deleting gate scripts before the installed global copy is reconciled. [invariant: no
fail-open authority]**
Verified machine state: `~/.claude/settings.json` and `~/.pi/agent/settings.json` still wire
`beads-edit-gate`, `beads-commit-gate`, `beads-stop-gate`, `beads-claim-sync`,
`beads-compact-restore`, `beads-memory-gate`, `project-memory`; Substrate is enrolled on neither
surface. Corrected order (lane 1 U-3 "enroll → verify → reconcile → delete", which the plan never
adopts): enroll → `setup.ts check --json` six-item green → run the installer to rewrite both
settings files from the canonical template → *then* delete hook files. Deleting first leaves both
runtimes with a gate command that resolves to a missing file.

---

## (F) Fail-open windows and dual-authority windows

| # | Window | Present today? | Exact gate that must exist |
|---|---|---|---|
| W1 | **Two claim authorities**: Core `bd kv claimed:<session>` + `IssueClaim` row; plus Beads `in_progress` as a third stored flag. | YES. `beads-claim-sync.mjs:79`, `beads-gate-utils.mjs:54-73`, `beads-gate-core.mjs:70-75` vs `claim.ts:16-18` | An executable assertion that no shipped path reads a stored claim flag: zero `bd kv` and zero `in_progress`-as-claim reads in `cli/src`, `.xtrm/hooks`, `packages/pi-extensions`. Prose is insufficient (ADR violation is CRITICAL per lane 5 C3). |
| W2 | **Beads remains authoritative for lifecycle** while §4 claims Substrate owns durable work: 15 `bd` subprocess sites in 8 files, including worktree creation (`worktree-session.ts:2937` with a silent plain-git fallback), assignee writes (`:181`), report queries (`report.ts:92,122`), and spec drift/archive gates (`spec/*`). | YES | Lane 8 D-14(ii)/D-15(ii): AST/text guard that `cli/src/**` (non-test) contains no `bd` spawn and `packages/pi-extensions/**` no `bd` subprocess, plus a suite run with `bd` absent from `PATH`. |
| W3 | **Board-authority dual write**: gen-1 round-trip mutates Beads (`roundtrip.py:803,809,813,893,902`) while Substrate becomes authority. | YES (path present; not exercised) | The lane-4 gate as an assertion, plus deletion of the editable/reconcile path before authority cutover (O5). |
| W4 | **Git durability depends on Beads**: `.githooks/pre-push.bd-sync:20-36` aborts the push on `bd dolt commit/pull/push` failure. | YES | An explicit decision record + proof that Push no longer depends on Beads state (lane 8 UNRESOLVED-4), or retention of an equivalent Substrate durability gate. Neither exists in the plan. |
| W5 | **No Substrate version gate at any point on the install/doctor/update path.** `docs/runtime-compatibility.json` has no `substrate` key; `runtime-compat.ts:33-36` `SIBLINGS` = specialists+xtmux; enforcement only at interactive launch (`worktree-session.ts:2534`); `XTRM_SKIP_RUNTIME_COMPAT=1` short-circuits it; `loadRuntimeRequirements` returns `null` on any parse miss; range strings are themselves unvalidated. | YES (all five VERIFIED) | A `substrate` row in `docs/runtime-compatibility.json` **and** a `substrate.ts`-boundary precondition on `sb --version` + six-item enrollment, executed in `xt init`, `xt update --apply`, and `xt doctor` — not only at launch. Without it, every §4 `REPLACE` proceeds without proof of Substrate authority (class 6). |
| W6 | **No gate at all for the freeze itself**: §3.1/§3.2 are human checklists with no owner, no date, and no check in any workflow. | YES | A committed, scripted gate (e.g. `scripts/check-substrate-contract.mjs` in `prepublishOnly`) that fails when the resolved `sb` artifact is outside the declared range, when `setup.ts check` is not green, or when the frozen version has no `gitHead`/attestation. |
| W7 | **Enrollment state can regress silently**: `probeInstalledPlugins` reports `beads-marketplace` remnants; nothing in CI asserts absence after enrollment. | YES (`lane1` F-26) | A post-cutover CI assertion that `~/.claude/plugins/installed_plugins.json` has no beads marketplace and no beads hooks, plus the six-item `setup.ts check`. |
| W8 | **Deleting the last working runtime gates before any Substrate runtime exists.** Pi edit enforcement is **already inert in worktrees** (`packages/pi-extensions/src/core/adapter.ts:39-41` requires `.beads` in `cwd`; this worktree has none while `/home/dawid/dev/core/.beads` exists) and Claude enforcement is wired to files whose source was deleted. | YES | The lane 1 U-3 order as a gate: enrollment verified → gates reconciled from template → replacement gate observed blocking a real edit → only then delete. |

---

## (G) Severity table

`ID | Finding | Class(1-13) | Severity | Evidence | Affects | Confidence`

| ID | Finding | Class | Sev | Evidence | Affects | Conf |
|---|---|---|---|---|---|---|
| L9-01 | Plan is truncated: no §6/§7/§8; §5.7 ends mid-sentence; lane 8 not incorporated; the plan's "only this document" promise is false | 5, 13 | **HIGH** | `core-substrate-hard-cut-plan.md:629` (EOF), forward refs at `:103,164,193,247,266`; `grep -c 'Lane 8'` = 0 | plan §0, §3, §4, §5 | VERIFIED |
| L9-02 | Plan §4 asserts Core *derives* project identity; source says the opposite ("never invents project identity") | 1, 3 | **HIGH** | `core-substrate-hard-cut-plan.md:258` vs `cli/src/core/substrate.ts:238-240,217-219`; `init.ts:1173-1199` | plan §4, §5.2; lane 2 Q3 | VERIFIED |
| L9-03 | No Substrate version gate anywhere on install/update/doctor; enforcement only at launch and skippable | 6 | **HIGH** | `docs/runtime-compatibility.json` (no `substrate` key), `runtime-compat.ts:33-36`, `worktree-session.ts:2534`, `runtime-compat.ts:163` | plan §3.1, §4 | VERIFIED |
| L9-04 | 15 `bd` subprocess sites in 8 files (not "≥9 across 4"): 3 `spec/*` modules unnamed by the plan | 2, 11 | **HIGH** | `worktree-session.ts:129,181,2937`; `codex-worktree-session.ts:283`; `end.ts:55`; `report.ts:9,92,122`; `docs-cross-check-bd.ts:15,50`; `spec/drift.ts:99,109,121`; `spec/archive-gate.ts:85,95`; `spec/reconcile.ts:88` | plan §5.2; lane 2 Q4/Q5 | VERIFIED |
| L9-05 | G2 block applied to one row while the sibling rows in the same group are ungated | 5, 9 | **HIGH** | `core-substrate-hard-cut-plan.md:260-261`; `integrations/pi/extension.ts:183,194,203,210` | plan §4; lane 1 U-1/A-3 | VERIFIED |
| L9-06 | Hidden `bd` dependency outside Core (smoke container, drift sweep, integration suite, `xtmux-events`) absent from the gap table | 11 | **HIGH** | `scripts/smoke-container/Dockerfile:42-50`; `verify.sh:493`; `service-skills-drift-sweep.yml:55-56,350,368`; `suite-c-coordinator-lineage.mjs:91,341` | plan §3.3, §4; lane 8 (C) | VERIFIED |
| L9-07 | No rollback path, no reconciliation for an `uncertain` outcome, no way back after a failed wave; no Core release exists as a rollback target | 5, 6, 13 | **HIGH** | absent from `core-substrate-hard-cut-plan.md`; `v0.12.0` lacks `cli/src/core/substrate.ts`; `npm view xtrm-tools@0.12.0 gitHead` empty | plan §3, §4; all lanes | VERIFIED |
| L9-08 | Dual claim authority (`bd kv` + `in_progress` + future `IssueClaim`) with no assertion gate | 2, 8 | **HIGH** | `beads-claim-sync.mjs:79`; `beads-gate-utils.mjs:54-73`; `beads-gate-core.mjs:70-75`; `claim.ts:16-18,31-40` | plan §4, §5.5; lane 5 C2/C3 | VERIFIED |
| L9-09 | BG-1..BG-12 are not implementable by Core even after both releases (chain runtime, `PlanDraft` chain binding, `ResultPayload` id set, hook installer, Pi stop, projection CLI/sender, bulk read, board-audit distribution, `sb init` release, readiness probe, push-sync durability, external `bd` consumers) | 3, 4, 11 | **HIGH** | see §(D) rows; each cites source | plan §3.3, §5.3, §7.3 (missing) | VERIFIED |
| L9-10 | Committed gen-1 board-audit fork has **zero** tests and is slated for deletion with no replacement | 1, 13 | **MED** | `git grep -l board-audit` over tests = 0; `core-substrate-hard-cut-plan.md:457-483` | plan §5.4; lane 4, lane 8 D-7 | VERIFIED |
| L9-11 | "26 references to `@xtrm/substrate`" is wrong (49 repo-wide / 20 excluding dist+docs) | 10 | **MED** | `core-substrate-hard-cut-plan.md:341-342`; `git grep -o` counts | plan §5.2; lane 2 Q1 | VERIFIED |
| L9-12 | §5.7 "prepublish … embeds a CI temp path" is fixed on main since `589e67e5` (2026-09-06, post-`v0.12.0`) | 10, 12 | **MED** | `scripts/vendor-specialists-from-manifest.mjs:36-52`; `git blame` → `589e67e5`; `.xtrm/registry.json` `"repo_path": "../specialists"` | plan §5.7; lane 7 F-8 | VERIFIED |
| L9-13 | `"Substrate has no CHANGELOG.md"` is false (975-line file exists) | 10 | **LOW** | `/tmp/audit/xtrm-main/CHANGELOG.md`; `core-substrate-hard-cut-plan.md:102` | plan §1.3 | VERIFIED |
| L9-14 | Lane 3 overstates `activationId` vs `job_id` as having "no counterpart"; source says `ActivationId` "maps to job_id" | 7 | **MED** | `specialists-master/src/activation/types.ts:21-22`; `lane3-spec-chain-convergence.md` §7.3 | lane 3; plan §5.5 (lane 5 is correct) | VERIFIED |
| L9-15 | Plan §4.1 "consistent with both existing public consumers" ignores that Specialists prefers an operator-selected Substrate **source checkout** over the installed artifact | 1, 10 | **MED** | `specialists-master/src/activation/workitem-store.ts:54-61,77-86`; `core-substrate-hard-cut-plan.md:284-288` | plan §4.1, §3.2 | VERIFIED |
| L9-16 | Identity-grep evidence command (`grep -c 'a\|b\|c'`) cannot match anything (BRE); conclusion happens to be true | 12 | **LOW** | `core-substrate-hard-cut-plan.md:184-185`; independent per-token greps = 0 | plan §2.6 | VERIFIED |
| L9-17 | Lane 5 C1 primary citation is wrong (`beads-gate-utils.mjs:31` is `getSessionClaim`; the collapse is `:20-21`); `beads/index.ts:14` not `:13` | 7 | **LOW** | `.xtrm/hooks/beads-gate-utils.mjs:20-21,31`; `beads/index.ts:14` | lane 5 C1; plan §5.5 | VERIFIED |
| L9-18 | Plan §5.1 `manifest.json:5` citation; `required: true` is `:7` | 12 | **LOW** | `packages/pi-extensions/src/manifest.json:4-9` | lane 1 A-13; plan §5.1 | VERIFIED |
| L9-19 | Live global settings files still wire retired gates and reference files deleted from the repo, while Substrate is unenrolled on both runtimes | 6, 12 | **HIGH** | `~/.claude/settings.json` (7 beads tokens, 0 substrate); `~/.pi/agent/settings.json`; `~/.xtrm/hooks/{beads-memory-gate,project-memory}.mjs` present; `959c7718` | plan §5.1; lane 1 F-25/F-26/U-3 | VERIFIED |
| L9-20 | Pi edit gate already inert in worktrees, yet the manifest still marks it `required: true` and no wave reconciles this | 5, 12 | **HIGH** | `packages/pi-extensions/src/core/adapter.ts:39-41`; `.beads` absent in this worktree; `manifest.json:7`; `policies/beads.json:3` "RETIRED" | plan §5.1; lane 1 A-8/A-13 | VERIFIED |
| L9-21 | Duplicated directory-wide hook install means 11 unregistered `beads-*` hooks ship in the tarball and are invisible to drift detection | 11, 12 | **MED** | `cli/src/core/global-hooks-bootstrap.ts:185` + `:42` `COPY_FILTER` (`__pycache__` only); `.xtrm/registry.json` hooks = 14, beads = 0; disk beads files = 11; `package.json files[]` includes `.xtrm/hooks` | plan §5.1; lane 1 C-9/C-2; lane 8 (C) | VERIFIED |
| L9-22 | No acceptance criteria and no deletion order inside the plan; lane 8's 15 proofs and D-1..D-10 exist but are unreferenced | 5, 9, 13 | **HIGH** | `lane8-tests-ci-migration.md:375-534`; `grep -c 'Lane 8'` in plan = 0 | plan §0, §4 | VERIFIED |

---

## Not refuted (explicitly)

I found no error in: ADR §2/§4/§18/§19/§100/§102 quotes; plan §1.2 artifact/version baseline;
plan §1.3 `v0.12.0` vs main asymmetry; plan §2.4/§2.5 chain-not-shipped statement; plan §2.6
identity taxonomy; plan §3.3 G1/G2/G3/G4/G6; plan §5.2 package-name defect and the `sb doctor`
exit-code contract; plan §5.3's two production breakages (`sp run` camelCase `jobId`,
`sp result` missing planner fields); plan §5.4's gen-1/gen-2 frame correction and `pre-push:105`
hardcoded path; plan §5.5 `claimId` namespace collision, `packages/contracts` 18 schemas, contracts
`@xtrm/contracts` 404; plan §5.6 `AGENTS.md:14/50/85/143-145` contradiction, `bd init` injection
commit `93924b3e`, root `skills/` 190 files not in `files[]`, `global-prompt-sync` duplicate-marker
fail-closed; plan §5.7 absence of a Substrate range, `gitHead` absence, tracked `cli/dist`.
Where I could not re-check (lane 7's tarball observation, lane 4's transport-branch sampling), I say
so above rather than inventing an objection.

## Unresolved for the migration owner

1. Who owns §3.1/§3.2 (the freeze gates) and what is the enforcing script? No owner, date, or check
   exists.
2. Which single Core release ships the Substrate seam so a rollback target exists? Not named.
3. What replaces the `bd dolt push` push-precondition (BG-11)?
4. What is the reconciliation rule for an `uncertain` projection/effect outcome? ADR-002 mandates
   append-only receipts and an `uncertain` result; no receipt table or service exists in
   `substrate/src`.
5. Does the plan intend to keep a Core-owned Git artifact transport after the cut? Not stated;
   BG-6/BG-8 make the answer "not yet possible" either way.
