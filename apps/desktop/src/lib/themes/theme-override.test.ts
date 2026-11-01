// An interface's colour theme is a temporary override: it decides what the
// shell paints while the interface is active, but the user's saved presets and
// the prefs published to Core stay the user's own.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ThemePrefs } from "@ryu/ui/theme/prefs.ts";

const published: ThemePrefs[] = [];
const realPreferences = await import("@/src/lib/api/preferences.ts");
mock.module("@/src/lib/api/preferences.ts", () => ({
	...realPreferences,
	setThemePrefs: (_target: unknown, prefs: ThemePrefs) => {
		published.push(prefs);
		return Promise.resolve();
	},
}));

const {
	findVariant,
	saveCustomTheme,
	savePluginThemes,
	STORAGE_KEYS,
	variantToCustomTokens,
} = await import("@/src/lib/themes/presets.ts");
const {
	activePresetId,
	getThemeOverride,
	INTERFACE_COLOR_THEMES_KEY,
	overrideCoversMode,
	readStoredThemeOverride,
	sanitizeThemeOverride,
	setThemeOverride,
	subscribeThemeOverride,
	THEME_OVERRIDE_STORAGE_KEY,
} = await import("./theme-override.ts");
const {
	applyCustomTokensLive,
	initTheme,
	publishThemePrefs,
	reapplyActivePreset,
	setLightPreset,
} = await import("@/src/hooks/useThemePreset.ts");

const originalMatchMedia = window.matchMedia;
afterAll(() => {
	window.matchMedia = originalMatchMedia;
});

function stubPrefersDark(prefersDark: boolean) {
	window.matchMedia = (query) => {
		const media = originalMatchMedia.call(window, query);
		Object.defineProperty(media, "matches", {
			configurable: true,
			value: query.includes("dark") ? prefersDark : false,
		});
		return media;
	};
}

function background(id: string): string {
	const bg = findVariant(id)?.tokens["--background"];
	if (!bg) {
		throw new Error(`preset ${id} has no --background token`);
	}
	return bg;
}

function findVariantOrThrow(id: string) {
	const variant = findVariant(id);
	if (!variant) {
		throw new Error(`no preset ${id}`);
	}
	return variant;
}

function appliedBackground(): string {
	return document.documentElement.style.getPropertyValue("--background");
}

const PIXEL = {
	dark: "catppuccin-dark",
	label: "Pixel Town",
	light: "catppuccin-light",
	plugin: "@acme/pixel-town",
	source: "@acme/pixel-town:town",
};

beforeEach(() => {
	setThemeOverride(null);
	localStorage.clear();
	document.documentElement.removeAttribute("style");
	localStorage.setItem("theme", "light");
	stubPrefersDark(false);
	published.length = 0;
});

describe("activePresetId", () => {
	test("falls back to the defaults, then to the user's stored preset", () => {
		expect(activePresetId(false)).toBe("ryu-light");
		expect(activePresetId(true)).toBe("ryu-dark");
		localStorage.setItem(STORAGE_KEYS.darkPreset, "ryu-dark-mono");
		expect(activePresetId(true)).toBe("ryu-dark-mono");
	});

	test("the override's slot wins for the mode it covers", () => {
		setThemeOverride({
			label: "Day only",
			light: "catppuccin-light",
			plugin: "@acme/pixel-town",
			source: "x",
		});
		expect(activePresetId(false)).toBe("catppuccin-light");
		expect(overrideCoversMode(false)).toBe(true);
		expect(activePresetId(true)).toBe("ryu-dark");
		expect(overrideCoversMode(true)).toBe(false);
	});

	test("an unknown id or a theme of the other mode falls back", () => {
		setThemeOverride({
			dark: "ryu-light",
			label: "Broken",
			light: "@acme/pixel-town:missing",
			plugin: "@acme/pixel-town",
			source: "x",
		});
		expect(activePresetId(false)).toBe("ryu-light");
		expect(activePresetId(true)).toBe("ryu-dark");
	});

	test("slots resolve only to built-ins or the owning plugin's themes", () => {
		const theme = (id: string) => ({
			id,
			label: id,
			mode: "dark" as const,
			preview: { bg: "#000", primary: "#fff", surface: "#111", text: "#eee" },
			tokens: { "--background": `bg-${id}` },
		});
		savePluginThemes([
			theme("neon-dark"),
			theme("@acme/pixel-town:night"),
			theme("@other/plugin:night"),
		]);
		saveCustomTheme(theme("my-custom-dark"));
		const pick = (dark: string) =>
			activePresetId(true, {
				dark,
				label: "Pixel Town",
				plugin: "@acme/pixel-town",
				source: "@acme/pixel-town:town",
			});
		expect(pick("@acme/pixel-town:night")).toBe("@acme/pixel-town:night");
		expect(pick("ryu-dark-mono")).toBe("ryu-dark-mono");
		// Another plugin's un-namespaced theme is not a built-in.
		expect(pick("neon-dark")).toBe("ryu-dark");
		// Nor is a user's custom theme, or another plugin's namespace.
		expect(pick("my-custom-dark")).toBe("ryu-dark");
		expect(pick("@other/plugin:night")).toBe("ryu-dark");
	});

	test("the user's switch turns the override off", () => {
		setThemeOverride(PIXEL);
		localStorage.setItem(INTERFACE_COLOR_THEMES_KEY, "false");
		expect(activePresetId(false)).toBe("ryu-light");
		expect(overrideCoversMode(false)).toBe(false);
	});
});

