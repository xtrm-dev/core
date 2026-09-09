# Memory System Evolution — r6g research

**Status:** ARCHIVED — bd-memory retired 2026-09-09 (bead xtrm-aemfv). Retained as a design record; reversible: the research direction is preserved here even though the `bd memories` substrate, memory gate, `xt memory`, and `.xtrm/memory.md` are removed. Not a plan of record.
**Author:** dispatched research worker (bead `xtmux-r6g.10`, worktree `core-r6g-w10`).
**Date:** 2026-07-18.
**Related:**
- Seed doc: [`docs/design/knowledgebasecerebras.md`](./knowledgebasecerebras.md).
- Immediate safety fixes: `/tmp/w5-memory-proposal-20260717-012000Z.md` (W5).
- Adjacent designs: [`docs/design/openwiki.md`](./openwiki.md), [`docs/design/issuetracking.md`](./issuetracking.md).

## 0. TL;DR

- The xtrm memory system today is **three disjoint substrates** (`bd remember` per-repo Dolt, a synthesized `.xtrm/memory.md`, and Claude Code's file-based auto-memory) glued together by hooks and a `memory-processor` specialist. It is **write-heavy, exact-key retrieval, and per-repo isolated**. It has no semantic search, no cross-repo view, no ingestion connectors, no decay, and no audit surface.
- W5 diagnosed **three correctness failures** in the processor: large audits time out, silent forgets are possible, prune instructions are incomplete. The W5 proposal ships **schema + key-set validation + hash-guarded prune + restore-on-mismatch**. This closes the dangerous failure and is orthogonal to the direction this document argues.
- The 12-24 month direction should be a **thin, additive knowledge layer over the existing per-repo Dolt truth**, borrowing four patterns:
  - **Cerebras Knowledge**: a single `(embedding, raw, summary, metadata, source)` table, multi-source connectors, hybrid retrieval fused at query time, and narrow MCP tools instead of a `answer()` monolith.
  - **Letta**: a **tier hierarchy** (core / recall / archival) so agents have a small always-in-prompt slice and a larger on-demand pool, with explicit tools to promote and demote items.
  - **mem0**: **ADD-only extraction** with conflict resolution at retrieval time, plus a small entity/graph store to boost recall.
  - **OpenWiki/OKF**: structured metadata front matter so **deterministic filtered retrieval** is possible without an LLM in the loop.
- **Ship-in-order (ponytail):** the smallest slice that proves the pattern is _not_ a Postgres+pgvector rollout. It is `.xtrm/memory.md` frontmatter (OKF) + `bd memories --format=jsonl` with `tags/source/ts` fields + a tiny `bd search` shim over SQLite FTS5. Zero new services, one new dependency (already-installed), one new bd flag, and it unblocks every downstream step.
- **Do NOT** overengineer the `memory-processor` specialist (per operator directive). This document is about the memory _system_ — the store, the schema, the retrieval surface, and the ingestion boundary — not the audit pipeline that the processor runs.

---

## 1. Current state — what the xtrm memory system actually is today

### 1.1 The three substrates

| # | Substrate                                | Storage                                                                                                          | Read API                                                | Write API                                                    | Scope                            |
|---|------------------------------------------|------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------|--------------------------------------------------------------|----------------------------------|
| 1 | `bd` durable memory ("raw truth")        | Per-repo Dolt table (`bd` internal), on-disk in `.beads/`                                                        | `bd memories`, `bd memories --json`, `bd recall <key>`  | `bd remember "<text>"`, `bd forget <key>`, `bd remember --key <key>` | Per-repo                         |
| 2 | Synthesized project memory               | `.xtrm/memory.md` at repo root (single file, ~100–200 lines target)                                              | Read by every agent at session start; grep-friendly     | Written **only** by the `memory-processor` specialist run    | Per-repo                         |
| 3 | Claude Code file-based auto-memory       | `~/.claude/projects/<slug>/memory/MEMORY.md` + per-topic files (`user_*.md`, `feedback_*.md`, `project_*.md`, `reference_*.md`) | Auto-loaded into context by Claude Code harness         | Agent writes via `Write` tool per typed schema in system prompt | Per-project-slug (host-user-wide) |

These three do **not** talk to each other. A `bd remember` in the `core` repo never appears in the `xtmux` repo's session; a Claude Code `user_role.md` note is invisible to `bd recall`; and the `.xtrm/memory.md` synthesis reads from #1 but nothing writes back to #1 from it.

### 1.2 Bulk shape of the data (measured `2026-07-17 → 2026-07-18`)

| Repo         | Memories | JSON bytes | `.xtrm/memory.md` |
|--------------|---------:|-----------:|-------------------|
| `xtrm-tools` (this repo, core) | 561      | 274,330    | ~13 lines (essentially empty)   |
| `specialists` | 845      | 403,260    | **missing**       |
| `xtmux`       | 178      | 95,341     | **missing**       |

Two of three managed repos have **no synthesized memory** on disk. The synthesis is expensive to produce (see §2.1) and has failed silently in the past (see §2.2), which explains the drift.

### 1.3 The `memory-processor` specialist

- Definition: `config/specialists/memory-processor.specialist.json` v1.1.0 in the `specialists` repo.
- Skill it follows: `config/skills/memory-audit-transaction/SKILL.md` (specialists repo, injected at run time).
- Model: MEDIUM permission, `stall_timeout_ms=120000`, `max_retries=0`.
- Output artefacts on disk (not chat):
  - `.tmp/memory-audit/memories.json` — full `{key: content}` bulk export.
  - `.tmp/memory-audit/keys.txt` — one key per line.
  - `.tmp/memory-audit/decisions.jsonl` — append-only ledger, one row per memory.
  - `.tmp/memory-audit/apply-log.txt` — every `bd forget` applied or skipped.
  - `.tmp/memory-audit/backup/<key>.txt` — pre-delete backup.
- Phases (from the skill): (1) read prior `.xtrm/memory.md`, (2) read last 3 session reports (targeted sections), (3) bulk-export via pre-script (`pre-bulk-export.sh`), (4) single-pass project state read (`git log -30`, `CLAUDE.md`, `README.md`), (5) chunked classification (20–30 per turn) with decisions appended to `decisions.jsonl`, (6) **completeness gate** before any write, (7) atomic hash-guarded prune, (8) write `.xtrm/memory.md`, (9) final report (counts only).

The processor is the **only** write path to `.xtrm/memory.md` and the **only** delete path against `bd`. Everything else is agent-driven append-only via `bd remember`.

### 1.4 The hooks that touch memory

Xtrm ships four hooks on the memory boundary. All live in `~/.xtrm/hooks/` (project-installed copy at `.xtrm/hooks/` per repo):

| Hook (`~/.xtrm/hooks/…`)                    | Claude Code event | Purpose                                                                                                   |
|---------------------------------------------|-------------------|-----------------------------------------------------------------------------------------------------------|
| `beads-compact-save.mjs`                    | PreCompact        | Snapshot `bd list --status=in_progress` IDs (plus active Serena project) to `.beads/.last_active`.        |
| `beads-compact-restore.mjs`                 | SessionStart      | Read `.beads/.last_active`, re-set restored IDs to `in_progress`, inject a one-line reminder, unlink.     |
| `beads-memory-gate.mjs`                     | Stop              | If the session's claimed issue was closed, **block Stop** until the agent satisfies `memory-acked:<id>`. Fires for `claimed:<sessionId>` or `closed-this-session:<sessionId>` or a branch-derived issue id. |
| `specialists/specialists-memory-cache-sync.mjs` | PostToolUse       | Sync the specialists memory cache after specialist tool calls.                                            |

None of the hooks does **retrieval**. `beads-compact-restore` re-establishes _state_ (which issues are in progress), not _knowledge_. The `memory-gate` is an **ack gate**, not a KB gate: it enforces that the agent typed at least a `bd remember` or `bd kv set memory-acked:<id> nothing novel:<reason>` before Stop. It never asks "is what the agent wrote actually useful?" and it never surfaces prior memories to the agent.

### 1.5 The Claude Code auto-memory (the third substrate)

The orchestrator's `CLAUDE.md` documents a per-project auto-memory system at `~/.claude/projects/<url-encoded-cwd>/memory/`. Two artefacts:

- `MEMORY.md` — a plain index (`- [Title](file.md) — hook line`), always in context, capped at ~200 lines.
- Per-topic files — one `.md` per memory, with YAML frontmatter (`name`, `description`, `metadata.type ∈ {user, feedback, project, reference}`).

This is **the only** part of the current stack that already ships an OKF-adjacent schema: typed, described, cross-linkable (`[[name]]`), and file-indexed. It is also the only substrate with a codified taxonomy (`user`/`feedback`/`project`/`reference`) — Beads memories are typeless free text.

The two systems **overlap heavily in intent** (persistent, per-project, agent-authored) and **diverge completely in mechanics**. That divergence is one of the failure modes below.

### 1.6 Read/write flow summary

```
                     ┌──────────────────────────────┐
                     │        Agent (session)       │
                     └──┬───────────────┬───────────┘
       bd remember/     │               │    Write user_*.md / feedback_*.md
       recall/forget    ▼               ▼
             ┌───────────────────┐  ┌────────────────────────────┐
             │  bd (Dolt, per-   │  │  ~/.claude/projects/<slug>/│
             │  repo)            │  │  memory/                   │
             │                   │  │  MEMORY.md + typed .md's   │
             │  key,content      │  │                            │
             └────────┬──────────┘  └────────────────────────────┘
                      │
             memory-processor
             (audit-transaction skill)
                      │
                      ▼
             ┌───────────────────┐
             │  .xtrm/memory.md  │  (read at every SessionStart)
             │  3 sections       │
             └───────────────────┘
```

There is no read edge from `~/.claude/projects/*/memory/` back to `bd`, and none from `.xtrm/memory.md` back to `bd` either. Everything downstream is a fan-out of #1.

---

## 2. Failure modes

### 2.1 What W5 already identified (confirmed here)

Cited from `/tmp/w5-memory-diagnosis-20260717-012000Z.md` and `/tmp/w5-memory-proposal-20260717-012000Z.md`:

- **F1 — Large audits fail or become unreliable.** Per-key `bd recall` costs ~150-300ms. At 561 memories that is 84-168 s against a 120 s bash-stall window. The pre-script `pre-bulk-export.sh` (single `bd memories --json` call) is the mitigation; when it is not run, the processor times out and produces "all Current" outputs without per-entry evidence.
- **F2 — Decisions/memories can disappear silently.** Completeness gate was **count-only**. A classifier that omitted a row let the processor still write `.xtrm/memory.md`, and prunes could apply against a snapshot that no longer matches live. Stale checkpoints could be reused across runs. No delete reconciliation.
- **F3 — Instructions internally inconsistent.** Processor prompt referenced obsolete flags and mixed the pre-W5 linear workflow with the chunked ledger workflow.

W5's ship-in-order is correct and this document does **not** try to replace it. The three W5 PRs (schema-and-key-set validation → deterministic 25-item batch driver → landed-work anchor) should ship regardless of anything below. This document argues about what the memory _system_ should become once F1-F3 are gone; the processor is the audit tool, not the system.

### 2.2 Additional failure modes visible from the substrate layout

**F4 — Cross-repo isolation.** Every managed repo has its own Dolt store. An operational lesson learned in `xtmux` (e.g. "PreToolUse hook block reasons must not include control chars — Claude Code truncates the log", which any of them could learn) never surfaces in `core` or `specialists` sessions. Agents rediscover the same wound.

**F5 — No semantic retrieval; no way to find memory by _shape_ of the problem.** `bd memories` returns a lexicographic key list, `bd recall <key>` requires an exact key. If the memory was written under `after-moving-extension-source-to-xtrm-ext-src` and the current session's question is "why did my registry crash after adding a Pi extension?", nothing on the surface matches. The synthesised `.xtrm/memory.md` compensates for small-N by putting the highlights in prompt, but at 561 memories that document is either too coarse (100-200 lines can't summarise 561 rows without loss) or too big to stay in the always-in-prompt budget.

