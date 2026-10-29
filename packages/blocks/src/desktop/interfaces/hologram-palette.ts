import type { CSSProperties } from "react";

/**
 * Hologram art: the projection's ink, the deck behind it, the alert and
 * your-turn signal tones, and the grid and scanline textures. This is the one
 * Hologram file where literal colors live. The thread itself (the host's
 * `threadView`) never takes these and stays on the theme's tokens.
 *
 * The ink starts as holographic cyan and is pulled toward the theme's
 * primary hue, with lightness and chroma set outright so any primary (blue,
 * mauve, green, near-black) still lands on a legible projection. Dark themes
 * get a deep deck with luminous ink. Light themes get a "daylight" variant:
 * a pale deck with deep ink, so text stays above 4.5:1. Everything is
 * exposed as `--holo-*` custom properties on the root; the root's `dark:`
 * classes swap the dark set in, so it follows the theme without reading the
 * DOM.
 */

/** Cyan pulled two fifths of the way toward the theme's primary. */
const SOURCE = "color-mix(in oklab, oklch(0.8 0.13 205) 58%, var(--primary))";
const tone = (lightness: number, chroma: number, alpha = 1) =>
	alpha === 1
		? `oklch(from var(--holo-src) ${lightness} ${chroma} h)`
		: `oklch(from var(--holo-src) ${lightness} ${chroma} h / ${alpha})`;

const LIGHT = {
	"--holo-alert-l": "oklch(from var(--destructive) min(l, 0.55) c h)",
	"--holo-deck-l": `color-mix(in oklab, var(--background) 78%, ${tone(0.95, 0.025)})`,
	"--holo-dim-l": tone(0.4, 0.045),
	"--holo-faint-l": tone(0.4, 0.045, 0.62),
	"--holo-glow-l": tone(0.6, 0.12, 0.3),
	"--holo-grid-l": tone(0.5, 0.08, 0.055),
	"--holo-ink-l": tone(0.52, 0.12),
	"--holo-line-l": tone(0.5, 0.1, 0.28),
	"--holo-panel-l": tone(0.985, 0.012, 0.82),
	"--holo-scan-l": tone(0.5, 0.08, 0.035),
	"--holo-text-l": tone(0.24, 0.04),
	"--holo-turn-l": "oklch(from var(--warning) min(l, 0.58) max(c, 0.12) h)",
};

const DARK = {
	"--holo-alert-d": "oklch(from var(--destructive) max(l, 0.7) c h)",
	"--holo-deck-d": `color-mix(in oklab, var(--background) 45%, ${tone(0.15, 0.035)})`,
	"--holo-dim-d": tone(0.78, 0.045),
	"--holo-faint-d": tone(0.78, 0.045, 0.6),
	"--holo-glow-d": tone(0.84, 0.12),
	"--holo-grid-d": tone(0.82, 0.12, 0.065),
	"--holo-ink-d": tone(0.84, 0.12),
	"--holo-line-d": tone(0.84, 0.12, 0.26),
	"--holo-panel-d": tone(0.19, 0.035, 0.72),
	"--holo-scan-d": tone(0.84, 0.12, 0.028),
	"--holo-text-d": tone(0.97, 0.02),
	"--holo-turn-d": "oklch(from var(--warning) max(l, 0.8) c h)",
};

/** Inline custom properties for the Hologram root. */
export const HOLO_VARS = {
	"--holo-src": SOURCE,
	...LIGHT,
	...DARK,
} as CSSProperties;

const NAMES = [
	"alert",
	"deck",
	"dim",
	"faint",
	"glow",
	"grid",
	"ink",
	"line",
	"panel",
	"scan",
	"text",
	"turn",
] as const;

/**
 * Picks the daylight or dark set. Kept as one class string on the root, so
 * every part below uses the plain `--holo-ink` / `--holo-deck` names.
 * Spelled out literally so Tailwind's scanner sees every class.
 */
export const HOLO_MODE =
	"[--holo-alert:var(--holo-alert-l)] [--holo-deck:var(--holo-deck-l)] [--holo-dim:var(--holo-dim-l)] [--holo-faint:var(--holo-faint-l)] [--holo-glow:var(--holo-glow-l)] [--holo-grid:var(--holo-grid-l)] [--holo-ink:var(--holo-ink-l)] [--holo-line:var(--holo-line-l)] [--holo-panel:var(--holo-panel-l)] [--holo-scan:var(--holo-scan-l)] [--holo-text:var(--holo-text-l)] [--holo-turn:var(--holo-turn-l)] dark:[--holo-alert:var(--holo-alert-d)] dark:[--holo-deck:var(--holo-deck-d)] dark:[--holo-dim:var(--holo-dim-d)] dark:[--holo-faint:var(--holo-faint-d)] dark:[--holo-glow:var(--holo-glow-d)] dark:[--holo-grid:var(--holo-grid-d)] dark:[--holo-ink:var(--holo-ink-d)] dark:[--holo-line:var(--holo-line-d)] dark:[--holo-panel:var(--holo-panel-d)] dark:[--holo-scan:var(--holo-scan-d)] dark:[--holo-text:var(--holo-text-d)] dark:[--holo-turn:var(--holo-turn-d)]";

/** Every `--holo-*` name the mode string assigns (kept in sync by a test). */
export const HOLO_TOKEN_NAMES: readonly string[] = NAMES;

/** The deck: a 32px projection grid over the deck tone. */
export const DECK_TEXTURE: CSSProperties = {
	backgroundColor: "var(--holo-deck)",
	backgroundImage:
		"linear-gradient(var(--holo-grid) 1px, transparent 1px), linear-gradient(90deg, var(--holo-grid) 1px, transparent 1px)",
	backgroundPosition: "center center",
	backgroundSize: "32px 32px",
};

/** Panels: translucent fill with fine horizontal scanlines. */
export const PANEL_TEXTURE: CSSProperties = {
	backgroundColor: "var(--holo-panel)",
	backgroundImage:
		"repeating-linear-gradient(0deg, var(--holo-scan) 0 1px, transparent 1px 3px)",
};

/**
 * The reactor disc: a dim centre (so the readout stays legible) brightening
 * to a lit rim, then falling off to the deck.
 */
export const CORE_FILL_STOPS = [
	{ offset: "0%", opacity: 0.06 },
	{ offset: "55%", opacity: 0.14 },
	{ offset: "84%", opacity: 0.42 },
	{ offset: "100%", opacity: 0 },
] as const;

/**
 * The open-thread frame: an opaque deck tone (nothing of the HUD bleeds
 * through) with the panels' scanlines.
 */
export const FRAME_TEXTURE: CSSProperties = {
	backgroundColor: "var(--holo-deck)",
	backgroundImage: PANEL_TEXTURE.backgroundImage,
};
