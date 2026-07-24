// Unit tests for the pure theme-preset helpers: variant lookup against
// built-ins + caller-supplied customs, mode filtering, and the lossless
// CustomTokens <-> ThemeVariant conversion that backs the theme editor. This
// module is required to stay pure (no document/window/localStorage).

import { describe, expect, test } from "bun:test";
import {
	builtinVariants,
	type CustomTokens,
	customTokensToVariant,
	DARK_VARIANTS,
	DEFAULT_DARK_ID,
	DEFAULT_LIGHT_ID,
	findVariantIn,
	LIGHT_VARIANTS,
	THEME_VARIANTS,
	type ThemeVariant,
	variantToCustomTokens,
} from "./presets.ts";

describe("THEME_VARIANTS / default ids", () => {
	test("the two default ids resolve to real built-in variants of the right mode", () => {
		const light = THEME_VARIANTS.find((v) => v.id === DEFAULT_LIGHT_ID);
		const dark = THEME_VARIANTS.find((v) => v.id === DEFAULT_DARK_ID);
		expect(light?.mode).toBe("light");
		expect(dark?.mode).toBe("dark");
	});

	test("LIGHT_VARIANTS and DARK_VARIANTS partition the full set by mode", () => {
		expect(LIGHT_VARIANTS.every((v) => v.mode === "light")).toBe(true);
		expect(DARK_VARIANTS.every((v) => v.mode === "dark")).toBe(true);
		expect(LIGHT_VARIANTS.length + DARK_VARIANTS.length).toBe(
			THEME_VARIANTS.length
		);
	});

	test("every variant id is unique", () => {
		const ids = THEME_VARIANTS.map((v) => v.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("findVariantIn", () => {
	test("resolves a built-in by id with no customs supplied", () => {
		expect(findVariantIn(DEFAULT_LIGHT_ID)?.id).toBe(DEFAULT_LIGHT_ID);
	});

	test("resolves a caller-supplied custom variant", () => {
		const custom: ThemeVariant = {
			id: "my-custom",
			label: "Mine",
			mode: "dark",
			preview: { bg: "#000", surface: "#111", primary: "#f00", text: "#fff" },
			tokens: {},
		};
		expect(findVariantIn("my-custom", [custom])).toBe(custom);
	});

	test("a built-in wins over a custom that reuses its id (precedence)", () => {
		const shadow: ThemeVariant = {
			id: DEFAULT_LIGHT_ID,
			label: "Impostor",
			mode: "dark",
			preview: { bg: "#000", surface: "#111", primary: "#f00", text: "#fff" },
			tokens: {},
		};
		expect(findVariantIn(DEFAULT_LIGHT_ID, [shadow])?.label).not.toBe(
			"Impostor"
		);
	});

	test("an unknown id returns undefined", () => {
		expect(findVariantIn("does-not-exist")).toBeUndefined();
		expect(findVariantIn("does-not-exist", [])).toBeUndefined();
	});
});

describe("builtinVariants", () => {
	test("filters to just the requested mode", () => {
		expect(builtinVariants("light")).toEqual(LIGHT_VARIANTS);
		expect(builtinVariants("dark")).toEqual(DARK_VARIANTS);
	});
});

describe("customTokensToVariant / variantToCustomTokens", () => {
	const tokens: CustomTokens = {
		background: "#ffffff",
		foreground: "#111111",
		primary: "#2563eb",
		muted: "#f4f4f5",
		mutedForeground: "#71717a",
		border: "#e4e4e7",
		sidebar: "#f9f9f9",
	};

	test("builds a variant that carries the identity + mode + preview", () => {
		const v = customTokensToVariant("id1", "Label 1", "light", tokens);
		expect(v.id).toBe("id1");
		expect(v.label).toBe("Label 1");
		expect(v.mode).toBe("light");
		expect(v.preview).toEqual({
			bg: tokens.background,
			surface: tokens.sidebar,
			primary: tokens.primary,
			text: tokens.foreground,
		});
	});

	test("card + popover derive from the sidebar token", () => {
		const v = customTokensToVariant("id", "L", "light", tokens);
		expect(v.tokens["--card"]).toBe(tokens.sidebar);
		expect(v.tokens["--popover"]).toBe(tokens.sidebar);
	});

	test("primary-foreground and destructive flip with mode", () => {
		const light = customTokensToVariant("i", "l", "light", tokens);
		const dark = customTokensToVariant("i", "d", "dark", tokens);
		expect(light.tokens["--primary-foreground"]).toBe("#ffffff");
		expect(dark.tokens["--primary-foreground"]).toBe("#000000");
		expect(light.tokens["--destructive"]).toBe("#ef4444");
		expect(dark.tokens["--destructive"]).toBe("#f87171");
	});

	test("round-trips all seven fields losslessly (variant -> tokens -> variant)", () => {
		const v = customTokensToVariant("i", "l", "light", tokens);
		expect(variantToCustomTokens(v)).toEqual(tokens);
	});

	test("variantToCustomTokens fills defaults for a variant missing tokens", () => {
		const bare: ThemeVariant = {
			id: "b",
			label: "Bare",
			mode: "light",
			preview: { bg: "#fff", surface: "#fff", primary: "#000", text: "#000" },
			tokens: {},
		};
		expect(variantToCustomTokens(bare)).toEqual({
			background: "#ffffff",
			foreground: "#000000",
			primary: "#000000",
			muted: "#f4f4f5",
			mutedForeground: "#71717a",
			border: "#e4e4e7",
			sidebar: "#f9f9f9",
		});
	});
});
