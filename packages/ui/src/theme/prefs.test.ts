// Unit tests for the theme-preferences contract: defaults, the tolerant
// coercion of an unknown JSON payload (Core round-trips this blob), and the
// active-preset resolver. normalizeThemePrefs is deliberately lenient — it
// coerces by field type and lets downstream clamp — so these tests PIN that
// tolerant scalar behavior. Custom-theme collections use the complete wire schema.

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTRAST, DEFAULT_RADIUS } from "./apply.ts";
import {
	activePresetId,
	defaultThemePrefs,
	normalizeThemePrefs,
	THEME_PREFS_VERSION,
	themePrefsSchema,
} from "./prefs.ts";
import {
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	THEME_VARIANTS,
} from "./presets.ts";

describe("defaultThemePrefs", () => {
	test("returns the documented system-following defaults", () => {
		const p = defaultThemePrefs();
		expect(p.version).toBe(THEME_PREFS_VERSION);
		expect(p.mode).toBe("system");
		expect(p.lightPreset).toBe(DEFAULT_LIGHT_ID);
		expect(p.darkPreset).toBe(DEFAULT_DARK_ID);
		expect(p.contrast).toBe(DEFAULT_CONTRAST);
		expect(p.radius).toBe(DEFAULT_RADIUS);
		expect(p.timezone).toBe("system");
		expect(p.customThemes).toEqual([]);
	});

	test("returns a fresh customThemes array each call (no shared mutable state)", () => {
		const a = defaultThemePrefs();
		const b = defaultThemePrefs();
		expect(a.customThemes).not.toBe(b.customThemes);
	});
});

