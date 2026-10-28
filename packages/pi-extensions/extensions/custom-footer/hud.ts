/**
 * One-line XTRM status HUD (CORE-2501 follow-up).
 *
 * Git context, context utilization, model/thinking level, token usage and the
 * recent cache hit rate, in that priority order, on one line that never wraps.
 * The Claude statusline (`.xtrm/hooks/statusline.mjs`) prints the same layout and
 * the same cache figure; change them together.
 *
 * Every number comes from a defined scope:
 *  - `↑` input / `↓` output are session totals over assistant-message usage,
 *    exactly like Pi's own footer (`dist/modes/interactive/components/footer.js`).
 *    Claude's statusline input has no session totals, so it omits this segment.
 *  - a response's hit rate is cacheRead / (input + cacheRead + cacheWrite) of one
 *    assistant message. Pi's own footer prints only the latest response (`CH`), which
 *    sits near 98% all session and says nothing. The HUD prints the median of the last
 *    {@link CACHE_WINDOW} responses, plus `(last N%)` when the latest response is at
 *    least {@link CACHE_MISS_GAP} points below that median (a cache miss). A provider
 *    that reports no cache fields yields `undefined`, and the HUD omits the field
 *    rather than inventing a value.
 *  - the context window appears once, inside the context segment.
 *
 * Pure and theme-injected so the render is testable without a terminal.
 */

export interface HudColors {
  fg(color: string, text: string): string;
  bold(text: string): string;
  /**
   * Theme ANSI path (pi's `Theme.style`). Preferred over {@link bold}, which is
   * chalk-backed and degrades to plain text when chalk has no colour level.
   */
  style?(text: string, options: { fg?: string; bold?: boolean }): string;
}

export interface GitContext {
  /** Inside a git work tree. False hides the whole git group. */
  repo: boolean;
  /**
   * Worktree name: the basename of the worktree's top level (`core` for the
   * main checkout, `core-xt-pi-colors` for a linked worktree). This is the
   * human identifier; the commit SHA is not shown for a normal HEAD.
   */
  name?: string;
  /** Current branch; empty for a detached HEAD. */
  branch?: string;
  /** Short commit of the worktree's HEAD; used only to label a detached HEAD. */
  head?: string;
  /**
   * Working-tree/ahead-behind markers: `*` modified, `+` staged, `-` deleted,
   * `↑` ahead, `↓` behind, `↕` diverged.
   */
  flags?: string;
}

export interface HudUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Median hit rate (percent) of the last CACHE_WINDOW responses; undefined when unreported. */
  cacheRate?: number;
  /** The latest response's own hit rate; printed only when it is a clear miss. */
  lastCacheRate?: number;
}

export const CACHE_WINDOW = 10;
export const CACHE_MISS_GAP = 20;

/** Median of a non-empty list (mean of the two middle values for an even count). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const EMPTY_GIT: GitContext = { repo: false };
export const EMPTY_USAGE: HudUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type UsageSides = {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
};

/** The session entry shape the HUD reads. Only usage-carrying entries matter. */
export interface HudEntry {
  type?: string;
  usage?: UsageSides;
  message?: { role?: string; usage?: UsageSides };
}

const MAX_BRANCH = 32;
const MAX_MODEL = 28;
const SEPARATOR = " · ";

function side(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Session usage totals plus the recent cache hit rate.
 *
 * Mirrors Pi's footer accumulation: top-level `usage` entries and
 * assistant-message `usage` are summed; the cache rate is the median over the
 * last CACHE_WINDOW assistant messages that report prompt tokens
 * (input + cacheRead + cacheWrite), and the latest one is kept apart.
 */
export function summarizeHudUsage(entries: readonly HudEntry[] | undefined): HudUsage {
  const usage: HudUsage = { ...EMPTY_USAGE };
  const rates: number[] = [];
  for (const entry of entries ?? []) {
    const sides = entry?.usage;
    if (sides) accumulate(usage, sides);
    const messageUsage = entry?.message?.usage;
    if (!messageUsage) continue;
    accumulate(usage, messageUsage);
    if (entry.message?.role === "assistant") {
      const promptTokens = side(messageUsage.input) + side(messageUsage.cacheRead) + side(messageUsage.cacheWrite);
      if (promptTokens > 0) rates.push((side(messageUsage.cacheRead) / promptTokens) * 100);
    }
  }
  // A provider that reports no cache fields at all must not surface a rate.
  const recent = rates.slice(-CACHE_WINDOW);
  if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && recent.length > 0) {
    usage.cacheRate = median(recent);
    usage.lastCacheRate = recent[recent.length - 1];
  }
  return usage;
}

function accumulate(total: HudUsage, sides: UsageSides): void {
  total.input += side(sides.input);
  total.output += side(sides.output);
  total.cacheRead += side(sides.cacheRead);
  total.cacheWrite += side(sides.cacheWrite);
}

