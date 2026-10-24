/**
 * Strict grayscale hierarchy (operator palette, 2026-10-24).
 *
 * Luminance, weight and spacing do all the work: no coloured status markers,
 * no provider accents, no tinted paths. Five text levels carry nearly every
 * screen; the border level is structural only. Errors earn prominence from a
 * brighter level and heavier weight plus a marker glyph, never from red.
 *
 * Raw SGR on purpose: chalk decides its level from the TTY/TERM at import time,
 * which makes the same row render styled in one environment and bare in another.
 */

export type GrayRole =
	| "primary"
	| "key"
	| "tool"
	| "action"
	| "path"
	| "thinkingLabel"
	| "thinkingRecap"
	| "meta"
	| "indicator"
	| "border"
	| "inactive"
	| "error";

interface GrayStyle {
	hex: string;
	bold?: boolean;
	italic?: boolean;
}

/**
 * Dark theme (background #181818). Light is the inverse ramp: the same roles
 * step darker instead of lighter so contrast holds on a pale background.
 */
const DARK: Record<GrayRole, GrayStyle> = {
	primary: { hex: "#e5e5e5" },
	key: { hex: "#e5e5e5", bold: true },
	tool: { hex: "#c8c8c8", bold: true },
	action: { hex: "#b0b0b0" },
	path: { hex: "#b8b8b8" },
	thinkingLabel: { hex: "#a0a0a0", bold: true },
	thinkingRecap: { hex: "#858585", italic: true },
	meta: { hex: "#707070" },
	indicator: { hex: "#858585" },
	border: { hex: "#383838" },
	inactive: { hex: "#606060" },
	error: { hex: "#e5e5e5", bold: true },
};

const LIGHT: Record<GrayRole, GrayStyle> = {
	primary: { hex: "#1a1a1a" },
	key: { hex: "#1a1a1a", bold: true },
	tool: { hex: "#333333", bold: true },
	action: { hex: "#4a4a4a" },
	path: { hex: "#3d3d3d" },
	thinkingLabel: { hex: "#5a5a5a", bold: true },
	thinkingRecap: { hex: "#6f6f6f", italic: true },
	meta: { hex: "#7a7a7a" },
	indicator: { hex: "#6f6f6f" },
	border: { hex: "#c8c8c8" },
	inactive: { hex: "#8a8a8a" },
	error: { hex: "#1a1a1a", bold: true },
};

/** Marker that makes an error legible without colour. */
export const ERROR_MARK = "!";

/** Real SGR bold. theme.bold/chalk decides its level from the TTY at import
 *  time, so the same row renders styled in one environment and bare in another. */
export function boldSgr(text: string): string {
	return `\u001b[1m${text}\u001b[22m`;
}

export function grayStyle(themeName: string | undefined, role: GrayRole): GrayStyle {
	return (themeName === "xtrm-light" ? LIGHT : DARK)[role];
}

function rgbSgr(hex: string, text: string): string {
	const h = hex.replace("#", "");
	const r = Number.parseInt(h.slice(0, 2), 16);
	const g = Number.parseInt(h.slice(2, 4), 16);
	const b = Number.parseInt(h.slice(4, 6), 16);
	return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

/** Style one span in a grayscale role. */
export function gray(themeName: string | undefined, role: GrayRole, text: string): string {
	const style = grayStyle(themeName, role);
	let out = rgbSgr(style.hex, text);
	if (style.italic) out = `\u001b[3m${out}\u001b[23m`;
	if (style.bold) out = `\u001b[1m${out}\u001b[22m`;
	return out;
}

/** Lazy-theme form: the theme resolves per call, so a late prefs load is honoured. */
export function grays(themeName: () => string | undefined): (role: GrayRole, text: string) => string {
	return (role, text) => gray(themeName(), role, text);
}
