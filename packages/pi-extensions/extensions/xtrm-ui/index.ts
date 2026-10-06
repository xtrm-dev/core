/**
 * XTRM-owned Pi chrome, themes, and native/external tool rendering.
 * custom-footer remains the sole footer owner.
 */

import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  ExtensionContext,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanOutputLines,
  countPrefixedItems,
  createUnifiedLineDiff,
  diffStats,
  formatDuration,
  formatLineLabel,
  formatPayloadSize,
  joinCompactMeta,
  joinMeta,
  lineCount,
  previewLines,
  renderRichDiffPreview,
  TOOL_ROW_MARKER,
  shortenCommand,
  shortenPath,
} from "./format";

// ============================================================================
// Types
// ============================================================================

export type XtrmThemeName = "xtrm-dark" | "xtrm-light";
export type XtrmResolvedThemeName = XtrmThemeName | "xtrm-dark-flattools" | "xtrm-light-flattools";
export type XtrmDensity = "compact" | "comfortable";

export interface XtrmUiPrefs {
  themeName: XtrmThemeName;
  density: XtrmDensity;
  showHeader: boolean;
  forceTheme: boolean;
  toolRowBg: boolean;
  commandPreviewLines: number;
}

// ============================================================================
// Defaults
// ============================================================================

export const XTRM_UI_PREFS_ENTRY = "xtrm-ui-prefs";

export const DEFAULT_PREFS: XtrmUiPrefs = {
  themeName: "xtrm-dark",
  density: "compact",
  showHeader: true,
  forceTheme: true,
  toolRowBg: false,
  commandPreviewLines: 4,
};

/** Collapsed command/code lines before the hidden-count line. Agent context is
 * never capped — this is display only; the model still receives full args. */
export const DEFAULT_COMMAND_PREVIEW_LINES = 4;


// ============================================================================
// Preferences
// ============================================================================

type MaybeCustomEntry = {
  type?: string;
  customType?: string;
  data?: unknown;
};

export function normalizePrefs(input: unknown): XtrmUiPrefs {
  if (!input || typeof input !== "object") return { ...DEFAULT_PREFS };
  const source = input as Partial<XtrmUiPrefs>;
  // Persisted prefs may still hold retired theme names; compare the raw value.
  const themeName: unknown = (input as { themeName?: unknown }).themeName;
  const lightTheme = themeName === "xtrm-light"
    || themeName === "xtrm-light-flattools"
    || themeName === "pidex-light"
    || themeName === "pidex-light-flattools";
  return {
    themeName: lightTheme ? "xtrm-light" : "xtrm-dark",
    density: source.density === "comfortable" ? "comfortable" : "compact",
    showHeader: source.showHeader ?? DEFAULT_PREFS.showHeader,
    forceTheme: source.forceTheme ?? DEFAULT_PREFS.forceTheme,
    toolRowBg: source.toolRowBg ?? DEFAULT_PREFS.toolRowBg,
    commandPreviewLines: normalizeCommandPreviewLines(source.commandPreviewLines),
  };
}

function normalizeCommandPreviewLines(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_COMMAND_PREVIEW_LINES;
  return Math.min(20, Math.max(1, n));
}

function loadPrefs(entries: ReadonlyArray<MaybeCustomEntry>): XtrmUiPrefs {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === XTRM_UI_PREFS_ENTRY) {
      return normalizePrefs(entry.data);
    }
  }
  return { ...DEFAULT_PREFS };
}

function persistPrefs(pi: ExtensionAPI, prefs: XtrmUiPrefs): void {
  pi.appendEntry(XTRM_UI_PREFS_ENTRY, prefs);
}


// ============================================================================
// Thinking Chrome
// ============================================================================

type AssistantMessageComponentCtor = {
	prototype: {
		updateContent?: (message: AssistantMessageLike) => void;
	};
};

type AssistantContentBlock = { type?: string; thinking?: string; text?: string };
type AssistantMessageLike = { content?: AssistantContentBlock[] };
type PatchableAssistantMessage = {
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	lastMessage?: AssistantMessageLike;
	updateContent?: (message: AssistantMessageLike) => void;
};

const PATCHED_ASSISTANT_MESSAGE = "__xtrmUiThinkingPreview5";
const ORIGINAL_ASSISTANT_UPDATE = "__xtrmUiThinkingPreviewOriginalUpdate";
const THINKING_PREVIEW_PATCH_VERSION = 6;

const THINKING_RECAP_MAX = 120;

/** Minimal theme surface used to style the thinking rows. */
export interface ThinkingRowStyle {
	/** Bold label (SGR bold + thinkingText color; theme.bold is a no-op in pi). */
	label: (text: string) => string;
	/** Dimmed trace/recap, e.g. `theme.fg("thinkingText", text)`. */
	recap: (text: string) => string;
	/** Dimmed hint, e.g. `theme.fg("dim", text)`. */
	hint: (text: string) => string;
	/** Dimmed label separator, e.g. `theme.fg("dim", " · ")`. */
	sep: string;
}

/**
 * One-line recap of a thinking block: the first substantive line, stripped of
 * markdown emphasis and list markers, whitespace-collapsed and truncated.
 * Fragments (a stray `**The**` or a one-word line) are skipped in favor of the
 * first line with real content.
 */
