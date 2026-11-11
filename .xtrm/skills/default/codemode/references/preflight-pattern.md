# Writer pre-flight pattern (explicit scope only — no OCR LLM)

OFF unless the pinned contract or scope explicitly names ocr delegation evidence, AgentRun
evidence, or both. When unnamed, ignore this pattern and review exactly per
`engineering-quality/references/review.md` above the lane sections.

One cell gives a writer OCR's deterministic scaffolding plus the repo's own checks,
with no `ocr review` token cost (see `engineering-quality/references/review.md`):

```js
const out = (r) => (typeof r === "string" ? r : r.output); // shape varies by release
const { homedir } = await import("node:os");
const { join } = await import("node:path");
// ~ never expands inside a JS string; resolve from homedir instead (CORE-2402).
const pf = join(homedir(), ".xtrm", "skills", "default", "engineering-quality", "scripts", "ocr-preflight.mjs");
const [pre, lint] = await Promise.allSettled([
  tools.bash({ command: `node ${pf} preflight --from origin/main --to HEAD` }),
  tools.bash({ command: "<repo lint && typecheck> 2>&1 | tail -40" }),
]);
const lintOut = lint.status === "fulfilled" ? out(lint.value) : lint.reason.message;
if (pre.status === "rejected") return { preflight_error: pre.reason.message, lint: lintOut };
const d = JSON.parse(out(pre.value));
store("ocr_preflight", d.files);
return { reviewable: d.reviewable, excluded: d.excluded_by_reason, checklists: d.rule_groups, lint: lintOut };
```

Apply the checklists, then run `ocr-preflight.mjs check` on your ledger. Fixes go in a
later cell: they change the diff, so rerun `preflight` before `check`.
Reviewers run the same cell for the ocr delegation lane and add `check` on their ledger.
