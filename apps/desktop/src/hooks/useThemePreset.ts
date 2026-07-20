import {
	applyContrastToMuted,
	applyFonts as applyFontVars,
	applyVariant as applyVariantDom,
	clearVariant,
	isDarkMode,
} from "@ryu/ui/theme/apply";
import {
	THEME_PREFS_VERSION,
	type ThemeMode,
	type ThemePrefs,
} from "@ryu/ui/theme/prefs";
import { useTheme } from "next-themes";
import { useEffect } from "react";
import { toTarget } from "@/src/lib/api/client.ts";
import { setThemePrefs } from "@/src/lib/api/preferences.ts";
import {
	type CustomTokens,
	customTokensToVariant,
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	findVariant,
	loadCustomThemes,
	STORAGE_KEYS,
	type ThemeVariant,
} from "@/src/lib/themes/presets.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export const DEFAULT_RADIUS = 0.625;
// The app runs in a frameless, transparent window, so the visible "window"
// corners are painted by CSS (PageWrapper + portaled overlays read
// `--ryu-window-radius-base`), not the OS. The window corner is much larger
// than a button/card corner, so we scale the roundness slider (`--radius`) up
// by this factor. The default radius (0.625) × this factor = the historical
// 2rem window corner, so the out-of-the-box look is unchanged.
const WINDOW_RADIUS_SCALE = 3.2;

// Derive the window-corner radius from the user's roundness setting and expose
// it as a CSS variable. PageWrapper consumes this for the main window silhouette
// and the portaled overlays (dialogs/sheets/drawers) so every surface tracks the
// same corner. A radius of 0 yields a square window.
export function applyWindowRadius(radius: number) {
	document.documentElement.style.setProperty(
		"--ryu-window-radius-base",
		`${radius * WINDOW_RADIUS_SCALE}rem`
	);
}
// Base unit (in rem) all Tailwind v4 spacing utilities derive from. Mirrors the
// `--spacing` value in apps/desktop/src/index.css; acts as a global UI zoom.
export const DEFAULT_SPACING = 0.24;
// Card inner padding (in rem). Mirrors the nova `--card-spacing` default of
// `--spacing(4)` at the default zoom (0.24rem * 4). Drives the `--card-pad`
// override consumed by the Card component in packages/ui; the small variant
// (`--card-pad-sm`) is derived at 0.75x to preserve nova's 4:3 ratio.
export const DEFAULT_CARD_SPACING = 0.96;
const CARD_SPACING_SM_RATIO = 0.75;
export const DEFAULT_CHAT_WIDTH = 720;

function applyCardSpacing(value: number) {
	const root = document.documentElement.style;
	root.setProperty("--card-pad", `${value}rem`);
	root.setProperty("--card-pad-sm", `${value * CARD_SPACING_SM_RATIO}rem`);
}

function currentContrast(): number {
	return Number(localStorage.getItem(STORAGE_KEYS.contrast) ?? "50");
}

function applyVariant(variant: ThemeVariant) {
	applyVariantDom(variant, currentContrast());
}

// --- Core sync ------------------------------------------------------------
// Publish the local theme prefs to Core so the island companion (a separate
// Electron process that cannot share localStorage) renders the same preset.
// localStorage stays the authoritative local cache; Core is the channel.

const PUSH_DEBOUNCE_MS = 400;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function buildThemePrefs(): ThemePrefs {
	const mode = (localStorage.getItem("theme") ?? "system") as ThemeMode;
	return {
		version: THEME_PREFS_VERSION,
		mode: mode === "light" || mode === "dark" ? mode : "system",
		lightPreset:
			localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID,
		darkPreset:
			localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID,
		contrast: currentContrast(),
		radius: Number(localStorage.getItem(STORAGE_KEYS.radius) ?? DEFAULT_RADIUS),
		customThemes: loadCustomThemes(),
		uiFont: localStorage.getItem(STORAGE_KEYS.uiFont) ?? undefined,
		headingFont: localStorage.getItem(STORAGE_KEYS.headingFont) ?? undefined,
		codeFont: localStorage.getItem(STORAGE_KEYS.codeFont) ?? undefined,
	};
}

