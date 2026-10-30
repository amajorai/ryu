// The theme-preferences blob: the cross-app contract persisted in Core under
// the `theme` preference key. Desktop writes it whenever appearance changes;
// island (and any future surface) reads it to render identically. Custom theme
// definitions travel inline so a user-saved preset id resolves anywhere, not
// just on the machine/process that created it.

import { z } from "zod";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeObjectReceiver,
	isNativeText,
} from "../lib/native-primitive-observation.ts";

import { DEFAULT_TIMEZONE } from "../lib/timezone.ts";
import { DEFAULT_CONTRAST, DEFAULT_RADIUS } from "./apply.ts";
import {
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	type ThemeVariant,
} from "./presets.ts";

export const THEME_PREF_KEY = "theme";
export const THEME_PREFS_VERSION = 1;

/** Same-document signal for appearance stores that need to publish the theme blob. */
export const THEME_APPEARANCE_CHANGE_EVENT = "ryu:theme-appearance-change";

/** Defaults for the appearance values that are meaningful on every Ryu UI surface. */
export const DEFAULT_SPACING = 0.24;
export const DEFAULT_SCALE = 1;
export const DEFAULT_CARD_SPACING = 0.96;
export const DEFAULT_UI_FONT = '"Inter Variable", "Inter", sans-serif';
export const DEFAULT_HEADING_FONT = '"Geist Variable", "Geist", sans-serif';
export const DEFAULT_CODE_FONT =
	'"Geist Mono Variable", "Geist Mono", monospace';

export type ThemeMode = "light" | "dark" | "system";

// The mode a surface renders in before the user has ever picked one: follow the
// OS. EVERY reader of the persisted mode must fall back to this — a surface that
// defaults to "system" while its provider defaults to "light" (or vice versa)
// renders a fresh install with light-mode component variants over dark-preset
// tokens, and the mismatch only clears once the user toggles the theme by hand.
//
// "system" is only safe because every resolver consults `prefers-color-scheme`:
// next-themes is mounted with `enableSystem` on both windows, the desktop's
// `initTheme()`/`storedIsDark()` read the media query, and the island's
// `use-island-theme` watches DARK_QUERY. Adding a resolver that cannot follow
// the OS means picking a concrete default again, not special-casing it there.
export const DEFAULT_THEME_MODE: ThemeMode = "system";

export interface ThemePrefs {
	/** Whether the host replaces the shared motion path with a static one. */
	animationsEnabled?: boolean;
	/** Explicit card padding, or null to derive it from spacing. */
	cardSpacing?: number | null;
	/** Whether the host shows the optional navigation/sidebar shadows. */
	chromeShadows?: boolean;
	codeFont?: string;
	contrast: number;
	/** User-saved custom variants, shipped inline so ids resolve cross-app. */
	customThemes: ThemeVariant[];
	darkPreset: string;
	/** Whether dialogs use the optional dimmed/blurred backdrop. */
	dialogOverlayBlur?: boolean;
	headingFont?: string;
	/** Whether the host uses the page background for popup surfaces. */
	invertedBackgrounds?: boolean;
	lightPreset: string;
	/** Locale used for date/time and localized number display in other processes. */
	locale?: string;
	mode: ThemeMode;
	/** Whether interactive controls use a pointer cursor. */
	pointerCursor?: boolean;
	/** Whether anchored popup surfaces use a backdrop. */
	popupOverlayBlur?: boolean;
	radius: number;
	scale?: number;
	spacing?: number;
	/** Effective IANA display zone projected to other Ryu processes. */
	timezone?: string;
	uiFont?: string;
	version: number;
}

