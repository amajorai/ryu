// Unit tests for the theme-preferences contract: defaults, the tolerant
// coercion of an unknown JSON payload (Core round-trips this blob), and the
// active-preset resolver. normalizeThemePrefs is deliberately lenient — it
// coerces by field type and lets downstream clamp — so these tests PIN that
// tolerant behavior rather than tightening it.

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONTRAST, DEFAULT_RADIUS } from "./apply.ts";
import { DEFAULT_DARK_ID, DEFAULT_LIGHT_ID } from "./presets.ts";
import {
	activePresetId,
	defaultThemePrefs,
	normalizeThemePrefs,
	THEME_PREFS_VERSION,
} from "./prefs.ts";

describe("defaultThemePrefs", () => {
	test("returns the documented light-first defaults", () => {
		const p = defaultThemePrefs();
		expect(p.version).toBe(THEME_PREFS_VERSION);
		expect(p.mode).toBe("light");
		expect(p.lightPreset).toBe(DEFAULT_LIGHT_ID);
		expect(p.darkPreset).toBe(DEFAULT_DARK_ID);
		expect(p.contrast).toBe(DEFAULT_CONTRAST);
		expect(p.radius).toBe(DEFAULT_RADIUS);
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
		expect(normalizeThemePrefs({ mode: "neon" }).mode).toBe("light");
		expect(normalizeThemePrefs({ mode: 7 }).mode).toBe("light");
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

	test("NaN is a number and passes through (tolerant contract — downstream clamps)", () => {
		const p = normalizeThemePrefs({ contrast: Number.NaN });
		expect(Number.isNaN(p.contrast)).toBe(true);
	});

	test("a non-current version is preserved, not reset (migration is a caller concern)", () => {
		expect(normalizeThemePrefs({ version: 99 }).version).toBe(99);
	});

	test("customThemes must be an array; a non-array falls back to empty", () => {
		expect(normalizeThemePrefs({ customThemes: { id: "x" } }).customThemes).toEqual(
			[]
		);
		const arr = [{ id: "z" }];
		expect(normalizeThemePrefs({ customThemes: arr }).customThemes).toBe(arr);
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