export function buildThinkingRecap(thinking: string, fallback = "Thinking..."): string {
	const cleaned = thinking
		.split("\n")
		.map((line) =>
			stripAnsi(line)
				.replace(/^#{1,6}\s+/, "")
				.replace(/\*\*([^*]+)\*\*/g, "$1")
				.replace(/\*([^*]+)\*/g, "$1")
				.replace(/`([^`]+)`/g, "$1")
				.replace(/^[-*+:]\s*/, "")
				.replace(/\s+/g, " ")
				.replace(/:$/, "")
				.trim(),
		)
		.filter((line) => line.length > 0);
	const source = cleaned.find((line) => line.length >= 20) ?? cleaned[0] ?? fallback;
	if (!source) return fallback;
	return source.length > THINKING_RECAP_MAX ? source.slice(0, THINKING_RECAP_MAX - 3) + "..." : source;
}

/** Collapsed row: bold label, dim separator, dimmed recap, raw char count, expand hint. */
export function buildCollapsedThinkingRow(recap: string, charCount: number, style: ThinkingRowStyle): string {
	return ` ${style.label("Thinking...")}${style.sep}${style.recap(recap)}${style.sep}${style.recap(String(charCount))} ${style.hint("(Ctrl+T to expand)")}`;
}

/** Expanded block: bold label row with collapse hint, then the full dimmed trace. */
export function buildExpandedThinkingBlock(thinking: string, style: ThinkingRowStyle): string {
	return `${style.label("Thinking...")} ${style.hint("(Ctrl+T to collapse)")}\n\n${style.recap(thinking.trim())}`;
}

const THINKING_ROW_LABEL = "Thinking...";
const THINKING_ROW_EXPAND_HINT = "(Ctrl+T to expand)";
// Pi's renderer reserves ~9-12 visible columns for the terminal-integration
// (OSC133) zone markers on the final content line; subtract so the row fits.
const THINKING_ROW_WIDTH_MARGIN = 12;

/** Raw row offset for a given visible-character index (skips ANSI escapes). */
function rawOffsetForVisibleIndex(row: string, visibleIndex: number): number {
	let visible = 0;
	for (let i = 0; i < row.length; i++) {
		if (row[i] === "\x1b") {
			const m = row.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
			if (m) {
				i += m[0].length - 1;
				continue;
			}
		}
		if (visible === visibleIndex) return i;
		visible += visibleWidth(row[i]) || 1;
	}
	return row.length;
}

/**
 * Keeps a collapsed thinking row on ONE line at the given render width,
 * truncating the recap so the expand hint always survives — the same behavior
 * as prime-agent's CollapsedThinkingRow. Non-row markdown passes through.
 */
export function fitThinkingRowToWidth(row: string, availableWidth: number | undefined): string {
	if (!availableWidth || availableWidth <= 0) return row;
	if (!row.includes(THINKING_ROW_LABEL) || row.includes("\n")) return row;
	const plain = stripAnsi(row);
	if (!plain.trimStart().startsWith(THINKING_ROW_LABEL) || !plain.includes(THINKING_ROW_EXPAND_HINT)) return row;

	const labelEnd = plain.indexOf(THINKING_ROW_LABEL) + THINKING_ROW_LABEL.length;
	const sepMatch = plain.slice(labelEnd).match(/^\s*·\s*/);
	const recapStartPlain = labelEnd + (sepMatch?.[0].length ?? 0);
	const recapStart = rawOffsetForVisibleIndex(row, recapStartPlain);
	const hintStart = rawOffsetForVisibleIndex(row, plain.indexOf(THINKING_ROW_EXPAND_HINT) - 1);
	const labelSepRaw = row.slice(0, recapStart);
	const recapRaw = row.slice(recapStart, hintStart);
	const hintRaw = row.slice(hintStart);

	const fixedWidth = visibleWidth(stripAnsi(labelSepRaw)) + visibleWidth(stripAnsi(hintRaw));
	const recapWidth = Math.max(8, availableWidth - fixedWidth - THINKING_ROW_WIDTH_MARGIN);
	const recapPlain = stripAnsi(recapRaw).trim();
	if (visibleWidth(recapPlain) <= recapWidth) return row;

	const colorPrefix = recapRaw.match(/^(\x1b\[[0-9;?]*m)+/)?.[0] ?? "";
	const colorSuffix = recapRaw.match(/(\x1b\[[0-9;?]*m)+$/)?.[0] ?? "";
	return labelSepRaw + colorPrefix + truncateToWidth(recapPlain, recapWidth) + colorSuffix + hintRaw;
}

function maybeFileUrlToPath(value: string): string {
	return value.startsWith("file:") ? fileURLToPath(value) : value;
}

export function piRuntimeEntryForCliPath(cliPath: string): string | undefined {
	if (cliPath.endsWith("/dist/bundle/cli.js")) return join(dirname(cliPath), "index.js");
	if (cliPath.endsWith("/dist/cli.js")) return join(dirname(cliPath), "index.js");
	return undefined;
}

function resolvePiCodingAgentEntryPath(): string {
	const candidates: string[] = [];

	const argvPath = process.argv[1];
	if (argvPath && existsSync(argvPath)) {
		const runtimeEntry = piRuntimeEntryForCliPath(realpathSync(argvPath));
		if (runtimeEntry) candidates.push(runtimeEntry);
	}

	const globalDist = join(
		dirname(process.execPath),
		"..",
		"lib",
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
	);
	candidates.push(join(globalDist, "bundle", "index.js"), join(globalDist, "index.js"));

	try {
		candidates.push(maybeFileUrlToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	} catch {}

	const entryPath = candidates.find((candidate) => existsSync(candidate));
	if (!entryPath) throw new Error("Could not resolve active pi-coding-agent runtime entry path");
	return entryPath;
}

// Pi's initial hideThinkingBlock is false (thinking expanded). We default to
// compact previews until the user toggles; once a real toggle is visible
// (a component with hideThinkingBlock === true), follow pi's toggle exactly.
// The latch is process-lifetime module state (pi caches the extension factory
// per process); session_start resets it per session (xtrm-6ggil). The patch
// factory takes the holder as a parameter so tests run with an isolated latch.
export type ThinkingToggleLatch = { followsToggle: boolean };
const thinkingToggleLatch: ThinkingToggleLatch = { followsToggle: false };

/**
 * Wraps AssistantMessageComponent.updateContent so thinking blocks render as
 * XTRM preview rows. Exported for unit tests: pass the original updateContent,
 * a style, and (optionally) an isolated latch.
 */
export function createPatchedUpdateContent(
	updateContent: (message: AssistantMessageLike) => void,
	style: ThinkingRowStyle,
	latch: ThinkingToggleLatch = thinkingToggleLatch,
): (this: PatchableAssistantMessage, message: AssistantMessageLike) => void {
	return function patchedUpdateContent(this: PatchableAssistantMessage, message: AssistantMessageLike) {
		const blocks = message.content;
		if (Array.isArray(blocks)) {
			const hasThinking = blocks.some((block) => block.type === "thinking" && block.thinking?.trim());
			if (hasThinking) {
				if (this.hideThinkingBlock) latch.followsToggle = true;
				const compact = this.hideThinkingBlock === true || !latch.followsToggle;
				const content = blocks.flatMap((block, index) => {
					if (block.type !== "thinking" || !block.thinking?.trim()) return [block];
					const row = compact
						? buildCollapsedThinkingRow(buildThinkingRecap(block.thinking), block.thinking.length, style)
						: buildExpandedThinkingBlock(block.thinking, style);
					// Text blocks render even when pi's hideThinkingBlock branch is
					// active (a "thinking" block would be swallowed and replaced by the
					// empty hidden label). Append an invisible single-line block (a
					// zero-width space survives pi's text trim and renders as a blank
					// line) when a visible text/thinking block follows — mirroring pi's
					// Spacer(1) after thinking runs; none before tool-call blocks.
					const hasVisibleAfter = blocks
						.slice(index + 1)
						.some((c) => (c.type === "text" && c.text?.trim()) || (c.type === "thinking" && c.thinking?.trim()));
					return hasVisibleAfter
						? [{ type: "text", text: row }, { type: "text", text: "\u200b" }]
						: [{ type: "text", text: row }];
				});
				updateContent.call(this, { ...message, content });
				// Pi stores lastMessage and re-renders from it in
				// setHideThinkingBlock()/invalidate()/setHiddenThinkingLabel().
				// Restore the RAW message so those re-renders re-enter this patch
				// with the original thinking blocks; otherwise the toggle renders
				// the already-converted rows and existing thinking rows never flip.
				this.lastMessage = message;
				return;
			}
		}
		updateContent.call(this, message);
	};
}

export function selectPatchBase<T>(
  current: T | undefined,
  installedVersion: number | boolean | undefined,
  targetVersion: number,
  original: T | undefined,
  patchName: string,
): T | undefined {
  if (!current || installedVersion === targetVersion) return undefined;
  if (installedVersion !== undefined && !original) {
    throw new Error(`${patchName} was installed by a legacy version; restart pi before upgrading`);
  }
  return original ?? current;
}

async function installThinkingPreviewPatch(): Promise<void> {
	const entryPath = resolvePiCodingAgentEntryPath();
	const mod = await import(pathToFileURL(entryPath).href) as {
		AssistantMessageComponent?: AssistantMessageComponentCtor;
	};
	// xtrm-dark and xtrm-light both map thinkingText/dim to these values. Raw
	// SGR avoids importing the unbundled theme singleton when pi runs bundle/cli.js.
	const thinkingText = (text: string) => `\x1b[38;2;167;167;167m${text}\x1b[39m`;
	const dimText = (text: string) => `\x1b[38;2;138;138;138m${text}\x1b[39m`;
	const style: ThinkingRowStyle = {
		label: (text) => `\x1b[1m${thinkingText(text)}\x1b[22m`,
		recap: thinkingText,
		hint: dimText,
		sep: dimText(" · "),
	};
	const proto = mod.AssistantMessageComponent?.prototype as
		| (AssistantMessageComponentCtor["prototype"] & {
			[PATCHED_ASSISTANT_MESSAGE]?: number | boolean;
			[ORIGINAL_ASSISTANT_UPDATE]?: (message: AssistantMessageLike) => void;
		})
		| undefined;
	if (!proto) return;

	const updateContent = selectPatchBase(
		proto.updateContent,
		proto[PATCHED_ASSISTANT_MESSAGE],
		THINKING_PREVIEW_PATCH_VERSION,
		proto[ORIGINAL_ASSISTANT_UPDATE],
		"xtrm-ui thinking preview patch",
	);
	if (!updateContent) return;
	proto[ORIGINAL_ASSISTANT_UPDATE] ??= updateContent;
	proto.updateContent = createPatchedUpdateContent(updateContent, style);
	proto[PATCHED_ASSISTANT_MESSAGE] = THINKING_PREVIEW_PATCH_VERSION;
}

let retryFailureWarned = false;
function warnRetryFailedOnce(error: unknown): void {
  if (retryFailureWarned) return;
  retryFailureWarned = true;
  const message = error instanceof Error ? error.message : String(error);
  // stderr so it surfaces even when Pi's UI eats stdout.
  process.stderr.write(
    `[xtrm-ui] thinking-preview install still failing at session_start: ${message.slice(0, 300)}\n`,
  );
}

/**
 * Single-flight wrapper around the thinking-preview prototype patch install.
 * The extension factory runs during Pi's resource loading, BEFORE the TUI
 * controller constructor calls initTheme(); the theme module (theme.js)
 * exports a Proxy that throws "Theme not initialized" until then, so the
 * factory-time attempt can fail. session_start fires after the controller is
 * constructed, so awaiting ensureInstalled() there retries a failed install
 * before the first assistant message renders (xtrm-3tus9). Exported for unit
 * tests: pass an install function and an isolated state holder.
 *
 * @internal — factored out and exported for unit-test isolation only.
 * `handlers.test.ts` constructs isolated install states per test to avoid
 * process-lifetime state bleed. Not part of the public extension API and
 * not intended for use outside this package's tests. Do not import from
 * downstream extensions.
 */
export function createThinkingPreviewInstallState(install: () => Promise<void>): {
  ensureInstalled: () => Promise<void>;
  isInstalled: () => boolean;
} {
  let installed = false;
  let current: Promise<void> | null = null;
  return {
    ensureInstalled() {
      if (installed) return Promise.resolve();
      if (current) return current;
      current = install().then(
        () => {
          installed = true;
          current = null;
        },
        (error: unknown) => {
          current = null;
          throw error;
        },
      );
      return current;
    },
    isInstalled: () => installed,
  };
}

type ToolExecutionComponentCtor = {
  prototype: {
    getRenderShell?: () => "default" | "self";
    hasRendererDefinition?: () => boolean;
    render?: (width: number) => string[];
  };
};

type PatchableToolExecutionComponent = {
  toolName?: string;
  args?: unknown;
  result?: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean };
  expanded?: boolean;
  isPartial?: boolean;
  hasRendererDefinition?: () => boolean;
  __xtrmExternalStartedAt?: number;
  __xtrmExternalDurationMs?: number;
};

type ExternalToolFrameKind = "serena" | "gitnexus" | "structured" | "process" | "external";

// Bump this on EVERY change to patchedRender/patchedGetRenderShell: a reload
// keeps the prototype (and its marker), so an unchanged version leaves the
// OLD closure installed and the fix silently absent (CORE-2358).
const PATCHED_EXTERNAL_TOOL_FRAME = "__xtrmUiExternalToolFrame";
const ORIGINAL_EXTERNAL_RENDER = "__xtrmUiExternalToolFrameOriginalRender";
const ORIGINAL_EXTERNAL_GET_RENDER_SHELL = "__xtrmUiExternalToolFrameOriginalGetRenderShell";
const EXTERNAL_TOOL_FRAME_PATCH_VERSION = 32;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// XTRM extension accent (#9a8bff) — pi's theme.fg() only accepts named tokens and
// throws on raw hex, so emit the truecolor SGR directly (repo already uses raw
// SGR escapes for bold).
const XTRM_EXT_ACCENT = "\x1b[38;2;154;139;255m";

type ToolRowStatus = "pending" | "success" | "error";

function boldSgr(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

/**
 * External tool row header in native tool style:
 *   ● used <Extension> <tool>
 *   - dot: plain prompt color; dim once the command succeeds (like native rows)
 *   - "used": bold action word
 *   - extension: #9a8bff, bold
 *   - tool: bold, dim until success, default (light) when success
 */
function externalToolHeaderLine(
  status: ToolRowStatus,
  provider: string,
  tool?: string,
): string {
  const dot = status === "success" ? "\x1b[2m●\x1b[22m" : "●";
  const ext = `${XTRM_EXT_ACCENT}${boldSgr(provider)}\x1b[39m`;
  const toolColor = status === "success" ? "" : "\x1b[2m";
  const toolReset = status === "success" ? "" : "\x1b[22m";
  const toolName = tool ? ` ${toolColor}${boldSgr(tool)}${toolReset}` : "";
  return `${dot} ${boldSgr("used")} ${ext}${toolName}`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function isBlankRenderedLine(line: string): boolean {
  return stripAnsi(line).trim().length === 0;
}

function externalToolFrameKind(toolName: string | undefined): ExternalToolFrameKind | undefined {
  if (!toolName || XTRM_BUILTIN_TOOLS.has(toolName)) return undefined;
  if (toolName === "structured_return") return "structured";
  if (toolName === "process") return "process";
  if (toolName.startsWith("gitnexus_")) return "gitnexus";
  if (SERENA_COMPACT_TOOLS.has(toolName)) return "serena";
  return "external";
}

function getToolArgs(component: PatchableToolExecutionComponent): Record<string, unknown> {
  return component.args && typeof component.args === "object" && !Array.isArray(component.args)
    ? component.args as Record<string, unknown>
    : {};
}

function summarizeExternalToolPending(toolName: string | undefined, input: Record<string, unknown>): string {
  // Bare header doctrine (CORE-2358): the header is provider + tool, nothing
  // more. Subjects, commands and paths stay in the output, never the header.
  const name = toolName ?? "tool";
  if (name === "structured_return") return `${TOOL_ROW_MARKER} structured_return`;
  if (name === "process") return `${TOOL_ROW_MARKER} process`;
  return `${TOOL_ROW_MARKER} ${normalizeToolLabel(name)}`;
}

function extractResultTextLines(component: PatchableToolExecutionComponent): string[] | undefined {
  const text = component.result?.content?.find((content) => content.type === "text")?.text;
  return text
    ? text.split("\n")
    : [summarizeExternalToolPending(component.toolName, getToolArgs(component))];
}

// CORE-2358: the framed row must show what ran above the output — otherwise the
// operator never sees it. Generic rule, no per-tool list: any external tool
// carrying its program in a `code` string arg (python, codemode-style) gets
// the preview. Codemode included: its Pi core renderer is shadowed by this
// frame exactly like python's was.
export function externalToolCodePreview(toolName: string | undefined, args: Record<string, unknown>): string[] | undefined {
  const code = args.code;
  if (typeof code !== "string" || code.trim().length === 0) return undefined;
  return code.split("\n");
}

export function externalToolContentLines(
  component: PatchableToolExecutionComponent,
  rendered: string[],
  expanded = false,
): string[] {
  const preview = externalToolCodePreview(component.toolName, getToolArgs(component));
  if (!preview) return extractResultTextLines(component) ?? rendered;
  // Pending: the program is the content. Resolved: program above output.
  // The output block renders dimmed: the call above is the eye anchor.
  // Collapsed: 4 code lines + a `showing X/N lines` count (N = code lines),
  // no expand hint — the footer already carries it.
  const shown = expanded ? preview : preview.slice(0, 4);
  const tail = component.result ? (extractResultTextLines(component) ?? rendered) : [];
  const dimmed = tail.map((l) => (l.trim().length > 0 ? `\x1b[2m${l}\x1b[22m` : l));
  const count = !expanded && preview.length > shown.length
    ? [` \x1b[2m\x1b[3m … +${preview.length - shown.length} lines\x1b[23m\x1b[22m`]
    : [];
  return [...shown, ...count, ...dimmed];
}

function trimRenderedToolLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankRenderedLine(lines[start] ?? "")) start++;
  while (end > start && isBlankRenderedLine(lines[end - 1] ?? "")) end--;
  return lines.slice(start, end).map((line) => line.replace(/\s+$/u, ""));
}

export function collapsedExternalToolLines(contentLines: string[], expanded: boolean): string[] {
  if (expanded || contentLines.length <= 6) return contentLines;
  return [
    ...contentLines.slice(0, 6),
    `... (${contentLines.length - 6} more lines, ctrl+o to expand)`,
  ];
}

function externalToolProvider(kind: ExternalToolFrameKind, toolName?: string): string {
  if (kind === "serena") return "Serena";
  if (kind === "gitnexus") return "GitNexus";
  if (kind === "structured") return "structured_return";
  if (kind === "process") return "process";

  const separator = toolName?.indexOf("_") ?? -1;
  return separator > 0 ? toolName?.slice(0, separator) ?? "external" : normalizeToolLabel(toolName ?? "external");
}

function externalToolAction(kind: ExternalToolFrameKind, toolName?: string): string | undefined {
  if (!toolName || kind === "structured" || kind === "process") return undefined;
  if (kind === "gitnexus" && toolName.startsWith("gitnexus_")) return toolName.slice("gitnexus_".length);
  if (kind === "serena") return toolName;

  const separator = toolName.indexOf("_");
  return separator > 0 ? toolName.slice(separator + 1).replace(/^_+/u, "") : undefined;
}

function externalToolHeader(
  kind: ExternalToolFrameKind,
  toolName: string | undefined,
  firstLine: string,
): { provider: string; action?: string } {
  const bracketHeader = firstLine.match(/^(?:[•›●]\s+)?\[([A-Za-z][A-Za-z0-9 _-]{0,31})\](?:\s+(\S+))?/u);
  const markerHeader = firstLine.match(/^[•›●]\s+(\S+)(?:\s+(\S+))?/u);
  return {
    provider: bracketHeader?.[1] ?? externalToolProvider(kind, toolName),
    action: externalToolAction(kind, toolName) ?? bracketHeader?.[2] ?? markerHeader?.[2],
  };
}

export function renderExternalToolBackgroundLines(
  contentLines: string[],
  width: number,
  kind: ExternalToolFrameKind,
  expanded: boolean,
  toolName?: string,
  durationMs?: number,
  status: ToolRowStatus = "pending",
  bareHeader = false,
): string[] {
  let displayLines = contentLines;
  const raw = contentLines.length === 1 ? contentLines[0]?.trim() : undefined;
  if (raw?.startsWith("{") || raw?.startsWith("[")) {
    try {
      displayLines = JSON.stringify(JSON.parse(raw), null, 2).split("\n");
    } catch {
      // Keep non-JSON output unchanged.
    }
  }

  const firstLine = displayLines[0] ?? "";
  const hasHeader = /^(?:[•›●]\s+)?\[[A-Za-z][A-Za-z0-9 _-]{0,31}\]/u.test(firstLine)
    || /^[•›●]\s+\S+/u.test(firstLine);
  // Bare header doctrine: provider + tool only. Otherwise an output first
  // line shaped like a header (`[X]`, `● word`) hijacks the header row.
  const header = bareHeader
    ? bareExternalToolHeader(kind, toolName)
    : externalToolHeader(kind, toolName, firstLine);
  const payloadLines = hasHeader && !bareHeader ? displayLines.slice(1) : displayLines;
  const headerLine = externalToolHeaderLine(status, header.provider, header.action);
  displayLines = [headerLine, ...payloadLines];

  const renderedHeader = displayLines[0] ?? "";
  const visiblePayload = expanded ? payloadLines : payloadLines.slice(0, 6);
  const shown = visiblePayload.length;
  const total = payloadLines.length;
  const lineSummary = !expanded && shown < total
    ? `showing ${shown}/${total} lines (ctrl+o expand)`
    : total > 0 ? formatLineLabel(total, "line") : undefined;
  const footerMeta = joinMeta([
    lineSummary,
    formatDuration(durationMs),
    formatPayloadSize(contentLines.join("\n")),
  ]);
  const renderWidth = Math.max(8, width);
  const body = [
    truncateToWidth(renderedHeader, renderWidth),
    ...visiblePayload.map((rawLine) => truncateToWidth(rawLine, renderWidth)),
  ];
  return footerMeta
    ? [...body, `\x1b[2m${truncateToWidth(`└─ ${footerMeta}`, renderWidth)}\x1b[22m`]
    : body;
}

/** Bare header: provider + tool, never sniffed from output or args. */
export function bareExternalToolHeader(
  kind: ExternalToolFrameKind,
  toolName?: string,
): { provider: string; action?: string } {
  const provider = externalToolProvider(kind, toolName);
  const action = externalToolAction(kind, toolName);
  return {
    provider,
    action: action ?? (toolName && toolName !== provider ? toolName : undefined),
  };
}

function renderExternalToolLines(
  lines: string[],
  width: number,
  kind: ExternalToolFrameKind,
  expanded = false,
  toolName?: string,
  durationMs?: number,
  status: ToolRowStatus = "pending",
  bareHeader = false,
): string[] {
  const contentLines = trimRenderedToolLines(lines).filter((line) => !isBlankRenderedLine(line));
  return contentLines.length > 0
    ? renderExternalToolBackgroundLines(contentLines, width, kind, expanded, toolName, durationMs, status, bareHeader)
    : [];
}

async function installExternalToolFramePatch(): Promise<void> {
  const entryPath = resolvePiCodingAgentEntryPath();
  const mod = await import(pathToFileURL(entryPath).href) as {
    ToolExecutionComponent?: ToolExecutionComponentCtor;
  };
  const proto = mod.ToolExecutionComponent?.prototype as
    | (ToolExecutionComponentCtor["prototype"] & {
      [PATCHED_EXTERNAL_TOOL_FRAME]?: number;
      [ORIGINAL_EXTERNAL_RENDER]?: (width: number) => string[];
      [ORIGINAL_EXTERNAL_GET_RENDER_SHELL]?: () => "default" | "self";
    })
    | undefined;
  if (!proto) return;

  const render = selectPatchBase(
    proto.render,
    proto[PATCHED_EXTERNAL_TOOL_FRAME],
    EXTERNAL_TOOL_FRAME_PATCH_VERSION,
    proto[ORIGINAL_EXTERNAL_RENDER],
    "xtrm-ui external tool frame patch",
  );
  if (!render) return;
  proto[ORIGINAL_EXTERNAL_RENDER] ??= render;
  proto[ORIGINAL_EXTERNAL_GET_RENDER_SHELL] ??= proto.getRenderShell;
  const getRenderShell = proto[ORIGINAL_EXTERNAL_GET_RENDER_SHELL];

  proto.getRenderShell = function patchedGetRenderShell(this: PatchableToolExecutionComponent) {
    const kind = externalToolFrameKind(this.toolName);
    if (kind) return "self";
    return getRenderShell?.call(this) ?? "default";
  };

  proto.render = function patchedRender(this: PatchableToolExecutionComponent, width: number) {
    const kind = externalToolFrameKind(this.toolName);
    if (kind) this.__xtrmExternalStartedAt ??= Date.now();
    const rendered = render.call(this, width);
    if (!kind || rendered.length === 0) return rendered;

    if (this.result && this.__xtrmExternalDurationMs == null) {
      this.__xtrmExternalDurationMs = Date.now() - (this.__xtrmExternalStartedAt ?? Date.now());
    }
    const firstContentIndex = rendered.findIndex((line) => !isBlankRenderedLine(line));
    const leading = firstContentIndex > 0 ? rendered.slice(0, firstContentIndex) : [];
    const isExpanded = Boolean(this.expanded);
    const content = externalToolContentLines(this, rendered, isExpanded);
    const bareHeader = !externalToolCodePreview(this.toolName, getToolArgs(this));
    const status: ToolRowStatus = this.result ? (this.result.isError ? "error" : "success") : "pending";
    let styled: string[];
    try {
      styled = renderExternalToolLines(
        content,
        width,
        kind,
        isExpanded,
        this.toolName,
        this.__xtrmExternalDurationMs,
        status,
        bareHeader,
      );
    } catch {
      // A patched renderer must never take the interactive mode down.
      return rendered;
    }
    return styled.length > 0 ? [...leading, ...styled] : rendered;
  };

  proto[PATCHED_EXTERNAL_TOOL_FRAME] = EXTERNAL_TOOL_FRAME_PATCH_VERSION;
}

function applyThinkingChrome(ctx: ExtensionContext): void {
  (ctx.ui as { setHiddenThinkingLabel?: (label?: string) => void }).setHiddenThinkingLabel?.("");
}

// ============================================================================
// Chrome Application
// ============================================================================

function fitVisible(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function resolveThemeForPrefs(prefs: XtrmUiPrefs): XtrmResolvedThemeName {
  if (prefs.toolRowBg) return prefs.themeName;
  return prefs.themeName === "xtrm-light" ? "xtrm-light-flattools" : "xtrm-dark-flattools";
}

function formatThinking(level: string): string {
  return level === "off" ? "standard" : level;
}

function applyXtrmChrome(
  ctx: ExtensionContext,
  prefs: XtrmUiPrefs,
  getThinkingLevel: () => string,
): void {
  if (prefs.forceTheme) {
    ctx.ui.setTheme(resolveThemeForPrefs(prefs));
  }

  ctx.ui.setToolsExpanded(false);
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    const editor = new XtrmEditor(tui, theme, keybindings);
    editor.setPrefs(prefs);
    return editor;
  });

  if (!prefs.showHeader) {
    ctx.ui.setHeader(undefined);
    return;
  }

  ctx.ui.setHeader((_tui, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const boxWidth = width >= 54 ? 50 : Math.max(24, width);
      const model = ctx.model?.id ?? "no-model";
      const thinking = getThinkingLevel();
      const border = (text: string) => theme.fg("borderAccent", text);
      const top = border(`╭${"─".repeat(Math.max(0, boxWidth - 2))}╮`);
      const line1 =
        border("│") +
        fitVisible(
          ` ${theme.fg("dim", ">_")} ${theme.bold("XTRM")} ${theme.fg("dim", "(v1.0.0)")}`,
          boxWidth - 2,
        ) +
        border("│");
      const gap = border("│") + fitVisible("", boxWidth - 2) + border("│");
      const line2 =
        border("│") +
        fitVisible(
          ` ${theme.fg("dim", "model:".padEnd(11))}${model} ${thinking}${theme.fg("accent", "    /model")}${theme.fg("dim", " to change")}`,
          boxWidth - 2,
        ) +
        border("│");
      const line3 =
        border("│") +
        fitVisible(
          ` ${theme.fg("dim", "directory:".padEnd(11))}${basename(ctx.cwd)}`,
          boxWidth - 2,
        ) +
        border("│");
      const bottom = border(`╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`);

      return [top, line1, gap, line2, line3, bottom];
    },
  }));
}


// ============================================================================
// Tool Render Helpers
// ============================================================================

function renderVerticalPreview(theme: any, lines: string[], maxLines: number): string {
  const subset = lines.slice(0, maxLines);
  let text = subset.map((line) => theme.fg("toolOutput", line)).join("\n");
  if (lines.length > maxLines) text += `\n${theme.fg("muted", `… +${lines.length - maxLines} more lines`)}`;
  return text;
}


function lineRange(offset?: number, limit?: number): string | undefined {
  if (offset == null && limit == null) return undefined;
  const start = offset ?? 1;
  if (limit == null) return `${start}`;
  return `${start}-${start + limit - 1}`;
}

const DEFAULT_TOOL_PREVIEW_LINES = 6;

function summarizeCount(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function previewSummary(shown: number, total: number, noun: string, expanded: boolean): string {
  return !expanded && shown < total
    ? `showing ${shown}/${total} ${noun}s (ctrl+o expand)`
    : formatLineLabel(total, noun);
}

// ============================================================================
// Editor (task p38n.3)
// ============================================================================

class XtrmEditor extends CustomEditor {
  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args);
  }

  setPrefs(prefs: XtrmUiPrefs): void {
    this.setPaddingX(prefs.density === "comfortable" ? 2 : 1);
  }

  render(width: number): string[] {
    return super.render(width);
  }
}

// ============================================================================
// Commands
// ============================================================================

function sendInfoMessage(pi: ExtensionAPI, title: string, content: string): void {
  pi.sendMessage({
    customType: "xtrm-ui-info",
    content,
    display: true,
    details: { title },
  });
}

function parseThemeArg(arg: string): XtrmThemeName | undefined {
  const normalized = arg.trim().toLowerCase();
  if (normalized === "dark") return "xtrm-dark";
  if (normalized === "light") return "xtrm-light";
  return undefined;
}

function parseDensityArg(arg: string): XtrmDensity | undefined {
  const normalized = arg.trim().toLowerCase();
  if (normalized === "compact") return "compact";
  if (normalized === "comfortable" || normalized === "normal") return "comfortable";
  return undefined;
}

function parseToggleArg(arg: string): boolean | undefined {
  const normalized = arg.trim().toLowerCase();
  if (normalized === "on") return true;
  if (normalized === "off") return false;
  return undefined;
}

function registerCommands(
  pi: ExtensionAPI,
  getPrefs: () => XtrmUiPrefs,
  setPrefs: (prefs: XtrmUiPrefs) => void,
  getThinkingLevel: () => string,
): void {
  pi.registerMessageRenderer("xtrm-ui-info", (message, _options, theme) => {
    const title = (message.details as { title?: string } | undefined)?.title ?? "XTRM UI";
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(title)), 0, 0));
    box.addChild(new Text(theme.fg("customMessageText", String(message.content ?? "")), 0, 0));
    return box;
  });

  pi.registerCommand("xtrm-ui", {
    description: "Show XTRM UI status and active preferences",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /xtrm-ui", "warning");
        return;
      }

      const prefs = getPrefs();
      const contextUsage = ctx.getContextUsage();
      sendInfoMessage(pi, "XTRM UI status", [
        `Theme: ${prefs.themeName}`,
        `Density: ${prefs.density}`,
        `Show header: ${prefs.showHeader ? "yes" : "no"}`,
        `Force theme: ${prefs.forceTheme ? "on" : "off"}`,
        `Tool row background: ${prefs.toolRowBg ? "on" : "off"}`,
      `Command lines: ${prefs.commandPreviewLines}`,
        `Model: ${ctx.model?.id ?? "none"}`,
        `Context: ${contextUsage?.tokens ?? "unknown"}/${contextUsage?.contextWindow ?? "unknown"}`,
      ].join("\n"));
    },
  });

  pi.registerCommand("xtrm-ui-theme", {
    description: "Switch XTRM UI theme: dark|light",
    getArgumentCompletions: (prefix) => {
      const values = ["dark", "light"].filter((item) => item.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const themeName = parseThemeArg(args);
      if (!themeName) {
        ctx.ui.notify("Usage: /xtrm-ui-theme dark|light", "warning");
        return;
      }
      const prefs = { ...getPrefs(), themeName };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`XTRM UI theme set to ${themeName}`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-density", {
    description: "Switch editor density: compact|comfortable",
    getArgumentCompletions: (prefix) => {
      const values = ["compact", "comfortable"].filter((item) => item.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const density = parseDensityArg(args);
      if (!density) {
        ctx.ui.notify("Usage: /xtrm-ui-density compact|comfortable", "warning");
        return;
      }
      const prefs = { ...getPrefs(), density };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`XTRM UI density set to ${density}`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-header", {
    description: "Toggle XTRM UI header: on|off",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off"].filter((item) => item.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const showHeader = parseToggleArg(args);
      if (showHeader === undefined) {
        ctx.ui.notify("Usage: /xtrm-ui-header on|off", "warning");
        return;
      }
      const prefs = { ...getPrefs(), showHeader };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`XTRM UI header ${showHeader ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-forcetheme", {
    description: "Control whether xtrm-ui overrides the active theme: on|off",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off"].filter((item) => item.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const forceTheme = parseToggleArg(args);
      if (forceTheme === undefined) {
        ctx.ui.notify("Usage: /xtrm-ui-forcetheme on|off", "warning");
        return;
      }
      const prefs = { ...getPrefs(), forceTheme };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`XTRM UI force theme ${forceTheme ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-rowbg", {
    description: "Toggle subtle tool-row background: on|off",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off"].filter((item) => item.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const toolRowBg = parseToggleArg(args);
      if (toolRowBg === undefined) {
        ctx.ui.notify("Usage: /xtrm-ui-rowbg on|off", "warning");
        return;
      }
      const prefs = { ...getPrefs(), toolRowBg };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`Tool row background ${toolRowBg ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-command-lines", {
    description: "Collapsed command/code lines before the hidden-count: 1-20",
    handler: async (args, ctx) => {
      const n = Math.floor(Number(args.trim()));
      if (!Number.isFinite(n) || n < 1 || n > 20) {
        ctx.ui.notify("Usage: /xtrm-ui-command-lines <1-20>", "warning");
        return;
      }
      const prefs = { ...getPrefs(), commandPreviewLines: n };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`Collapsed command lines set to ${n}.`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-reset", {
    description: "Restore XTRM UI defaults",
    handler: async (_args, ctx) => {
      const prefs = { ...DEFAULT_PREFS };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify("XTRM UI reset to defaults", "info");
    },
  });
}

// ============================================================================
// XTRM Tool Renderers
// ============================================================================

type BuiltInTools = ReturnType<typeof createBuiltInTools>;

type XtrmWritePreview =
  | { kind: "created"; lineCount: number }
  | { kind: "updated"; diff: string; additions: number; removals: number }
  | { kind: "unchanged" };

type XtrmToolRenderState = {
  startedAt?: number;
  writePreview?: XtrmWritePreview;
};

type XtrmToolRenderContext = {
  executionStarted: boolean;
  isPartial: boolean;
  state: XtrmToolRenderState;
};

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string) {
  return {
    bash: createBashTool(cwd),
    read: createReadTool(cwd),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    find: createFindTool(cwd),
    grep: createGrepTool(cwd),
    ls: createLsTool(cwd),
  };
}

function getTools(cwd: string): BuiltInTools {
  let tools = toolCache.get(cwd);
  if (!tools) {
    tools = createBuiltInTools(cwd);
    toolCache.set(cwd, tools);
  }
  return tools;
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content.find((content) => content.type === "text");
  return item?.text ?? "";
}

function createWritePreview(path: string, nextContent: string): XtrmWritePreview {
  if (!path || !existsSync(path)) {
    return { kind: "created", lineCount: lineCount(nextContent) };
  }

  let currentContent = "";
  try {
    currentContent = readFileSync(path, "utf8");
  } catch {
    return { kind: "created", lineCount: lineCount(nextContent) };
  }

  if (currentContent === nextContent) return { kind: "unchanged" };

  const diff = createUnifiedLineDiff(currentContent, nextContent);
  const stats = diffStats(diff);
  return {
    kind: "updated",
    diff,
    additions: stats.additions,
    removals: stats.removals,
  };
}

function appendToolTree(
  theme: any,
  lines: string[],
  outputLines: string[],
  meta?: string,
): string {
  outputLines.forEach((line, index) => {
    lines.push(index === 0
      ? `${theme.fg("muted", "└")} ${theme.fg("toolOutput", line)}`
      : `  ${theme.fg("toolOutput", line)}`);
  });
  if (meta) lines.push(theme.fg("dim", meta));
  return lines.join("\n");
}

export function renderBashTree(
  theme: any,
  statusColor: string,
  command: string,
  outputLines: string[] = [],
  meta?: string,
  commandCap: number = DEFAULT_COMMAND_PREVIEW_LINES,
): string {
  const commandColor = statusColor === "success" ? "text" : "dim";
  const allCommands = command.split("\n");
  const cap = Math.min(Math.max(1, commandCap), allCommands.length);
  const [firstCommand = "", ...continuedCommands] = allCommands.slice(0, cap);
  const hiddenCommands = allCommands.length - cap;
  // theme.bold is a chalk no-op in pi's runtime; emit the SGR escape directly.
  const boldCommand = (text: string) => `\x1b[1m${text}\x1b[22m`;
  const countLine = hiddenCommands > 0 ? ` \x1b[2m\x1b[3m … +${hiddenCommands} lines\x1b[23m\x1b[22m` : undefined;
  return appendToolTree(theme, [
    `${theme.fg(statusColor, "●")} ${theme.fg(statusColor, theme.bold("Ran"))} ${boldCommand(theme.fg(commandColor, firstCommand))}`,
    ...continuedCommands.map((line) => boldCommand(theme.fg(commandColor, line))),
    ...(countLine ? [countLine] : []),
  ], outputLines, meta);
}

function renderNamedToolTree(
  theme: any,
  statusColor: string,
  label: string,
  subject: string,
  outputLines: string[] = [],
  meta?: string,
): string {
  const subjectColor = statusColor === "success" ? "text" : "dim";
  return appendToolTree(theme, [
    `${theme.fg(statusColor, "●")} ${theme.fg(statusColor, theme.bold(label))}${subject ? ` ${theme.fg(subjectColor, subject)}` : ""}`,
  ], outputLines, meta);
}

function renderPendingCall(toolName: string, args: Record<string, unknown>, theme: any, commandCap: number = DEFAULT_COMMAND_PREVIEW_LINES): Text {
  if (toolName === "bash") {
    return new Text(renderBashTree(theme, "accent", String(args.command ?? ""), [], undefined, commandCap), 0, 0);
  }
  return new Text(renderNamedToolTree(theme, "accent", toolName, summarizeToolSubject(toolName, args) ?? ""), 0, 0);
}

function summarizeToolSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case "bash": return shortenCommand(String(args.command ?? ""), 52);
    case "read": {
      const path = shortenPath(String(args.path ?? ""), 42);
      const range = lineRange(args.offset as number | undefined, args.limit as number | undefined);
      return range ? `${path}:${range}` : path;
    }
    case "edit":
    case "write": return shortenPath(String(args.path ?? ""), 42);
    case "find":
    case "grep": return String(args.pattern ?? "");
    case "ls": return shortenPath(String(args.path ?? "."), 42);
    default: return undefined;
  }
}

const SERENA_COMPACT_TOOLS = new Set([
  "find_symbol",
  "find_referencing_symbols",
  "insert_after_symbol",
  "replace_symbol_body",
  "read_file",
  "get_symbols_overview",
  "insert_before_symbol",
  "rename_symbol",
  "restart_language_server",
  "jet_brains_get_symbols_overview",
  "jet_brains_find_symbol",
  "jet_brains_find_referencing_symbols",
  "jet_brains_type_hierarchy",
  "search_for_pattern",
  "list_dir",
  "find_file",
  "create_text_file",
  "replace_content",
  "delete_lines",
  "replace_lines",
  "insert_at_line",
  "execute_shell_command",
  "get_current_config",
  "activate_project",
  "remove_project",
  "switch_modes",
  "open_dashboard",
  "check_onboarding_performed",
  "onboarding",
  "initial_instructions",
  "prepare_for_new_conversation",
  "summarize_changes",
  "think_about_collected_information",
  "think_about_task_adherence",
  "think_about_whether_you_are_done",
  "read_memory",
  "write_memory",
  "list_memories",
  "delete_memory",
  "rename_memory",
  "edit_memory",
  "serena_mcp_reset",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function summarizeSerenaSubject(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case "find_symbol":
    case "find_referencing_symbols":
    case "replace_symbol_body":
    case "insert_after_symbol":
    case "insert_before_symbol":
    case "rename_symbol":
    case "jet_brains_find_symbol":
    case "jet_brains_find_referencing_symbols":
    case "jet_brains_type_hierarchy":
      return String(input.name_path_pattern ?? input.name_path ?? "symbol");
    case "get_symbols_overview":
    case "jet_brains_get_symbols_overview":
    case "read_file":
    case "create_text_file":
    case "replace_content":
    case "replace_lines":
    case "delete_lines":
    case "insert_at_line":
    case "list_dir":
    case "find_file":
      return shortenPath(String(input.relative_path ?? input.path ?? "."), 42);
    case "search_for_pattern":
      return shortenCommand(String(input.substring_pattern ?? ""), 52);
    case "read_memory":
    case "write_memory":
    case "delete_memory":
    case "rename_memory":
    case "edit_memory":
      return String(input.memory_name ?? input.old_name ?? "memory");
    case "activate_project":
    case "remove_project":
      return String(input.project ?? input.project_name ?? "project");
    case "switch_modes": {
      const modes = input.modes;
      if (Array.isArray(modes)) return modes.map((mode) => String(mode)).join(",");
      return "modes";
    }
    case "execute_shell_command":
      return shortenCommand(String(input.command ?? ""), 52);
    default:
      return undefined;
  }
}



function normalizeToolLabel(toolName: string): string {
  const gitnexusMap: Record<string, string> = {
    gitnexus_query: "gitnexus query",
    gitnexus_context: "gitnexus context",
    gitnexus_impact: "gitnexus impact",
    gitnexus_detect_changes: "gitnexus detect_changes",
    gitnexus_list_repos: "gitnexus list_repos",
    gitnexus_rename: "gitnexus rename",
    gitnexus_cypher: "gitnexus cypher",
  };

  if (gitnexusMap[toolName]) return gitnexusMap[toolName];

  if (toolName.startsWith("gitnexus_")) {
    return `gitnexus ${toolName.slice("gitnexus_".length)}`;
  }

  const idx = toolName.indexOf("_");
  if (idx > 0) {
    const head = toolName.slice(0, idx);
    const tail = toolName.slice(idx + 1);
    if (head && tail) return `${head} ${tail}`;
  }

  return toolName;
}



const XTRM_BUILTIN_TOOLS = new Set(["bash", "read", "edit", "write", "find", "grep", "ls"]);


function registerXtrmUiTools(pi: ExtensionAPI, getPrefs: () => XtrmUiPrefs): void {
  const tools = getTools(process.cwd());
  const toolRowText = (theme: any, text: string) =>
    new Text(
      text,
      0,
      0,
      getPrefs().toolRowBg ? (line: string) => theme.bg("selectedBg", line) : undefined,
    );
  const renderCall = (
    toolName: string,
    args: Record<string, unknown>,
    theme: any,
    context: XtrmToolRenderContext,
  ) => {
    context.state.startedAt ??= Date.now();
    return context.isPartial && !context.executionStarted
      ? renderPendingCall(toolName, args, theme, getPrefs().commandPreviewLines)
      : toolRowText(theme, "");
  };
  const renderDuration = (context: XtrmToolRenderContext) =>
    formatDuration(context.state.startedAt == null ? undefined : Date.now() - context.state.startedAt);

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: tools.bash.description,
    parameters: tools.bash.parameters,
    execute: tools.bash.execute,
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderCall("bash", args as Record<string, unknown>, theme, context),
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = (result.details ?? {}) as BashToolDetails;
      const args = context.args as Record<string, unknown>;
      const command = String(args.command ?? "");
      if (isPartial) {
        return toolRowText(theme, renderBashTree(theme, "accent", command, [], undefined, getPrefs().commandPreviewLines));
      }
      const output = getTextContent(result as any);
      const outputLines = cleanOutputLines(output);
      const statusColor = context.isError ? "error" : "success";
      const visibleLines = expanded ? outputLines : outputLines.slice(-DEFAULT_TOOL_PREVIEW_LINES);
      const lineSummary = previewSummary(visibleLines.length, outputLines.length, "line", expanded);
      const text = renderBashTree(theme, statusColor, command, visibleLines, joinMeta([
        lineSummary,
        renderDuration(context),
        formatPayloadSize(output),
        details.truncation?.truncated ? "truncated" : undefined,
      ]), getPrefs().commandPreviewLines);
      return toolRowText(theme, text);
    },
  });

  pi.registerTool({
    name: "read",
    label: "read",
    description: tools.read.description,
    parameters: tools.read.parameters,
    execute: tools.read.execute,
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderCall("read", args as Record<string, unknown>, theme, context),
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "read", "loading"));
      const details = (result.details ?? {}) as ReadToolDetails;
      const args = context.args as Record<string, unknown>;
      const subjectBase = shortenPath(String(args.path ?? ""));
      const range = lineRange(args.offset as number | undefined, args.limit as number | undefined);
      const subject = range ? `${subjectBase}:${range}` : subjectBase;
      const first = result.content[0];
      if (first?.type === "image") {
        return toolRowText(theme, renderNamedToolTree(
          theme,
          "success",
          "read",
          subject,
          [],
          joinMeta(["image", renderDuration(context)]),
        ));
      }
      const textContent = getTextContent(result as any);
      const lines = textContent.split("\n");
      const totalLines = lines.length;
      const visibleLines = expanded ? lines : lines.slice(0, DEFAULT_TOOL_PREVIEW_LINES);
      const lineSummary = previewSummary(visibleLines.length, totalLines, "line", expanded);
      const text = renderNamedToolTree(
        theme,
        context.isError ? "error" : "success",
        "read",
        subject,
        totalLines > 0 ? visibleLines : [],
        joinMeta([
          lineSummary,
          renderDuration(context),
          formatPayloadSize(textContent),
          details.truncation?.truncated ? `from ${details.truncation.totalLines}` : undefined,
        ]),
      );
      return toolRowText(theme, text);
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: tools.edit.description,
    parameters: tools.edit.parameters,
    execute: tools.edit.execute,
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderCall("edit", args as Record<string, unknown>, theme, context),
    renderResult(result, { isPartial }, theme, context) {
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "edit", "applying"));
      const details = (result.details ?? {}) as EditToolDetails;
      const args = context.args as Record<string, unknown>;
      const path = String(args.path ?? "");
      const textContent = getTextContent(result as any);
      if (context.isError) {
        return toolRowText(theme, renderNamedToolTree(
          theme,
          "error",
          "edit",
          path,
          [],
          joinMeta([textContent.split("\n")[0], renderDuration(context)]),
        ));
      }
      const stats = details.diff ? diffStats(details.diff) : { additions: 0, removals: 0 };
      const text = renderNamedToolTree(
        theme,
        "success",
        "edit",
        path,
        details.diff ? renderRichDiffPreview(theme, details.diff, 18).split("\n") : [],
        joinMeta([`+${stats.additions}`, `-${stats.removals}`, renderDuration(context)]),
      );
      return toolRowText(theme, text);
    },
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: tools.write.description,
    parameters: tools.write.parameters,
    execute: tools.write.execute,
    renderShell: "self",
    renderCall(args, theme, context) {
      const input = args as Record<string, unknown>;
      const state = context.state as XtrmToolRenderState;
      if (context.argsComplete && !state.writePreview) {
        state.writePreview = createWritePreview(String(input.path ?? ""), String(input.content ?? ""));
      }
      return renderCall("write", input, theme, context);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "write", "writing"));
      const args = context.args as Record<string, unknown>;
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      const textContent = getTextContent(result as any);
      if (context.isError) {
        return toolRowText(theme, renderNamedToolTree(
          theme,
          "error",
          "write",
          path,
          [],
          joinMeta([textContent.split("\n")[0], renderDuration(context)]),
        ));
      }

      const preview = (context.state as XtrmToolRenderState).writePreview;
      if (preview?.kind === "unchanged") {
        return toolRowText(theme, renderNamedToolTree(
          theme,
          "success",
          "write",
          path,
          [],
          joinMeta(["no changes", renderDuration(context)]),
        ));
      }
      if (preview?.kind === "updated") {
        return toolRowText(theme, renderNamedToolTree(
          theme,
          "success",
          "write",
          path,
          preview.diff ? renderRichDiffPreview(theme, preview.diff, 18).split("\n") : [],
          joinMeta([`+${preview.additions}`, `-${preview.removals}`, renderDuration(context)]),
        ));
      }

      const lines = preview?.kind === "created" ? preview.lineCount : lineCount(content);
      const contentLines = content.split("\n");
      const visibleLines = !content ? [] : expanded ? contentLines : contentLines.slice(0, DEFAULT_TOOL_PREVIEW_LINES);
      const text = renderNamedToolTree(
        theme,
        "success",
        "write",
        path,
        visibleLines,
        joinMeta([
          previewSummary(visibleLines.length, lines, "line", expanded),
          renderDuration(context),
          formatPayloadSize(content),
        ]),
      );
      return toolRowText(theme, text);
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description: tools.find.description,
    parameters: tools.find.parameters,
    execute: tools.find.execute,
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderCall("find", args as Record<string, unknown>, theme, context),
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "find", "searching"));
      const details = (result.details ?? {}) as FindToolDetails;
      const args = context.args as Record<string, unknown>;
      const textContent = getTextContent(result as any);
      const count = summarizeCount(textContent);
      const outputLines = count > 0 ? previewLines(textContent, expanded ? 10 : DEFAULT_TOOL_PREVIEW_LINES) : [];
      const text = renderNamedToolTree(
        theme,
        context.isError ? "error" : "success",
        "find",
        String(args.pattern ?? ""),
        outputLines,
        joinMeta([
          previewSummary(Math.min(outputLines.length, count), count, "match", expanded),
          renderDuration(context),
          formatPayloadSize(textContent),
          details.resultLimitReached ? "limit reached" : undefined,
        ]),
      );
      return toolRowText(theme, text);
    },
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description: tools.grep.description,
    parameters: tools.grep.parameters,
    execute: tools.grep.execute,
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderCall("grep", args as Record<string, unknown>, theme, context),
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "grep", "searching"));
      const details = (result.details ?? {}) as GrepToolDetails;
      const args = context.args as Record<string, unknown>;
      const textContent = getTextContent(result as any);
      const count = countPrefixedItems(textContent, ["-- "]) || summarizeCount(textContent);
      const outputLines = textContent.length > 0 ? previewLines(textContent, expanded ? 12 : DEFAULT_TOOL_PREVIEW_LINES) : [];
      const text = renderNamedToolTree(
        theme,
        context.isError ? "error" : "success",
        "grep",
        String(args.pattern ?? ""),
        outputLines,
        joinMeta([
          previewSummary(Math.min(outputLines.length, count), count, "match", expanded),
          renderDuration(context),
          formatPayloadSize(textContent),
          details.matchLimitReached ? "limit reached" : undefined,
        ]),
      );
      return toolRowText(theme, text);
    },
  });

  pi.registerTool({
    name: "ls",
    label: "ls",
    description: tools.ls.description,
    parameters: tools.ls.parameters,
    execute: tools.ls.execute,
    renderShell: "self",
    renderCall: (args, theme, context) =>
      renderCall("ls", args as Record<string, unknown>, theme, context),
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "ls", "listing"));
      const details = (result.details ?? {}) as LsToolDetails;
      const args = context.args as Record<string, unknown>;
      const textContent = getTextContent(result as any);
      const count = summarizeCount(textContent);
      const outputLines = count > 0 ? previewLines(textContent, expanded ? 12 : DEFAULT_TOOL_PREVIEW_LINES) : [];
      const text = renderNamedToolTree(
        theme,
        context.isError ? "error" : "success",
        "ls",
        shortenPath(String(args.path ?? ".")),
        outputLines,
        joinMeta([
          previewSummary(Math.min(outputLines.length, count), count, "entry", expanded),
          renderDuration(context),
          formatPayloadSize(textContent),
          details.entryLimitReached ? "limit reached" : undefined,
        ]),
      );
      return toolRowText(theme, text);
    },
  });
}

