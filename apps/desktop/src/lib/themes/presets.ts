// Desktop theme presets. The variant data + pure helpers now live in the
// shared `@ryu/ui/theme` module (single source of truth across desktop +
// island). This file re-exports them and keeps only the desktop-local,
// localStorage-backed custom-theme helpers.

import {
	findVariantIn,
	THEME_VARIANTS,
	type ThemeVariant,
} from "@ryu/ui/theme/presets";

export type { CustomTokens, ThemeVariant } from "@ryu/ui/theme/presets";
// biome-ignore lint/performance/noBarrelFile: thin compatibility shim re-exporting the shared @ryu/ui/theme module for existing desktop call sites, alongside the localStorage helpers below.
export {
	customTokensToVariant,
	DARK_VARIANTS,
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	LIGHT_VARIANTS,
	THEME_VARIANTS,
	variantToCustomTokens,
} from "@ryu/ui/theme/presets";

export const STORAGE_KEYS = {
	lightPreset: "ryu_light_preset",
	darkPreset: "ryu_dark_preset",
	uiFont: "ryu_ui_font",
	headingFont: "ryu_heading_font",
	codeFont: "ryu_code_font",
	contrast: "ryu_contrast",
	radius: "ryu_radius",
	spacing: "ryu_spacing",
	cardSpacing: "ryu_card_spacing",
	chatWidth: "ryu_chat_width",
	customThemes: "ryu_custom_themes",
	highContrast: "ryu_high_contrast",
} as const;

export function loadCustomThemes(): ThemeVariant[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEYS.customThemes);
		if (!raw) {
			return [];
		}
		return JSON.parse(raw) as ThemeVariant[];
	} catch {
		return [];
	}
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

export function getAllVariants(mode: "light" | "dark"): ThemeVariant[] {
	const builtIn = THEME_VARIANTS.filter((v) => v.mode === mode);
	const custom = loadCustomThemes().filter((v) => v.mode === mode);
	return [...builtIn, ...custom];
}

/** Resolve a variant id against built-ins + locally-saved custom themes. */
export function findVariant(id: string): ThemeVariant | undefined {
	return findVariantIn(id, loadCustomThemes());
}
