# Planner-Bead `<change-contract>` XML Shape

> Emitted by `xt spec apply` (and `xt spec apply --dry-run` for preview).
> Consumed by the planner specialist's Pass-1, which produces an epic + child
> root beads, then Pass-2 annotates `recommended_template` per child root.

## Why XML, not markdown

- Substrate (specialists-roadmap §6.4 / D30) parses XML deterministically;
  markdown headers are fragile (level confusion, typos, ordering).
- Dispatcher `<scope>` lookups are deterministic for matcher rules.
- LLM consumers (the planner specialist reading the bead as task context)
  parse XML tags more reliably than markdown headers.

## Shape

```xml
<change-contract>
  <problem>…free text…</problem>
  <success>
    <item>…end-state 1…</item>
    <item>…end-state 2…</item>
  </success>
  <scrutiny>low|medium|high|critical</scrutiny>
  <scope>
    <item>cli/src/foo/bar.ts</item>
    <item>cli/src/foo/baz.ts</item>
  </scope>
  <non-goals>
    <item>…</item>
  </non-goals>
  <constraints>
    <item>…</item>
  </constraints>
  <validation>
    <item>R1: acceptance criterion 1</item>
    <item>R1: acceptance criterion 2</item>
    <item>unit: target X</item>
    <item>telemetry: log event Y presence</item>
  </validation>
  <output/>
</change-contract>
```

## Field mapping from spec.yaml

| spec.yaml field | XML target | Notes |
|---|---|---|
| `problem` | `<problem>` | Verbatim text (escaped). |
| `success[]` | `<success><item>…</item></success>` | One `<item>` per array element. |
| `scrutiny` | `<scrutiny>` | **Effective scrutiny** — the inferred floor, not the operator's explicit value if lower. |
| `scope.include[]` | `<scope><item>…</item></scope>` | One per entry. |
| `scope.exclude[]` + `non_goals[]` | `<non-goals><item>…</item></non-goals>` | Merged into one list (excludes come first). |
| `constraints[]` | `<constraints><item>…</item></constraints>` | Verbatim. |
| `requirements[].acceptance[]` + `validation[]` | `<validation><item>…</item></validation>` | Acceptance items prefixed `R<n>:`; validation items prefixed by `<kind>:`. |
| (reserved) | `<output/>` | Empty in the contract input; planner fills with epic_id, children[], test_issues[], first_task. |

## Escaping

All free-text content is XML-escaped: `&`, `<`, `>`, `"`, `'`. Field-count
parity is asserted via the transform-table test
(`cli/src/spec/__tests__/transform.test.ts` — added in xtrm-ai9xl.14).

## Size limit

The planner-bead description must fit within `BD_DESCRIPTION_LIMIT_BYTES`
(60_000 bytes). If a spec exceeds, `xt spec apply` refuses with
`spec_too_large` and a hint to split into smaller scopes.

## Substrate migration

When substrate lands and bd issues carry a first-class `<change-contract>`
field row (per §6.4), the XML body in the description retires in favor of
the row. The tag names (`change-contract`, `problem`, `success`, …) are
identical, so migration is a rename pass — no semantic transform.
