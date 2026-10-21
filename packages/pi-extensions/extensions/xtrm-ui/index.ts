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
import chalk from "chalk";
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
  resultPreviewLines: number;
  diffPreviewLines: number;
  extPreviewLines: number;
  extNoCompact: boolean;
  ultracompact: boolean;
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
  resultPreviewLines: 6,
  diffPreviewLines: 18,
  extPreviewLines: 6,
  extNoCompact: false,
  ultracompact: false,
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

export function normalizePrefs(input: unknown, base: XtrmUiPrefs = DEFAULT_PREFS): XtrmUiPrefs {
  if (!input || typeof input !== "object") return { ...base };
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
    commandPreviewLines: normalizeCappedLines(source.commandPreviewLines, base.commandPreviewLines, 20),
    resultPreviewLines: normalizeCappedLines((source as { resultPreviewLines?: unknown }).resultPreviewLines, base.resultPreviewLines, 50),
    diffPreviewLines: normalizeCappedLines((source as { diffPreviewLines?: unknown }).diffPreviewLines, base.diffPreviewLines, 50),
    extPreviewLines: normalizeCappedLines((source as { extPreviewLines?: unknown }).extPreviewLines, base.extPreviewLines, 50),
    extNoCompact: source.extNoCompact ?? DEFAULT_PREFS.extNoCompact,
    ultracompact: (source as { ultracompact?: unknown }).ultracompact === true,
  };
}

function normalizeCappedLines(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(1, n));
}

/** Machine-global xtrm-ui defaults from `~/.pi/settings.json` (`xtrmUi` key).
 * Session entries win; globals beat built-ins. Fail-open: a missing or
 * broken settings file changes nothing. */
export function readGlobalXtrmUi(settingsPath?: string): Partial<XtrmUiPrefs> {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const raw = readFileSync(settingsPath ?? join(home, ".pi", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { xtrmUi?: unknown };
    return typeof parsed.xtrmUi === "object" && parsed.xtrmUi !== null
      ? parsed.xtrmUi as Partial<XtrmUiPrefs>
      : {};
  } catch {
    return {};
  }
}

function loadPrefs(entries: ReadonlyArray<MaybeCustomEntry>): XtrmUiPrefs {
  const base: XtrmUiPrefs = { ...DEFAULT_PREFS, ...readGlobalXtrmUi() };
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === XTRM_UI_PREFS_ENTRY) {
      return normalizePrefs(entry.data, base);
    }
  }
  return base;
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
	/** Collapsed label (dim italic — every collapsed span shares one level, zero bold). */
	label: (text: string) => string;
	/** Collapsed count span (dim italic). The expanded trace uses the expanded style. */
	recap: (text: string) => string;
	/** Collapsed recap span (dim italic). */
	italic: (text: string) => string;
	/** Collapsed hint (dim italic). */
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

/** Collapsed row: every span dim italic at one level, zero bold (assistant
 *  text blocks are trimmed before Markdown render, so literal indentation
 *  cannot survive — distinction from response text comes from the treatment,
 *  not the indent). Dim separator between label, recap, count, expand hint. */
export function buildCollapsedThinkingRow(recap: string, charCount: number, style: ThinkingRowStyle): string {
	return `${style.label("Thinking...")}${style.sep}${style.italic(recap)}${style.sep}${style.recap(String(charCount))} ${style.hint("(Ctrl+T to expand)")}`;
}

/** Expanded block: bold label row with collapse hint, then the full dimmed trace. */
export function buildExpandedThinkingBlock(thinking: string, style: ThinkingRowStyle): string {
	return `${style.label("Thinking...")} ${style.hint("(Ctrl+T to collapse)")}\n\n${style.recap(thinking.trim())}`;
}

/** Collapsed thinking-row style: every span shares one level (dim italic),
 *  zero bold — the row reads distinct from roman full-bright response text.
 *  Raw SGR avoids importing the unbundled theme singleton when pi runs
 *  bundle/cli.js; dim RGB follows the active xtrm theme (dark #8a8a8a,
 *  light #7a7a7a). themeName resolves lazily per call so a session_start
 *  prefs load after patch install still picks up the active theme. */
export function collapsedThinkingStyle(themeName: () => string): ThinkingRowStyle {
	const dim = (text: string) => {
		const rgb = themeName() === "xtrm-light" ? "122;122;122" : "138;138;138";
		return `\x1b[38;2;${rgb}m${text}\x1b[39m`;
	};
	const dimItalic = (text: string) => `\x1b[3m${dim(text)}\x1b[23m`;
	return { label: dimItalic, recap: dimItalic, italic: dimItalic, hint: dimItalic, sep: dim(" · ") };
}

/** Expanded thinking-block style, frozen at the pre-ultra treatment (bold
 *  label, gray trace): the collapsed-only restyle must not touch expanded. */
export const expandedThinkingStyle: ThinkingRowStyle = {
	label: (text) => `\x1b[1m\x1b[38;2;167;167;167m${text}\x1b[39m\x1b[22m`,
	recap: (text) => `\x1b[38;2;167;167;167m${text}\x1b[39m`,
	italic: (text) => `\x1b[3m\x1b[38;2;167;167;167m${text}\x1b[39m\x1b[23m`,
	hint: (text) => `\x1b[38;2;138;138;138m${text}\x1b[39m`,
	sep: `\x1b[38;2;138;138;138m · \x1b[39m`,
};

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
 * a collapsed style, and (optionally) an isolated latch and expanded style.
 */