describe("persistence", () => {
	test("set persists, reports a change once and notifies", () => {
		let calls = 0;
		const unsubscribe = subscribeThemeOverride(() => {
			calls += 1;
		});
		expect(setThemeOverride(PIXEL)).toBe(true);
		expect(setThemeOverride({ ...PIXEL })).toBe(false);
		expect(calls).toBe(1);
		expect(readStoredThemeOverride()).toEqual(PIXEL);
		expect(setThemeOverride(null)).toBe(true);
		expect(localStorage.getItem(THEME_OVERRIDE_STORAGE_KEY)).toBeNull();
		expect(getThemeOverride()).toBeNull();
		unsubscribe();
	});

	test("a stored value is sanitized on read", () => {
		localStorage.setItem(THEME_OVERRIDE_STORAGE_KEY, "{not json");
		expect(readStoredThemeOverride()).toBeNull();
		localStorage.setItem(
			THEME_OVERRIDE_STORAGE_KEY,
			JSON.stringify({ label: "No slots", plugin: "p", source: "x" })
		);
		expect(readStoredThemeOverride()).toBeNull();
		localStorage.setItem(
			THEME_OVERRIDE_STORAGE_KEY,
			JSON.stringify({
				dark: "ryu-dark",
				extra: true,
				light: 7,
				plugin: "p",
				source: "x",
			})
		);
		expect(readStoredThemeOverride()).toEqual({
			dark: "ryu-dark",
			label: "",
			plugin: "p",
			source: "x",
		});
		localStorage.setItem(
			THEME_OVERRIDE_STORAGE_KEY,
			JSON.stringify({ dark: "ryu-dark", source: "x" })
		);
		expect(readStoredThemeOverride()).toBeNull();
	});

	test("control characters and oversized ids are dropped", () => {
		expect(
			sanitizeThemeOverride({ light: "ryu-light\n", plugin: "p", source: "x" })
		).toBeNull();
		expect(
			sanitizeThemeOverride({
				light: "a".repeat(129),
				plugin: "p",
				source: "x",
			})
		).toBeNull();
		expect(
			sanitizeThemeOverride({ light: "ryu-light", plugin: "p", source: "" })
		).toBeNull();
		expect(sanitizeThemeOverride(["ryu-light"])).toBeNull();
	});
});

describe("painting", () => {
	test("initTheme paints the override for the current mode", () => {
		setThemeOverride(PIXEL);
		initTheme();
		expect(appliedBackground()).toBe(background("catppuccin-light"));
	});

	test("a light pick under a light override is saved, not painted", () => {
		setThemeOverride(PIXEL);
		reapplyActivePreset();
		setLightPreset("ryu-light");
		expect(localStorage.getItem(STORAGE_KEYS.lightPreset)).toBe("ryu-light");
		expect(appliedBackground()).toBe(background("catppuccin-light"));

		setThemeOverride(null);
		reapplyActivePreset();
		expect(appliedBackground()).toBe(background("ryu-light"));
	});

	test("a live token edit under a light override is not painted", () => {
		setThemeOverride(PIXEL);
		reapplyActivePreset();
		applyCustomTokensLive(
			"light",
			variantToCustomTokens(findVariantOrThrow("ryu-light"))
		);
		expect(appliedBackground()).toBe(background("catppuccin-light"));

		setThemeOverride(null);
		reapplyActivePreset();
		applyCustomTokensLive(
			"light",
			variantToCustomTokens(findVariantOrThrow("ryu-light-mono"))
		);
		expect(appliedBackground()).toBe(background("ryu-light-mono"));
	});

	test("published prefs carry the user's presets, never the override", async () => {
		localStorage.setItem(STORAGE_KEYS.lightPreset, "ryu-light");
		setThemeOverride(PIXEL);
		publishThemePrefs();
		await Bun.sleep(450);
		const last = published.at(-1);
		expect(last?.lightPreset).toBe("ryu-light");
		expect(last?.darkPreset).toBe("ryu-dark");
	});
});