const themeAppearanceSchema = z
	.object({
		cardRadius: z.number().optional(),
		codeFont: z.string().optional(),
		contentScale: z.number().optional(),
		contentWidth: z.string().optional(),
		density: z.enum(["compact", "comfortable", "spacious"]).optional(),
		fontSizes: z
			.object({
				xs: z.string().optional(),
				sm: z.string().optional(),
				base: z.string().optional(),
				lg: z.string().optional(),
				xl: z.string().optional(),
				"2xl": z.string().optional(),
			})
			.optional(),
		fontWeights: z
			.object({
				normal: z.number().optional(),
				medium: z.number().optional(),
				semibold: z.number().optional(),
				bold: z.number().optional(),
			})
			.optional(),
		headingFont: z.string().optional(),
		layout: z
			.object({
				navigation: z.enum(["sidebar", "topbar", "minimal"]).optional(),
				contentAlign: z.enum(["start", "center", "wide"]).optional(),
				panelStyle: z.enum(["flat", "card", "outline"]).optional(),
			})
			.optional(),
		panelRadius: z.number().optional(),
		radius: z.number().optional(),
		spacingScale: z.number().optional(),
		uiFont: z.string().optional(),
	})
	.passthrough();
const themeVariantSchema = z
	.object({
		appearance: themeAppearanceSchema.optional(),
		id: z.string(),
		label: z.string(),
		mode: z.enum(["light", "dark"]),
		preview: z
			.object({
				bg: z.string(),
				surface: z.string(),
				primary: z.string(),
				text: z.string(),
			})
			.passthrough(),
		tokens: z.record(z.string(), z.string()),
	})
	.passthrough();

/** Validate the cross-process wire blob without applying appearance defaults. */
export const themePrefsSchema = z
	.object({
		animationsEnabled: z.boolean().optional(),
		cardSpacing: z.number().nullable().optional(),
		chromeShadows: z.boolean().optional(),
		codeFont: z.string().optional(),
		contrast: z.number(),
		customThemes: z.array(themeVariantSchema),
		darkPreset: z.string(),
		dialogOverlayBlur: z.boolean().optional(),
		headingFont: z.string().optional(),
		invertedBackgrounds: z.boolean().optional(),
		lightPreset: z.string(),
		locale: z.string().optional(),
		mode: z.enum(["light", "dark", "system"]),
		pointerCursor: z.boolean().optional(),
		popupOverlayBlur: z.boolean().optional(),
		radius: z.number(),
		scale: z.number().optional(),
		spacing: z.number().optional(),
		timezone: z.string().optional(),
		uiFont: z.string().optional(),
		version: z.number(),
	})
	.passthrough() satisfies z.ZodType<ThemePrefs>;

export function defaultThemePrefs(): ThemePrefs {
	return {
		version: THEME_PREFS_VERSION,
		mode: DEFAULT_THEME_MODE,
		lightPreset: DEFAULT_LIGHT_ID,
		darkPreset: DEFAULT_DARK_ID,
		contrast: DEFAULT_CONTRAST,
		radius: DEFAULT_RADIUS,
		spacing: DEFAULT_SPACING,
		scale: DEFAULT_SCALE,
		cardSpacing: null,
		pointerCursor: false,
		chromeShadows: false,
		dialogOverlayBlur: false,
		popupOverlayBlur: false,
		invertedBackgrounds: false,
		animationsEnabled: true,
		timezone: DEFAULT_TIMEZONE,
		customThemes: [],
	};
}

function normalizeCustomThemes<CustomThemeInput>(
	input: CustomThemeInput
): ThemeVariant[] {
	const parsed = themePrefsSchema.shape.customThemes.safeParse(input);
	return parsed.success ? parsed.data : [];
}

