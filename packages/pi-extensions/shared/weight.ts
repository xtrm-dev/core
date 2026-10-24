/**
 * Operator-row weight ladder (SPEC v1 rule 15, SPECIALISTS-4361).
 *
 * ANSI SGR cannot express an intermediate font weight: it has bold (1),
 * faint (2) and normal (22) only. What a TUI can vary is therefore (a) bold
 * on/off and (b) foreground luminance. This module names the three
 * combinations the UI actually uses, so renderers ask for a weight instead
 * of splicing escape codes, and every surface gets the same ladder.
 *
 *   heavy  bold + muted     one per row at most: identity, a tool name that
 *                           must pop. Real SGR, never theme.bold (chalk
 *                           decides weight from the TTY/TERM at import time).
 *   semi   muted, no bold   the intermediate weight: ultra tool verbs such
 *                           as "Ran shell command".
 *   soft   dim              subjects, outcomes, facts, chrome hints.
 *
 * On a terminal whose bold face is a semibold font (WezTerm, Kitty and
 * iTerm2 all allow a separate bold font), `heavy` renders semibold rather
 * than a heavy face - that is the only real "smaller bold" available, and it
 * is a terminal setting, not something this module can encode.
 *
 * Errors keep the theme's error colour at full strength and skip the ladder:
 * dimming a failure is the one thing the baseline must never do.
 */

import type { EventTheme } from "./event.ts";

export type UiWeight = "heavy" | "semi" | "soft";

const BOLD_ON = "\u001b[1m";
const BOLD_OFF = "\u001b[22m";

/** Real SGR bold. Use instead of theme.bold wherever weight carries meaning. */
export function boldSgr(text: string): string {
  return `${BOLD_ON}${text}${BOLD_OFF}`;
}

/** Theme surface this ladder needs; Pi's Theme satisfies it structurally. */
export interface WeightTheme {
  fg(token: string, text: string): string;
}

/** Apply one weight tier to already-sanitized text. */
export function weightText(theme: WeightTheme, weight: UiWeight, text: string): string {
  switch (weight) {
    case "heavy":
      return boldSgr(theme.fg("muted", text));
    case "semi":
      return theme.fg("muted", text);
    case "soft":
    default:
      return theme.fg("dim", text);
  }
}

/** Fixed-colour fallback for surfaces with no theme handle (ultra external rows). */
export interface WeightPalette {
  muted: string;
  dim: string;
}

/** Truecolor foreground from a #rrggbb literal, no chalk involved. */
export function rgbSgr(hex: string, text: string): string {
  const h = hex.replace("#", "");
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[39m`;
}

/**
 * The same ladder for call sites that only know a fixed palette. `soft`
 * reproduces the dim token exactly (SGR 2 around the colour), so a soft span
 * from here and one from weightText look the same.
 */
export function weightHex(palette: WeightPalette, weight: UiWeight, text: string): string {
  switch (weight) {
    case "heavy":
      return boldSgr(rgbSgr(palette.muted, text));
    case "semi":
      return rgbSgr(palette.muted, text);
    case "soft":
    default:
      return `\u001b[2m${rgbSgr(palette.dim, text)}\u001b[22m`;
  }
}
