// Unit tests for the pure theme-preset helpers: variant lookup against
// built-ins + caller-supplied customs, mode filtering, and the lossless
// CustomTokens <-> ThemeVariant conversion that backs the theme editor. This
// module is required to stay pure (no document/window/localStorage).

import { describe, expect, test } from "bun:test";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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

// ── Brand colour ────────────────────────────────────────────────────────────
/**
 * Normalize a colour token to a `#rrggbb` string.
 *
 * Most tokens are authored in OKLCH, but the brand is specified in hex, so a
 * test that compares token strings would only ever prove the token equals
 * itself. Converting is what makes "this token IS #0099ff" checkable, and it
 * catches the failure that actually happened: a token holding a *different*
 * blue that nobody notices because both render as "blue".
 *
 * A token that is ALREADY a hex passes straight through. The brand tokens are
 * deliberately authored that way: `oklch()` is not gamut-clamped, so on a
 * Display-P3 screen the browser renders those coordinates outside sRGB and paints
 * a visibly different blue from the `#0099ff` the brand is defined as — and from
 * the literal `#0099ff` the app uses elsewhere. Storing the hex is what makes the
 * rendered colour match the specified one on wide-gamut displays.
 */
function oklchToHex(token: string): string {
	if (/^#[0-9a-f]{6}$/i.test(token)) {
		return token.toLowerCase();
	}
	const m = token.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
	if (!m) {
		throw new Error(`not a plain oklch() or #rrggbb token: ${token}`);
	}
	const [L, C, Hdeg] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const h = (Hdeg * Math.PI) / 180;
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);

	const l_ = L + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
	const m_ = L - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
	const s_ = L - 0.089_484_177_5 * a - 1.291_485_548 * b;
	const [lin_l, lin_m, lin_s] = [l_ ** 3, m_ ** 3, s_ ** 3];

	const rgb = [
		4.076_741_662_1 * lin_l - 3.307_711_591_3 * lin_m + 0.230_969_929_2 * lin_s,
		-1.268_438_004_6 * lin_l +
			2.609_757_401_1 * lin_m -
			0.341_319_396_5 * lin_s,
		-0.004_196_086_3 * lin_l - 0.703_418_614_7 * lin_m + 1.707_614_701 * lin_s,
	];

	return `#${rgb
		.map((c) => {
			const srgb =
				c <= 0.003_130_8 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
			const byte = Math.max(0, Math.min(255, Math.round(srgb * 255)));
			return byte.toString(16).padStart(2, "0");
		})
		.join("")}`;
}

/** A `--brand: <value>;` (or `}`-terminated) declaration in a CSS source. */
const BRAND_DECLARATION = /--brand:\s*([^;}]+)\s*[;}]/g;
const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

/** `#rgb` / `#rrggbb` / `oklch(L C H)` -> lowercase `#rrggbb`. */
function colourToHex(value: string): string {
	const v = value.trim();
	if (HEX6.test(v)) {
		return v.toLowerCase();
	}
	if (HEX3.test(v)) {
		const [r, g, b] = v.slice(1).toLowerCase();
		return `#${r}${r}${g}${g}${b}${b}`;
	}
	return oklchToHex(v);
}

const REPO_ROOT = join(
	fileURLToPath(new URL(".", import.meta.url)),
	"../../../.."
);
const NON_SOURCE_DIRS = new Set([
	".next",
	"build",
	"dist",
	"node_modules",
	"out",
	"target",
]);

function cssFilesUnder(dir: string): string[] {
	const found: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return found; // root absent in this checkout — nothing to check
	}

	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!NON_SOURCE_DIRS.has(entry.name)) {
				for (const nested of cssFilesUnder(full)) {
					found.push(nested);
				}
			}
		} else if (entry.name.endsWith(".css")) {
			found.push(full);
		}
	}
	return found;
}

/** Every hand-written CSS file under `packages/ui/src` and each app's `src`. */
function sourceCssFiles(): string[] {
	const roots = [join(REPO_ROOT, "packages/ui/src")];
	try {
		for (const app of readdirSync(join(REPO_ROOT, "apps"), {
			withFileTypes: true,
		})) {
			if (app.isDirectory()) {
				roots.push(join(REPO_ROOT, "apps", app.name, "src"));
			}
		}
	} catch {
		// no apps/ dir (mirrored checkout) — packages/ui alone still guards
	}

	const files: string[] = [];
	for (const root of roots) {
		for (const file of cssFilesUnder(root)) {
			files.push(file);
		}
	}
	return files;
}