/** Debounced publish of the current theme prefs to the active Core node. */
export function publishThemePrefs() {
	if (pushTimer) {
		clearTimeout(pushTimer);
	}
	pushTimer = setTimeout(() => {
		const target = toTarget(useNodeStore.getState().getActiveNode());
		// Fire-and-forget: setThemePrefs swallows errors (best-effort sync).
		setThemePrefs(target, buildThemePrefs()).catch(() => {
			// Ignore: theme sync is best-effort; localStorage remains source of truth.
		});
	}, PUSH_DEBOUNCE_MS);
}

function applyFonts(uiFont: string, headingFont: string, codeFont: string) {
	applyFontVars(uiFont, headingFont, codeFont);
}

export function initTheme() {
	const lightId =
		localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID;
	const darkId =
		localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID;
	const uiFont = localStorage.getItem(STORAGE_KEYS.uiFont) ?? UI_FONTS[0].value;
	const headingFont =
		localStorage.getItem(STORAGE_KEYS.headingFont) ?? HEADING_FONTS[0].value;
	const codeFont =
		localStorage.getItem(STORAGE_KEYS.codeFont) ?? CODE_FONTS[0].value;
	const radius = Number(
		localStorage.getItem(STORAGE_KEYS.radius) ?? DEFAULT_RADIUS
	);
	const spacing = Number(
		localStorage.getItem(STORAGE_KEYS.spacing) ?? DEFAULT_SPACING
	);
	const storedCardSpacing = localStorage.getItem(STORAGE_KEYS.cardSpacing);
	const chatWidth = Number(
		localStorage.getItem(STORAGE_KEYS.chatWidth) ?? DEFAULT_CHAT_WIDTH
	);

	const storedTheme = localStorage.getItem("theme") ?? "system";
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const dark = isDarkMode(storedTheme, prefersDark ? "dark" : "light");
	const variant = findVariant(dark ? darkId : lightId);
	if (variant) {
		applyVariant(variant);
	}

	applyFonts(uiFont, headingFont, codeFont);
	document.documentElement.style.setProperty("--radius", `${radius}rem`);
	applyWindowRadius(radius);
	document.documentElement.style.setProperty("--spacing", `${spacing}rem`);
	// Only override card padding when the user has set it; otherwise the Card's
	// own fallback (calc(var(--spacing) * 4)) keeps it tracking the zoom slider.
	if (storedCardSpacing) {
		applyCardSpacing(Number(storedCardSpacing));
	}
	document.documentElement.style.setProperty(
		"--an-max-width",
		`${chatWidth}px`
	);
	document.documentElement.classList.remove("high-contrast");
}

export function useThemePreset() {
	const { theme, resolvedTheme } = useTheme();

	useEffect(() => {
		const lightId =
			localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID;
		const darkId =
			localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID;
		const dark = isDarkMode(theme, resolvedTheme);
		const variant = findVariant(dark ? darkId : lightId);
		if (variant) {
			applyVariant(variant);
		} else {
			clearVariant();
		}
		publishThemePrefs();
	}, [theme, resolvedTheme]);
}

export function setLightPreset(id: string) {
	localStorage.setItem(STORAGE_KEYS.lightPreset, id);
	const storedTheme = localStorage.getItem("theme") ?? "system";
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const dark = isDarkMode(storedTheme, prefersDark ? "dark" : "light");
	if (!dark) {
		const variant = findVariant(id);
		if (variant) {
			applyVariant(variant);
		}
	}
	publishThemePrefs();
}

export function setDarkPreset(id: string) {
	localStorage.setItem(STORAGE_KEYS.darkPreset, id);
	const storedTheme = localStorage.getItem("theme") ?? "system";
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const dark = isDarkMode(storedTheme, prefersDark ? "dark" : "light");
	if (dark) {
		const variant = findVariant(id);
		if (variant) {
			applyVariant(variant);
		}
	}
	publishThemePrefs();
}

