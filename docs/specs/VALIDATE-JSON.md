# `xt spec validate --json` Output Schema

Stable structured report consumed by editors, CI, and downstream xt
spec apply pre-flight.

## Top-level

```jsonc
{
  "schema": "xt.spec.validate.v1",
  "ok": false,
  "source": "/abs/path/to/spec.yaml",
  "errors": [ /* ValidationIssue[] */ ],
  "warnings": [ /* ValidationIssue[] */ ],
  "inferred": {
    "scrutiny": {
      "explicit": "medium",
      "inferred": "high",
      "effective": "high"
    },
    "layer_hints": { "R1": "shell" }
  }
}
```

## ValidationIssue

```jsonc
{
  "code": "scope_too_vague",        // stable ErrorCode string
  "field_path": "scope.include[0]", // yaml-style field path
  "severity": "error",              // "error" | "warning"
  "message": "Human-readable description",
  "fix": "How to resolve it"        // optional
}
```

## Error codes (stable)

| code | severity | meaning |
|---|---|---|
| `schema_invalid` | error | Schema-level parse/zod failure (one issue per zod path) |
| `scope_too_vague` | error | Scope entry too generic to act on |
| `requirement_untestable` | error | Acceptance criterion uses vague word |
| `layer_missing` | error/warning | Requirement missing layer_hint (warning if inferable) |
| `cycle_detected` | error | Dependency graph has a cycle |
| `scrutiny_lower_than_inferred` | warning | Explicit scrutiny floor raised by inference |
| `open_question_unresolved` | error | High/critical scrutiny with unresolved questions |
| `yaml_parse_error` | error | yaml load failure (emitted only by the CLI wrapper) |

## Exit codes

| code | meaning |
|---|---|
| 0 | All gates pass; zero errors and zero warnings (or warnings ignored without `--strict`) |
| 1 | Errors present (or warnings present under `--strict`) |
| 2 | Zero errors but ≥1 warning |
| 64 | Usage error (missing path, invalid flag combination) |

## Stability

`schema: "xt.spec.validate.v1"` is the contract. Adding new fields is
backward-compatible; renaming or removing fields requires bumping to v2.
New error codes can be added under the same schema version.
