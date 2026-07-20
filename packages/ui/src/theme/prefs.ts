// The theme-preferences blob: the cross-app contract persisted in Core under
// the `theme` preference key. Desktop writes it whenever appearance changes;
// island (and any future surface) reads it to render identically. Custom theme
// definitions travel inline so a user-saved preset id resolves anywhere, not
// just on the machine/process that created it.

import { DEFAULT_CONTRAST, DEFAULT_RADIUS } from "./apply.ts";
import {
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	type ThemeVariant,
} from "./presets.ts";

export const THEME_PREF_KEY = "theme";
export const THEME_PREFS_VERSION = 1;

export type ThemeMode = "light" | "dark" | "system";

export interface ThemePrefs {
	codeFont?: string;
	contrast: number;
	/** User-saved custom variants, shipped inline so ids resolve cross-app. */
	customThemes: ThemeVariant[];
	darkPreset: string;
	headingFont?: string;
	lightPreset: string;
	mode: ThemeMode;
	radius: number;
	uiFont?: string;
	version: number;
}

export function defaultThemePrefs(): ThemePrefs {
	return {
		version: THEME_PREFS_VERSION,
		mode: "light",
		lightPreset: DEFAULT_LIGHT_ID,
		darkPreset: DEFAULT_DARK_ID,
		contrast: DEFAULT_CONTRAST,
		radius: DEFAULT_RADIUS,
		customThemes: [],
	};
}

/** Tolerantly coerce an unknown payload (parsed JSON from Core) into ThemePrefs. */
export function normalizeThemePrefs(input: unknown): ThemePrefs {
	const base = defaultThemePrefs();
	if (!input || typeof input !== "object") {
		return base;
	}
	const raw = input as Record<string, unknown>;
	const mode = raw.mode;
	return {
		version: typeof raw.version === "number" ? raw.version : base.version,
		mode:
			mode === "light" || mode === "dark" || mode === "system"
				? mode
				: base.mode,
		lightPreset:
			typeof raw.lightPreset === "string" ? raw.lightPreset : base.lightPreset,
		darkPreset:
			typeof raw.darkPreset === "string" ? raw.darkPreset : base.darkPreset,
		contrast: typeof raw.contrast === "number" ? raw.contrast : base.contrast,
		radius: typeof raw.radius === "number" ? raw.radius : base.radius,
		customThemes: Array.isArray(raw.customThemes)
			? (raw.customThemes as ThemeVariant[])
			: base.customThemes,
		uiFont: typeof raw.uiFont === "string" ? raw.uiFont : undefined,
		headingFont:
			typeof raw.headingFont === "string" ? raw.headingFont : undefined,
		codeFont: typeof raw.codeFont === "string" ? raw.codeFont : undefined,
	};
}

/** Resolve the active variant id for a prefs blob given the effective dark/light. */
export function activePresetId(prefs: ThemePrefs, isDark: boolean): string {
	return isDark ? prefs.darkPreset : prefs.lightPreset;
}