export function applyCustomTokensLive(
	mode: "light" | "dark",
	tokens: CustomTokens
) {
	const storedTheme = localStorage.getItem("theme") ?? "system";
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	const currentlyDark = isDarkMode(storedTheme, prefersDark ? "dark" : "light");
	if ((mode === "dark") !== currentlyDark) {
		return;
	}
	const variant = customTokensToVariant("_preview", "_preview", mode, tokens);
	applyVariant(variant);
}

export function setContrast(value: number) {
	localStorage.setItem(STORAGE_KEYS.contrast, String(value));
	applyContrastToMuted(value);
	publishThemePrefs();
}

export function setRadius(value: number) {
	localStorage.setItem(STORAGE_KEYS.radius, String(value));
	document.documentElement.style.setProperty("--radius", `${value}rem`);
	applyWindowRadius(value);
	publishThemePrefs();
}

export function setSpacing(value: number) {
	localStorage.setItem(STORAGE_KEYS.spacing, String(value));
	document.documentElement.style.setProperty("--spacing", `${value}rem`);
}

export function setCardSpacing(value: number) {
	localStorage.setItem(STORAGE_KEYS.cardSpacing, String(value));
	applyCardSpacing(value);
}

/** Clear the card-padding override so cards fall back to the zoom-derived default. */
export function resetCardSpacing() {
	localStorage.removeItem(STORAGE_KEYS.cardSpacing);
	const root = document.documentElement.style;
	root.removeProperty("--card-pad");
	root.removeProperty("--card-pad-sm");
}

export function setChatWidth(value: number) {
	localStorage.setItem(STORAGE_KEYS.chatWidth, String(value));
	document.documentElement.style.setProperty("--an-max-width", `${value}px`);
}

export const SIDEBAR_WIDTH_KEY = "ryu:sidebar-width";
export const DEFAULT_SIDEBAR_WIDTH = 360;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 480;

export function setSidebarWidthSetting(value: number) {
	const clamped = Math.max(
		MIN_SIDEBAR_WIDTH,
		Math.min(MAX_SIDEBAR_WIDTH, value)
	);
	localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
	window.dispatchEvent(
		new CustomEvent("ryu:sidebar-width", { detail: clamped })
	);
}

export function setUiFont(value: string) {
	localStorage.setItem(STORAGE_KEYS.uiFont, value);
	document.documentElement.style.setProperty("--font-sans", value);
	publishThemePrefs();
}

export function setHeadingFont(value: string) {
	localStorage.setItem(STORAGE_KEYS.headingFont, value);
	document.documentElement.style.setProperty("--font-heading", value);
	publishThemePrefs();
}

export function setCodeFont(value: string) {
	localStorage.setItem(STORAGE_KEYS.codeFont, value);
	document.documentElement.style.setProperty("--font-code", value);
	publishThemePrefs();
}

export const UI_FONTS = [
	{ label: "Inter", value: '"Inter Variable", "Inter", sans-serif' },
	{ label: "Geist", value: '"Geist Variable", "Geist", sans-serif' },
	{ label: "System UI", value: "system-ui, -apple-system, sans-serif" },
] as const;

export const HEADING_FONTS = [
	{ label: "Geist", value: '"Geist Variable", "Geist", sans-serif' },
	{ label: "Inter", value: '"Inter Variable", "Inter", sans-serif' },
	{ label: "System UI", value: "system-ui, -apple-system, sans-serif" },
] as const;

export const CODE_FONTS = [
	{
		label: "System Mono",
		value:
			'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
	},
	{
		label: "JetBrains Mono",
		value: '"JetBrains Mono", ui-monospace, monospace',
	},
	{
		label: "Fira Code",
		value: '"Fira Code", "Fira Mono", ui-monospace, monospace',
	},
] as const;