**F6 — Two substrates, two schemas, two write paths.** `bd` memories have no type. Claude Code auto-memory has four types. There is no reconciliation. The user has to remember which surface to write to for which kind of note. The `memory-gate` only checks that _some_ `bd remember` fired — a `feedback` insight the agent recorded in `user_*.md` will pass the gate but never reach `bd`, and vice versa.

**F7 — No ingestion connectors.** Every memory in `bd` was typed by an agent as `bd remember "<text>"`. There is no automated ingestion of:
  - merged PR titles/bodies/reviews (Cerebras pulls PR discussion; we don't),
  - release notes and CHANGELOG entries,
  - ADRs and `docs/design/*.md` (this very file will never surface in memory retrieval),
  - session reports under `.xtrm/reports/` (except by manual excerpt in phase 2 of the processor).
The knowledge that _already exists in git_ is invisible to the agent memory system unless an agent bothered to `bd remember` a paraphrase.

**F8 — No decay, no age signal.** A memory written when we still had a `local-legacy` skills pack path (deprecated) is still full-weight against a fresh memory written after the migration. Only the audit's `Contradicted` decision can retire it, and only when the audit runs. There is no `updated_at`-weighted rerank.

**F9 — No audit / no ACL.** All memories are readable by any agent in the repo. No per-role scoping (`security-auditor` should probably not see everything an `executor` wrote). No PII redaction on ingestion. `bd forget` is destructive; only the backup dir under `.tmp/memory-audit/backup/` is the recovery path, and it is not versioned in git.

**F10 — No versioning beyond git.** `.xtrm/memory.md` is committed to git so history exists at file granularity. `bd` memory state changes are opaque in git (the Dolt export in `.beads/issues.jsonl` covers issues, not memories). A memory-processor run that damages the store cannot be `git-revert`-ed because there is nothing to revert to.

**F11 — Retrieval is agent-eyeballed.** Even when memory exists that would answer today's question, the retrieval loop is "agent reads `.xtrm/memory.md`, thinks _hmm, might there be a relevant memory?_, tries an exact key". There is no `bd search "<query>"` today. When the answer is in `bd` but the agent doesn't guess the key, the memory is effectively lost. This is the same failure mode Cerebras describes as _"grep is all you need"_ scepticism — and they concluded that no, semantic + lexical + freshness fusion is what makes recall usable at scale.

---

## 3. External patterns worth borrowing

Four references. All read for compatibility with the "per-repo Dolt is the SoT, we don't want a new datastore" constraint the user set.

### 3.1 Cerebras Knowledge Base (the seed)

Source: [`docs/design/knowledgebasecerebras.md`](./knowledgebasecerebras.md), archived from the Cerebras blog post *"How We Built Our Knowledge Base"* (Isaac, Daniel, Zenghao — 2026). Also see linked blog `cerebras.ai/blog/how-we-built-our-knowledge-base`.

**Architecture at a glance:**

- **One table, many sources.** At the core is a single Postgres table holding `(embedding, raw, summary, metadata, source)`. Every source (Slack thread, wiki section, code chunk, PR, netlist) lands in the same row shape. Adding a new source is a connector, not a schema.
- **Multi-source connectors** run continuously. Slack is subscribed via Socket Mode: each event resolves back to the full thread, which is re-fetched, distilled by an LLM (question / summary / resolution / systems mentioned), embedded, and written. Code uses [CocoIndex](https://github.com/cocoindex-io/cocoindex) for incremental language-aware chunking; only changed chunks re-embed on each commit.
- **Hybrid retrieval, fused at query time.** No single scorer is trusted. Every query runs BM25 + vector similarity + IDF scoring + age decay in parallel. Rankings are fused. Context expansion (adjacent chunks) happens after rerank, not before. This directly rebuts the "vector search is enough" instinct.
- **"Bursting" for Slack.** A run of consecutive messages from the same author is embedded as its own unit — because sometimes the answer lives in one tangent that never made it into the thread summary. A burst must pass three quality gates (rare-token IDF ≥ 4.0, ≥ 200 chars, at least one reaction) before it becomes an embedding.
- **MCP retrieval primitives, not one "ask" endpoint.** Cerebras exposes `search`, `search_slack`, `search_code`, `subsystem_index`, `recent_prs`, `who_knows` — each running _one_ underlying pipeline. Client agents (Claude Code, others) orchestrate the tools; the KB layer stays LLM-free and deterministic per call.
- **A separate planner** decides which tools to call, per query. A UI agent runs `planner → executor → reranker → expander`; an MCP client can wire the same primitives differently.

**Why this maps to xtrm.** The "one table + connectors" shape is exactly the escape hatch xtrm needs from three-disjoint-substrates. The "narrow MCP primitives" shape matches xtrm's existing tool posture (agents pick from `bd memories`, `gitnexus_impact`, etc.). The "hybrid retrieval fused" shape resolves F5 and F11 without abandoning the Dolt truth store — we can layer the fusion on top.

### 3.2 Letta (formerly MemGPT) — tiered agent memory

Source: DeepWiki `letta-ai/letta` — Agent Memory System (§2.3). Also see the MemGPT paper (Packer et al., 2023) and `letta/schemas/memory.py`.

**Architecture at a glance:**

- **Three tiers.** `Core memory` (labeled `Block` objects, always in the system prompt, e.g. `persona`, `human`), `Recall memory` (past messages, managed by `MessageManager`, backed by Postgres), and `Archival memory` (long-term facts, unbounded, `PassageManager`, Postgres with optional Turbopuffer dual-write).
- **Explicit tools to promote/demote items** between tiers: `core_memory_append`, `core_memory_replace`, `archival_memory_insert`, `archival_memory_search`, `conversation_search`. The agent decides what to promote; the storage layer doesn't.
- **Retrieval per tier.** Core is implicit (in prompt every step). Recall is case-insensitive string match. Archival is embedding-based with metadata filters (`tags`, `tag_match_mode`, `start_datetime`, `end_datetime`).
- **The system prompt shows tier occupancy.** `ContextWindowOverview` reports `num_archival_memory` and `num_recall_memory` so the agent knows what's outside the context window and can search for it.

**Why this maps to xtrm.** The three-tier vocabulary maps almost cleanly onto the xtrm substrates once you squint:

| Letta            | xtrm today                                                                         |
|------------------|------------------------------------------------------------------------------------|
| Core             | `.xtrm/memory.md` (target ~100–200 lines, read into every session)                 |
| Recall           | Session reports under `.xtrm/reports/*.md` (past turns, chronological)             |
| Archival         | `bd` memories (unbounded, indexed by key, semantic-retrieval-hungry)               |

The gap is the retrieval interface. Xtrm has _no_ `archival_memory_search`. It has `bd recall <exact-key>` and `bd memories` (list). Letta's schema shows the shape of the tool that xtrm is missing: **semantic search + tag/time filters** returning ranked passages, not a full dump.

The tier hierarchy also gives a natural policy for promotion: when the memory-processor synthesises `.xtrm/memory.md`, it is _promoting_ Archival → Core. When an agent writes `bd remember`, it is inserting into Archival. This is worth naming explicitly in the design.

### 3.3 mem0 — ADD-only extraction and hybrid retrieval

Source: DeepWiki `mem0ai/mem0`. Also `github.com/mem0ai/mem0`.

**Architecture at a glance:**

- **Operations:** `POST /v3/memories/add/` (async, ADD-only), `POST /v3/memories/search/` (hybrid), `POST /v3/memories/` (paginated get), `PUT /v1/memories/{id}/`, `DELETE /v1/memories/{id}/`.
- **ADD-only extraction.** New conversations get their facts extracted by an LLM (guided by `ADDITIVE_EXTRACTION_PROMPT`). New facts are _added alongside_ old ones. Nothing is overwritten during extraction. This preserves temporal context.
- **Conflict resolution at retrieval time**, not at write time. When two memories disagree, the search layer ranks them (relevance + freshness + entity boost) and the caller sees the winning one first. The loser is _still_ in the store.
- **Three stores:**
  - Vector DB: text + embeddings + metadata (primary fact storage).
  - Graph / entity store: entities and links across memories (adds entity-based retrieval boost).
  - SQL: history of `add` events, rolling message window (audit trail and dedupe context).
- **Multi-Signal Hybrid Search.** Every query is preprocessed (lemmatise keywords, extract entities), then scored in parallel by semantic + BM25 + entity-matching. Scores fuse into a single ranking. Top-K returned.

**Why this maps to xtrm.** Two lessons.

- **ADD-only** rebuts the current xtrm design instinct that the audit must _delete_ contradictions. It doesn't have to. If retrieval fuses freshness and entity signals, the old-and-wrong memory can stay, it just never wins a match. That is a much smaller, safer store to build than one that must correctly delete under transactional guarantees. (The processor's F2 was fundamentally a symptom of "we have to delete or the store rots" — mem0's answer is "you don't, if search is good enough.")
- **The audit trail (`SQL: history of add events`)** is what xtrm is missing for F10. Every `bd remember` and `bd forget` should be an event, not a mutation of the current-state table.

### 3.4 OpenWiki / OKF — structured front matter for deterministic retrieval

Source: [`docs/design/openwiki.md`](./openwiki.md) archived from LangChain's OpenWiki 0.2 announcement. Repo: `github.com/langchain-ai/openwiki`. Spec: Google Cloud's Open Knowledge Format (OKF).

**Architecture at a glance:**

- **YAML front matter on every doc.** `title`, `description`, `tags`, `categories`, `resource URLs`.
- **`index.md`** per directory summarising files and subdirectories.
- **`logs.md`** per directory acting as a per-directory changelog.
- **Enables deterministic filtered retrieval.** An agent can filter to "every doc tagged `billing`" or "every doc in category `bigquery-tables`" without invoking an LLM. Agentic search is preserved but not the only path.

**Why this maps to xtrm.** OKF is the cheapest possible upgrade to the file-based side of xtrm's memory. `.xtrm/memory.md` today has three ad-hoc sections; a Claude Code auto-memory `user_*.md` file has proto-frontmatter (`name`, `description`, `metadata.type`). Aligning both to OKF gives:

- **Deterministic retrieval** (`grep -l 'tags:.*testing' .xtrm/memory/`) even before any embedding infrastructure exists.
- **A `logs.md`** per memory directory that answers "what did the processor change last time" without diffing the raw file.
- **A single schema** for the file-backed substrate that Claude Code and Beads-installed hooks can both write against.

This is the smallest external pattern to adopt and has the highest one-week ROI.

### 3.5 Patterns considered and dropped

- **CocoIndex** (Cerebras uses it for repo embeddings): out of scope. xtrm code-context already goes through GitNexus (`gitnexus_query`, `gitnexus_context`, `gitnexus_impact`), which is our incumbent. A memory system does not need to embed code; it needs to embed _insights about_ the code.
- **LangGraph LangMem / LangMem SDK**: broadly overlaps with mem0 and Letta; not additive enough for the design budget here. Cite as further reading.
- **Zep / Graphiti (getzep/graphiti)**: temporal knowledge graph — interesting for F4/F8 (cross-repo + decay), but adds a graph store dependency the operator explicitly discouraged. Revisit only if F4 becomes a top-3 pain point.

---

## 4. Proposed evolution — the vision, not the implementation

Framing: **do not** replace `bd`. Do not introduce Postgres. Do not deploy a service. **Layer** a retrieval and ingestion surface on top of what already exists, in the smallest steps that preserve the truth store.

### 4.1 Storage layer

**Keep `bd` (Dolt) as the raw truth store, per-repo.** It is transactional, git-adjacent, and already the write path for every memory-writing hook and specialist. Nothing in this document justifies replacing it.

**Add a per-repo derived index.** SQLite (already a transitive dependency of every JS runtime we ship with) with an FTS5 virtual table gives us BM25 and full-text search **without a new service**. Location: `.beads/memory-index.sqlite`, generated from `bd memories --json`. This index is derived, so it can be dropped and rebuilt at will and does not need to be committed.

**Optionally, a per-repo embeddings sidecar** at `.beads/memory-embeddings.sqlite` using [sqlite-vss](https://github.com/asg017/sqlite-vss) or [sqlite-vec](https://github.com/asg017/sqlite-vec) — same shape, semantic search. **Deferred until §5 PR 6** and gated on operator greenlight; not a P0.

**No cross-repo store yet.** F4 (cross-repo isolation) is real but is a v2 problem, and it needs an operator-level design decision the research worker cannot make. When it lands, the shape should be: an opt-in `~/.xtrm/memory-hub/` per-user store that aggregates read-only projections from each repo's `.beads/memory-index.sqlite` (not a write path). Do not commit to this in the ship-in-order.

### 4.2 Schema — the "one table, many sources" table

Whether the physical store is Dolt, SQLite, or (future) Postgres, the **row shape** should converge on one schema aligned with Cerebras KB:

```
memory_item {
  id            :: content-hash                        # stable, deterministic
  raw           :: text                                # the original bd remember content
  summary       :: text                                # optional distilled form (LLM-produced)
  source        :: enum {bd, pr, release, adr, report, hook, user}
  kind          :: enum {feedback, project, user, reference, howto, do-not-repeat}
  tags          :: text[]                              # freeform (retrieval filter)
  entities      :: text[]                              # extracted: repo/file/symbol/service names
  created_at    :: timestamp
  updated_at    :: timestamp
  provenance    :: json                                # {url, commit, session_id, bead_id, ...}
  content_hash  :: sha256(raw)                         # what W5 already tracks for the prune guard
  embedding     :: vector(384) or NULL                 # optional; deferred
}
```

**`kind`** mirrors Claude Code auto-memory's `metadata.type` (`user`, `feedback`, `project`, `reference`) + two xtrm-shaped additions (`howto`, `do-not-repeat`) that the current `.xtrm/memory.md` already uses as section headers. That is: **the schema is a superset of both existing typed memory systems**, so an agent can write against one and satisfy both.

**`source`** is the connector identity — every ingested item can be traced back to its origin. Cerebras' "one table many sources" principle.

**`entities`** is what mem0 uses for the entity-boost signal at retrieval. Populated by a cheap extractor (regex + known symbol registry from GitNexus's clusters). No LLM needed at ingestion time.

### 4.3 Retrieval interface

Expose retrieval as **narrow tools**, one pipeline per tool, following Cerebras' MCP posture:

- `bd search <query>` — hybrid BM25 + (optional) vector, tag/kind/source filters, time filter, top-K. This is the single new CLI verb.
- `bd recall <key>` — unchanged, still exact-key.
- `bd memories --kind feedback --tag testing` — deterministic filtered retrieval (OKF pattern) — no LLM needed.
- MCP tool `memory_search(query, filters, k)` — same as `bd search`, exposed to Claude Code / Pi as an MCP call.
- MCP tool `memory_get(id_or_key)` — exact fetch.
- MCP tool `memory_add(text, kind, tags, source)` — thin wrapper over `bd remember` that also populates `kind`, `tags`, `source` — resolves F6 (schema drift between substrates) at the write boundary.

**Ranking policy (Cerebras-inspired):**
- BM25 term match (catches literal error strings, flag names, keys).
- Vector similarity (catches paraphrase — only when the sidecar is enabled).
- Entity match boost (mem0-inspired — a query mentioning `beads-memory-gate.mjs` boosts memories tagged with that entity).
- Age decay (F8 — half-life default 90 days, override per `kind`).
- No LLM in the ranker. Reranker is a candidate for a later step.

**Explicit non-goal:** no "answer" endpoint. The retrieval layer returns evidence; the agent decides.

### 4.4 Ingestion — where memory comes from

The current pipeline is 100% agent-triggered. F7 says most of the useful knowledge is already in git and never gets ingested. Fix that with **connectors** — small, boring jobs, one per source. Each connector reads its source, extracts distinct items, and calls `memory_add(..., source=<name>)`.

Priority order (cheapest / highest yield first):

1. **`bd` connector** — trivial: agent-authored memories are already in `bd`, we just need to also populate `kind` / `tags` / `source=bd` on write. Backfill for existing rows via a one-off pass in the audit-transaction skill.
2. **`report` connector** — parse `.xtrm/reports/*.md`, extract the four high-signal sections (`Summary`, `Problems Encountered`, `Memories Saved`, `Suggested Next Priority`), ingest each as a memory item with `source=report`, `provenance.report_path=<path>`.
3. **`pr` connector** — for each merged PR, extract title + body + reviewer comments (`gh pr view <n> --json`) and ingest as `source=pr`. Cerebras does this for Slack; xtrm's Slack is GitHub PR discussion. **This is where the W5 "landed-work anchor" idea earns its keep** — the memory-processor's evidence anchor becomes a first-class connector, not a one-off pre-script.
4. **`release` connector** — `gh release list --json` + `gh api /repos/<owner>/<repo>/releases`. Every release note is a memory item with `source=release`, tagged with the semver.
5. **`adr` / `design` connector** — every `docs/design/*.md` and any file matching `docs/adr-*.md` becomes a memory item. Frontmatter (OKF, §3.4) provides the tags; the connector just walks the tree.
6. **`hook` connector (later)** — log every hook block/allow decision into the memory store so future sessions can retrieve "why did commit gate block me last week?" without opening the hook source.

Connectors are **stateless jobs**, not services. They run:
- On demand (`xt memory ingest --source pr`).
- Weekly, if the operator opts in to a cron/GH-Actions workflow.
- After a release (in the release skill).

### 4.5 Auth, audit, privacy (F9)

**Per-repo isolation** stays the default. A memory written in `xtmux` is invisible to `core` sessions until an operator explicitly opts into cross-repo aggregation (§4.1).

**Kind-scoped ACL.** Optional (defer to v2): specialists that don't need `feedback` about the user (e.g. a `security-auditor`) can be spawned with `--memory-kind=project,reference` — the retrieval layer filters at query time. This is analogous to Cerebras' user auth+audit layer, scaled down.

**Redaction on ingestion.** Non-negotiable at v2: strip obvious secrets (via `gitleaks` regex packs — already installed via the `security-pipeline` skill) before storing. Store the hash + redaction marker; never store secrets in memory.

**Audit trail = event log (mem0 pattern).** Every `memory_add`, `memory_update`, `memory_forget` becomes a row in `.beads/memory-events.jsonl` (append-only, git-committable). Restore path for F10: `bd memory replay --until <ts>` reconstructs a prior state from the event log. This is small, boring, and eliminates the "audit run corrupts the store, no way back" failure.

### 4.6 Tier promotion policy (Letta-inspired)

Explicit vocabulary for what the memory-processor is _actually doing_:

- **Archival** — every row in `bd` / SQLite index. Unbounded. Retrieved on demand via `memory_search`.
- **Recall** — the last N session reports (`.xtrm/reports/*.md`), the ADR set, the merged-PR set for the current sprint. Bounded, chronological, but larger than what fits in prompt.
- **Core** — `.xtrm/memory.md`. Always in prompt. Target ≤ 200 lines. Written **only** by the memory-processor (promotion Archival → Core).

The processor's job clarifies: **it is not a delete tool; it is a promotion tool.** It picks Archival rows that survive the classifier and rewrites Core. Deletion (`bd forget`) becomes a rare, evidence-heavy, opt-in operation with the W5 safeguards — it does not need to run every session. Retrieval fusion (§4.3) resolves conflicts at query time even if stale rows are still in Archival, per mem0.

This reframing directly addresses F2 (silent forgets): if the processor doesn't need to prune to keep the system healthy, most of the risk of silent-loss goes away.

### 4.7 What this system looks like from the agent's seat

A fresh session in `core` starts:

1. `beads-compact-restore` re-establishes in_progress issues (unchanged).
2. `.xtrm/memory.md` (Core, OKF-fronted) is auto-read.
3. The agent's system prompt lists the memory MCP tools: `memory_search`, `memory_get`, `memory_add`.
4. The agent works. When it needs recall, it calls `memory_search("commit gate blocking on empty diff", kind=do-not-repeat)`. Ranked evidence returns. It uses one item.
5. When it discovers something durable, it calls `memory_add("<insight>", kind=feedback, tags=[...])` — this hits `bd remember` under the hood and populates the row shape.
6. At Stop, `beads-memory-gate` is unchanged (it still enforces "you must have written something"), but now has evidence — it can also check that `memory_add` populated `kind`/`source` so gate satisfaction has substance beyond a keystroke.
7. Weekly, on the release cycle, connectors ingest PR bodies / releases / new design docs. Nothing agent-driven.
8. Monthly, the operator invokes `memory-processor`, which now runs against a healthy typed store, promotes Archival to Core, and updates `.xtrm/memory.md` (with an OKF `logs.md` sibling).

None of this requires a service, a new datastore, or a new dependency beyond `sqlite-vss` (deferred).

---

## 5. Ship-in-order — the smallest thing that proves the pattern

Ponytail: two rungs of the ladder before code. Two of the four external patterns land _without_ any new binary. The others gate on operator greenlight.

### PR 1 — Structured metadata on `bd remember` (no new deps)

- Add `--kind`, `--tags`, `--source` optional flags to `bd remember`. Store as JSON side-channel or extra columns on the existing Dolt table.
- Existing calls keep working (defaults to `kind=project`, `source=agent`, `tags=[]`).
- Extend `bd memories --json` to emit those fields.
- Update the `beads-memory-gate` hook so the failure message tells agents to pass `--kind` and `--tags`.
- **Deliverable:** every _new_ memory has typed metadata. Existing rows are untyped until the audit backfill in PR 3.
- Effort: ~1 day in `bd`.

**Why first:** every downstream step (deterministic filter, OKF, retrieval, connectors) needs types. Nothing else can start without this.

### PR 2 — OKF front matter on `.xtrm/memory.md` (no new deps, no code)

- The `memory-audit-transaction` skill's Phase 8 template already produces three sections. Add YAML frontmatter above them:
  ```
  ---
  title: "Project Memory — <repo>"
  description: "Synthesized durable memory for this repo."
  tags: [xtrm, memory]
  categories: [project-memory]
  updated: <YYYY-MM-DD>
  memory_count: {current, pruned, skipped}
  ---
  ```
- Emit a sibling `.xtrm/memory-log.md` (OKF's `logs.md`) — one line per run: date, counts, artefact path.
- Consumers (Claude Code auto-memory / Pi) can now filter, and diffing the log tells operators what changed at a glance.
- Effort: ~2 hours in the specialists repo.

**Why second:** proves the OKF pattern on the file-backed substrate at zero cost. Immediately mitigates F10 (versioning) and F6 (schema drift) at the file boundary.

### PR 3 — `bd search "<query>"` over SQLite FTS5 (no new external service)

- On each `bd remember` and `bd forget`, sync the row into `.beads/memory-index.sqlite` (FTS5 virtual table).
- `bd search <query> [--kind ...] [--tag ...] [--limit N]` runs the BM25 query, applies filters, returns ranked rows.
- Index is derived; regenerate from `bd memories --json` if `.beads/memory-index.sqlite` is missing or stale.
- Backfill: on first run, populate the index from all existing rows.
- Effort: ~3 days in `bd`. SQLite is already a transitive dependency of the Node runtime used by hooks.

**Why third:** solves F5 and F11 for the 80% case _without_ embeddings. If BM25 + tag filter answers most retrieval needs (Cerebras admits it does for exact-token queries), the vector sidecar can wait.

### PR 4 — MCP `memory_*` tools (thin wrapper)

- `memory_search`, `memory_get`, `memory_add` MCP tools, thin wrappers over `bd search` / `bd recall` / `bd remember --kind ... --tags ...`.
- Register in the xtrm MCP config so Claude Code and Pi see them.
- Effort: ~1 day in the mcp-server-dev skill.

**Why fourth:** narrow, LLM-free tools per Cerebras' MCP philosophy. The agent-side integration is one config change.

### PR 5 — First connectors: `report` and `release`

- `xt memory ingest --source report` walks `.xtrm/reports/*.md`, extracts four sections per report, calls `memory_add` per section with `source=report`, `provenance.report_path=<path>`.
- `xt memory ingest --source release` walks `gh release list --json`, one memory per release, tagged with semver.
- Run once, then weekly via a `.github/workflows/memory-ingest.yml`.
- Effort: ~2 days in the CLI.

**Why fifth:** the first evidence that "the knowledge already in git can flow into memory automatically". Foundation for later `pr` / `adr` / `hook` connectors.

### Gated on operator greenlight

- **PR 6 — sqlite-vec sidecar + embeddings.** New (small) dependency. Only useful when BM25 misses paraphrase. Ship only if PR 3 telemetry shows unsatisfied searches (`bd search` returning 0 rows on non-trivial queries).
- **PR 7 — `pr` connector, `adr` connector, `hook` connector.** Follow the same shape as PR 5 once its cadence is proven.
- **PR 8 — cross-repo aggregation (`~/.xtrm/memory-hub/`).** Big design decision. Do not touch until F4 is loudest complaint from the operator.
- **PR 9 — event log + `bd memory replay`.** Solves F10. Cheap to build (append `.beads/memory-events.jsonl` on every mutation), but the restore path is design-heavy and should not ship without operator sign-off.

### What is _not_ on this list

- No Postgres.
- No Turbopuffer / no external vector service.
- No new specialist role. `memory-processor` stays as is; the W5 correctness PRs fix it.
- No LLM in the retrieval hot path.
- No agent-visible tier vocabulary (`core / recall / archival`) until the OKF frontmatter + `bd search` land. Vocabulary without a retrieval interface is just paperwork.

---

## 6. Open questions for the operator

Answers change the ship-in-order.

1. **Cross-repo aggregation** — is F4 (isolation) a real pain, or acceptable for another 6 months? If real, PR 8 jumps up.
2. **Embedding budget** — if `sqlite-vec` + a local model (e.g. `bge-small`, ~100 MB, CPU-inference) is on the table, PR 6 can land alongside PR 3. If not, defer.
3. **Ingestion of Slack / meeting notes** — Cerebras' single most valuable connector was Slack. Xtrm has no Slack equivalent for design conversation (most of it lives in Claude Code sessions). Is that gap worth a `session-transcript` connector, or does the `report` connector cover it?
4. **Delete or don't** — if we adopt mem0's "conflict-resolve at query time, never delete" stance, do we _still_ want the audit-transaction pruner to delete? The W5 safeguards make it safe, but §4.6 argues it may not be _necessary_.
5. **Claude Code auto-memory** — should it be _folded into_ the `bd` store (writes go through `memory_add`, MCP tool exposes it) or left as a parallel substrate? Folding kills F6 but requires per-file → row migration.

---

## 7. Cross-refs

- **W5 immediate safety fixes:** `/tmp/w5-memory-proposal-20260717-012000Z.md`, `/tmp/w5-memory-diagnosis-20260717-012000Z.md`. Independent and complementary. Ship regardless of this design.
- **Cerebras seed:** [`docs/design/knowledgebasecerebras.md`](./knowledgebasecerebras.md).
- **OKF retrieval pattern:** [`docs/design/openwiki.md`](./openwiki.md).
- **Agent-native issue contracts (adjacent, non-blocking):** [`docs/design/issuetracking.md`](./issuetracking.md). The "Dispatchable Issue Contract" shape (`PROBLEM / SCOPE / NON-GOALS / ACCEPTANCE / VALIDATION / RISK / …`) is a natural memory schema too — see if the `bd` `kind` values want to align.
- **Letta / MemGPT:** `github.com/letta-ai/letta`, MemGPT paper (Packer et al., 2023).
- **mem0:** `github.com/mem0ai/mem0`. `docs.mem0.ai` for the platform API.
- **OpenWiki 0.2:** `github.com/langchain-ai/openwiki`. OKF spec: Google Cloud open-source docs.
- **CocoIndex (deferred):** `github.com/cocoindex-io/cocoindex`.
- **sqlite-vec (deferred):** `github.com/asg017/sqlite-vec`.

---

## 8. Appendix — files cited in current-state inventory

Absolute paths measured `2026-07-17`. Repo-relative paths in parentheses.

- `~/.xtrm/hooks/beads-memory-gate.mjs` — Stop hook, memory-ack gate.
- `~/.xtrm/hooks/beads-compact-save.mjs` — PreCompact snapshot of in_progress bd IDs.
- `~/.xtrm/hooks/beads-compact-restore.mjs` — SessionStart restore of the same.
- `~/.xtrm/hooks/specialists/specialists-memory-cache-sync.mjs` — PostToolUse cache sync.
- `~/dev/specialists/config/specialists/memory-processor.specialist.json` — the memory-processor specialist definition, v1.1.0.
- `~/dev/specialists/config/skills/memory-audit-transaction/SKILL.md` — the 9-phase chunked-ledger workflow.
- `~/dev/specialists/config/skills/memory-audit-transaction/scripts/pre-bulk-export.sh` — the bulk-export pre-script (single `bd memories --json` call).
- `.xtrm/memory.md` in each managed repo — synthesized Core memory (missing in `specialists` and `xtmux` as of measurement date).
- `.tmp/memory-audit/` in each managed repo — processor artefact tree (transient).
- `~/.claude/projects/<slug>/memory/MEMORY.md` — Claude Code auto-memory index (per-project slug).
- `.xtrm/reports/*.md` — session reports, Phase 2 input to the processor.

---

_End of research doc. This is a design; nothing in it is committed as an implementation plan. §5 is what to build first if any of it is greenlit._
