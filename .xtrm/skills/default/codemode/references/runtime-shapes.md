# Runtime shapes (probe, don't assume)

Pi releases differ. Two observed shapes (2026-10-13 observation; reconciled
2026-10-14 against installed Pi 1.2.0 source and `docs/codemode.md`):

- **Pi 1.2.0 (verified in `dist/extensions/codemode/{execute,tool}.js` and
  `dist/core/tools/bash.js`):** `tools.bash` resolves to structured
  `{output (<=1MiB), truncated, full_output_path?, exit_code, wall_time_seconds}`;
  `tools.read` to text (image block for images); MCP tools to their
  `CallToolResult`. Globals include `searchTools/describeTool/describeNamespace/
  ALL_TOOLS`, `models`, `store/load`. This is the only Pi install found on this
  machine.
- **Older/other build (observed 2026-10-13, build not identified):**
  `tools.bash`/`tools.read` resolved to **plain strings**; `searchTools`,
  `describeTool`, `ALL_TOOLS` did **not** exist. Enumerate with
  `Object.keys(tools)` (Task*, ast_grep, bash, grep, find, ls, read, write,
  edit, python, process, subagent/bg_*, specialist_*, fusion_*, intercom,
  claude-link, MCP `mcp__server__tool` names, `agentrun`, `models`). Not
  reproducible from the 1.2.0 install; treat as a fallback shape, and probe
  before relying on either.
- `models` classifiers: live-tested only in the older build (jev-1.13 paid → 402;
  jev-1.13-free works). Question shape is ID-mapped
  `{id: {type: choice|bool|score, instructions, criteria}}` — arrays reject
  with the exact contract in the error.

Probing pattern (one cheap cell each): resolve shape (`Object.keys` /
`JSON.stringify(r).slice`), globals (`typeof models`), classifier with a
trivial question before spending state on a real one. A failed probe that
prints the contract is a successful probe.
