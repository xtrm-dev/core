# Runtime shapes (probe, don't assume)

Pi releases differ. Verified against two runtimes 2026-10-13:

- Latest docs: `tools.bash` resolves to structured `{output (≤1MiB), truncated,
  full_output_path, exit_code}`; `tools.read` to text; globals include
  `searchTools/describeTool/describeNamespace/ALL_TOOLS`, `models`, `store/load`.
- This harness: `tools.bash`/`tools.read` resolve to **plain strings**;
  `searchTools`, `describeTool`, `ALL_TOOLS` do **not** exist. Enumerate with
  `Object.keys(tools)` (here: Task*, ast_grep, bash, grep, find, ls, read, write,
  edit, python, process, subagent/bg_*, specialist_*, fusion_*, intercom,
  claude-link, MCP `mcp__server__tool` names, `agentrun`, `models`).
- `models` exists here with live classifiers (jev-1.13 paid → 402 here;
  jev-1.13-free works). Question shape is ID-mapped
  `{id: {type: choice|bool|score, instructions, criteria}}` — arrays reject
  with the exact contract in the error.

Probing pattern (one cheap cell each): resolve shape (`Object.keys` /
`JSON.stringify(r).slice`), globals (`typeof models`), classifier with a
trivial question before spending state on a real one. A failed probe that
prints the contract is a successful probe.
