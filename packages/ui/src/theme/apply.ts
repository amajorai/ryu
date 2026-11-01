// Applies a ThemeVariant to the DOM by writing CSS custom properties on
// <html>. Shared by every Ryu surface so a preset renders identically wherever
// it is applied. Browser-only (touches `document`), but free of any storage
// concern — callers pass contrast/radius in.

import type { ThemeVariant } from "./presets.ts";

const ALL_THEME_VARS = [
	"--background",
	"--foreground",
	"--card",
	"--card-foreground",
	"--popover",
	"--popover-foreground",
	"--primary",
	"--primary-foreground",
	"--secondary",
	"--secondary-foreground",
	"--muted",
	"--muted-foreground",
	"--accent",
	"--accent-foreground",
	"--destructive",
	"--border",
	"--input",
	"--ring",
	"--sidebar",
	"--sidebar-foreground",
	"--sidebar-primary",
	"--sidebar-primary-foreground",
	"--sidebar-accent",
	"--sidebar-accent-foreground",
	"--sidebar-border",
	"--sidebar-ring",
];

// Popover surfaces intentionally get NO inline value: globals.css derives them
// from --muted / --foreground so overlay menus always track the (customizable)
// muted colour instead of a fixed per-preset value. Skipping them when applying
// a variant lets the stylesheet's var() references win. (--card is NOT included:
// some surfaces layer bg-card against bg-muted and need the two to stay
// distinct, so --card keeps its own per-variant value.)
const MUTED_DERIVED_VARS = new Set(["--popover", "--popover-foreground"]);

const MUTED_BASE_VARS = ["--muted-base", "--muted-foreground-base"];

// Keys applyVariant always clears itself; anything else a variant writes is an
// "extra" token whose prior inline value is tracked so it can be restored.
const CORE_THEME_VARS = new Set([...ALL_THEME_VARS, ...MUTED_BASE_VARS]);

interface WrittenExtraToken {
	/** The inline value the key had before the variant wrote it ("" = none). */
	previous: string;
	/** The inline value the variant wrote, as the browser stored it. */
	written: string;
}

// Per root element: the extra tokens (e.g. --chart-1, --radius, --font-sans)
// the last applyVariant wrote, so a temporary theme never leaks past a switch.
const writtenExtraTokens = new WeakMap<
	HTMLElement,
	Map<string, WrittenExtraToken>
>();

function removeThemeVars(el: HTMLElement) {
	for (const v of ALL_THEME_VARS) {
		el.style.removeProperty(v);
	}
	for (const v of MUTED_BASE_VARS) {
		el.style.removeProperty(v);
	}
}

/**
 * Undo the extra tokens the last variant wrote. A key still holding the
 * variant's value gets its earlier inline value back (or is removed); a key
 * something else changed since (e.g. the radius slider) is left alone.
 */
function restoreExtraTokens(el: HTMLElement) {
	const extras = writtenExtraTokens.get(el);
	if (!extras) {
		return;
	}
	writtenExtraTokens.delete(el);
	for (const [key, { previous, written }] of extras) {
		if (el.style.getPropertyValue(key) !== written) {
			continue;
		}
		if (previous === "") {
			el.style.removeProperty(key);
		} else {
			el.style.setProperty(key, previous);
		}
	}
}

export const DEFAULT_CONTRAST = 50;
export const DEFAULT_RADIUS = 0.625;

/**
 * The spacing unit (rem) for each density. Comfortable is the desktop default,
 * so `size-4` renders a true 16px; compact keeps the earlier 0.24rem unit.
 * Pass either to {@link applySpacing}.
 */
export const COMFORTABLE_SPACING = 0.25;
export const COMPACT_SPACING = 0.24;

/** Set the shared spacing unit used by Tailwind v4 utilities. */
export function applySpacing(spacingRem: number) {
	document.documentElement.style.setProperty("--spacing", `${spacingRem}rem`);
}

/** Set the shared UI zoom and expose it to sandboxed Companion documents. */
export function applyScale(scale: number) {
	const root = document.documentElement;
	root.style.setProperty("--ryu-ui-scale", String(scale));
	root.style.zoom = String(scale);
}

/** Set the shared Card padding override and its compact companion value. */
export function applyCardSpacing(spacingRem: number) {
	const root = document.documentElement.style;
	root.setProperty("--card-pad", `${spacingRem}rem`);
	root.setProperty("--card-pad-sm", `${spacingRem * 0.75}rem`);
}

/** Remove the explicit Card padding so it follows the shared spacing unit. */
export function clearCardSpacing() {
	const root = document.documentElement.style;
	root.removeProperty("--card-pad");
	root.removeProperty("--card-pad-sm");
}

/** Adjust muted/muted-foreground around the neutral 50 midpoint. */
export function applyContrastToMuted(value: number) {
	const el = document.documentElement;
	if (value === DEFAULT_CONTRAST) {
		el.style.setProperty("--muted", "var(--muted-base)");
		el.style.setProperty("--muted-foreground", "var(--muted-foreground-base)");
		return;
	}
	const offset = (Math.abs(value - DEFAULT_CONTRAST) / DEFAULT_CONTRAST) * 25;
	const dir = value > DEFAULT_CONTRAST ? "white" : "black";
	el.style.setProperty(
		"--muted",
		`color-mix(in oklch, var(--muted-base), ${dir} ${offset}%)`
	);
	el.style.setProperty(
		"--muted-foreground",
		`color-mix(in oklch, var(--muted-foreground-base), ${dir} ${offset}%)`
	);
}

/** Write a variant's tokens onto <html>, then re-apply the contrast curve. */
export function applyVariant(
	variant: ThemeVariant,
	contrast: number = DEFAULT_CONTRAST
) {
	const el = document.documentElement;
	removeThemeVars(el);
	restoreExtraTokens(el);

	const extras = new Map<string, WrittenExtraToken>();
	for (const [key, value] of Object.entries(variant.tokens)) {
		if (MUTED_DERIVED_VARS.has(key)) {
			continue;
		}
		if (CORE_THEME_VARS.has(key)) {
			el.style.setProperty(key, value);
			continue;
		}
		const previous = el.style.getPropertyValue(key);
		el.style.setProperty(key, value);
		extras.set(key, { previous, written: el.style.getPropertyValue(key) });
	}
	if (extras.size > 0) {
		writtenExtraTokens.set(el, extras);
	}
	const mutedBase = variant.tokens["--muted"];
	if (mutedBase) {
		el.style.setProperty("--muted-base", mutedBase);
	}
	const mutedFgBase = variant.tokens["--muted-foreground"];
	if (mutedFgBase) {
		el.style.setProperty("--muted-foreground-base", mutedFgBase);
	}

	applyContrastToMuted(contrast);
}

export function clearVariant() {
	const el = document.documentElement;
	removeThemeVars(el);
	restoreExtraTokens(el);
}

export function applyRadius(radiusRem: number) {
	document.documentElement.style.setProperty("--radius", `${radiusRem}rem`);
}

export function applyFonts(
	uiFont: string,
	headingFont: string,
	codeFont: string
) {
	const el = document.documentElement;
	el.style.setProperty("--font-sans", uiFont);
	el.style.setProperty("--font-heading", headingFont);
	el.style.setProperty("--font-code", codeFont);
}

export function isDarkMode(
	theme: string | undefined,
	resolvedTheme: string | undefined
): boolean {
	if (theme === "system") {
		return resolvedTheme === "dark";
	}
	return theme === "dark";
}
