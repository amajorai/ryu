import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SYSTEM_COLOR_SCHEME,
	DEFAULT_THEME_MODE,
	DEFAULT_THEME_PRESET,
	defaultThemePreference,
	isThemeColorScheme,
	isThemeMode,
	isThemePreference,
	isThemePresetId,
	loadThemePreference,
	loadThemePreferences,
	noColorRequested,
	resolveTheme,
	resolveThemePreference,
	saveThemePreference,
	serializeThemePreference,
	THEME_CATALOG,
	THEME_COLOR_SCHEMES,
	THEME_MODES,
	THEME_PRESET_IDS,
} from "../core/themePreferences.ts";
import {
	ryuNoColorDarkTheme,
	ryuNoColorLightTheme,
	ryuTheme,
} from "../ui/theme.ts";

const HEX_COLOR = /^#[0-9A-F]{6}$/i;

describe("terminal theme catalog", () => {
	test("exposes named Ryu preset ids with complete termcn themes", () => {
		expect(THEME_PRESET_IDS).toEqual(["ryu", "ryu-mono"]);

		for (const preset of Object.values(THEME_CATALOG)) {
			for (const theme of [preset.light, preset.dark]) {
				expect(theme.name).toBeString();
				for (const color of Object.values(theme.colors)) {
					expect(color).toMatch(HEX_COLOR);
				}
				expect(theme.border.color).toMatch(HEX_COLOR);
				expect(theme.border.focusColor).toMatch(HEX_COLOR);
			}
		}
	});

	test("keeps the existing ryuTheme as the default dark compatibility theme", () => {
		expect(ryuTheme).toBe(THEME_CATALOG.ryu.dark);
		expect(ryuTheme.name).toBe("ryu");
	});
});

describe("theme preference validation", () => {
	test("defines system, light, and dark modes", () => {
		expect(THEME_MODES).toEqual(["system", "light", "dark"]);
		expect(THEME_COLOR_SCHEMES).toEqual(["light", "dark"]);
		expect(DEFAULT_THEME_MODE).toBe("system");
		expect(DEFAULT_THEME_PRESET).toBe("ryu");
		expect(DEFAULT_SYSTEM_COLOR_SCHEME).toBe("dark");
	});

	test("accepts only known modes, schemes, presets, and complete preferences", () => {
		expect(isThemeMode("system")).toBe(true);
		expect(isThemeMode("light")).toBe(true);
		expect(isThemeMode("dark")).toBe(true);
		expect(isThemeMode("auto")).toBe(false);
		expect(isThemeColorScheme("light")).toBe(true);
		expect(isThemeColorScheme("system")).toBe(false);
		expect(isThemePresetId("ryu")).toBe(true);
		expect(isThemePresetId("missing")).toBe(false);
		expect(isThemePreference({ mode: "dark", preset: "ryu" })).toBe(true);
		expect(isThemePreference({ mode: "neon", preset: "ryu" })).toBe(false);
		expect(isThemePreference({ mode: "dark" })).toBe(false);
	});

	test("returns fresh safe defaults for missing or malformed values", () => {
		expect(defaultThemePreference()).toEqual({ mode: "system", preset: "ryu" });
		expect(loadThemePreference(null)).toEqual(defaultThemePreference());
		expect(loadThemePreference("not-json")).toEqual(defaultThemePreference());
		expect(loadThemePreference({ mode: "neon", preset: "missing" })).toEqual(
			defaultThemePreference()
		);
	});

	test("validates persisted fields independently and accepts JSON", () => {
		expect(loadThemePreference({ mode: "light", preset: "ryu-mono" })).toEqual({
			mode: "light",
			preset: "ryu-mono",
		});
		expect(loadThemePreference({ mode: "bad", preset: "ryu-mono" })).toEqual({
			mode: "system",
			preset: "ryu-mono",
		});
		expect(loadThemePreference({ mode: "dark", preset: "bad" })).toEqual({
			mode: "dark",
			preset: "ryu",
		});
		expect(loadThemePreferences('{"mode":"light","preset":"ryu"}')).toEqual({
			mode: "light",
			preset: "ryu",
		});
	});

	test("save returns a validated plain object without mutating the input", () => {
		const input = { mode: "dark", preset: "ryu-mono", extra: true };
		const saved = saveThemePreference(input);

		expect(saved).toEqual({ mode: "dark", preset: "ryu-mono" });
		expect(saved).not.toBe(input);
		expect(serializeThemePreference(saved)).toBe(
			'{"mode":"dark","preset":"ryu-mono"}'
		);
	});
});

describe("theme resolution", () => {
	test("resolves explicit light and dark preferences", () => {
		expect(resolveThemePreference({ mode: "light", preset: "ryu" })).toBe(
			THEME_CATALOG.ryu.light
		);
		expect(resolveTheme({ mode: "dark", preset: "ryu-mono" })).toBe(
			THEME_CATALOG["ryu-mono"].dark
		);
	});

	test("resolves system mode from the supplied terminal scheme", () => {
		expect(
			resolveThemePreference({ mode: "system", preset: "ryu" }, "light")
		).toBe(THEME_CATALOG.ryu.light);
		expect(
			resolveThemePreference({ mode: "system", preset: "ryu" }, "dark")
		).toBe(THEME_CATALOG.ryu.dark);
	});

	test("falls back to the readable dark Ryu theme for an unknown system scheme", () => {
		expect(
			resolveThemePreference({ mode: "system", preset: "ryu-mono" }, "unknown")
		).toBe(THEME_CATALOG["ryu-mono"].dark);
		expect(resolveThemePreference({ mode: "unknown", preset: "unknown" })).toBe(
			ryuTheme
		);
	});
});

describe("NO_COLOR", () => {
	test("is requested only when the variable is present and not empty", () => {
		expect(noColorRequested({ NO_COLOR: "1" })).toBe(true);
		expect(noColorRequested({ NO_COLOR: "" })).toBe(false);
		expect(noColorRequested({})).toBe(false);
	});

	test("resolves a hue-free theme for the active scheme", () => {
		expect(
			resolveThemePreference({ mode: "light", preset: "ryu" }, "dark", true)
		).toBe(ryuNoColorLightTheme);
		expect(
			resolveThemePreference({ mode: "system", preset: "ryu" }, "dark", true)
		).toBe(ryuNoColorDarkTheme);
		const { colors } = ryuNoColorDarkTheme;
		for (const status of [
			colors.primary,
			colors.accent,
			colors.success,
			colors.warning,
			colors.error,
			colors.info,
		]) {
			expect(status).toBe(colors.foreground);
		}
	});
});
