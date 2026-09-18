# Test and evidence planning

Choose proof from the layer being changed.

| Surface | Evidence floor |
|---|---|
| Pure/core logic | unit/property/characterization tests as appropriate |
| API/DB/file boundary | contract/integration evidence; live contract when safe |
| CLI/shell wiring | integration + smoke command |
| agent/hook/MCP/workflow | isolated runtime smoke/E2E + lifecycle evidence |
| deploy/infra | health/rollback/observability evidence |
| logging/metrics/tracing | assert event/field/query path and redaction |

A good validation contract names the command or observable artifact, expected result,
safe setup/cleanup, and what a failure would mean.

Prefer real behavior over mocks when the boundary is safely available. Mocks are useful
for isolation but they validate assumptions, not the external system.

For operational or autonomous systems, include the telemetry needed for a future agent to
diagnose failure: event identity, correlation IDs, outcome/error, duration, and a query or
artifact path. Never require secrets or raw sensitive payloads in logs.

Do not create one test Issue per implementation Issue mechanically. Batch tests when they
share a layer and ship/validate together.