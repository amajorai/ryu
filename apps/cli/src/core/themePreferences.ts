import { z } from "zod";
import type { Theme } from "@/components/ui/theme-provider.tsx";
import {
	RYU_THEME_PRESETS,
	ryuNoColorDarkTheme,
	ryuNoColorLightTheme,
	ryuTheme,
	THEME_CATALOG,
	THEME_PRESET_IDS,
	type ThemePresetId,
} from "../ui/theme.ts";

export type { RyuThemePreset, ThemePresetId } from "../ui/theme.ts";
export { RYU_THEME_PRESETS, ryuTheme, THEME_CATALOG, THEME_PRESET_IDS };

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_COLOR_SCHEMES = ["light", "dark"] as const;
export type ThemeColorScheme = (typeof THEME_COLOR_SCHEMES)[number];

export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const DEFAULT_THEME_PRESET: ThemePresetId = "ryu";
export const DEFAULT_SYSTEM_COLOR_SCHEME: ThemeColorScheme = "dark";

export interface ThemePreference {
	mode: ThemeMode;
	preset: ThemePresetId;
}

export type ThemePreferences = ThemePreference;

export const DEFAULT_THEME_PREFERENCE: Readonly<ThemePreference> =
	Object.freeze({
		mode: DEFAULT_THEME_MODE,
		preset: DEFAULT_THEME_PRESET,
	});

export const DEFAULT_THEME_PREFERENCES = DEFAULT_THEME_PREFERENCE;

const themeModeSchema = z.enum(THEME_MODES);
const themeColorSchemeSchema = z.enum(THEME_COLOR_SCHEMES);
const themePresetIdSchema = z.enum(THEME_PRESET_IDS);
const themePreferenceSchema = z.object({
	mode: themeModeSchema,
	preset: themePresetIdSchema,
});
const persistedThemePreferenceSchema = z.object({
	mode: themeModeSchema.catch(DEFAULT_THEME_MODE),
	preset: themePresetIdSchema.catch(DEFAULT_THEME_PRESET),
});

export function isThemeMode(
	value: Parameters<typeof themeModeSchema.safeParse>[0]
): value is ThemeMode {
	return themeModeSchema.safeParse(value).success;
}
export function isThemeColorScheme(
	value: Parameters<typeof themeColorSchemeSchema.safeParse>[0]
): value is ThemeColorScheme {
	return themeColorSchemeSchema.safeParse(value).success;
}
export function isThemePresetId(
	value: Parameters<typeof themePresetIdSchema.safeParse>[0]
): value is ThemePresetId {
	return themePresetIdSchema.safeParse(value).success;
}
export function isThemePreference(
	value: Parameters<typeof themePreferenceSchema.safeParse>[0]
): value is ThemePreference {
	return themePreferenceSchema.safeParse(value).success;
}

export function defaultThemePreference(): ThemePreference {
	return {
		mode: DEFAULT_THEME_PREFERENCE.mode,
		preset: DEFAULT_THEME_PREFERENCE.preset,
	};
}

/**
 * Read a persisted preference value without touching storage.
 *
 * Both an already-parsed object and a JSON string are accepted because the
 * eventual CLI config adapter may use either representation. Each field is
 * validated independently so one bad value cannot make the terminal choose an
 * unreadable theme.
 */
export function loadThemePreference(
	value: Parameters<typeof persistedThemePreferenceSchema.safeParse>[0]
): ThemePreference {
	const text = z.string().safeParse(value);
	let parsed: ReturnType<typeof persistedThemePreferenceSchema.safeParse>;
	if (text.success) {
		try {
			parsed = persistedThemePreferenceSchema.safeParse(
				JSON.parse(text.data.trim())
			);
		} catch {
			return defaultThemePreference();
		}
	} else {
		parsed = persistedThemePreferenceSchema.safeParse(value);
	}
	return parsed.success ? parsed.data : defaultThemePreference();
}

/** Plural spelling for callers that treat the pair as a preferences record. */
export const loadThemePreferences = loadThemePreference;

/**
 * Return a fresh, validated object ready for a config adapter to persist.
 * This function intentionally performs no I/O; invalid input is replaced with
 * the same safe defaults used while loading.
 */
export const saveThemePreference = loadThemePreference;

export const saveThemePreferences = saveThemePreference;

export function serializeThemePreference(
	value: Parameters<typeof persistedThemePreferenceSchema.safeParse>[0]
): string {
	return JSON.stringify(saveThemePreference(value));
}

function resolveColorScheme(
	preference: ThemePreference,
	systemColorScheme: Parameters<typeof themeColorSchemeSchema.safeParse>[0]
): ThemeColorScheme {
	if (preference.mode !== "system") {
		return preference.mode;
	}
	return isThemeColorScheme(systemColorScheme)
		? systemColorScheme
		: DEFAULT_SYSTEM_COLOR_SCHEME;
}

/**
 * Whether the environment opts out of color under the NO_COLOR convention
 * (https://no-color.org): the variable is present and not empty.
 */
export function noColorRequested(
	env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
	return Boolean(env.NO_COLOR);
}

export function resolveThemePreference(
	value: Parameters<typeof persistedThemePreferenceSchema.safeParse>[0],
	systemColorScheme: Parameters<
		typeof themeColorSchemeSchema.safeParse
	>[0] = DEFAULT_SYSTEM_COLOR_SCHEME,
	noColor = false
): Theme {
	const preference = loadThemePreference(value);
	const colorScheme = resolveColorScheme(preference, systemColorScheme);
	if (noColor) {
		return colorScheme === "light" ? ryuNoColorLightTheme : ryuNoColorDarkTheme;
	}
	const preset = THEME_CATALOG[preference.preset];

	return preset?.[colorScheme] ?? THEME_CATALOG.ryu.dark ?? ryuTheme;
}

export const resolveTheme = resolveThemePreference;
