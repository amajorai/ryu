import { useI18n } from "@ryu/i18n/react";
import {
	effectiveTimeZone,
	TIMEZONE_CHANGE_EVENT,
} from "@ryu/ui/lib/timezone.ts";
import {
	applyCardSpacing as applyCardSpacingDom,
	applyContrastToMuted,
	applyFonts as applyFontVars,
	applyScale as applyScaleDom,
	applySpacing as applySpacingDom,
	applyVariant as applyVariantDom,
	clearCardSpacing as clearCardSpacingDom,
	clearVariant,
	DEFAULT_RADIUS as DEFAULT_THEME_RADIUS,
	isDarkMode,
} from "@ryu/ui/theme/apply.ts";
import {
	DEFAULT_CARD_SPACING as DEFAULT_THEME_CARD_SPACING,
	DEFAULT_THEME_MODE,
	DEFAULT_SCALE as DEFAULT_THEME_SCALE,
	DEFAULT_SPACING as DEFAULT_THEME_SPACING,
	THEME_APPEARANCE_CHANGE_EVENT,
	THEME_PREFS_VERSION,
	type ThemeMode,
	type ThemePrefs,
} from "@ryu/ui/theme/prefs.ts";
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
	loadPluginThemes,
	STORAGE_KEYS,
	type ThemeVariant,
} from "@/src/lib/themes/presets.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

export const DEFAULT_RADIUS = DEFAULT_THEME_RADIUS;
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
export const DEFAULT_SPACING = DEFAULT_THEME_SPACING;
// True browser-style UI scale (Chrome/Electron zoom). Applied as the CSS `zoom`
// property on the root element, so it scales EVERYTHING — text, spacing, images,
// canvas — with reflow, unlike `--spacing` which only rescales spacing-derived
// sizes. 1 = 100%.
export const DEFAULT_SCALE = DEFAULT_THEME_SCALE;
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 2;
export const SCALE_STEP = 0.05;

function applyScale(value: number) {
	applyScaleDom(value);
}
// Card inner padding (in rem). Mirrors the nova `--card-spacing` default of
// `--spacing(4)` at the default zoom (0.24rem * 4). Drives the `--card-pad`
// override consumed by the Card component in packages/ui; the small variant
// (`--card-pad-sm`) is derived at 0.75x to preserve nova's 4:3 ratio.
export const DEFAULT_CARD_SPACING = DEFAULT_THEME_CARD_SPACING;
export const DEFAULT_CHAT_WIDTH = 720;

function applyCardSpacing(value: number) {
	applyCardSpacingDom(value);
}

function currentContrast(): number {
	return Number(localStorage.getItem(STORAGE_KEYS.contrast) ?? "50");
}

// next-themes owns the `theme` key and seeds it from its own `defaultTheme`
// prop — but ONLY writes it once the user picks a mode, so on a fresh install
// the key is absent. Every read here must therefore fall back to the same
// constant the provider is mounted with (DEFAULT_THEME_MODE), or the two
// disagree: next-themes puts one class on <html> while these readers resolve a
// different mode and paint the other preset's tokens over it. Both sides now
// default to "system" and both resolve it from `prefers-color-scheme`, so a
// fresh install follows the OS with the class and the tokens in agreement.
function storedThemeMode(): ThemeMode {
	const stored = localStorage.getItem("theme");
	return stored === "light" || stored === "dark" || stored === "system"
		? stored
		: DEFAULT_THEME_MODE;
}

/** Resolve dark/light from the persisted mode, consulting the OS only for "system". */
function storedIsDark(): boolean {
	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	return isDarkMode(storedThemeMode(), prefersDark ? "dark" : "light");
}

function applyVariant(variant: ThemeVariant) {
	applyVariantDom(variant, currentContrast());
}

function applyAnimationsPreference(enabled: boolean) {
	if (enabled) {
		document.documentElement.removeAttribute("data-ryu-animations");
	} else {
		document.documentElement.setAttribute("data-ryu-animations", "off");
	}
}

/** Stamp the global motion preference before the first desktop surface mounts. */
export function initAnimationsPreference() {
	applyAnimationsPreference(
		localStorage.getItem("ryu:animations-enabled") !== "false"
	);
}

// --- Core sync ------------------------------------------------------------
// Publish the local theme prefs to Core so the island companion (a separate
// Electron process that cannot share localStorage) renders the same preset.
// localStorage stays the authoritative local cache; Core is the channel.

const PUSH_DEBOUNCE_MS = 400;
let pushTimer: ReturnType<typeof setTimeout> | undefined;

