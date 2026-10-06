/**
 * toolnudge.ts — "use the better tool" duty source.
 *
 * Agents forget ast-grep, gitnexus and the python kernel exist and fall back
 * to grep/read/one-shot-python. Deterministic counters over observed tool
 * calls drive inline advisories on the exact tool result where the
 * inefficiency happens — no model call, per-kind session cooldown.
 */

import type { VerbSpec } from "../../shared/suggest.ts";

export interface ToolCounters {
  grepCount: number;
  pyBashCount: number;
  astGrepUsed: boolean;
  gitnexusUsed: boolean;
  kernelUsed: boolean;
}

export function newCounters(): ToolCounters {
  return { grepCount: 0, pyBashCount: 0, astGrepUsed: false, gitnexusUsed: false, kernelUsed: false };
}

/** Update counters from one observed tool call. Returns the same object. */
export function observeTool(counters: ToolCounters, toolName: string, args: Record<string, unknown> | undefined, input: Record<string, unknown> | undefined): ToolCounters {
  const cmd = String(args?.["command"] ?? input?.["command"] ?? "");
  if (toolName === "ast_grep") counters.astGrepUsed = true;
  if (toolName.startsWith("gitnexus")) counters.gitnexusUsed = true;
  if (toolName === "python") counters.kernelUsed = true;
  if (toolName === "bash" && cmd) {
    if (/\bgrep\b/.test(cmd) && /\s-[a-zA-Z]*[rR]/.test(cmd)) counters.grepCount++;
    if (/\bpython3?\s+(-c\b|\S+\.py\b)/.test(cmd)) counters.pyBashCount++;
  }
  return counters;
}

export type NudgeKind = "ast_grep" | "gitnexus" | "kernel";

export interface Nudge {
  kind: NudgeKind;
  verb: VerbSpec;
}

const NUDGE_COOLDOWN_MIN = 240; // once per session, practically

/**
 * The nudge due for THIS tool result, or null. Pure judge: the tool_call
 * observer already counted this call — no incrementing here.
 */
export function evaluateToolNudge(counters: ToolCounters, toolName: string, args: Record<string, unknown> | undefined, input: Record<string, unknown> | undefined): Nudge | null {
  const cmd = String(args?.["command"] ?? input?.["command"] ?? "");
  if (toolName !== "bash" || !cmd) return null;

  const isRecursiveGrep = /\bgrep\b/.test(cmd) && /\s-[a-zA-Z]*[rR]/.test(cmd);
  if (isRecursiveGrep) {
    if (!counters.astGrepUsed && counters.grepCount >= 2) {
      const ident = /\b(?:grep(?:\\b)?|def|function|class)\b/.test(cmd);
      if (ident && !counters.gitnexusUsed) {
        return {
          kind: "gitnexus",
          verb: {
            id: "tool_nudge",
            action: "gitnexus knows this symbol",
            oneLine: "Graph context answers callers/callees/impact without grepping definitions.",
            instruction: () =>
              "You are grep-hunting a symbol across files: gitnexus context/impact returns callers, callees and blast radius directly — cheaper than reading every hit.",
            severity: "normal",
            cooldownMin: NUDGE_COOLDOWN_MIN,
            source: "deterministic",
          },
        };
      }
      return {
        kind: "ast_grep",
        verb: {
          id: "tool_nudge",
          action: "ast-grep matches structure",
          oneLine: "Structural search beats text grep for code patterns.",
          instruction: () =>
            "Second text grep over source: the ast_grep tool matches AST patterns (ast_grep run --pattern …) and survives formatting noise that grep drowns in.",
          severity: "normal",
          cooldownMin: NUDGE_COOLDOWN_MIN,
          source: "deterministic",
        },
      };
    }
  }

  if (/\bpython3?\s+(-c\b|\S+\.py\b)/.test(cmd)) {
    if (!counters.kernelUsed && counters.pyBashCount >= 2) {
      return {
        kind: "kernel",
        verb: {
          id: "tool_nudge",
          action: "python kernel keeps state",
          oneLine: "The persistent python kernel survives across calls — no re-importing, no re-reading.",
          instruction: () =>
            "Second one-shot python3 in this session: the python tool runs in a persistent kernel — variables, imports and DataFrames stay alive between calls.",
          severity: "normal",
          cooldownMin: NUDGE_COOLDOWN_MIN,
          source: "deterministic",
        },
      };
    }
  }
  return null;
}
