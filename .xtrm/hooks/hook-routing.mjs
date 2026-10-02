// hook-routing.mjs — which tool each xt check applies to (CORE-2339).
//
// Extracted from dispatch.mjs so the routing is assertable: the sets below are
// the ONLY thing that decides whether a check runs for a given tool call, and
// the pre-CORE-2339 matchers lived in policies/*.json. cli/test/hooks/
// hook-routing.test.ts pins them against those matchers and against the tool
// names gitnexus-hook.cjs actually understands, so a routing edit cannot
// silently drop an enforcement path.

/** $WRITE_TOOLS in scripts/compile-policies.mjs (Edit|Write|MultiEdit|NotebookEdit). */
export const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Tools the worktree-boundary PreToolUse guard applies to. */
export const PRE_TOOLS = [...EDIT_TOOLS, 'Agent'];

/**
 * Tools routed to gitnexus enrichment. The canonical matcher was
 * Bash|Grep|Read|Glob, but the runtime sync has historically widened the
 * installed matcher to Serena symbol/file tools (mergeMatcher in
 * cli/src/utils/atomic-config.ts), so those stay here too — excluding them
 * would silently drop enrichment on machines that had it.
 */
export const GITNEXUS_TOOLS = [
  'Bash', 'Grep', 'Read', 'Glob',
  'mcp__serena__find_symbol',
  'mcp__serena__find_referencing_symbols',
  'mcp__serena__replace_symbol_body',
  'mcp__serena__insert_after_symbol',
  'mcp__serena__insert_before_symbol',
  'mcp__serena__get_symbols_overview',
  'mcp__serena__search_for_pattern',
  'mcp__serena__rename_symbol',
];

export const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];