describe("normalizeThemePrefs", () => {
	test("non-object inputs fall back to defaults", () => {
		expect(normalizeThemePrefs(null)).toEqual(defaultThemePrefs());
		expect(normalizeThemePrefs(undefined)).toEqual(defaultThemePrefs());
		expect(normalizeThemePrefs("nope")).toEqual(defaultThemePrefs());
		expect(normalizeThemePrefs(42)).toEqual(defaultThemePrefs());
	});

	test("empty object yields defaults plus undefined optional fonts", () => {
		const p = normalizeThemePrefs({});
		expect(p).toEqual({
			...defaultThemePrefs(),
			uiFont: undefined,
			headingFont: undefined,
			codeFont: undefined,
		});
	});

	test("accepts each of the three valid modes", () => {
		expect(normalizeThemePrefs({ mode: "light" }).mode).toBe("light");
		expect(normalizeThemePrefs({ mode: "dark" }).mode).toBe("dark");
		expect(normalizeThemePrefs({ mode: "system" }).mode).toBe("system");
	});

	test("an invalid mode falls back to the default mode", () => {
		expect(normalizeThemePrefs({ mode: "neon" }).mode).toBe("system");
		expect(normalizeThemePrefs({ mode: 7 }).mode).toBe("system");
	});

	test("string preset ids pass through; non-strings fall back", () => {
		const p = normalizeThemePrefs({ lightPreset: "custom-l", darkPreset: 9 });
		expect(p.lightPreset).toBe("custom-l");
		expect(p.darkPreset).toBe(DEFAULT_DARK_ID);
	});

	test("numeric contrast/radius pass through, non-numbers fall back", () => {
		const p = normalizeThemePrefs({ contrast: 80, radius: 1.5 });
		expect(p.contrast).toBe(80);
		expect(p.radius).toBe(1.5);
		const bad = normalizeThemePrefs({ contrast: "80", radius: null });
		expect(bad.contrast).toBe(DEFAULT_CONTRAST);
		expect(bad.radius).toBe(DEFAULT_RADIUS);
	});

	test("normalizes the shared layout and appearance controls", () => {
		const p = normalizeThemePrefs({
			spacing: 0.3,
			scale: 1.25,
			cardSpacing: null,
			pointerCursor: true,
			chromeShadows: false,
			dialogOverlayBlur: true,
			popupOverlayBlur: true,
			invertedBackgrounds: true,
			animationsEnabled: false,
		});
		expect(p.spacing).toBe(0.3);
		expect(p.scale).toBe(1.25);
		expect(p.cardSpacing).toBeNull();
		expect(p.pointerCursor).toBe(true);
		expect(p.chromeShadows).toBe(false);
		expect(p.dialogOverlayBlur).toBe(true);
		expect(p.popupOverlayBlur).toBe(true);
		expect(p.invertedBackgrounds).toBe(true);
		expect(p.animationsEnabled).toBe(false);
	});

	test("normalizes cross-process date and locale preferences", () => {
		const p = normalizeThemePrefs({
			locale: "en-GB",
			timezone: "Asia/Singapore",
		});
		expect(p.locale).toBe("en-GB");
		expect(p.timezone).toBe("Asia/Singapore");
	});

	test("NaN is a number and passes through (tolerant contract — downstream clamps)", () => {
		const p = normalizeThemePrefs({ contrast: Number.NaN });
		expect(Number.isNaN(p.contrast)).toBe(true);
	});

	test("a non-current version is preserved, not reset (migration is a caller concern)", () => {
		expect(normalizeThemePrefs({ version: 99 }).version).toBe(99);
	});

	test("valid custom themes retain values/order using parsed array and field copies", () => {
		const source = THEME_VARIANTS.slice(0, 2).map((variant) => ({
			...variant,
			tokens: { ...variant.tokens },
			extra: "retained",
		}));
		expect(source).toHaveLength(2);
		const parsed = normalizeThemePrefs({ customThemes: source }).customThemes;
		expect(parsed).toEqual(source);
		expect(parsed).not.toBe(source);
		expect(parsed[0]).not.toBe(source[0]);
		expect(parsed[0]?.tokens).not.toBe(source[0]?.tokens);
		expect(normalizeThemePrefs({ customThemes: [] }).customThemes).toEqual([]);
	});

	test("malformed custom collections fall back without tightening scalar tolerance", () => {
		const valid = THEME_VARIANTS[0];
		if (!valid) {
			throw new Error("The authored theme catalog must contain a fixture");
		}
		const invalidCollections = [
			undefined,
			null,
			{ id: "x" },
			[{ id: "z" }],
			[valid, null],
			[{ ...valid, tokens: null }],
			[{ ...valid, mode: "neon" }],
			[{ ...valid, preview: { ...valid.preview, primary: 3 } }],
			[{ ...valid, tokens: { "--primary": 3 } }],
			[{ ...valid, appearance: { radius: Number.NaN } }],
		];
		for (const customThemes of invalidCollections) {
			const prefs = normalizeThemePrefs({ customThemes, contrast: Number.NaN });
			expect(prefs.customThemes).toEqual([]);
			expect(Number.isNaN(prefs.contrast)).toBe(true);
		}
	});

	test("optional font fields survive only as strings", () => {
		const p = normalizeThemePrefs({
			uiFont: "Inter",
			headingFont: 3,
			codeFont: "Mono",
		});
		expect(p.uiFont).toBe("Inter");
		expect(p.headingFont).toBeUndefined();
		expect(p.codeFont).toBe("Mono");
	});
});

describe("activePresetId", () => {
	test("dark flag selects the dark preset, light flag the light preset", () => {
		const prefs = { ...defaultThemePrefs(), lightPreset: "L", darkPreset: "D" };
		expect(activePresetId(prefs, true)).toBe("D");
		expect(activePresetId(prefs, false)).toBe("L");
	});
});

describe("themePrefsSchema", () => {
	test("validates a saved wire blob without normalizing numeric appearance values", () => {
		const prefs = { ...defaultThemePrefs(), contrast: 80, radius: 1.5 };
		expect<typeof prefs>(themePrefsSchema.parse(prefs)).toEqual(prefs);
	});
	test("rejects corrupt custom theme entries before they reach a renderer", () => {
		expect(
			themePrefsSchema.safeParse({
				...defaultThemePrefs(),
				customThemes: [{ id: "custom", tokens: null }],
			}).success
		).toBe(false);
	});
});