describe("Ryu brand colour", () => {
	const BRAND = "#0099ff";

	test("oklchToHex round-trips the known brand token", () => {
		expect(oklchToHex("oklch(0.6690 0.1837 248.81)")).toBe(BRAND);
	});

	// Every token in the default Ryu presets that is supposed to BE the brand.
	// `--sidebar-primary` is here because it silently held Tailwind blue-600
	// (#155dfc light) and blue-500 (#2b7fff dark) instead: close enough to read
	// as "blue" at a glance, wrong enough that the app never actually showed the
	// brand colour in its most prominent chrome. Neutral tokens (--ring,
	// --border, the greys) are deliberately NOT brand and are not listed.
	const BRAND_TOKENS = ["--primary", "--sidebar-primary"] as const;

	for (const id of [DEFAULT_LIGHT_ID, DEFAULT_DARK_ID]) {
		for (const token of BRAND_TOKENS) {
			test(`${id} ${token} is exactly ${BRAND}`, () => {
				const variant = findVariantIn(id);
				expect(variant).toBeDefined();
				const value = variant?.tokens[token];
				expect(value).toBeDefined();
				// SAFETY: The preceding toBeDefined assertion excludes undefined from this captured string token.
				expect(oklchToHex(value as string)).toBe(BRAND);
			});
		}

		test(`${id} preview.primary is exactly ${BRAND}`, () => {
			const variant = findVariantIn(id);
			expect(variant?.preview.primary.toLowerCase()).toBe(BRAND);
		});
	}

	// Presets only reach surfaces that run the theme engine. Web, extension,
	// fumadocs and storyboard just `@import` globals.css, so they render its base
	// `:root` / `.dark` block (from globals/theme-tokens.css). Assert it directly.
	describe("globals.css base block", () => {
		const css = readFileSync(
			new URL("../styles/globals/theme-tokens.css", import.meta.url),
			"utf8"
		);

		/** Body of the first top-level `selector { … }` block (no nesting inside). */
		function blockBody(selector: string): string {
			const start = css.indexOf(`${selector} {`);
			if (start < 0) {
				throw new Error(`no \`${selector} {\` block in globals.css`);
			}
			const open = css.indexOf("{", start);
			const end = css.indexOf("}", open);
			return css.slice(open + 1, end);
		}

		function declaration(body: string, prop: string): string {
			const m = body.match(new RegExp(`^\\s*${prop}:\\s*([^;]+);`, "m"));
			if (!m) {
				throw new Error(`no \`${prop}\` declaration in block`);
			}
			return m[1]!.trim();
		}

		for (const [label, selector] of [
			["light", ":root"],
			["dark", ".dark"],
		] as const) {
			for (const token of BRAND_TOKENS) {
				test(`${label} base ${token} is exactly ${BRAND}`, () => {
					expect(oklchToHex(declaration(blockBody(selector), token))).toBe(
						BRAND
					);
				});
			}
		}
	});

	// `--brand` is the Plate editor's accent, and it was a SECOND blue: the
	// vendored Plate defaults (Tailwind blue-500 light / blue-400 dark) that
	// nobody rebased onto the Ryu brand. Only apps/desktop imports editor.css,
	// so the desktop's editor chrome — selection, focus ring, block selection,
	// caret overlay, comment avatars, table drop line, suggestion chrome —
	// painted a blue no other app could reproduce and no preset could reach.
	//
	// The fix removes the standalone declaration and maps `--color-brand`
	// straight at `--primary`, so these two guards are structural, not
	// chromatic: once it aliases the brand token, its resolved value is
	// whatever preset the user has active (third-party presets legitimately
	// carry their own `--primary`), and asserting a hex here would fight that.
	// The colour itself is already pinned by the preset and globals.css cases
	// above.
	describe("editor.css `--brand`", () => {
		const css = readFileSync(
			new URL("../components/editor/editor.css", import.meta.url),
			"utf8"
		);

		test("declares no standalone --brand of its own", () => {
			expect(css.match(BRAND_DECLARATION)).toBeNull();
		});

		test("maps --color-brand at the brand token", () => {
			expect(css).toContain("--color-brand: var(--primary);");
		});
	});

	// Belt and braces for the whole design system: any *other* CSS that
	// reintroduces a literal `--brand` has to spell the brand, in hex or in
	// oklch. Scoped to the two source roots that ship UI (this package and the
	// apps' own `src/`) rather than a repo-root walk, so an unrelated file
	// elsewhere in the tree cannot fail this suite.
	test("every --brand declaration in source CSS is the brand colour", () => {
		const offenders: string[] = [];

		for (const file of sourceCssFiles()) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(BRAND_DECLARATION)) {
				const value = match[1]?.trim() ?? "";
				let hex: string;
				try {
					hex = colourToHex(value);
				} catch {
					offenders.push(`${relative(REPO_ROOT, file)}: --brand: ${value}`);
					continue;
				}
				if (hex !== BRAND) {
					offenders.push(
						`${relative(REPO_ROOT, file)}: --brand: ${value} (= ${hex})`
					);
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