// Read only the owner's preference fields; each is normalized independently below.
const themePrefsInputSchema = z.object({
	animationsEnabled: z.unknown().optional(),
	cardSpacing: z.unknown().optional(),
	chromeShadows: z.unknown().optional(),
	codeFont: z.unknown().optional(),
	contrast: z.unknown().optional(),
	customThemes: z.unknown().optional(),
	darkPreset: z.unknown().optional(),
	dialogOverlayBlur: z.unknown().optional(),
	headingFont: z.unknown().optional(),
	invertedBackgrounds: z.unknown().optional(),
	lightPreset: z.unknown().optional(),
	locale: z.unknown().optional(),
	mode: z.unknown().optional(),
	pointerCursor: z.unknown().optional(),
	popupOverlayBlur: z.unknown().optional(),
	radius: z.unknown().optional(),
	scale: z.unknown().optional(),
	spacing: z.unknown().optional(),
	timezone: z.unknown().optional(),
	uiFont: z.unknown().optional(),
	version: z.unknown().optional(),
});

/**
 * Tolerantly coerce parsed Core preferences. Custom themes must satisfy the full
 * wire schema; malformed collections fall back to empty. Accepted collections
 * use the parser's copies rather than retaining the source array/variant objects.
 */
export function normalizeThemePrefs<PrefsInput>(input: PrefsInput): ThemePrefs {
	const base = defaultThemePrefs();
	if (!(input && isNativeObjectReceiver(input))) {
		return base;
	}
	const parsed = themePrefsInputSchema.safeParse(input);
	if (!parsed.success) {
		return base;
	}
	const raw = parsed.data;
	const mode = raw.mode;
	const cardSpacing = raw.cardSpacing;
	return {
		version: isNativeNumber(raw.version) ? raw.version : base.version,
		mode:
			mode === "light" || mode === "dark" || mode === "system"
				? mode
				: base.mode,
		lightPreset: isNativeText(raw.lightPreset)
			? raw.lightPreset
			: base.lightPreset,
		darkPreset: isNativeText(raw.darkPreset) ? raw.darkPreset : base.darkPreset,
		contrast: isNativeNumber(raw.contrast) ? raw.contrast : base.contrast,
		radius: isNativeNumber(raw.radius) ? raw.radius : base.radius,
		spacing: isNativeNumber(raw.spacing) ? raw.spacing : base.spacing,
		scale: isNativeNumber(raw.scale) ? raw.scale : base.scale,
		cardSpacing:
			cardSpacing === null
				? null
				: isNativeNumber(cardSpacing)
					? cardSpacing
					: base.cardSpacing,
		pointerCursor: isNativeBoolean(raw.pointerCursor)
			? raw.pointerCursor
			: base.pointerCursor,
		chromeShadows: isNativeBoolean(raw.chromeShadows)
			? raw.chromeShadows
			: base.chromeShadows,
		dialogOverlayBlur: isNativeBoolean(raw.dialogOverlayBlur)
			? raw.dialogOverlayBlur
			: base.dialogOverlayBlur,
		popupOverlayBlur: isNativeBoolean(raw.popupOverlayBlur)
			? raw.popupOverlayBlur
			: base.popupOverlayBlur,
		invertedBackgrounds: isNativeBoolean(raw.invertedBackgrounds)
			? raw.invertedBackgrounds
			: base.invertedBackgrounds,
		animationsEnabled: isNativeBoolean(raw.animationsEnabled)
			? raw.animationsEnabled
			: base.animationsEnabled,
		locale: isNativeText(raw.locale) ? raw.locale : base.locale,
		timezone: isNativeText(raw.timezone) ? raw.timezone : base.timezone,
		customThemes: Array.isArray(raw.customThemes)
			? normalizeCustomThemes(raw.customThemes)
			: base.customThemes,
		uiFont: isNativeText(raw.uiFont) ? raw.uiFont : undefined,
		headingFont: isNativeText(raw.headingFont) ? raw.headingFont : undefined,
		codeFont: isNativeText(raw.codeFont) ? raw.codeFont : undefined,
	};
}

/** Resolve the active variant id for a prefs blob given the effective dark/light. */
export function activePresetId(prefs: ThemePrefs, isDark: boolean): string {
	return isDark ? prefs.darkPreset : prefs.lightPreset;
}
