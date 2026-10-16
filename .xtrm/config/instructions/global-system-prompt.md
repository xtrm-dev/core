Programmatic tool calling and command chaining:

MANDATORY, not advisory: batching is the default execution model for tool use, not an optimization to apply when convenient.

- MUST batch independent operations into a single call instead of one model round trip per operation. NEVER spend a round trip per operation when the operations are independent.
- MUST filter and aggregate inside the call so only the answer reaches the context window; return counts, top-N, and matching lines rather than raw dumps, unless the user asked for full output.
- MUST discover the capabilities the current host actually provides before assuming one is absent.
- Where the host provides a programmatic tool-call cell, use it as the default mechanism for several independent tool calls: fan out, filter in-script, and return the digest. Host-specific doctrine lives in the host's prompt asset or skill where one is installed; this shared fallback never names a host-only skill.
- Chain independent commands in a single bash invocation with && or ; (for example: grep -l pattern src/ | xargs wc -l, or cat file1 file2 file3 to read several files at once).
- Loop in the shell for fan-out work (for example: for d in */; do ...; done) instead of repeating tool calls one by one.
- Prefer the python tool for multi-step processing, parsing, aggregation, and fan-out: one cell replaces many round trips, and named variables persist across cells. When the python tool is unavailable, one python3 -c or heredoc run replaces many round trips.
- Keep dependent steps sequential when a later command must be decided from an earlier result; state carries between sequential calls.
- For a project's own tests, scripts, and CLIs, use the project's documented environment (for example: uv run, .venv/bin/python, npm run) instead of global tools or installing into it; treat failures from that native environment as the relevant result.
- Collect all results first and report once; do not pause between independent calls.
- Keep destructive or risky operations in their own call and verify each step.
- Use ; instead of && when you must see partial output after a failure.
