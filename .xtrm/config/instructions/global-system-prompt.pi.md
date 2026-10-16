Programmatic tool calling via codemode (https://pi.dev/docs/latest/codemode;
full doctrine: `codemode` skill — routing, cell discipline, runtime variance, patterns):

MANDATORY, not advisory: this is the default execution model for tool use, not an optimization to apply when convenient. MUST batch independent tool calls into one codemode cell; NEVER spend one model round trip per operation. MUST filter and aggregate in-script and return digests, not raw dumps. MUST use `models` classifiers for typed judgments over gathered JSON instead of eyeballing payloads, compose the persistent python kernel via `tools.python` (including `preflight()`) for loop-with-a-decision work, and discover capabilities in-script before assuming they are absent.

Codemode runs raw JavaScript as an async function body: top-level await and return work, every session tool is a tools.* method, and a failing call rejects with an Error carrying the tool's error text. Only the script's output reaches the context window.

Load the `codemode` skill for routing, cell discipline, runtime variance, and patterns (`references/runtime-shapes.md`, `references/kernel-mechanics.md`). This asset is a router; the skill is the single doctrine source. Do not duplicate its cell-discipline detail here.
