import { z } from "zod";
// Desktop theme presets. The variant data + pure helpers now live in the
// shared `@ryu/ui/theme` module (single source of truth across desktop +
// island). This file re-exports them and keeps only the desktop-local,
// localStorage-backed custom-theme helpers.

import {
	findVariantIn,
	THEME_VARIANTS,
	type ThemeVariant,
} from "@ryu/ui/theme/presets.ts";

export type { CustomTokens, ThemeVariant } from "@ryu/ui/theme/presets.ts";
// thin compatibility shim re-exporting the shared @ryu/ui/theme module for existing desktop call sites, alongside the localStorage helpers below.
export {
	customTokensToVariant,
	DARK_VARIANTS,
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	LIGHT_VARIANTS,
	THEME_VARIANTS,
	variantToCustomTokens,
} from "@ryu/ui/theme/presets.ts";

export const STORAGE_KEYS = {
	lightPreset: "ryu_light_preset",
	pluginThemes: "ryu_plugin_themes",
	darkPreset: "ryu_dark_preset",
	uiFont: "ryu_ui_font",
	headingFont: "ryu_heading_font",
	codeFont: "ryu_code_font",
	contrast: "ryu_contrast",
	radius: "ryu_radius",
	spacing: "ryu_spacing",
	scale: "ryu_ui_scale",
	cardSpacing: "ryu_card_spacing",
	chatWidth: "ryu_chat_width",
	customThemes: "ryu_custom_themes",
	highContrast: "ryu_high_contrast",
} as const;

const themeAppearanceSchema = z.object({
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
});
const themeVariantSchema = z.object({
	id: z.string(),
	label: z.string(),
	mode: z.enum(["light", "dark"]),
	preview: z.object({
		bg: z.string(),
		surface: z.string(),
		primary: z.string(),
		text: z.string(),
	}),
	tokens: z.record(z.string(), z.string()),
	appearance: themeAppearanceSchema.optional(),
});

function loadVariantList(key: string): ThemeVariant[] {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) {
			return [];
		}
		return z.array(themeVariantSchema).parse(JSON.parse(raw));
	} catch {
		return [];
	}
}

export function loadCustomThemes(): ThemeVariant[] {
	return loadVariantList(STORAGE_KEYS.customThemes);
}

/**
 * Themes contributed by installed marketplace plugins (`contributes.themes`).
 *
 * Cached in localStorage rather than read live from `GET /api/plugins/contributions`
 * because `initTheme()` runs before React mounts and before any node is reachable:
 * if a plugin theme were only resolvable from the network, a user whose selected
 * preset came from a plugin would boot into an unstyled flash (or the wrong preset)
 * on every cold start and stay wrong entirely while offline. The cache is refreshed
 * from Core on every contributions read, so an uninstalled plugin's theme disappears
 * on the next load — it is a resolution table, never the source of truth.
 */
export function loadPluginThemes(): ThemeVariant[] {
	return loadVariantList(STORAGE_KEYS.pluginThemes);
}

/** Replace the plugin-theme cache with the set Core currently serves. */
export function savePluginThemes(variants: ThemeVariant[]) {
	localStorage.setItem(STORAGE_KEYS.pluginThemes, JSON.stringify(variants));
}

/** Where a variant id comes from — drives the picker's groups and whether it can be deleted. */
export type VariantSource = "builtin" | "plugin" | "custom";

export function variantSource(id: string): VariantSource {
	if (loadCustomThemes().some((v) => v.id === id)) {
		return "custom";
	}
	if (loadPluginThemes().some((v) => v.id === id)) {
		return "plugin";
	}
	// Deliberately the fallback, not "custom": an id we cannot account for must not
	// light up the delete affordance, which only ever removes a locally-saved theme.
	return "builtin";
}

export function saveCustomTheme(variant: ThemeVariant) {
	const existing = loadCustomThemes().filter((v) => v.id !== variant.id);
	localStorage.setItem(
		STORAGE_KEYS.customThemes,
		JSON.stringify([...existing, variant])
	);
}

export function deleteCustomTheme(id: string) {
	const existing = loadCustomThemes().filter((v) => v.id !== id);
	localStorage.setItem(STORAGE_KEYS.customThemes, JSON.stringify(existing));
}

/**
 * Every variant selectable for a mode, in picker order: the user's own themes
 * first, then themes installed from the marketplace, then the shipped presets.
 * A user who saved a theme should not have to scroll past 30 built-ins to find it.
 */
export function getAllVariants(mode: "light" | "dark"): ThemeVariant[] {
	const groups = getGroupedVariants(mode);
	return [...groups.custom, ...groups.plugin, ...groups.builtin];
}

export interface GroupedVariants {
	builtin: ThemeVariant[];
	custom: ThemeVariant[];
	plugin: ThemeVariant[];
}

/** The same set as {@link getAllVariants}, split by provenance for the picker's headers. */
export function getGroupedVariants(mode: "light" | "dark"): GroupedVariants {
	const byMode = (v: ThemeVariant) => v.mode === mode;
	return {
		custom: loadCustomThemes().filter(byMode),
		plugin: loadPluginThemes().filter(byMode),
		builtin: THEME_VARIANTS.filter(byMode),
	};
}

/** Resolve a variant id against built-ins + plugin themes + locally-saved custom themes. */
export function findVariant(id: string): ThemeVariant | undefined {
	return findVariantIn(id, [...loadCustomThemes(), ...loadPluginThemes()]);
}
