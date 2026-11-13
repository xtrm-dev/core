import type { ExtensionAPI, ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { isReadToolResult } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// read-line-numbers — owns the model-facing transform of Pi's built-in `read`
// tool: every source line is prefixed with its true line number, honoring the
// caller's `offset` so numbering matches the file, not the window position.
//
// Boundaries:
//  - The transform applies ONLY to built-in `read` tool results
//    (discriminated via isReadToolResult). All other tools pass through.
//  - Pi synthetic notices are preserved verbatim — prefixing one would
//    fabricate a false citation. They are recognized by the same discriminants
//    Pi uses: isError for error banners, details.truncation for truncation
//    notices, and the exact notice text Pi appends for user-limit reads.
//  - xtrm-ui remains presentation-only: it renders the already-numbered
//    content unchanged and never re-prefixes.
//
// Pi source-of-truth (pi-coding-agent read.js:194-213): Pi computes
//   allLines = textContent.split("\n"); if (startLine >= allLines.length)
//   throws "Offset X is beyond end of file (N lines total)"; then joins
//   slice(startLine, endLine) with "\n". EVERY element of the split is an
//   addressable line, INCLUDING the trailing "" produced when the file ends
//   in "\n". "one\n"    -> 2 lines ["one",""], offset=2 returns "".
//   "one\ntwo\n" -> 3 lines ["one","two",""], offset=3 returns "".
//   ""            -> 1 line   [""],           offset>1 throws.
// This module MUST number the trailing empty; Specialists citation-evidence
// (src/specialist/citation-evidence.ts:93-94) encodes the same contract.
// ---------------------------------------------------------------------------

// Every quantifier below is bounded: these patterns run on tool output, so an
// open `.*` next to a digit run is a ReDoS surface (CodeQL js/polynomial-redos,
// CORE-2694). NOTICE_MAX_LENGTH keeps large file content away from the patterns
// entirely, and any notice longer than it is content, not a notice.
const NOTICE_MAX_LENGTH = 16384;
// The banner's trailing run is a file path, which can be long — but ONLY that
// run may be large. Two adjacent large runs separated by literals re-open a
// polynomial stall (repeating " exceeds " measured ~1 s at 8 KiB bounds), so the
// size and limit fields stay at 64: they hold text like "60KB," and "50KB".
const SIZE_FIELD = "[^\\n]{0,64}";
const PATH_TAIL = "[^\\n]{0,8192}";

/** Pi appends this notice after a blank separator when the line limit was hit. */
const SHOWING_NOTICE = new RegExp(
  `^\\[Showing lines \\d{1,10}-\\d{1,10} of \\d{1,10}${PATH_TAIL}Use offset=\\d{1,10} to continue\\.\\]$`,
);
/** Pi appends this notice when a user-specified `limit` stopped before EOF. */
const USER_LIMIT_NOTICE = /^\[\d{1,10} more lines in file\. Use offset=\d{1,10} to continue\.\]$/;
/** Pi emits this banner alone when the first line exceeds the byte limit. */
const FIRST_LINE_BANNER = new RegExp(
  `^\\[Line \\d{1,10} is ${SIZE_FIELD} exceeds ${SIZE_FIELD} limit\\. Use bash: sed -n '\\d{1,10}p' ${PATH_TAIL}\\]$`,
);

function isSyntheticNotice(line: string): boolean {
  if (line.length > NOTICE_MAX_LENGTH) return false;
  return SHOWING_NOTICE.test(line) || USER_LIMIT_NOTICE.test(line) || FIRST_LINE_BANNER.test(line);
}

function numberLines(lines: string[], startLine: number): string {
  return lines.map((line, index) => `${startLine + index} | ${line}`).join("\n");
}

/**
 * Number the model-facing text of a `read` tool result.
 *
 * - `startLine` is the 1-based number of the first line (Pi's `offset`, default 1).
 * - `truncated` mirrors `details.truncation.truncated`: when true, Pi appended a
 *   trailing `\n\n[Showing lines ...]` notice that stays verbatim.
 * - Every element produced by `text.split("\n")` is a Pi-addressable line and
 *   gets numbered — including the trailing "" that appears when the source
 *   ends in "\n". The only unnumbered structure is the "\n\n" separator Pi
 *   inserts BEFORE a synthetic notice.
 */
export function numberReadText(text: string, startLine: number, truncated: boolean): string {
  // ponytail: `truncated` is accepted for API stability but not needed —
  // trailing-notice detection uses the notice regexes below, which fire
  // regardless of the truncation flag (Pi appends notices for user-limit
  // reads without setting truncation.truncated).
  void truncated;
  const lines = text.split("\n");
  const last = lines.length - 1;
  if (isSyntheticNotice(lines[last])) {
    // Whole payload is a banner (firstLineExceedsLimit) — keep verbatim.
    if (last === 0) return lines[last];
    // Trailing "\n\n[notice]": lines[last-1] is the synthetic blank separator
    // Pi inserted before the notice; the source ran through lines[0..last-2].
    // Number the source, then re-append "\n\n" + notice verbatim so the
    // separator stays unnumbered and the notice is never prefixed.
    const source = lines.slice(0, last - 1);
    return (source.length === 0 ? "" : numberLines(source, startLine)) + "\n\n" + lines[last];
  }
  // Every element is a Pi-addressable line, including a trailing "" from a
  // source that ended in "\n". Number them all.
  return numberLines(lines, startLine);
}

export default function readLineNumbersExtension(pi: ExtensionAPI): void {
  pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
    // Built-in `read` tool only — never intercept other tools.
    if (!isReadToolResult(event)) return undefined;
    // Error banners ("Offset N is beyond end of file", ...) stay verbatim.
    if (event.isError) return undefined;
    const truncation = event.details?.truncation;
    // The whole payload is the bash-fallback banner, not file content.
    if (truncation?.firstLineExceedsLimit) return undefined;
    // Image / non-text (binary) content: no-op.
    if (event.content.some((item) => item.type !== "text")) return undefined;
    // Pi's image path (read.js:174) emits a SINGLE text item shaped
    //   "Read image file [<mime>]\n<processing message>..."
    // when image processing fails. No image item is attached, so the
    // non-text guard above does not fire. Passing this synthetic note
    // through numberLines would prefix "1 | Read image file [...]" and
    // fabricate line numbers for a note that has no file lines. Skip it.
    if (event.content.length === 1 && event.content[0].type === "text") {
      const t = (event.content[0] as { text?: unknown }).text;
      if (typeof t === "string" && /^Read image file \[/.test(t)) return undefined;
    }

    // Pi's `offset` is 1-based; the first displayed line keeps that number.
    const offset = event.input.offset;
    const startLine = typeof offset === "number" && offset > 0 ? offset : 1;
    const transformed = event.content.map((item) => {
      if (item.type !== "text") return item;
      const text = (item as { text?: unknown }).text;
      if (typeof text !== "string") return item;
      return { type: "text" as const, text: numberReadText(text, startLine, truncation?.truncated === true) };
    });
    return { content: transformed };
  });
}
