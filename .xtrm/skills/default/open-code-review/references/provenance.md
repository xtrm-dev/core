# Provenance — open-code-review skill pack

- Source: `alibaba/open-code-review`, `plugins/open-code-review/skills/` (SKILL.md +
  DELEGATE.md, skill version 1.0.0), upstream HEAD `4a3844c42fe0` at fetch 2026-10-13.
  Local layout: `SKILL.md` root, delegation contract at `references/delegate.md`,
  usage/arguments/gotchas at `references/usage.md`, this record at `references/provenance.md`
  (vendored content unmodified; sections relocated into `references/` to satisfy the
  universal skill-root budget).
- License: Apache-2.0 (repo LICENSE + skill frontmatter). Compatible with XTRM use.
- Re-check 2026-10-14: both upstream skill files unchanged since `25af21ce37af`
  (2026-10-10); vendored text still identical. Local addition: the marked
  "XTRM local additions" section at the end of `references/usage.md`.
- Upstream files vendored unmodified. Local wiring (not upstream): `ocr` CLI installed
  globally (v1.12.13 at vendoring; v1.13.0 since 2026-10-13); durable provider `shimgo` → localhost shim → opencode.ai subscription
  (`openai-responses`, model `muse-spark-1.3-contributor`); systemd unit `ocr-zen-shim`.
- Audit 2026-10-13 (find-skills): no overlap with existing XTRM skills (reviewer exists
  as runtime role, not skill); no bundled scripts/assets; network use = configured LLM
  endpoint only; credentials via local ocr config, never in the pack. Verified live:
  delegation preview/rule with no credentials; full JSON reviews of XTRM-612 fix (2
  findings) and market-data PR #958 (1 high true positive, code-verified).
- Deltas from upstream guidance: none in workflow; local default adds file-sized token
  budgets (`--max-tokens-budget` sized by file, `--max-tokens` per-group ceiling) and
  always passing `--background` context. `.md` files are excluded upstream
  (`unsupported_ext`); MCP-server shape unverified in v1.12.13 — CLI only.
