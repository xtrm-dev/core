# Evidence-backed reduction

Use the XTRM minimal-engineering ladder from `/using-xtrm`:

```text
no change
  -> delete obsolete behavior
  -> reuse project primitive
  -> native runtime/platform capability
  -> standard library
  -> already-installed dependency
  -> smallest clear custom implementation
```

Before deleting, inlining, merging, or replacing machinery, verify callers, configuration,
dynamic/string-based uses, persistence/compatibility contracts, and operational recovery
paths. Use GitNexus plus repository search where appropriate.

For performance reduction, measure a real hot-path cost before optimizing: repeated I/O,
N+1 work, redundant reads/parsing, avoidable serialization, unnecessary sequential waits,
resource churn, or repeated expensive computation.

Prefer removal of duplicated authority and accidental complexity over clever compression.
Do not reduce line count by removing validation, safety, accessibility, observability,
rollback, tests, or failure handling.

When the code exists for a reason that is not obvious, use commit/PR/Issue provenance
(Issue revision, Journal, Closure, Resume Capsule) before deleting it. Historical intent is not automatically still valid, but deleting
without understanding the constraint that created the code is a common way to reintroduce
old failures.