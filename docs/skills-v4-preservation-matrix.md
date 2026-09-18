# Skills v4 preservation matrix

Status: normative migration evidence for the skills-v4 consolidation.

A removed v3 top-level skill is acceptable only when this table records one of four
dispositions:

- **absorbed** — its durable reasoning/contract now lives in a named v4 skill/reference;
- **moved** — the capability remains as a distinct optional skill or external XTRM subsystem;
- **runtime-owned** — deterministic runtime/CLI/hook machinery now owns the invariant;
- **retired** — the behavior was redundant, stale, malformed, or intentionally unsupported.

“Removed from default” is not itself a disposition. Concrete scripts/templates/schemas are
preserved when they remain useful even if the old prompt/manual is rewritten.

| Former skill/surface | Disposition | Successor / current owner | Preservation note |
|---|---|---|---|
| `using-xtrm` | retained default | `default/using-xtrm` | Core system doctrine. |
| `planning` | retained default | `default/planning` | Contract/planning router; board triage, premortem and test strategy are references. |
| `test-planning` | absorbed | `planning/references/test-strategy.md` | Test-plan reasoning is part of contract planning rather than a second trigger. |
| `premortem` | absorbed | `planning/references/premortem.md` | Risk discovery remains available on demand. |
| `issue-triage` reasoning | absorbed | `planning/references/board-triage.md` | Board classification/rewiring belongs to planning. |
| `issue-triage/resources/board-audit` | moved | `xtrm/packages/board-audit` | Old one-shot bundle exporter retired. Gen-2 publication uses permanent orphan `board-audit-export-do-not-cancel`; Beads/Dolt remains authority. |
| `delegating` | absorbed | `multiplexing`, `using-specialists`, `planning` | Delegation is selected by execution shape and contract, not a separate generic router. |
| `multiplexing-team` | absorbed | `multiplexing/references/*` | Team/worker/message/continuation doctrine unified under one coordination skill. |
| `multiplexing-native-test` | absorbed | `multiplexing/references/*` | Proven native-transport doctrine promoted to first-class; experiment duplicate retired. |
| `spec-dispatch` | absorbed | `planning` + `multiplexing`/`using-specialists` | Spec becomes durable contracts first; execution backend is then selected. |
| `init-session` | absorbed/runtime-owned | `/using-xtrm` continuity (was `starting-and-resuming-work`, folded CORE-2304) + runtime hooks/CLI | Cold-start/claim/continuity mechanics are no longer a separate prompt. |
| `session-close-report` | absorbed/runtime-owned | `/using-xtrm` continuity (was `starting-and-resuming-work`, folded CORE-2304), `xtrm-maintenance` | Durable handoff/finalization replaces a separate report trigger. |
| `xt-end` | absorbed | `xtrm-maintenance/references/finalize.md` + current repo workflow | Session finalization is maintenance/continuity behavior. |
| `xt-merge` skill | runtime-owned / retired duplicate prompt | Core `xt merge` CLI + Specialists `config/specialists/xt-merge.specialist.json` | The CLI performs authority/preflight checks and dispatches the canonical `xt-merge` Specialist. No managed skill root is required. |
| `xt-debugging` | absorbed | `engineering-quality` + `gitnexus` | Causal debugging and code-graph tracing are composed directly. |
| `clean-code` | absorbed | `engineering-quality/references/reduction.md` | Coding/reduction discipline remains part of ordinary engineering quality. |
| `code-review` | absorbed | `engineering-quality/references/review.md` | Review evidence is a default engineering phase. |
| `pr-reviewer` | absorbed | `engineering-quality/references/review.md` + project review gates | No separate generic PR-review trigger. |
| `using-tdd` | absorbed | `engineering-quality/references/testing.md` | TDD is one test-strategy mode, not universal routing. |
| `using-quality-gates` | runtime-owned | quality hooks/CI + `engineering-quality` | Deterministic checks stay in runtime; judgment stays in skill. |
| malformed `quality-gates` bundle | retired/runtime-owned | `.xtrm/hooks/quality-check*`, CI | Nested `.claude` skill/config payload was not a valid managed skill root. |
| optional `code-quality/*` pack | absorbed | `engineering-quality` | Systematic debugging/review/verification overlap with default engineering discipline; duplicate pack retired. |
| `gitnexus-cli` | absorbed | `gitnexus/references/cli.md` | CLI details are progressive disclosure. |
| `gitnexus-debugging` | absorbed | `gitnexus/references/debugging.md` | Code-graph debugging reference. |
| `gitnexus-exploring` | absorbed | `gitnexus/references/exploring.md` | Exploration reference. |
| `gitnexus-guide` | absorbed | `gitnexus` root + refs | Generic guide folded into router. |
| `gitnexus-impact-analysis` | absorbed | `gitnexus/references/impact-and-refactoring.md` | Blast-radius workflow preserved. |
| `gitnexus-pr-review` | absorbed | `gitnexus/references/pr-review.md` | Graph-assisted review preserved. |
| `gitnexus-refactoring` | absorbed | `gitnexus/references/impact-and-refactoring.md` | Refactor analysis preserved. |
| `using-specialists` | retained default | Specialists-owned `using-specialists` | Core vendors reviewed runtime payload from pinned Specialists commit. |
| `using-kpi` | absorbed | `using-specialists/references/kpi.md` | Specialized surface of the same execution backend. |
| `using-nodes` | absorbed | `using-specialists/references/nodes.md` | NodeSupervisor stays available without a separate active trigger. |
| `using-script-specialists` | absorbed | `using-specialists/references/script-class.md` | `sp script`/`sp serve` guidance preserved. |
| `specialists-creator` | absorbed + assets preserved | `using-specialists/references/specialist-definitions.md` + `scripts/specialist-definitions/*` | Schema-driven scaffold/validate/audit helpers preserved. |
| `using-specialists-auto` | retired | normal XTRM routing | Automatic duplicate routing surface removed intentionally. |
| `update-specialists` | moved | `optional/xtrm-maintenance/update-specialists` | Distinct maintainer workflow remains opt-in and Specialists-owned. |
| `sre-triage` | moved/absorbed | `optional/sre-ops/sre-ops` | Live causal SRE workflow; historical alert scripts preserved. |
| `deploy-monitor` | absorbed | `sre-ops/references/deploy-monitoring.md` | Deploy verification is one SRE incident/change mode. |
| `capacity-reclaim` | absorbed | `sre-ops/references/capacity.md` | Capacity/host-pressure workflow remains available. |
| old runbook-update behavior | moved | `xtrm/packages/service-knowledge` + `/updating-service-knowledge` | Service-specific `Deploy & Runbook`, health, failure-mode and data-flow freshness remains service-knowledge-owned. |
| direct Grafana/Prom/OTel MCP schema loading | retired pattern | `sre-ops` via `mcpq` | `mcpq servers -> list-tools -> describe -> call` is preferred targeted observability access. |
| `security-auditor` | absorbed | `optional/security-ops/security-ops` | Security investigation/review unified under domain pack. |
| `security-pipeline` | moved + assets preserved | `optional/security-ops/security-bootstrap` | Bootstrap scripts/templates retained; stale external-plan/tool-version assumptions removed. |
| `updating-dependencies` | moved + assets preserved | `optional/xtrm-maintenance/updating-dependencies` | Case schemas, dossier and PR/watch templates preserved. |
| `releasing` | moved + script assets preserved | `optional/xtrm-maintenance/releasing` | Distinct release state transition remains opt-in; root now resolves live repo gates. |
| `sync-docs` | moved + assets preserved | `optional/xtrm-maintenance/sync-docs` | Single-doc invariant, drift/metadata/structure helpers and refs preserved without stale hidden rule dependency. |
| `agent-docs-maintainer` | absorbed + helper preserved | `xtrm-maintenance` agent-doc audit helper | Agent-doc maintenance is one maintenance mode, not default. |
| `update-xt` | absorbed/runtime-owned | `xtrm-maintenance` + current `xt update` CLI | Update mechanics belong to current CLI; maintenance skill routes operator work. |
| `hook-development` | moved + helper scripts preserved | `optional/xtrm-development/hook-development` | Rewritten around `policies/*.json -> compile-policies -> .xtrm/config/hooks.json` and Claude/Pi parity. |
| `authoring-workflows` | absorbed | `xtrm-development/references/workflows.md` | Generic XTRM workflow machinery is a development reference; runtime primitives are preferred. |
| `prompt-improving` | absorbed/retired stale detail | `optional/architecture-design/prompt-engineering-patterns` | Durable prompt-design patterns remain; stale provider-specific manuals are not default. |
| `deepwiki` | absorbed | `optional/research-methods/research/references/documentation.md` | Documentation-source routing belongs to research. |
| `find-docs` | absorbed | `research-methods/research` | Cross-source documentation discovery is a research mode. |
| `github-search` | absorbed | `research-methods/research/references/code-search.md` + live GitHub tools | No extra default trigger for one search provider. |
| `last30days` root/manual | absorbed | `research-methods/research/references/recent-web.md` | Recent-web research remains available. |
| `last30days` large provider/cookie/vendor implementation | retired | current web/connector/plugin research surfaces | Old embedded scraping/provider stack is not shipped as XTRM runtime machinery. |
| `academic-researcher`, `deep-research`, `fact-checker` | absorbed | `optional/research-methods/research` refs | One research router with task-specific references. |
| `brainstorming` visual/server bundle | retired/moved out of runtime | architecture/research workflows as needed | Large local visual companion server is not a baseline skill capability. |
| `vaultctl` | moved | `optional/personal-tools/vaultctl` | Personal tool remains opt-in. |

## Review rule

Any future deletion of a managed skill root must update this matrix or its successor with
the same preservation analysis. A PR that removes a skill without a successor/retirement
record is incomplete even if package/registry tests pass.

For migrated concrete assets, tests should validate the new shipped path rather than
requiring the historical path to remain.