export function createPatchedUpdateContent(
	updateContent: (message: AssistantMessageLike) => void,
	collapsedStyle: ThinkingRowStyle,
	latch: ThinkingToggleLatch = thinkingToggleLatch,
	expandedStyle: ThinkingRowStyle = collapsedStyle,
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
						? buildCollapsedThinkingRow(buildThinkingRecap(block.thinking), block.thinking.length, collapsedStyle)
						: buildExpandedThinkingBlock(block.thinking, expandedStyle);
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
	// Collapsed rows share one dim-italic level (zero bold); the expanded
	// block keeps its frozen pre-ultra treatment via expandedThinkingStyle.
	// The theme resolves lazily per render so a session_start prefs load
	// after install still picks up the active theme.
	const collapsed = collapsedThinkingStyle(() => activePrefsSnapshot?.themeName ?? DEFAULT_PREFS.themeName);
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
	proto.updateContent = createPatchedUpdateContent(updateContent, collapsed, thinkingToggleLatch, expandedThinkingStyle);
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
const EXTERNAL_TOOL_FRAME_PATCH_VERSION = 40;
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

function collectResultTexts(component: PatchableToolExecutionComponent): string[] {
  return component.result?.content
    ?.filter((content) => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text as string)
    .filter((text) => text.length > 0) ?? [];
}

function extractResultTextLines(component: PatchableToolExecutionComponent): string[] | undefined {
  // Join EVERY text block: codemode ships its result as a wrapper block
  // ("Script completed\nWall time …\nOutput:\n") plus the script output in
  // later blocks — first-block-only would render the wrapper and drop the
  // actual output. Blank seams from the join are filtered downstream.
  const texts = collectResultTexts(component);
  if (texts.length === 0) {
    return [summarizeExternalToolPending(component.toolName, getToolArgs(component))];
  }
  return texts.join("\n").split("\n");
}

/**
 * Result text without the pending-summary fallback. Code tools show their
 * program while waiting, so an empty or partial result must render as no
 * output — not as a `› tool` line the real output then visibly replaces
 * (the native-looking flash on slow code tools).
 */
function resultTextLinesOnly(component: PatchableToolExecutionComponent): string[] | undefined {
  const texts = collectResultTexts(component);
  return texts.length > 0 ? texts.join("\n").split("\n") : undefined;
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
  codeCap: number = DEFAULT_COMMAND_PREVIEW_LINES,
): string[] {
  const preview = externalToolCodePreview(component.toolName, getToolArgs(component));
  if (!preview) return extractResultTextLines(component) ?? rendered;
  // Pending: the program is the content. Resolved: program above output.
  // Collapsed: the header carries line 1, the body shows lines 2..codeCap
  // plus a ` … +N lines` count (same shape as the bash frame), no expand
  // hint — the footer already carries it. The result tail is intentionally
  // NOT capped here: the frame renderer caps code and result against
  // separate budgets, so execution never starves output (or vice versa).
  const cap = Math.max(1, Math.floor(codeCap));
  // Bash semantics: the header carries the first line (via callSummary),
  // so the body starts at the second — otherwise line 1 renders twice.
  const shown = expanded ? preview.slice(1) : preview.slice(1, cap);
  const tail = component.result ? (resultTextLinesOnly(component) ?? []) : [];
  // The tail stays plain: the frame renders it bash-style (muted └ tree,
  // toolOutput color), so dimming here would fight the output treatment.
  // Hidden counts the header line as shown (bash: hidden = total - cap).
  const hidden = preview.length - shown.length - 1;
  const count = !expanded && hidden > 0
    ? [` \x1b[2m\x1b[3m … +${hidden} lines\x1b[23m\x1b[22m`]
    : [];
  const indentedCode = shown.map((l) => (l.length > 0 ? `  ${l}` : l));
  return [...indentedCode, ...count, ...tail];
}

export function collapsedExternalToolLines(contentLines: string[], expanded: boolean, resultCap: number = DEFAULT_PREFS.resultPreviewLines): string[] {
  if (expanded || contentLines.length <= resultCap) return contentLines;
  return [
    ...contentLines.slice(0, resultCap),
    `... (${contentLines.length - resultCap} more lines, ctrl+o to expand)`,
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
  callSummary?: string,
): { provider: string; action?: string } {
  const bracketHeader = firstLine.match(/^(?:[•›●]\s+)?\[([A-Za-z][A-Za-z0-9 _-]{0,31})\](?:\s+(\S+))?/u);
  const markerHeader = firstLine.match(/^[•›●]\s+(\S+)(?:\s+(\S+))?/u);
  return {
    provider: bracketHeader?.[1] ?? externalToolProvider(kind, toolName),
    action: externalToolAction(kind, toolName) ?? bracketHeader?.[2] ?? markerHeader?.[2] ?? callSummary,
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
  resultCap: number = DEFAULT_PREFS.resultPreviewLines,
  callSummary?: string,
  codeCount = 0,
): string[] {
  let displayLines = contentLines;
  const raw = contentLines.length === 1 && codeCount === 0 ? contentLines[0]?.trim() : undefined;
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
  // Code tools always take the bare path: the first content line is program
  // text from args (never sniffable), with the first code line carried as
  // the header summary instead — a code line shaped like `[X]` must neither
  // hijack the header nor eat the payload slice below.
  const bare = bareHeader ? bareExternalToolHeader(kind, toolName) : undefined;
  const header = bareHeader && bare
    ? { provider: bare.provider, action: callSummary ?? bare.action }
    : externalToolHeader(kind, toolName, firstLine, callSummary);
  const payloadLines = hasHeader && !bareHeader ? displayLines.slice(1) : displayLines;
  const headerLine = externalToolHeaderLine(status, header.provider, header.action);
  // Code tools (codemode, python): the leading codeCount payload lines are
  // the executed program — outside the result budget. Collapsing caps the
  // result block only, so a long program never starves output to one line.
  const codeLines = codeCount > 0 ? payloadLines.slice(0, codeCount) : [];
  const resultLines = codeCount > 0 ? payloadLines.slice(codeCount) : payloadLines;
  displayLines = [headerLine, ...codeLines, ...resultLines];

  const renderedHeader = displayLines[0] ?? "";
  const visibleResult = expanded ? resultLines : resultLines.slice(0, resultCap);
  const visiblePayload = [...codeLines, ...visibleResult];
  const shown = visiblePayload.length;
  const total = payloadLines.length;
  const shownResult = visibleResult.length;
  const totalResult = resultLines.length;
  const resultSummary = !expanded && shownResult < totalResult
    ? `showing ${shownResult}/${totalResult} lines (ctrl+o expand)`
    : totalResult > 0 ? formatLineLabel(totalResult, "line") : undefined;
  const lineSummary = codeCount > 0 ? resultSummary : (!expanded && shown < total
    ? `showing ${shown}/${total} lines (ctrl+o expand)`
    : total > 0 ? formatLineLabel(total, "line") : undefined);
  const footerMeta = joinMeta([
    lineSummary,
    formatDuration(durationMs),
    formatPayloadSize(contentLines.join("\n")),
  ]);
  const renderWidth = Math.max(8, width);
  // Payload lines indent two spaces under the flush header (design-system
  // tool rows: header at column 0, everything below carries two spaces).
  // Code previews indent at creation; plain result lines indent here.
  // Code tools (codemode, python) are the exception: native-tool parity.
  // The header above is untouched (dot + provider colors as-is); everything
  // below mirrors the bash tree — bold execution lines, muted └ output
  // anchor, plain dim meta footer with no └─ prefix.
  if (codeCount > 0) {
    const boldCode = (line: string) =>
      status === "success" ? boldSgr(line) : `\x1b[2m${boldSgr(line)}\x1b[22m`;
    const treeOutput = visibleResult.map((line, index) =>
      index === 0 ? `  \x1b[2m└\x1b[22m ${line}` : `    ${line}`,
    );
    const body = [
      truncateToWidth(renderedHeader, renderWidth),
      ...[...codeLines.map(boldCode), ...treeOutput].map((line) => truncateToWidth(line, renderWidth)),
    ];
    return footerMeta
      ? [...body, `\x1b[2m${truncateToWidth(`  ${footerMeta}`, renderWidth)}\x1b[22m`]
      : body;
  }
  const payload = visiblePayload.map((rawLine) =>
    truncateToWidth(rawLine.length > 0 ? `  ${rawLine}` : rawLine, renderWidth),
  );
  const body = [truncateToWidth(renderedHeader, renderWidth), ...payload];
  return footerMeta
    ? [...body, `\x1b[2m${truncateToWidth(`  └─ ${footerMeta}`, renderWidth)}\x1b[22m`]
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

/** Frame styling through chalk — never hardcoded color bytes — so the
 *  frame downgrades per terminal exactly like the native theme-backed rows.
 *  Hexes mirror the xtrm theme tokens (dimGray/errorRed) per active theme.
 *  normalizePrefs collapses themeName to xtrm-dark/xtrm-light, so anything
 *  else falls back to dark (xtrm-ui forces an xtrm theme by default). */
export function ultraThemeHexes(themeName: string): { dim: string; error: string } {
	return themeName === "xtrm-light"
		? { dim: "#7a7a7a", error: "#a85f5f" }
		: { dim: "#8a8a8a", error: "#ff9a9a" };
}

/** Test/embedding hook: override the active prefs snapshot (drives frame
 *  styling and activeUltracompact() without running the extension factory). */
export function setActivePrefsSnapshotForTests(prefs: XtrmUiPrefs | null): void {
	activePrefsSnapshot = prefs;
}

const ultraHexes = () => ultraThemeHexes(activePrefsSnapshot?.themeName ?? DEFAULT_PREFS.themeName);
const ultraDim = (text: string) => faint(chalk.hex(ultraHexes().dim)(text));
const ultraDimBold = (text: string) => faint(chalk.hex(ultraHexes().dim)(chalk.bold(text)));
const ultraRed = (text: string) => chalk.hex(ultraHexes().error)(text);
const ultraRedBold = (text: string) => chalk.hex(ultraHexes().error)(chalk.bold(text));

/** Class B operational tools keep the `●` in ultra rows; every other
 *  external tool takes the two-space indent (Class A). */
const ULTRA_KEEP_DOT = new Set([
  "BashBackground",
  "Monitor",
  "BackgroundStop",
  "SendMessage",
  "ListAgents",
]);

export function ultraExternalSubject(toolName: string | undefined, args: Record<string, unknown>): string | undefined {
  const firstCode = externalToolCodePreview(toolName, args)?.[0]?.trim();
  if (firstCode) return firstCode;
  switch (toolName) {
    case "BashBackground":
      return typeof args.command === "string" && args.command ? shortenCommand(args.command) : undefined;
    case "Monitor": {
      if (typeof args.command === "string" && args.command) return shortenCommand(args.command);
      const ws = asRecord(args.ws);
      return typeof ws?.url === "string" && ws.url ? shortenCommand(ws.url) : undefined;
    }
    case "BackgroundStop":
      return typeof args.task_id === "string" && args.task_id ? args.task_id : undefined;
    case "SendMessage": {
      if (typeof args.to === "string" && args.to) return `to ${args.to}`;
      if (typeof args.reply_to === "string" && args.reply_to) return `reply ${args.reply_to}`;
      if (typeof args.cancel === "string" && args.cancel) return `cancel ${args.cancel}`;
      if (typeof args.status === "string" && args.status) return `status ${args.status}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

export function ultraExternalPrimary(toolName: string | undefined, resultTexts: string[]): string | undefined {
  if (resultTexts.length === 0) return undefined;
  const joined = resultTexts.join("\n");
  if (toolName === "ListAgents") {
    const roster = joined.match(/Peer sessions \((\d+)\)/);
    if (roster) return `${roster[1]} ${roster[1] === "1" ? "peer" : "peers"}`;
  }
  // JSON results pretty-print with a bare `{` first line: summarize the
  // shape instead (`{a, b, +1}`, `[N items]`).
  const trimmed = joined.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const summary = summarizeJsonValue(JSON.parse(trimmed));
      if (summary) return summary;
    } catch {
      // Not actually JSON: fall through to the first-line rule.
    }
  }
  const first = joined.split("\n")
    .map((line) => line.trim())
    // Skip bracket-only echoes (`[GitNexus]` with nothing after it would
    // duplicate the header provider).
    .find((line) => /[A-Za-z0-9]/.test(line) && !/^\s*\[[^\]]*\]\s*$/.test(line));
  return first ? shortenCommand(first, 80) : undefined;
}

function summarizeJsonValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const shown = keys.slice(0, 3).join(", ");
    return keys.length > 3 ? `{${shown}, +${keys.length - 3}}` : `{${shown}}`;
  }
  return undefined;
}

/** Single-line ultra frame row: bare provider/action header (never sniffed),
 *  no `●` except Class B, no `·` — the outcome rides the dim level. */
export function buildUltraExternalLine(
  toolName: string | undefined,
  args: Record<string, unknown>,
  resultTexts: string[],
  status: ToolRowStatus,
): string {
  const kind = externalToolFrameKind(toolName) ?? "external";
  const bare = bareExternalToolHeader(kind, toolName);
  const subject = ultraExternalSubject(toolName, args);
  const primary = resultTexts.length > 0 ? ultraExternalPrimary(toolName, resultTexts) : undefined;
  const isError = status === "error";
  const dot = ULTRA_KEEP_DOT.has(toolName ?? "")
    ? `${isError ? ultraRed("●") : faint(status === "success" ? "\x1b[2m●\x1b[22m" : "●")} `
    : "  ";
  // Uniform with native rows: the whole `used <Tool> [<action>]` head is
  // one bold dim verb span, the subject plain dim after it. No provider
  // accent in ultra — that hue lives in the expanded frame only.
  const span = (text: string) => isError ? ultraRedBold(text) : ultraDimBold(text);
  const sub = (text: string) => isError ? ultraRed(text) : ultraDim(text);
  const actionPart = bare.action && bare.action !== bare.provider ? bare.action : undefined;
  const head = ["used", bare.provider, ...(actionPart ? [actionPart] : [])].join(" ");
  let row = `${dot}${span(head)}`;
  if (subject) row += ` ${sub(subject)}`;
  if (primary) row += `  ${isError ? ultraRed(primary) : ultraDim(primary)}`;
  if (isError && !/fail(ed|ure)?/i.test(primary ?? "")) {
    row += `  ${ultraRed("failed")}`;
  }
  return row;
}

export function renderExternalToolLines(
  lines: string[],
  width: number,
  kind: ExternalToolFrameKind,
  expanded = false,
  toolName?: string,
  durationMs?: number,
  status: ToolRowStatus = "pending",
  bareHeader = false,
  resultCap: number = DEFAULT_PREFS.resultPreviewLines,
  callSummary?: string,
  codeCount = 0,
): string[] {
  // Blank filtering is per-section so the code/result boundary survives it:
  // codeCount indexes pre-filter lines, and the frame needs the post-filter
  // code length to keep the result budget off the program lines.
  const rtrimmed = lines.map((line) => line.replace(/\s+$/u, ""));
  const codeSection = codeCount > 0 ? rtrimmed.slice(0, codeCount) : [];
  const resultSection = codeCount > 0 ? rtrimmed.slice(codeCount) : rtrimmed;
  const keptCode = codeSection.filter((line) => !isBlankRenderedLine(line));
  const contentLines = [...keptCode, ...resultSection.filter((line) => !isBlankRenderedLine(line))];
  return contentLines.length > 0
    ? renderExternalToolBackgroundLines(contentLines, width, kind, expanded, toolName, durationMs, status, bareHeader, resultCap, callSummary, keptCode.length)
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
    const isExpanded = Boolean(this.expanded) || activeExtNoCompact();
    const codeCap = activeCommandPreviewLines();
    const content = externalToolContentLines(this, rendered, isExpanded, codeCap);
    const preview = externalToolCodePreview(this.toolName, getToolArgs(this));
    // Code tools always take the bare header path (first content line is
    // program text, never a sniffable output header); the first code line
    // still rides along as the header summary via callSummary.
    const bareHeader = true;
    const callSummary = preview?.[0]?.trim() || undefined;
    // Pre-filter code-section length: renderExternalToolLines filters blanks
    // per-section and re-derives the boundary, so this stays valid.
    const tailLength = preview && this.result ? (resultTextLinesOnly(this)?.length ?? 0) : 0;
    const codeCount = preview ? Math.max(0, content.length - tailLength) : 0;
    const status: ToolRowStatus = this.result ? (this.result.isError ? "error" : "success") : "pending";
    if (activeUltracompact() && !isExpanded) {
      try {
        const line = buildUltraExternalLine(
          this.toolName,
          getToolArgs(this),
          this.result ? collectResultTexts(this) : [],
          status,
        );
        return [...leading, truncateToWidth(line, Math.max(8, width))];
      } catch {
        return rendered;
      }
    }
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
        activeExtPreviewLines(),
        callSummary,
        codeCount,
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
// Working indicator + turn summary
// ============================================================================

/** True 3x3 X indicator, dots only. A dot travels the real X path through
 *  the true center cell: top-left, center, bottom-right, bottom-left,
 *  center, top-right, then a double flash of the full 3x3 dot-X and the
 *  cycle restarts. The Loader renders the multiline frame verbatim and the
 *  elapsed message rides the bottom row. Engine/timing stay on pi's
 *  documented path (ctx.ui.setWorkingIndicator). Every row carries a
 *  double-tab lead: the Loader never trims, so the working block sits at
 *  the same double indent as the settled summary line. */
const X_DOT = "\u2022";
const X_EMPTY = "\u00b7";
const X_INDENT = "\t\t";
const xRow = (cells: string) => `${X_INDENT}${cells}`;
const xFrame = (top: string, mid: string, bot: string) => `${xRow(top)}\n${xRow(mid)}\n${xRow(bot)}`;
const X_TRACE = [
	xFrame(`${X_DOT}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`),
	xFrame(`${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_DOT}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`),
	xFrame(`${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_DOT}`),
	xFrame(`${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_DOT}${X_EMPTY}${X_EMPTY}`),
	xFrame(`${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_DOT}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`),
	xFrame(`${X_EMPTY}${X_EMPTY}${X_DOT}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`, `${X_EMPTY}${X_EMPTY}${X_EMPTY}`),
];
const X_FULL = xFrame(`${X_DOT}${X_EMPTY}${X_DOT}`, `${X_EMPTY}${X_DOT}${X_EMPTY}`, `${X_DOT}${X_EMPTY}${X_DOT}`);
export const WORKING_FRAMES = [...X_TRACE, X_FULL, "", X_FULL, ""];
export const WORKING_FRAME_MS = 80;
const WORKING_TICK_MS = 1000;

/** Custom entry type for the persisted per-turn summary. Custom entries never
 *  enter LLM context; the entry renderer below draws the transcript line. */
export const XTRM_TURN_SUMMARY_ENTRY = "xtrm-turn-summary";

export interface XtrmTurnSummary {
	seconds: number;
	tokens: number;
}

type UsageSides = { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown };
type UsageLike = { usage?: UsageSides; message?: { usage?: UsageSides } };

function usageSidesTotal(usage: UsageSides): number {
	// Fresh tokens only: input + output + cacheWrite. cacheRead re-transmits
	// the whole context on every response (~98% of the raw sum), so counting
	// it makes every turn look session-sized. totalTokens is unusable here
	// because it already includes cacheRead.
	let total = 0;
	for (const key of ["input", "output", "cacheWrite"] as const) {
		const value = usage[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) total += value;
	}
	return total;
}

/** Defensive usage total: usage lives on assistant message entries
 *  (entry.message.usage), not on top-level entry.usage — standalone usage
 *  entries are rare (cache warming). Sums both, ignoring everything else. */
export function sumUsageTokens(entries: Array<UsageLike>): number {
	let total = 0;
	for (const entry of entries) {
		if (entry?.usage) total += usageSidesTotal(entry.usage);
		const messageUsage = entry?.message?.usage;
		if (messageUsage) total += usageSidesTotal(messageUsage);
	}
	return Math.round(total);
}

export function formatTokenCount(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

export function formatTurnSummary(summary: XtrmTurnSummary): string {
	return `worked for ${summary.seconds}s, used ${formatTokenCount(summary.tokens)} tokens`;
}

/** Applies the dot frames through pi's documented WorkingIndicatorOptions. */
export function applyWorkingIndicator(ui: { setWorkingIndicator: (options: { frames: string[]; intervalMs: number }) => void }): void {
	ui.setWorkingIndicator({ frames: [...WORKING_FRAMES], intervalMs: WORKING_FRAME_MS });
}

type TurnClock = {
	startedAt: number;
	endedAt: number | undefined;
	tokensAtStart: number;
	timer: ReturnType<typeof setInterval> | undefined;
	ui: { setWorkingMessage: (message?: string) => void } | undefined;
};
const turnClock: TurnClock = { startedAt: 0, endedAt: undefined, tokensAtStart: 0, timer: undefined, ui: undefined };

function stopTurnClock(): void {
	if (turnClock.timer !== undefined) clearInterval(turnClock.timer);
	turnClock.timer = undefined;
	turnClock.ui = undefined;
}

/** Starts the elapsed ticker on agent_start; the message updates live while
 *  pi animates the (custom) frames. now/schedule are injectable for tests. */
export function startTurnClock(
	ui: { setWorkingMessage: (message?: string) => void },
	tokensAtStart: number,
	now: number = Date.now(),
	schedule: (fn: () => void, ms: number) => ReturnType<typeof setInterval> = setInterval,
): void {
	stopTurnClock();
	turnClock.startedAt = now;
	turnClock.endedAt = undefined;
	turnClock.tokensAtStart = tokensAtStart;
	turnClock.ui = ui;
	ui.setWorkingMessage("elapsed 0s");
	turnClock.timer = schedule(() => {
		const elapsed = Math.max(0, Math.round((Date.now() - turnClock.startedAt) / 1000));
		turnClock.ui?.setWorkingMessage(`elapsed ${elapsed}s`);
	}, WORKING_TICK_MS);
}

/** Freezes the ticker at turn end but keeps the totals: the final assistant
 *  message entry may land after agent_end, so measuring happens at settle. */
export function freezeTurnClock(now: number = Date.now()): void {
	if (turnClock.timer !== undefined) clearInterval(turnClock.timer);
	turnClock.timer = undefined;
	turnClock.endedAt = now;
}

/** Returns the turn totals from the frozen clock (null when no clock runs,
 *  so double-settle can never append twice). */
export function stopTurnClockAndSummarize(tokensAtEnd: number): XtrmTurnSummary | null {
	if (turnClock.ui === undefined) return null;
	const end = turnClock.endedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - turnClock.startedAt) / 1000));
	const summary = { seconds, tokens: Math.max(0, Math.round(tokensAtEnd - turnClock.tokensAtStart)) };
	stopTurnClock();
	return summary;
}

function sessionUsageTokens(ctx: ExtensionContext): number {
	return sumUsageTokens(ctx.sessionManager.getEntries() as Array<UsageLike>);
}

function registerTurnSummary(pi: ExtensionAPI): void {
	pi.registerEntryRenderer(XTRM_TURN_SUMMARY_ENTRY, (entry, _options, theme) => {
		const data = (entry as { data?: Partial<XtrmTurnSummary> }).data ?? {};
		// Double-tab lead (Text expands tabs, unlike Markdown which trims):
		// the settled line keeps the working row's double indent.
		return new Text("\t\t" + theme.fg("dim", theme.italic(formatTurnSummary({
			seconds: Math.max(0, Math.round(Number(data.seconds) || 0)),
			tokens: Math.max(0, Math.round(Number(data.tokens) || 0)),
		}))), 0, 0);
	});
	pi.on("agent_start", (_event, ctx) => {
		startTurnClock(ctx.ui, sessionUsageTokens(ctx));
	});
	pi.on("agent_end", () => {
		freezeTurnClock();
	});
	pi.on("agent_settled", (_event, ctx) => {
		const summary = stopTurnClockAndSummarize(sessionUsageTokens(ctx));
		if (summary) pi.appendEntry(XTRM_TURN_SUMMARY_ENTRY, summary);
	});
	pi.on("session_shutdown", () => {
		stopTurnClock();
	});
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
      `Result lines: ${prefs.resultPreviewLines}`,
      `Diff lines: ${prefs.diffPreviewLines}`,
      `Extension lines: ${prefs.extPreviewLines}`,
      `Extension compaction: ${prefs.extNoCompact ? "off" : "on"}`,
      `Ultracompact: ${!prefs.ultracompact ? "off" : prefs.extNoCompact ? "on (idle: extension compaction is off)" : "on"}`,
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

  pi.registerCommand("xtrm-ui-result-lines", {
    description: "Collapsed result lines before the hidden-count: 1-50",
    handler: async (args, ctx) => {
      const n = Math.floor(Number(args.trim()));
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        ctx.ui.notify("Usage: /xtrm-ui-result-lines <1-50>", "warning");
        return;
      }
      const prefs = { ...getPrefs(), resultPreviewLines: n };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`Collapsed result lines set to ${n}.`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-ext-lines", {
    description: "Compacted visible lines for extension tool frames: 1-50",
    handler: async (args, ctx) => {
      const n = Math.floor(Number(args.trim()));
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        ctx.ui.notify("Usage: /xtrm-ui-ext-lines <1-50>", "warning");
        return;
      }
      const prefs = { ...getPrefs(), extPreviewLines: n };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`Extension compacted lines set to ${n}.`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-ext-compact", {
    description: "Compact extension tool output: on|off (off never compacts)",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off"].filter((item) => item.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const on = parseToggleArg(args);
      if (on === undefined) {
        ctx.ui.notify("Usage: /xtrm-ui-ext-compact on|off", "warning");
        return;
      }
      const prefs = { ...getPrefs(), extNoCompact: !on };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`Extension compaction ${on ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-ultra", {
    description: "Ultracompact tool rows (header-only Class A, one-line Class B): on|off",
    getArgumentCompletions: (prefix) => {
      const values = ["on", "off"].filter((item) => item.startsWith(prefix));
      return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const on = parseToggleArg(args);
      if (on === undefined) {
        ctx.ui.notify("Usage: /xtrm-ui-ultra on|off", "warning");
        return;
      }
      const prefs = { ...getPrefs(), ultracompact: on };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`Ultracompact rows ${on ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.registerCommand("xtrm-ui-diff-lines", {
    description: "Diff preview lines for edit/write rows: 1-50",
    handler: async (args, ctx) => {
      const n = Math.floor(Number(args.trim()));
      if (!Number.isFinite(n) || n < 1 || n > 50) {
        ctx.ui.notify("Usage: /xtrm-ui-diff-lines <1-50>", "warning");
        return;
      }
      const prefs = { ...getPrefs(), diffPreviewLines: n };
      setPrefs(prefs);
      persistPrefs(pi, prefs);
      applyXtrmChrome(ctx, prefs, getThinkingLevel);
      ctx.ui.notify(`Diff preview lines set to ${n}.`, "info");
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
  const indented = lines.map((line, index) => (index === 0 || line.length === 0 ? line : `  ${line}`));
  outputLines.forEach((line, index) => {
    indented.push(index === 0
      ? `  ${theme.fg("muted", "└")} ${theme.fg("toolOutput", line)}`
      : `    ${theme.fg("toolOutput", line)}`);
  });
  if (meta) indented.push(`  ${theme.fg("dim", meta)}`);
  return indented.join("\n");
}

/** Live prefs snapshot for module-level render paths (the prototype patch has
 * no factory closure). Display only — the model always sees full args. */
let activePrefsSnapshot: XtrmUiPrefs | null = null;
export function activeResultPreviewLines(): number {
  return activePrefsSnapshot?.resultPreviewLines ?? DEFAULT_PREFS.resultPreviewLines;
}

/** Display-only cap for the executed-program section of code tools
 * (`/xtrm-ui-command-lines`). Mirrors the native bash command cap. */
export function activeCommandPreviewLines(): number {
  return activePrefsSnapshot?.commandPreviewLines ?? DEFAULT_PREFS.commandPreviewLines;
}

/** Compacted visible-line cap for extension frames (`/xtrm-ui-ext-lines`). */
export function activeExtPreviewLines(): number {
  return activePrefsSnapshot?.extPreviewLines ?? DEFAULT_PREFS.extPreviewLines;
}

/** Never compact extension output (`/xtrm-ui-ext-compact off`). */
export function activeExtNoCompact(): boolean {
  return activePrefsSnapshot?.extNoCompact ?? DEFAULT_PREFS.extNoCompact;
}

/** Ultracompact rows (`/xtrm-ui-ultra on`): header-only Class A, one-line Class B. Collapsed only. */
export function activeUltracompact(): boolean {
  return activePrefsSnapshot?.ultracompact ?? DEFAULT_PREFS.ultracompact;
}

/** Display-only segmentation: a `&&`/`||` chain is one string, so split it
 * into visual segments before capping — otherwise chained writes never
 * compact. The model still receives the raw command; a `&&` inside quotes
 * may mis-split on screen and nowhere else. */
export function splitCommandSegments(command: string): string[] {
  const parts = command.split(/ (&&|\|\|) /);
  const segments: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const op = parts[i + 1];
    segments.push(op ? `${parts[i]} ${op}` : (parts[i] ?? ""));
  }
  return segments.filter((s) => s.length > 0);
}

export function renderBashTree(
  theme: any,
  statusColor: string,
  command: string,
  outputLines: string[] = [],
  meta?: string,
  commandCap: number = DEFAULT_COMMAND_PREVIEW_LINES,
  expanded = false,
): string {
  const commandColor = statusColor === "success" ? "text" : "dim";
  const allCommands = splitCommandSegments(command).flatMap((seg) => seg.split("\n"));
  const cap = expanded ? allCommands.length : Math.min(Math.max(1, commandCap), allCommands.length);
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

// ============================================================================
// Ultracompact rows (/xtrm-ui-ultra on). Collapsed only; expanded keeps the
// current rendering verbatim. No `●` on Class A (two-space indent matches the
// `● ` width), no `·` anywhere — fields split by dimming levels over
// two-space gaps. Thinking rows are untouched.
// ============================================================================

export interface UltraRowParts {
  statusColor: string;
  verb: string;
  subject?: string;
  /** Primary meta: dim level. */
  primary?: string;
  /** Secondary meta: muted level. */
  secondary?: string;
  /** Class B operational tools keep the `●`; Class A takes the indent. */
  dot?: boolean;
}

export function renderUltraRow(theme: any, parts: UltraRowParts): string {
  const isError = parts.statusColor === "error";
  // Ultra dim baseline: nothing renders full-bright. Verb and subject drop
  // to standard dim, fainted; outcomes sit one level dimmer. Colored spans
  // keep their hue under the faint. Errors keep full red so failures
  // survive dimming — the one exception.
  const verb = isError
    ? theme.fg("error", theme.bold(parts.verb))
    : faint(theme.fg("dim", theme.bold(parts.verb)));
  const subject = parts.subject
    ? isError ? theme.fg("error", parts.subject) : faint(theme.fg("dim", parts.subject))
    : "";
  const dot = parts.dot
    ? `${isError ? theme.fg("error", "●") : faint(theme.fg(parts.statusColor, "●"))} `
    : "  ";
  let row = subject ? `${dot}${verb} ${subject}` : `${dot}${verb}`;
  if (parts.primary) row += `  ${isError ? theme.fg("error", parts.primary) : faint(theme.fg("dim", parts.primary))}`;
  if (parts.secondary) row += `  ${isError ? theme.fg("error", parts.secondary) : faint(theme.fg("muted", parts.secondary))}`;
  // Explicit failure word: dimming removed the color cue, so failed rows
  // say so (skipped when the outcome already says fail-*).
  if (isError && !/fail(ed|ure)?/i.test(`${parts.primary ?? ""} ${parts.secondary ?? ""}`)) {
    row += `  ${theme.fg("error", "failed")}`;
  }
  return row;
}

/** Faint wrapper: the ultra dim baseline (nothing full-bright). */
function faint(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

/** First command segment without a dangling `&&`/`||` tail. */
export function ultraBashSubject(command: string): string {
  const first = splitCommandSegments(command)[0] ?? "";
  return shortenCommand(first.replace(/\s*(&&|\|\|)\s*$/, ""));
}

/** Ultra verb for shell calls: the full phrase, not bare `Ran`. */
export const ULTRA_BASH_VERB = "Ran shell command";

function renderUltraPendingCall(theme: any, toolName: string, args: Record<string, unknown>): Text {
  const verb = toolName === "bash" ? ULTRA_BASH_VERB : toolName;
  const subject = toolName === "bash"
    ? ultraBashSubject(String(args.command ?? ""))
    : summarizeToolSubject(toolName, args);
  return new Text(renderUltraRow(theme, { statusColor: "accent", verb, subject }), 0, 0);
}

function renderPendingCall(toolName: string, args: Record<string, unknown>, theme: any, commandCap: number = DEFAULT_COMMAND_PREVIEW_LINES, expanded = false): Text {
  if (toolName === "bash") {
    return new Text(renderBashTree(theme, "accent", String(args.command ?? ""), [], undefined, commandCap, expanded), 0, 0);
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
    if (context.isPartial && !context.executionStarted) {
      if (getPrefs().ultracompact) return renderUltraPendingCall(theme, toolName, args);
      return renderPendingCall(toolName, args, theme, getPrefs().commandPreviewLines);
    }
    return toolRowText(theme, "");
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
      if (getPrefs().ultracompact && !expanded) {
        return toolRowText(theme, renderUltraRow(theme, {
          statusColor: isPartial ? "accent" : context.isError ? "error" : "success",
          verb: ULTRA_BASH_VERB,
          subject: ultraBashSubject(command),
        }));
      }
      if (isPartial) {
        return toolRowText(theme, renderBashTree(theme, "accent", command, [], undefined, getPrefs().commandPreviewLines, expanded));
      }
      const output = getTextContent(result as any);
      const outputLines = cleanOutputLines(output);
      const statusColor = context.isError ? "error" : "success";
      const visibleLines = expanded ? outputLines : outputLines.slice(-getPrefs().resultPreviewLines);
      const lineSummary = previewSummary(visibleLines.length, outputLines.length, "line", expanded);
      const text = renderBashTree(theme, statusColor, command, visibleLines, joinMeta([
        lineSummary,
        renderDuration(context),
        formatPayloadSize(output),
        details.truncation?.truncated ? "truncated" : undefined,
      ]), getPrefs().commandPreviewLines, expanded);
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
      if (getPrefs().ultracompact && !expanded) {
        const ultraArgs = context.args as Record<string, unknown>;
        const base = shortenPath(String(ultraArgs.path ?? ""));
        const ultraRange = lineRange(ultraArgs.offset as number | undefined, ultraArgs.limit as number | undefined);
        const first = result.content[0];
        return toolRowText(theme, renderUltraRow(theme, {
          statusColor: isPartial ? "accent" : context.isError ? "error" : "success",
          verb: "read",
          subject: ultraRange ? `${base}:${ultraRange}` : base,
          primary: !isPartial && first?.type === "image" ? "image" : undefined,
        }));
      }
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
      const visibleLines = expanded ? lines : lines.slice(0, getPrefs().resultPreviewLines);
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
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (getPrefs().ultracompact && !expanded) {
        const ultraArgs = context.args as Record<string, unknown>;
        const ultraDetails = (result.details ?? {}) as EditToolDetails;
        const stats = ultraDetails.diff ? diffStats(ultraDetails.diff) : undefined;
        const ultraText = getTextContent(result as any);
        return toolRowText(theme, renderUltraRow(theme, {
          statusColor: isPartial ? "accent" : context.isError ? "error" : "success",
          verb: "edit",
          subject: shortenPath(String(ultraArgs.path ?? ""), 42),
          primary: context.isError || isPartial
            ? ultraText.split("\n")[0] || undefined
            : stats ? `+${stats.additions} -${stats.removals}` : undefined,
        }));
      }
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
        details.diff ? renderRichDiffPreview(theme, details.diff, getPrefs().diffPreviewLines).split("\n") : [],
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
      if (getPrefs().ultracompact && !expanded) {
        const ultraArgs = context.args as Record<string, unknown>;
        const ultraContent = String(ultraArgs.content ?? "");
        const ultraPreview = (context.state as XtrmToolRenderState).writePreview;
        const ultraText = getTextContent(result as any);
        const primary = context.isError || isPartial
          ? ultraText.split("\n")[0] || undefined
          : ultraPreview?.kind === "updated"
            ? `+${ultraPreview.additions} -${ultraPreview.removals}`
            : ultraPreview?.kind === "created"
              ? `${ultraPreview.lineCount} lines`
              : ultraPreview?.kind === "unchanged"
                ? "no changes"
                : ultraContent ? `${lineCount(ultraContent)} lines` : undefined;
        return toolRowText(theme, renderUltraRow(theme, {
          statusColor: isPartial ? "accent" : context.isError ? "error" : "success",
          verb: "write",
          subject: shortenPath(String(ultraArgs.path ?? ""), 42),
          primary,
        }));
      }
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
          preview.diff ? renderRichDiffPreview(theme, preview.diff, getPrefs().diffPreviewLines).split("\n") : [],
          joinMeta([`+${preview.additions}`, `-${preview.removals}`, renderDuration(context)]),
        ));
      }

      const lines = preview?.kind === "created" ? preview.lineCount : lineCount(content);
      const contentLines = content.split("\n");
      const visibleLines = !content ? [] : expanded ? contentLines : contentLines.slice(0, getPrefs().resultPreviewLines);
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
      if (getPrefs().ultracompact && !expanded) {
        const ultraArgs = context.args as Record<string, unknown>;
        const ultraText = getTextContent(result as any);
        const count = summarizeCount(ultraText);
        return toolRowText(theme, renderUltraRow(theme, {
          statusColor: isPartial ? "accent" : context.isError ? "error" : "success",
          verb: "find",
          subject: String(ultraArgs.pattern ?? ""),
          primary: !isPartial && !context.isError && count > 0 ? `${count} ${count === 1 ? "match" : "matches"}` : undefined,
        }));
      }
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "find", "searching"));
      const details = (result.details ?? {}) as FindToolDetails;
      const args = context.args as Record<string, unknown>;
      const textContent = getTextContent(result as any);
      const count = summarizeCount(textContent);
      const outputLines = count > 0 ? previewLines(textContent, expanded ? 10 : getPrefs().resultPreviewLines) : [];
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
      if (getPrefs().ultracompact && !expanded) {
        const ultraArgs = context.args as Record<string, unknown>;
        const ultraText = getTextContent(result as any);
        const count = countPrefixedItems(ultraText, ["-- "]) || summarizeCount(ultraText);
        return toolRowText(theme, renderUltraRow(theme, {
          statusColor: isPartial ? "accent" : context.isError ? "error" : "success",
          verb: "grep",
          subject: String(ultraArgs.pattern ?? ""),
          primary: !isPartial && !context.isError && count > 0 ? `${count} ${count === 1 ? "match" : "matches"}` : undefined,
        }));
      }
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "grep", "searching"));
      const details = (result.details ?? {}) as GrepToolDetails;
      const args = context.args as Record<string, unknown>;
      const textContent = getTextContent(result as any);
      const count = countPrefixedItems(textContent, ["-- "]) || summarizeCount(textContent);
      const outputLines = textContent.length > 0 ? previewLines(textContent, expanded ? 12 : getPrefs().resultPreviewLines) : [];
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
      if (getPrefs().ultracompact && !expanded) {
        const ultraArgs = context.args as Record<string, unknown>;
        const ultraText = getTextContent(result as any);
        const count = summarizeCount(ultraText);
        return toolRowText(theme, renderUltraRow(theme, {
          statusColor: isPartial ? "accent" : context.isError ? "error" : "success",
          verb: "ls",
          subject: shortenPath(String(ultraArgs.path ?? ".")),
          primary: !isPartial && !context.isError && count > 0 ? `${count} ${count === 1 ? "entry" : "entries"}` : undefined,
        }));
      }
      if (isPartial) return toolRowText(theme, renderNamedToolTree(theme, "accent", "ls", "listing"));
      const details = (result.details ?? {}) as LsToolDetails;
      const args = context.args as Record<string, unknown>;
      const textContent = getTextContent(result as any);
      const count = summarizeCount(textContent);
      const outputLines = count > 0 ? previewLines(textContent, expanded ? 12 : getPrefs().resultPreviewLines) : [];
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
    activePrefsSnapshot = nextPrefs;
  };
  const getThinkingLevel = () => formatThinking(pi.getThinkingLevel());

  registerXtrmUiTools(pi, getPrefs);
  registerTurnSummary(pi);
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
    applyWorkingIndicator(ctx.ui);
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