/** Build a git context from raw command output (testable without a repo). */
export function gitContextFrom(parts: {
  toplevel?: string | null;
  branch?: string | null;
  head?: string | null;
  flags?: string | null;
}): GitContext {
  const toplevel = parts.toplevel?.trim();
  if (!toplevel) return { repo: false };
  const branch = parts.branch?.trim() ?? "";
  const head = parts.head?.trim() || undefined;
  const flags = parts.flags?.trim() || undefined;
  const name = toplevel.split(/[\\/]/).filter(Boolean).pop();
  return { repo: true, name: name || undefined, branch: branch || undefined, head, flags };
}

export type GitRunner = (args: readonly string[], cwd: string) => string | null;

/**
 * Resolve the ACTIVE worktree's git context. Every command runs with `cwd` so a
 * linked worktree (`…/.xtrm/worktrees/<name>`) reports its own branch, never the
 * parent repository's.
 */
export function detectGitContext(cwd: string, run: GitRunner): GitContext {
  const toplevel = run(["rev-parse", "--show-toplevel"], cwd);
  if (!toplevel?.trim()) return { repo: false };
  return gitContextFrom({
    toplevel,
    branch: run(["branch", "--show-current"], cwd),
    head: run(["rev-parse", "--short", "HEAD"], cwd),
  });
}

export interface HudState {
  git: GitContext;
  contextPercent?: number | null;
  contextWindow?: number;
  modelId?: string;
  provider?: string;
  showProvider?: boolean;
  reasoning?: boolean;
  thinkingLevel?: string;
  usage: HudUsage;
}

/** Pi's footer token formatting, so both lines read the same. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return count.toString();
  if (count < 10_000) return count % 1000 === 0 ? `${count / 1000}k` : `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * The human identifier is the worktree name, not a commit hash: an 8-hex blob
 * reads like code and crowds out the branch. The SHA appears only for a
 * detached HEAD, where it is the only thing that identifies the checkout.
 */
function repoLabel(git: GitContext): string | undefined {
  // Never truncated: the worktree name is how the operator tells agents apart.
  return git.name || undefined;
}

function branchLabel(git: GitContext): string | undefined {
  if (!git.repo) return undefined;
  const name = git.branch
    ? truncateLabel(git.branch, MAX_BRANCH)
    : git.head ? `detached@${git.head}` : "detached";
  return `(${name}${git.flags ? ` ${git.flags}` : ""})`;
}

function contextLabel(state: HudState): string | undefined {
  const percent = state.contextPercent;
  const window = state.contextWindow && state.contextWindow > 0 ? formatTokens(state.contextWindow) : undefined;
  const knownPercent = typeof percent === "number" && Number.isFinite(percent);
  // Nothing reliable to say: omit the group instead of printing a bare `?`.
  if (!knownPercent && !window) return undefined;
  const percentText = knownPercent ? `${(percent as number).toFixed(1)}%` : "?";
  if (!window) return percentText;
  return `${percentText}/${window}`;
}

function modelLabel(state: HudState): string | undefined {
  const id = state.modelId?.trim();
  if (!id) return undefined;
  const model = truncateLabel(id, MAX_MODEL);
  const provider = state.showProvider && state.provider ? `(${state.provider}) ` : "";
  const level = state.reasoning && state.thinkingLevel && state.thinkingLevel !== "off" ? ` ${state.thinkingLevel}` : "";
  return `${provider}${model}${level}`;
}