function buildThemePrefs(localeOverride?: string): ThemePrefs {
	const mode = storedThemeMode();
	const storedCardSpacing = localStorage.getItem(STORAGE_KEYS.cardSpacing);
	return {
		version: THEME_PREFS_VERSION,
		mode,
		lightPreset:
			localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID,
		darkPreset:
			localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID,
		contrast: currentContrast(),
		radius: Number(localStorage.getItem(STORAGE_KEYS.radius) ?? DEFAULT_RADIUS),
		spacing: Number(
			localStorage.getItem(STORAGE_KEYS.spacing) ?? DEFAULT_SPACING
		),
		scale: Number(localStorage.getItem(STORAGE_KEYS.scale) ?? DEFAULT_SCALE),
		cardSpacing: storedCardSpacing === null ? null : Number(storedCardSpacing),
		pointerCursor: localStorage.getItem("ryu_pointer_cursor") === "true",
		chromeShadows: localStorage.getItem("ryu_chrome_shadows") !== "false",
		dialogOverlayBlur:
			localStorage.getItem("ryu_dialog_overlay_blur") === "true",
		popupOverlayBlur: localStorage.getItem("ryu_popup_overlay_blur") === "true",
		invertedBackgrounds:
			localStorage.getItem("ryu_inverted_backgrounds") === "true",
		animationsEnabled:
			localStorage.getItem("ryu:animations-enabled") !== "false",
		timezone: effectiveTimeZone(),
		locale:
			localeOverride ??
			(globalThis.document !== undefined && document.documentElement.lang
				? document.documentElement.lang
				: globalThis.navigator === undefined
					? undefined
					: navigator.language),
		// The island resolves the selected preset id against this list alone, so it
		// carries every NON-built-in variant — the user's saved themes AND the ones
		// installed from the marketplace. Sending only `loadCustomThemes()` would
		// leave the companion unable to resolve a plugin theme and silently falling
		// back to the default preset while the main window shows the chosen one.
		customThemes: [...loadCustomThemes(), ...loadPluginThemes()],
		uiFont: localStorage.getItem(STORAGE_KEYS.uiFont) ?? undefined,
		headingFont: localStorage.getItem(STORAGE_KEYS.headingFont) ?? undefined,
		codeFont: localStorage.getItem(STORAGE_KEYS.codeFont) ?? undefined,
	};
}

/** Debounced publish of the current theme prefs to the active Core node. */
export function publishThemePrefs(localeOverride?: string) {
	if (pushTimer) {
		clearTimeout(pushTimer);
	}
	pushTimer = setTimeout(() => {
		const target = toTarget(useNodeStore.getState().getActiveNode());
		// Fire-and-forget: setThemePrefs swallows errors (best-effort sync).
		setThemePrefs(target, buildThemePrefs(localeOverride)).catch(() => {
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
	const scale = Number(
		localStorage.getItem(STORAGE_KEYS.scale) ?? String(DEFAULT_SCALE)
	);
	const storedCardSpacing = localStorage.getItem(STORAGE_KEYS.cardSpacing);
	const chatWidth = Number(
		localStorage.getItem(STORAGE_KEYS.chatWidth) ?? DEFAULT_CHAT_WIDTH
	);

	const variant = findVariant(storedIsDark() ? darkId : lightId);
	if (variant) {
		applyVariant(variant);
	}

	applyFonts(uiFont, headingFont, codeFont);
	document.documentElement.style.setProperty("--radius", `${radius}rem`);
	applyWindowRadius(radius);
	applySpacingDom(spacing);
	applyScale(scale);
	// Only override card padding when the user has set it; otherwise the Card's
	// own fallback (calc(var(--spacing) * 4)) keeps it tracking the zoom slider.
	if (storedCardSpacing) {
		applyCardSpacing(Number(storedCardSpacing));
	} else {
		clearCardSpacingDom();
	}
	document.documentElement.style.setProperty(
		"--an-max-width",
		`${chatWidth}px`
	);
	document.documentElement.classList.remove("high-contrast");
}

export function useThemePreset() {
	const { theme, resolvedTheme } = useTheme();
	const { locale } = useI18n();

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
		publishThemePrefs(locale);
	}, [locale, resolvedTheme, theme]);

	useEffect(() => {
		const publish = () => publishThemePrefs();
		window.addEventListener(THEME_APPEARANCE_CHANGE_EVENT, publish);
		window.addEventListener(TIMEZONE_CHANGE_EVENT, publish);
		return () => {
			window.removeEventListener(THEME_APPEARANCE_CHANGE_EVENT, publish);
			window.removeEventListener(TIMEZONE_CHANGE_EVENT, publish);
		};
	}, []);
}

/**
 * Re-resolve and re-apply whichever preset is selected for the ACTIVE mode.
 *
 * Needed when the pool of resolvable variants changes underneath a stable
 * selection — installing, updating or removing a marketplace theme plugin. Without
 * this the window keeps painting the palette it resolved at boot until the next
 * restart, so an updated theme looks like it did not install. Also republishes to
 * Core so the island companion re-resolves against the same list.
 */
export function reapplyActivePreset() {
	const id =
		localStorage.getItem(
			storedIsDark() ? STORAGE_KEYS.darkPreset : STORAGE_KEYS.lightPreset
		) ?? (storedIsDark() ? DEFAULT_DARK_ID : DEFAULT_LIGHT_ID);
	const variant = findVariant(id);
	if (variant) {
		applyVariant(variant);
	}
	publishThemePrefs();
}

export function setLightPreset(id: string) {
	localStorage.setItem(STORAGE_KEYS.lightPreset, id);
	if (!storedIsDark()) {
		const variant = findVariant(id);
		if (variant) {
			applyVariant(variant);
		}
	}
	publishThemePrefs();
}

export function setDarkPreset(id: string) {
	localStorage.setItem(STORAGE_KEYS.darkPreset, id);
	if (storedIsDark()) {
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
	if ((mode === "dark") !== storedIsDark()) {
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
	applySpacingDom(value);
	publishThemePrefs();
}

export function setScale(value: number) {
	localStorage.setItem(STORAGE_KEYS.scale, String(value));
	applyScale(value);
	publishThemePrefs();
}

export function setCardSpacing(value: number) {
	localStorage.setItem(STORAGE_KEYS.cardSpacing, String(value));
	applyCardSpacing(value);
	publishThemePrefs();
}

/** Clear the card-padding override so cards fall back to the zoom-derived default. */
export function resetCardSpacing() {
	localStorage.removeItem(STORAGE_KEYS.cardSpacing);
	clearCardSpacingDom();
	publishThemePrefs();
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
