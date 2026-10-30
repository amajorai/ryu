import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useRef, useState } from "react";
import {
	applyCustomTokensLive,
	CODE_FONTS,
	DEFAULT_CARD_SPACING,
	DEFAULT_CHAT_WIDTH,
	DEFAULT_RADIUS,
	DEFAULT_SCALE,
	DEFAULT_SIDEBAR_WIDTH,
	DEFAULT_SPACING,
	HEADING_FONTS,
	SIDEBAR_WIDTH_KEY,
	setCardSpacing,
	setChatWidth,
	setCodeFont,
	setContrast,
	setDarkPreset,
	setHeadingFont,
	setLightPreset,
	setRadius,
	setScale,
	setSidebarWidthSetting,
	setSpacing,
	setUiFont,
	UI_FONTS,
} from "@/src/hooks/useThemePreset.ts";
import {
	APPEARANCE_DEFAULTS,
	resetAppearanceSettings,
} from "@/src/lib/appearance-settings.ts";
import {
	type CustomTokens,
	customTokensToVariant,
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	deleteCustomTheme,
	type GroupedVariants,
	getGroupedVariants,
	STORAGE_KEYS,
	saveCustomTheme,
} from "@/src/lib/themes/presets.ts";
import { initTokens, tokensAreEqual } from "./appearance-tab-model.ts";

/**
 * The Appearance tab's theme editor and slider state: preset ids, token edits,
 * fonts, density sliders and the reset handler, in the order the tab called them.
 */
