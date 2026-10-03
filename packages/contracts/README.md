# @xtrm/contracts

Shared cross-runtime contracts for the xtrm ecosystem (Core ⇄ Specialists ⇄ xtmux).
Publishes the wire/record schemas the three repos agree on, as **JSON Schemas**
(source of truth) plus **TypeScript types**, **ajv runtime validators**, and
**golden fixtures**. Audit item **P2-02**.

## Layout

| Path | What |
|---|---|
| `schemas/*.json` | JSON Schema (draft-07) per contract, `$id` = schema id. The source of truth. |
| `src/validate.ts` | ajv registry: `validate`, `assertValid`, `getValidator`, `getSchema`, `SCHEMA_IDS`. |
| `src/types.ts` | Hand-authored TS types mirroring the schemas + `SCHEMA_ID` constants + `ContractTypeMap`. |
| `fixtures/golden.json` | One valid golden payload per schema. |
| `fixtures/invalid.json` | One intentionally-invalid payload per schema (negative fixtures). |
| `test/contracts.test.ts` | Proves every golden validates, every invalid is rejected, and id coverage. |

## Usage

```ts
import { validate, assertValid, isValid, SCHEMA_ID, uuidV7TimestampMs } from '@xtrm/contracts';
import type { RuntimeOriginV1, BeadsLifecycleEventV1 } from '@xtrm/contracts';

const { valid, errors } = validate(SCHEMA_ID.runtimeOrigin, payload);
assertValid('xtrm.branch.integration.v1', event); // throws with a readable message
if (isValid(SCHEMA_ID.piExtensionManifest, data)) { /* data: PiExtensionManifestV1 */ }
const occurredAtMs = uuidV7TimestampMs(beadsEvent.id);
```

Consumers who only want the raw schemas can read `@xtrm/contracts/schemas/<id>.json`.

## Contracts

Core: `xtrm.runtime-compatibility.v1`, `xtrm.interactive-role-envelope.v1`,
`xtrm.pi-extension-manifest.v1`, `xtrm.command-deprecations.v1`,
`xtrm.command-outcome.v1`, `xtrm.runtime-matrix.v1`.
Lineage/observability: `xtrm.runtime-origin.v1`, `xtrm.branch.integration.v1`,
`xtrm.beads.lifecycle-event.v1`.
xtmux runtime: `xtrm.xtmux.topology.v1`, `xtrm.xtmux.message.v1`, `xtrm.xtmux.obligation.v1`,
`xtrm.xtmux.monitor.v1`, `xtrm.xtmux.wait.v1`, `xtrm.xtmux.bridge.v1`, `xtrm.agent-role-launched.v1`.
Legacy specialists: `xtrm.specialist-role-envelope.v1` (registry version `"1"`).
Aggregation: `xtrm.topology.projection.v1` — the read-only join across xtmux, tmux,
Specialists, Beads, git and GitHub emitted by `xt topology --json` (audit P2-05). It is a
per-invocation snapshot, never a persisted graph, and it deliberately cannot carry pane
capture: no content/preview/output field exists at any level.

Agent host protocol (PRD xtrm-app §35.3, §35.8 item 1, §36.7; XTRM-562):

| Schema | Direction / transport |
|---|---|
| `xtrm.agent-event.v1` | in-session extension or Claude hooks → agent host, NDJSON on `$XDG_RUNTIME_DIR/xtrm/agent-host.sock` |
| `xtrm.agent-command.v1` | agent host → extension, same socket |
| `xtrm.agent-host-api.v1` | client ⇄ agent host, HTTP + SSE on `127.0.0.1` |

Socket frames carry `schema`, `seq`, `sessionId`, `at`, and `payload`. Event payloads
are the Pi 1.0.0 extension lifecycle events plus `session_identity`,
`extension_ui_request`, `extension_ui_resolved`, and `command_result`. Every
`extension_ui_request` is closed by one `extension_ui_resolved` with the same `id`
(`resolvedBy`: `local` | `host`, `outcome`: `answered` | `cancelled`). Pi-native messages and tool args/results
pass through opaque. `agent_settled` closes a Frame. `agent_end.willRetry` is optional,
because the Pi extension API does not expose it. Tool events carry the raw registration
source (`tool.sourceInfo` / `tool.namespace`) and an optional §36.7 `origin`.

```ts
import { decodeFrame, encodeFrame, checkSchemaVersion } from '@xtrm/contracts';

const result = decodeFrame('xtrm.agent-event.v1', line); // never throws
if (!result.ok && result.reason === 'unsupported_major') { /* peer runs another major */ }
socket.write(encodeFrame(commandFrame));
```

`fixtures/agent-protocol.json` holds one round-trip fixture per event type, command
type, and host API kind. The test fails when a union member has no fixture.

Each schema documents its authoritative source file in its `description`. The
JSON Schema is the source of truth — the TS types mirror it and the fixture test
guards their agreement.

## Scripts

```
npm run build      # tsup → dist (esm + cjs + d.ts)
npm run typecheck  # tsc --noEmit
npm test           # vitest
```

## Notes

- Beads owns lifecycle facts for Claude, Pi, and raw shells through its Dolt
  `events` table. Project them as `bd.<event_type>`; do not treat legacy hook or
  explicit telemetry rows (`bd.claim`, `bd.close`) as additional source facts.
- `xtrm.beads.lifecycle-event.v1` uses the Beads UUIDv7 event ID for idempotency
  and UTC milliseconds. Beads 1.1.0 may serialize `created_at` as local wall time
  with a `Z` suffix, so consumers must use `occurred_at_ms` for ordering/time.
- Un-versioned xtmux CLI responses (message/obligation/monitor/wait) carry no
  `schema_version` on the wire; their schemas mirror the current CLI output shape.
- `format` (e.g. `date-time`) is documentation only — not enforced (no ajv-formats dep).
- This package does **not** yet feed the existing `scripts/check-*.mjs` gates or
  `docs/runtime-compatibility.json`; wiring runtime code to consume these
  validators is a separate follow-up (per the P2-02 brief).