function tokenLabel(usage: HudUsage): string | undefined {
  const parts: string[] = [];
  if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function cacheLabel(usage: HudUsage): string | undefined {
  if (typeof usage.cacheRate !== "number" || !Number.isFinite(usage.cacheRate)) return undefined;
  // Clamp: a provider that reports cacheRead above the prompt total must not
  // print a rate outside 0-100.
  const rate = Math.max(0, Math.min(100, usage.cacheRate));
  const text = `${Math.round(rate)}% cache`;
  const last = usage.lastCacheRate;
  if (typeof last !== "number" || !Number.isFinite(last)) return text;
  const lastRate = Math.max(0, Math.min(100, last));
  return rate - lastRate >= CACHE_MISS_GAP ? `${text} (last ${Math.round(lastRate)}%)` : text;
}

/** A display group: priority 0 survives longest (git, then context, …). */
interface HudSegment {
  priority: number;
  plain: string;
  paint: (colors: HudColors | undefined) => string;
  /** Shorter form used when this is the only segment left and still too wide. */
  compact?: { plain: string; paint: (colors: HudColors | undefined) => string };
}

function paint(colors: HudColors | undefined, token: string, text: string, bold = false): string {
  if (!colors) return text;
  if (typeof colors.style === "function") {
    return colors.style(text, bold ? { fg: token, bold: true } : { fg: token });
  }
  const painted = colors.fg(token, text);
  return bold && typeof colors.bold === "function" ? colors.bold(painted) : painted;
}

function buildSegments(state: HudState): HudSegment[] {
  const segments: HudSegment[] = [];
  const repo = state.git.repo;
  const name = repoLabel(state.git);
  const branch = branchLabel(state.git);
  if (repo) {
    const plain = [name, branch].filter(Boolean).join("  ");
    segments.push({
      priority: 0,
      plain: plain || "detached",
      // The worktree name is bold and the branch is full-brightness text: together they
      // say which agent this is, so they carry more weight than the rest of the HUD.
      paint: (colors) => (name && branch
        ? `${paint(colors, "toolTitle", name, true)}  ${paint(colors, "text", branch)}`
        : paint(colors, name ? "toolTitle" : "muted", name ?? branch ?? "detached", !!name)),
      // The worktree name outranks the branch: when only this group is left, shed the branch first.
      compact: name ? { plain: name, paint: (colors) => paint(colors, "toolTitle", name, true) } : undefined,
    });
  }

  const context = contextLabel(state);
  if (context) {
    const percent = state.contextPercent;
    // No colour accent: thresholds move through weight and brightness only.
    const token = typeof percent === "number" && percent > 90 ? "text" : typeof percent === "number" && percent > 70 ? "muted" : "dim";
    const bold = typeof percent === "number" && percent > 70;
    segments.push({ priority: 1, plain: context, paint: (colors) => paint(colors, token, context, bold) });
  }

  const model = modelLabel(state);
  if (model) {
    segments.push({
      priority: 2,
      plain: model,
      paint: (colors) => {
        const id = truncateLabel(state.modelId ?? "", MAX_MODEL);
        const provider = state.showProvider && state.provider ? `(${state.provider}) ` : "";
        const level = state.reasoning && state.thinkingLevel && state.thinkingLevel !== "off"
          ? ` ${paint(colors, "dim", state.thinkingLevel)}`
          : "";
        return `${provider}${paint(colors, "muted", id)}${level}`;
      },
    });
  }

  const tokens = tokenLabel(state.usage);
  if (tokens) segments.push({ priority: 3, plain: tokens, paint: (colors) => paint(colors, "dim", tokens) });

  const cache = cacheLabel(state.usage);
  if (cache) segments.push({ priority: 4, plain: cache, paint: (colors) => paint(colors, "dim", cache) });

  return segments;
}

function joinPlain(segments: readonly HudSegment[]): string {
  return segments.map((segment) => segment.plain).join(SEPARATOR);
}

function visibleLength(text: string): number {
  // The HUD never receives ANSI in `plain`, but branch/model labels can carry
  // wide characters; count them as one column each, which is what a terminal
  // does for the glyphs this HUD prints (↑, ↓, ·).
  return [...text].length;
}

function joinPainted(segments: readonly HudSegment[], colors: HudColors | undefined): string {
  const separator = paint(colors, "dim", "·");
  return segments.map((segment) => segment.paint(colors)).join(` ${separator} `);
}

/**
 * Render the HUD as exactly one line. Segments drop from the lowest priority
 * (cache, then tokens, then model, then context) until the line fits; the git
 * group is the last to go. A final ANSI-aware truncation guarantees one line at
 * any width, so the footer can never wrap.
 */
export function renderHud(state: HudState, width: number, colors?: HudColors, truncate?: (text: string, width: number) => string): string {
  const maxWidth = Math.max(8, Math.floor(Number(width)) || 80);
  let segments = buildSegments(state);
  if (segments.length === 0) return "";

  while (segments.length > 1 && visibleLength(joinPlain(segments)) > maxWidth) {
    let dropIndex = -1;
    let dropPriority = -1;
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index]!.priority > dropPriority) {
        dropPriority = segments[index]!.priority;
        dropIndex = index;
      }
    }
    segments = segments.filter((_, index) => index !== dropIndex);
  }
  const only = segments[0]!;
  if (segments.length === 1 && only.compact && visibleLength(only.plain) > maxWidth) {
    segments = [{ ...only, plain: only.compact.plain, paint: only.compact.paint }];
  }

  const line = joinPainted(segments, colors);
  // Always hand the assembled line to the ANSI-aware truncator when one is
  // available: the code-point count above cannot see double-width glyphs in a
  // branch or model label, and `truncateToWidth` is the only width-true guard.
  if (truncate) return truncate(line, maxWidth);
  if (visibleLength(joinPlain(segments)) <= maxWidth) return line;
  const plain = joinPlain(segments);
  return `${plain.slice(0, Math.max(1, maxWidth - 1))}…`;
}
