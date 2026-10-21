---
service_id: api-gateway
name: API Gateway
territory:
  - source/**
---

# API Gateway

## Service Overview

The api-gateway proxies inbound HTTP requests to upstream services.

## Architecture

[PENDING RESEARCH]

## CRITICAL REQUIREMENTS

The complete set of redaction keys is: `authorization`, `cookie`, `x-request-id`.

The redaction placeholder is `[REDACTED]`.

## Data Flows

The `http_request_duration_seconds` metric carries labels `method` and `status` only.

## Database Interactions

[PENDING RESEARCH]

## Cross-Service Health Check

[PENDING RESEARCH]

## Common Operations

[PENDING RESEARCH]

## Failure Modes

[PENDING RESEARCH]

## Deploy & Runbook

[PENDING RESEARCH]

<!-- SEMANTIC_START -->
## Semantic Deep Dive (Human/Agent Refined)

Curatorial notes preserved verbatim across regeneration.
<!-- SEMANTIC_END -->

## Scripts

[PENDING RESEARCH]

## References

[PENDING RESEARCH]
