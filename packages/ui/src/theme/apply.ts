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

export const DEFAULT_CONTRAST = 50;
export const DEFAULT_RADIUS = 0.625;

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
	for (const v of ALL_THEME_VARS) {
		el.style.removeProperty(v);
	}
	el.style.removeProperty("--muted-base");
	el.style.removeProperty("--muted-foreground-base");

	for (const [key, value] of Object.entries(variant.tokens)) {
		if (MUTED_DERIVED_VARS.has(key)) {
			continue;
		}
		el.style.setProperty(key, value);
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
	for (const v of ALL_THEME_VARS) {
		el.style.removeProperty(v);
	}
	el.style.removeProperty("--muted-base");
	el.style.removeProperty("--muted-foreground-base");
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