export function useAppearanceThemeState() {
	const [lightPresetId, setLightPresetId] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID
	);
	const [darkPresetId, setDarkPresetId] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID
	);
	const [lightTokens, setLightTokens] = useState<CustomTokens>(() =>
		initTokens(
			localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID
		)
	);
	const [darkTokens, setDarkTokens] = useState<CustomTokens>(() =>
		initTokens(localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID)
	);
	const [lightBaseTokens, setLightBaseTokens] = useState<CustomTokens>(() =>
		initTokens(
			localStorage.getItem(STORAGE_KEYS.lightPreset) ?? DEFAULT_LIGHT_ID
		)
	);
	const [darkBaseTokens, setDarkBaseTokens] = useState<CustomTokens>(() =>
		initTokens(localStorage.getItem(STORAGE_KEYS.darkPreset) ?? DEFAULT_DARK_ID)
	);
	const lightDirty = !tokensAreEqual(lightTokens, lightBaseTokens);
	const darkDirty = !tokensAreEqual(darkTokens, darkBaseTokens);

	const [lightGroups, setLightGroups] = useState<GroupedVariants>(() =>
		getGroupedVariants("light")
	);
	const [darkGroups, setDarkGroups] = useState<GroupedVariants>(() =>
		getGroupedVariants("dark")
	);

	const [uiFont, setUiFontState] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.uiFont) ?? UI_FONTS[0].value
	);
	const [headingFont, setHeadingFontState] = useState<string>(
		() =>
			localStorage.getItem(STORAGE_KEYS.headingFont) ?? HEADING_FONTS[0].value
	);
	const [codeFont, setCodeFontState] = useState<string>(
		() => localStorage.getItem(STORAGE_KEYS.codeFont) ?? CODE_FONTS[0].value
	);
	const [contrastValue, setContrastValue] = useState<number>(() =>
		Number(localStorage.getItem(STORAGE_KEYS.contrast) ?? "50")
	);
	const [radiusValue, setRadiusValue] = useState<number>(() =>
		Number(localStorage.getItem(STORAGE_KEYS.radius) ?? String(DEFAULT_RADIUS))
	);
	const [spacingValue, setSpacingValue] = useState<number>(() =>
		Number(
			localStorage.getItem(STORAGE_KEYS.spacing) ?? String(DEFAULT_SPACING)
		)
	);
	const [scaleValue, setScaleValue] = useState<number>(() =>
		Number(localStorage.getItem(STORAGE_KEYS.scale) ?? String(DEFAULT_SCALE))
	);
	const [cardSpacingValue, setCardSpacingValue] = useState<number>(() =>
		Number(
			localStorage.getItem(STORAGE_KEYS.cardSpacing) ??
				String(DEFAULT_CARD_SPACING)
		)
	);
	const [chatWidthValue, setChatWidthValue] = useState<number>(() =>
		Number(
			localStorage.getItem(STORAGE_KEYS.chatWidth) ?? String(DEFAULT_CHAT_WIDTH)
		)
	);
	const [sidebarWidthValue, setSidebarWidthValue] = useState<number>(() =>
		Number(
			localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? String(DEFAULT_SIDEBAR_WIDTH)
		)
	);

	const [appearanceResetConfirm, setAppearanceResetConfirm] = useState(false);

	const [lightSaveDialog, setLightSaveDialog] = useState(false);
	const [darkSaveDialog, setDarkSaveDialog] = useState(false);
	const [lightSaveName, setLightSaveName] = useState("");
	const [darkSaveName, setDarkSaveName] = useState("");
	const pendingCustomPresetIds = useRef<{
		light: string | null;
		dark: string | null;
	}>({ light: null, dark: null });

	const handleLightPreset = useCallback((id: string | null) => {
		if (!id) {
			return;
		}
		pendingCustomPresetIds.current.light = null;
		const tokens = initTokens(id);
		setLightPresetId(id);
		setLightTokens(tokens);
		setLightBaseTokens(tokens);
		setLightSaveDialog(false);
		setLightPreset(id);
	}, []);

	const handleDarkPreset = useCallback((id: string | null) => {
		if (!id) {
			return;
		}
		pendingCustomPresetIds.current.dark = null;
		const tokens = initTokens(id);
		setDarkPresetId(id);
		setDarkTokens(tokens);
		setDarkBaseTokens(tokens);
		setDarkSaveDialog(false);
		setDarkPreset(id);
	}, []);

	const handleLightTokenChange = useCallback(
		(key: keyof CustomTokens, value: string) => {
			setLightTokens((prev) => {
				const updated = { ...prev, [key]: value };
				applyCustomTokensLive("light", updated);
				return updated;
			});
		},
		[]
	);

	const handleDarkTokenChange = useCallback(
		(key: keyof CustomTokens, value: string) => {
			setDarkTokens((prev) => {
				const updated = { ...prev, [key]: value };
				applyCustomTokensLive("dark", updated);
				return updated;
			});
		},
		[]
	);

	const handleLightSaveConfirm = useCallback(() => {
		const name = lightSaveName.trim();
		if (!name) {
			return;
		}
		const id =
			pendingCustomPresetIds.current.light ??
			`custom-light-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
		pendingCustomPresetIds.current.light = id;
		const variant = customTokensToVariant(id, name, "light", lightTokens);
		try {
			saveCustomTheme(variant);
			setLightPreset(id);
		} catch {
			toast.error(
				"Couldn't save theme preset. Your draft is unchanged; try again."
			);
			return;
		}
		pendingCustomPresetIds.current.light = null;
		setLightGroups(getGroupedVariants("light"));
		setLightPresetId(id);
		setLightBaseTokens(lightTokens);
		setLightSaveDialog(false);
		setLightSaveName("");
	}, [lightSaveName, lightTokens]);

	const handleDarkSaveConfirm = useCallback(() => {
		const name = darkSaveName.trim();
		if (!name) {
			return;
		}
		const id =
			pendingCustomPresetIds.current.dark ??
			`custom-dark-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
		pendingCustomPresetIds.current.dark = id;
		const variant = customTokensToVariant(id, name, "dark", darkTokens);
		try {
			saveCustomTheme(variant);
			setDarkPreset(id);
		} catch {
			toast.error(
				"Couldn't save theme preset. Your draft is unchanged; try again."
			);
			return;
		}
		pendingCustomPresetIds.current.dark = null;
		setDarkGroups(getGroupedVariants("dark"));
		setDarkPresetId(id);
		setDarkBaseTokens(darkTokens);
		setDarkSaveDialog(false);
		setDarkSaveName("");
	}, [darkSaveName, darkTokens]);

	// Deleting the ACTIVE preset would otherwise leave a dangling id in
	// localStorage: `findVariant` returns undefined, `initTheme` applies nothing,
	// and the next cold start boots with whatever tokens the stylesheet ships. So
	// deletion always re-selects the shipped default for that mode, which also
	// repaints immediately through the normal preset-change path.
	const handleLightDelete = useCallback(
		(id: string) => {
			deleteCustomTheme(id);
			setLightGroups(getGroupedVariants("light"));
			if (lightPresetId === id) {
				handleLightPreset(DEFAULT_LIGHT_ID);
			}
		},
		[handleLightPreset, lightPresetId]
	);

	const handleDarkDelete = useCallback(
		(id: string) => {
			deleteCustomTheme(id);
			setDarkGroups(getGroupedVariants("dark"));
			if (darkPresetId === id) {
				handleDarkPreset(DEFAULT_DARK_ID);
			}
		},
		[handleDarkPreset, darkPresetId]
	);

	const handleLightDiscard = useCallback(() => {
		pendingCustomPresetIds.current.light = null;
		// Re-apply the saved preset variant (not customTokensToVariant on the
		// 7 base fields). customTokensToVariant invents primary-foreground and
		// would leave Switch thumbs / primary ink wrong after a swatch edit.
		setLightTokens(lightBaseTokens);
		setLightSaveDialog(false);
		setLightPreset(lightPresetId);
	}, [lightBaseTokens, lightPresetId]);

	const handleDarkDiscard = useCallback(() => {
		pendingCustomPresetIds.current.dark = null;
		setDarkTokens(darkBaseTokens);
		setDarkSaveDialog(false);
		setDarkPreset(darkPresetId);
	}, [darkBaseTokens, darkPresetId]);

	const handleUiFont = (value: string | null) => {
		if (!value) {
			return;
		}
		setUiFontState(value);
		setUiFont(value);
	};

	const handleHeadingFont = (value: string | null) => {
		if (!value) {
			return;
		}
		setHeadingFontState(value);
		setHeadingFont(value);
	};

	const handleCodeFont = (value: string | null) => {
		if (!value) {
			return;
		}
		setCodeFontState(value);
		setCodeFont(value);
	};

	const handleContrast = (vals: number | readonly number[]) => {
		const value = [vals].flat()[0] ?? 50;
		setContrastValue(value);
		setContrast(value);
	};

	const handleRadius = (vals: number | readonly number[]) => {
		const value = [vals].flat()[0] ?? DEFAULT_RADIUS;
		setRadiusValue(value);
		setRadius(value);
	};

	const handleSpacing = (vals: number | readonly number[]) => {
		const value = [vals].flat()[0] ?? DEFAULT_SPACING;
		setSpacingValue(value);
		setSpacing(value);
	};

	const handleScale = (vals: number | readonly number[]) => {
		const value = [vals].flat()[0] ?? DEFAULT_SCALE;
		setScaleValue(value);
		setScale(value);
	};

	const handleCardSpacing = (vals: number | readonly number[]) => {
		const value = [vals].flat()[0] ?? DEFAULT_CARD_SPACING;
		setCardSpacingValue(value);
		setCardSpacing(value);
	};

	const handleChatWidth = (vals: number | readonly number[]) => {
		const value = [vals].flat()[0] ?? DEFAULT_CHAT_WIDTH;
		setChatWidthValue(value);
		setChatWidth(value);
	};

	const handleSidebarWidth = (vals: number | readonly number[]) => {
		const value = [vals].flat()[0] ?? DEFAULT_SIDEBAR_WIDTH;
		setSidebarWidthValue(value);
		setSidebarWidthSetting(value);
	};

	const resetAppearanceDefaults = () => {
		pendingCustomPresetIds.current = { light: null, dark: null };
		// Registry owns every appearance preference — adding a setting means
		// registering it in appearance-settings.ts, not extending this list.
		resetAppearanceSettings();

		// Sync local useState mirrors (sliders / font selects / preset editors).
		// Hook-backed toggles update themselves via their external stores.
		const lightTok = initTokens(APPEARANCE_DEFAULTS.lightPreset);
		setLightPresetId(APPEARANCE_DEFAULTS.lightPreset);
		setLightTokens(lightTok);
		setLightBaseTokens(lightTok);
		setLightSaveDialog(false);
		const darkTok = initTokens(APPEARANCE_DEFAULTS.darkPreset);
		setDarkPresetId(APPEARANCE_DEFAULTS.darkPreset);
		setDarkTokens(darkTok);
		setDarkBaseTokens(darkTok);
		setDarkSaveDialog(false);
		setUiFontState(APPEARANCE_DEFAULTS.uiFont);
		setHeadingFontState(APPEARANCE_DEFAULTS.headingFont);
		setCodeFontState(APPEARANCE_DEFAULTS.codeFont);
		setContrastValue(APPEARANCE_DEFAULTS.contrast);
		setRadiusValue(APPEARANCE_DEFAULTS.radius);
		setSpacingValue(APPEARANCE_DEFAULTS.spacing);
		setScaleValue(APPEARANCE_DEFAULTS.scale);
		setCardSpacingValue(DEFAULT_CARD_SPACING);
		setChatWidthValue(APPEARANCE_DEFAULTS.chatWidth);
		setSidebarWidthValue(APPEARANCE_DEFAULTS.sidebarWidth);

		setAppearanceResetConfirm(false);
	};

	return {
		lightPresetId,
		setLightPresetId,
		darkPresetId,
		setDarkPresetId,
		lightTokens,
		setLightTokens,
		darkTokens,
		setDarkTokens,
		lightBaseTokens,
		setLightBaseTokens,
		darkBaseTokens,
		setDarkBaseTokens,
		lightDirty,
		darkDirty,
		lightGroups,
		setLightGroups,
		darkGroups,
		setDarkGroups,
		uiFont,
		setUiFontState,
		headingFont,
		setHeadingFontState,
		codeFont,
		setCodeFontState,
		contrastValue,
		setContrastValue,
		radiusValue,
		setRadiusValue,
		spacingValue,
		setSpacingValue,
		scaleValue,
		setScaleValue,
		cardSpacingValue,
		setCardSpacingValue,
		chatWidthValue,
		setChatWidthValue,
		sidebarWidthValue,
		setSidebarWidthValue,
		appearanceResetConfirm,
		setAppearanceResetConfirm,
		lightSaveDialog,
		setLightSaveDialog,
		darkSaveDialog,
		setDarkSaveDialog,
		lightSaveName,
		setLightSaveName,
		darkSaveName,
		setDarkSaveName,
		pendingCustomPresetIds,
		handleLightPreset,
		handleDarkPreset,
		handleLightTokenChange,
		handleDarkTokenChange,
		handleLightSaveConfirm,
		handleDarkSaveConfirm,
		handleLightDelete,
		handleDarkDelete,
		handleLightDiscard,
		handleDarkDiscard,
		handleUiFont,
		handleHeadingFont,
		handleCodeFont,
		handleContrast,
		handleRadius,
		handleSpacing,
		handleScale,
		handleCardSpacing,
		handleChatWidth,
		handleSidebarWidth,
		resetAppearanceDefaults,
	};
}

export type AppearanceThemeState = ReturnType<typeof useAppearanceThemeState>;
