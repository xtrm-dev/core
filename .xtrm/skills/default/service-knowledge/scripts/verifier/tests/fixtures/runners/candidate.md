---
service_id: runners
name: Runners
territory:
  - source/**
---

# Runners

## Service Overview

The CI runner fleet executes pipeline jobs.

## Architecture

The `runner-exporter` service exposes runner metrics.

## CRITICAL REQUIREMENTS

[PENDING RESEARCH]

## Data Flows

The `runner_jobs_total` metric carries labels `queue` and `result`.

## Database Interactions

[PENDING RESEARCH]

## Cross-Service Health Check

[PENDING RESEARCH]

## Common Operations

[PENDING RESEARCH]

## Failure Modes

[PENDING RESEARCH]

## Deploy & Runbook

The `RUNNER_TOKEN` environment variable is set to `FAKE_TOKEN`.

<!-- SEMANTIC_START -->
## Semantic Deep Dive (Human/Agent Refined)

Curatorial notes preserved verbatim across regeneration.
<!-- SEMANTIC_END -->

## Scripts

[PENDING RESEARCH]

## References

[PENDING RESEARCH]
