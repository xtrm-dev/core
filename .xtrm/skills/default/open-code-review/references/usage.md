# Open Code Review — usage reference

## Advanced Review Options

Beyond the common flags above, `ocr review` exposes a few groups of controls. Run `ocr review --help` for the complete list.

**Scoping**

- `--exclude '<patterns>'` — comma-separated gitignore-style patterns (for example `--exclude '**/generated/*,**/testdata/*'`), merged with `rule.json` excludes.
- `--background-file <path>` — read review context from a Markdown file. Takes precedence over `--background`.

**Output**

- `--format text|json|sarif` — `text` (default) for humans; `json` for machine-readable findings; `sarif` for code-scanning integrations such as GitHub Code Scanning.

**Model**

- `--provider <name>` / `--model <name>` — override the configured provider/model for this run only (for example, to recheck a diff with a different model; the user names the model, `ocr llm providers` lists the built-ins).

**Budget**

- `--max-tokens <n>` — per-group prompt ceiling; defaults to the configured value or the template default (`200000`).
- `--max-tokens-budget <n>` — cap total input + output tokens for the run. Checked before every LLM round: a group already over budget gets one final round to submit findings, no further groups are dispatched, partial results are still published, and skipped files are reported as `failed(budget)`.
- `--no-filter` — keep all review comments and skip the LLM post-filtering call.

## Gotchas

- **LLM must be configured first** — `ocr review` will fail loudly if no LLM is reachable. See the Troubleshooting section below if this happens.
- **Working directory matters** — `ocr review` operates on the Git repo at the current directory. Use `--repo /path/to/repo` to run from elsewhere.
- **Untracked files are reviewed in workspace mode** — running bare `ocr review` includes staged, unstaged, *and* untracked changes. Stage selectively if you want narrower scope.
- **Large diffs may hit token limits** — `MAX_TOKENS` sets the prompt budget (`200000` in the review template; `ocr scan` uses `58888`); conversation context is compressed to stay within this prompt budget. Model output is capped separately by `MAX_COMPLETION_TOKENS` (`16384`). A file whose diff alone exceeds ~80% of `MAX_TOKENS` is skipped before the LLM is called.
- **Plan phase triggers on either of two thresholds** — a group runs an extra risk-analysis phase before main review when its largest changed file reaches `PLAN_MODE_LINE_THRESHOLD` (default `50`) **or** it holds 2+ files whose combined changed lines reach `PLAN_MODE_GROUP_LINE_THRESHOLD` (default `100`). This adds latency but improves quality.
- **Don't pass `--audience human`** — it streams progress UI that pollutes output. Always use `--audience agent`.
- **Comment language follows config** — the `language` config controls review comment language, defaults to `English`, and accepts any language name (for example `English` or `中文`).
- **Avoid output truncation** — Large review runs produce verbose output. Never pipe command output to `tail` or `head` as it drops review comments from earlier sections. Use `--output <path>` and read it in full; on older CLIs, follow the **Output file** guidance above.
- **Resume an interrupted review** — a failed or interrupted range/commit review can be continued with `ocr review --resume <id>` using the same `--from`/`--to` or `--commit` target (the id is printed as `retry with: --resume <id>` on failure, or find it with `ocr session list`). Workspace resume is not supported.

## Validation

After the review completes, verify success by checking:

1. The command exited with code 0
2. Comments were generated (or "No comments generated" message appears)
3. Warnings (if any) are displayed in stderr

If errors occurred, check the stderr warnings for details about which files failed and why.

## Troubleshooting

**`ocr: command not found`**

Install the CLI:

```bash
npm install -g @alibaba-group/open-code-review
```

**`unknown flag: --output`**

The CLI is older than v1.10.0. Do not continue the review with plain stdout. Ask the user whether to upgrade (`npm i -g @alibaba-group/open-code-review@latest`) and wait for the answer before proceeding. After the user confirms and the upgrade succeeds, rerun with `--output`.

**`ocr review` fails with LLM connection error**

Prompt the user to configure an LLM provider.

Interactive setup (recommended):

```bash
ocr config provider
```

Manual setup (alternative):

```bash
ocr config set llm.url https://api.anthropic.com/v1/messages
ocr config set llm.auth_token <api-key>
ocr config set llm.model claude-opus-4-6
ocr config set llm.use_anthropic true
```

Verify connectivity with `ocr llm test`. Stop here and ask the user to provide credentials — never invent or hardcode API keys.

## References

- Full docs: https://github.com/alibaba/open-code-review
- NPM package: https://www.npmjs.com/package/@alibaba-group/open-code-review
- Issue tracker: https://github.com/alibaba/open-code-review/issues