// ============================================================================
// Main Extension
// ============================================================================

export default function xtrmUiExtension(pi: ExtensionAPI): void {
  const thinkingPreviewInstall = createThinkingPreviewInstallState(installThinkingPreviewPatch);
  // Warm-up attempt. It can fail while Pi's theme is not initialized yet (the
  // factory runs during resource loading, before initTheme()); session_start
  // below retries via ensureInstalled() before the first message renders.
  void thinkingPreviewInstall.ensureInstalled().catch(() => undefined);
  // Same treatment for the external tool frame patch: fire-and-forget at factory
  // time, retried on session_start. A silent factory-time failure must not leave
  // external tool rows rendering through pi's unpatched default path.
  const externalToolInstall = createThinkingPreviewInstallState(installExternalToolFramePatch);
  void externalToolInstall.ensureInstalled().catch(() => undefined);

  // Keep collapsed thinking rows to one line: the recap is truncated to the
  // render width so the expand hint never wraps or disappears. Runs for both
  // plain assistant text and 'assistant-thinking' blocks (the collapsed row is
  // a thinking block again so pi can add its post-thinking spacer).
  pi.registerMarkdownTransformer((markdown, context) => {
    if (!markdown.includes("Thinking...")) return markdown;
    return fitThinkingRowToWidth(markdown, context.availableWidth);
  });

  let prefs: XtrmUiPrefs = { ...DEFAULT_PREFS };
  const getPrefs = () => prefs;
  const setPrefs = (nextPrefs: XtrmUiPrefs) => {
    prefs = nextPrefs;
  };
  const getThinkingLevel = () => formatThinking(pi.getThinkingLevel());

  registerXtrmUiTools(pi, getPrefs);
  registerCommands(pi, getPrefs, setPrefs, getThinkingLevel);

  const refresh = (ctx: ExtensionContext) => {
    applyXtrmChrome(ctx, prefs, getThinkingLevel);
    applyThinkingChrome(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    // thinkingToggleLatch is process-lifetime module state (the extension
    // factory is cached per process and the prototype patch installs once).
    // Reset it per session so a stale latch from an earlier session cannot
    // flip the first thinking block of a fresh session to the expanded raw
    // trace (xtrm-6ggil).
    thinkingToggleLatch.followsToggle = false;
    setPrefs(loadPrefs(ctx.sessionManager.getEntries() as Array<MaybeCustomEntry>));
    // Await the prototype patch BEFORE the first message can render: a
    // factory-time install failure (theme not initialized yet) must be
    // retried here, after Pi's theme controller has run initTheme(), or the
    // first thinking block renders through Pi's unpatched empty hidden label
    // (xtrm-3tus9). No-op once installed.
    await thinkingPreviewInstall.ensureInstalled().catch((error: unknown) => {
      // If BOTH the factory warm-up AND this session_start retry fail, the
      // prototype patch never installs and Pi's own hideThinkingBlock branch
      // renders an empty label instead of the collapsed one-liner. Surface
      // once per process so the operator sees a signal (silent .catch() is
      // exactly the regression this whole PR closes) — never throw here,
      // session_start must not fail because of this.
      if (!thinkingPreviewInstall.isInstalled()) {
        warnRetryFailedOnce(error);
      }
    });
    // Thinking/editor chrome must not depend on external tool patch startup.
    refresh(ctx);
    // External tool rows: retry the frame patch before session_start returns.
    await externalToolInstall.ensureInstalled().catch((error: unknown) => {
      if (!externalToolInstall.isInstalled()) {
        warnRetryFailedOnce(error);
      }
    });
  });

  // Pi 1.0 has no session_switch/session_fork events. /new, /resume and /fork
  // replace the runtime and emit session_start (reason new|resume|fork) with a
  // fresh ctx, so the session_start handler above already refreshes the chrome.
  // session_before_* would run against the outgoing ctx, which is invalidated.

  pi.on("model_select", async (_event, ctx) => {
    refresh(ctx);
  });

  pi.on("session_shutdown", async () => {
    // No-op: no theme restoration on shutdown
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (!event.text.trim()) return { action: "continue" as const };
    if (event.text.startsWith("/") || event.text.startsWith("!")) return { action: "continue" as const };
    if (event.text.startsWith("› ")) return { action: "continue" as const };
    return event.images
      ? { action: "transform" as const, text: `› ${event.text}`, images: event.images }
      : { action: "transform" as const, text: `› ${event.text}` };
  });

  pi.on("context", async (event) => {
    const messages = event.messages.map((message) => {
      if (message.role === "user" && typeof message.content === "string" && message.content.startsWith("› ")) {
        return { ...message, content: message.content.slice(2) };
      }
      if (message.role === "user" && Array.isArray(message.content)) {
        return {
          ...message,
          content: message.content.map((item, index) =>
            index === 0 && item.type === "text" && item.text.startsWith("› ")
              ? { ...item, text: item.text.slice(2) }
              : item
          ),
        };
      }
      return message;
    });
    return { messages };
  });
}
