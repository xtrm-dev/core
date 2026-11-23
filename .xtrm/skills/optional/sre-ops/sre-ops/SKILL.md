---
name: sre-ops
description: >
  Operational/SRE stack for live service health, incident triage, causal production
  debugging, observability-driven diagnosis, deploy verification, capacity/resource
  pressure, rollback evidence, and service-specific routing. Use when an alert fires, a
  service is unhealthy, a deployment may have regressed behavior, resource pressure
  appears, or an operator asks what changed and why production broke. Prefer the `mcpq`
  CLI for compact, on-demand access to Grafana/Prometheus/OpenTelemetry MCP surfaces
  instead of loading their tool schemas and context into every agent by default.
---

# SRE Ops

SRE investigation starts from the live failure window and reconstructs causality across
runtime and source history.

```text
alert / user-visible symptom
  -> first bad metric/trace/request/job
  -> affected service/dependency path
  -> deployment/release present at first bad time
  -> commits introduced by that deployment
  -> PR / Bead / XTRM worker that produced the change
  -> why the change was made
  -> mechanism connecting change/state to symptom
  -> remediation + rollback + post-change proof
```

Do not stop at “container is unhealthy,” “latency increased,” or “this commit is recent.”
The investigation should explain how the evidence fits together.

## Route by incident shape

| Need | Read |
|---|---|
| Current health / alert / unknown outage | `references/triage.md` |
| Reconstruct runtime -> deploy -> source/work provenance | `references/causal-tracing.md` |
| A merge/redeploy needs a monitored verification window | `references/deploy-monitoring.md` |
| CPU, memory, disk, runner or machine pressure | `references/capacity.md` |
| Multi-surface incident and evidence synthesis | `references/incident-response.md` |

The bundled `scripts/` directory contains deterministic historical-alert helpers retained
from the previous SRE triage skill. Execute them when the reference calls for them; do not
load script source unless debugging the helper itself.

## `mcpq` is the default observability access path

XTRM environments can expose large MCP surfaces for Grafana, Prometheus, Tempo/OpenTelemetry
and related systems. Do not inject those complete MCP schemas into every SRE agent by
default. Prefer `mcpq`: it discovers configured sidecars and invokes only the tool needed
for the current evidence question.

Start with discovery:

```bash
mcpq servers
mcpq prometheus list-tools
mcpq grafana list-tools
```

Then inspect only the selected tool and invoke it:

```bash
mcpq prometheus describe <tool>
mcpq prometheus call <tool> --arg query='<promql>' --json

mcpq grafana describe <tool>
mcpq grafana call <tool> ... --json
```

Use the same `list-tools -> describe -> call` pattern for configured tracing/OpenTelemetry
servers. Server names and tool prefixes are project configuration, normally discovered
from `.mcpq.json`/`mcpq servers`; never freeze Mercury- or repo-specific prefixes in this
generic skill.

This is a context-budget rule as well as an operator convenience:

```text
agent needs one observability fact
  -> mcpq discovers server/tool
  -> describe only that tool if needed
  -> call it
  -> retain compact evidence/result

not:
agent starts
  -> preload Grafana + Prometheus + OTel MCP schemas and unrelated tools
```

If `mcpq` is unavailable, use a native/read-only observability surface when available.
Only fall back to cached health/runbook files after live query surfaces fail, and mark the
result `UNKNOWN` when required live evidence cannot be obtained.

## Observability is an evidence system

When the project provides Prometheus, Grafana, Tempo/OpenTelemetry, logs, profiles and
direct health signals, use them together rather than treating one green query as proof.

- **Prometheus**: alerts, availability, error/latency/throughput/freshness/saturation and
  relevant before/after time series.
- **Grafana**: discover and inspect the service/stack dashboards and their relevant panels,
  variables and time ranges. Query the underlying panel data when possible; do not reduce
  Grafana to a screenshot or a single headline number.
- **Tempo / tracing**: search the affected time window and services, follow representative
  traces across service boundaries, inspect error spans/status/duration and compare bad
  traces with known-good traces. Use trace-to-logs/metrics/profiles and exemplars when the
  stack exposes them.
- **Service topology**: prefer live trace-derived service/dependency graphs when available;
  an alerting downstream service is not automatically the root cause.
- **Logs**: correlate using timestamps, request/trace/correlation IDs and first occurrence.
- **Change intelligence**: align deploys, config/feature-flag changes, dependency/schema
  changes and manual interventions with the same incident timeline.
- **Deployment/source history**: identify the artifact/revision and the work that created
  it.

## Service knowledge and runbook freshness

Operational knowledge is owned by XTRM `service-knowledge`, not duplicated into this
skill. When a repository has service knowledge, use its current service skill/runbook for
service-specific diagnostics and remediation. Before reading service source, call
`knowledge_evidence_for_files`; before grep, call `knowledge_search`; use
`knowledge_status` when stale and `knowledge_drift` after recent changes. If the tools are
unavailable, use the CLI fallback below.

Check freshness when the incident depends on service-specific assumptions:

```bash
service-knowledge status
service-knowledge drift
```

Drift is advisory, not a reason to block an incident investigation. Continue with live
observability plus commit history, then reconcile through `/updating-service-knowledge`.
A successful reconcile updates service knowledge including `Failure Modes`, `Data Flows`,
`Cross-Service Health Check`, and `Deploy & Runbook`; clear the drift marker/rebuild the
index only after that reconcile succeeds.

## SRE invariants

1. Live runtime evidence beats cached documentation.
2. Use `mcpq` for targeted observability access when configured; avoid eager MCP schema
   loading that adds unrelated context to the agent.
3. A recent change is a suspect only after timing/path evidence connects it to the failure.
4. Diagnose before mutating production; read-only evidence collection is the first phase.
5. Query relevant Grafana dashboards fully when they exist, alongside raw metrics/traces.
6. Route affected services to current service knowledge/specialists when available.
7. Missing required observability is `UNKNOWN`/`BLOCKED`, never healthy.
8. A deploy monitor proves the intended artifact is actually running before judging it.
9. The first abnormal deploy-window sample is actionable; do not hide it in an average.
10. Operational changes require explicit ownership, rollback, and post-change evidence.
11. Record the root cause including deploy/commit/work-contract provenance, not only the
    immediate technical symptom.

## XTRM integration

Use `/engineering-quality` for the general causal-debugging method and source-level
regression discipline. Use `/using-xtrm` contracts for remediation handed to another
worker, `/multiplexing` for a coordinated incident team, and `/using-specialists` when a
bounded SRE/observability/change-forensics specialist is appropriate.

SRE Ops stays an optional pack because it is a production-operations domain capability,
not because it is low value. Infrastructure-heavy environments such as Mercury should
enable it globally or per project with `xt skills`.