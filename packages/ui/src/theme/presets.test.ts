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
import { colorContrastRatio } from "./ring.ts";

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

	test("destructive flips with mode; primary-foreground follows primary luminance", () => {
		const light = customTokensToVariant("i", "l", "light", tokens);
		const dark = customTokensToVariant("i", "d", "dark", tokens);
		// #2563eb is a mid/dark blue — white ink in both modes (not mode-hardcoded black).
		expect(light.tokens["--primary-foreground"]).toBe("#ffffff");
		expect(dark.tokens["--primary-foreground"]).toBe("#ffffff");
		expect(light.tokens["--destructive"]).toBe("#ef4444");
		expect(dark.tokens["--destructive"]).toBe("#f87171");
	});

	test("light primary colours get black primary-foreground even in dark mode", () => {
		const pale = customTokensToVariant("i", "d", "dark", {
			...tokens,
			primary: "#fafafa",
		});
		expect(pale.tokens["--primary-foreground"]).toBe("#000000");
		expect(pale.tokens["--sidebar-primary-foreground"]).toBe("#000000");
	});

	test("oklch brand blue (ryu-dark primary) gets light primary-foreground", () => {
		const v = customTokensToVariant("i", "d", "dark", {
			...tokens,
			primary: "oklch(0.6690 0.1837 248.81)",
		});
		expect(v.tokens["--primary-foreground"]).toBe("#ffffff");
	});

	test("pale primary gets a darker ring that clears 3:1 on every surface", () => {
		const v = customTokensToVariant("i", "l", "light", {
			...tokens,
			primary: "#80cbc4",
		});
		const ring = v.tokens["--ring"] ?? "";
		expect(ring).not.toBe("#80cbc4");
		expect(v.tokens["--sidebar-ring"]).toBe(ring);
		expect(v.tokens["--primary"]).toBe("#80cbc4");
		for (const surface of [
			"--background",
			"--card",
			"--popover",
			"--sidebar",
		]) {
			expect(
				colorContrastRatio(ring, v.tokens[surface] ?? "") ?? 0
			).toBeGreaterThanOrEqual(3);
		}
	});

	test("dark primary in dark mode gets a lighter ring", () => {
		const v = customTokensToVariant("i", "d", "dark", {
			...tokens,
			background: "#18181b",
			sidebar: "#27272a",
			primary: "#1e3a8a",
		});
		const ring = v.tokens["--ring"] ?? "";
		expect(ring).not.toBe("#1e3a8a");
		expect(colorContrastRatio(ring, "#27272a") ?? 0).toBeGreaterThanOrEqual(3);
	});

	test("a passing primary is the ring; an explicit ring token wins", () => {
		const passing = customTokensToVariant("i", "l", "light", tokens);
		expect(passing.tokens["--ring"]).toBe(tokens.primary);
		const explicit = customTokensToVariant("i", "l", "light", {
			...tokens,
			primary: "#80cbc4",
			ring: "#80cbc4",
		});
		expect(explicit.tokens["--ring"]).toBe("#80cbc4");
		expect(explicit.tokens["--sidebar-ring"]).toBe("#80cbc4");
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

// ── Well-known third-party presets ─────────────────────────────────────────

// The third-party themes are authored in hex, so unlike the OKLCH brand tokens
// there is no conversion needed — the guard is simply "this preset's palette
// really is the theme's canonical palette". Every value below was verified
// against the theme's own source (see the comments in presets.ts). In
// particular, Codex is BLUE (#3A83F7), not the old #10A37F OpenAI green, and
// Claude's accent is the confirmed clay #D97757.
describe("well-known third-party presets", () => {
	const ACCENTS = {
		codex: { light: "#2c67c5", dark: "#3a83f7" },
		claude: { light: "#d97757", dark: "#d97757" },
		tokyo: { light: "#2e7de9", dark: "#7aa2f7" },
		catppuccin: { light: "#8839ef", dark: "#cba6f7" },
		dracula: { light: "#644ac9", dark: "#bd93f9" },
		github: { light: "#0969da", dark: "#4493f8" },
		linear: { light: "#5e6ad2", dark: "#5e6ad2" },
		nord: { light: "#5e81ac", dark: "#88c0d0" },
		one: { light: "#4078f2", dark: "#61afef" },
		raycast: { light: "#ff6363", dark: "#ff6363" },
	};

	for (const [family, expected] of Object.entries(ACCENTS)) {
		for (const [mode, id] of [
			["light", `${family}-light`],
			["dark", `${family}-dark`],
		] as const) {
			const accent = expected[mode];
			if (!accent) {
				continue;
			}
			test(`${family}-${mode} primary is ${accent}`, () => {
				const v = findVariantIn(id);
				expect(v).toBeDefined();
				expect(v?.tokens["--primary"]).toBe(accent);
				expect(v?.preview.primary).toBe(accent);
			});
		}
	}

	test("tokyo-light uses the real day palette bg (#e1e2e7), not the old #d5d6db", () => {
		const v = findVariantIn("tokyo-light");
		expect(v?.tokens["--background"]).toBe("#e1e2e7");
	});

	test("ayu-dark bg is #10141c (the old #1f2430 was Ayu Mirage)", () => {
		const v = findVariantIn("ayu-dark");
		expect(v?.tokens["--background"]).toBe("#10141c");
	});

	test("codex-dark bg is the near-black #0d0d0d", () => {
		const v = findVariantIn("codex-dark");
		expect(v?.tokens["--background"]).toBe("#0d0d0d");
	});
});

// The non-accent channels (bg / fg / muted / mutedFg) were audited against the
// bundled @shikijs/themes JSON and the canonical theme sources; lock in the
// values that had to be corrected so they can't silently regress.
describe("well-known third-party preset channels", () => {
	const CHANNELS: [string, Partial<Record<string, string>>][] = [
		// tokio-night fg is folke's Normal fg, not the bundle's fg_dark #a9b1d6.
		[
			"tokyo-dark",
			{ "--foreground": "#c0caf5", "--muted-foreground": "#565f89" },
		],
		// gruvbox muted text is the palette "gray" #928374 in both modes.
		["gruvbox-light", { "--muted-foreground": "#928374" }],
		["gruvbox-dark", { "--muted-foreground": "#928374" }],
		// monokai muted is the line-highlight #3E3D32; comment is mono3 #75715E.
		["monokai", { "--muted": "#3e3d32", "--muted-foreground": "#75715e" }],
		// min-dark foreground is the theme's #888888.
		["min-dark", { "--foreground": "#888888" }],
		// material muted-foreground is each flavour's comment colour.
		["material-theme", { "--muted-foreground": "#546e7a" }],
		["material-theme-darker", { "--muted-foreground": "#545454" }],
		["material-theme-ocean", { "--muted-foreground": "#464b5d" }],
		["material-theme-palenight", { "--muted-foreground": "#676e95" }],
		// catppuccin muted text is the official subtext0/overlay0.
		["catppuccin-dark", { "--muted-foreground": "#6c7086" }],
		["catppuccin-light", { "--muted-foreground": "#6c7086" }],
	];

	for (const [id, tokens] of CHANNELS) {
		for (const [token, value] of Object.entries(tokens)) {
			test(`${id} ${token} is ${value}`, () => {
				expect(findVariantIn(id)?.tokens[token]).toBe(value);
			});
		}
	}
});
