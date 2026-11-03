// Pins Ryu's brand blue (#0099ff) everywhere it is declared: the built-in
// theme presets, the base `:root` / `.dark` blocks of the shared globals.css,
// and every `--brand` declaration in the repository's source stylesheets.

import { describe, expect, test } from "bun:test";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readSharedGlobals } from "../styles/read-shared-globals.ts";
import { DEFAULT_DARK_ID, DEFAULT_LIGHT_ID, findVariantIn } from "./presets.ts";

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

	// Surfaces without the theme engine (web, extension, fumadocs) render the
	// base `:root` / `.dark` block of globals.css. Assert it directly.
	describe("globals.css base block", () => {
		const css = readSharedGlobals();

		/**
		 * The value of `prop` in the first flat `… { … }` rule whose selector
		 * list names `selector` exactly. The base theme block shares its rule
		 * with scoped twins (`:root, .ryu-color-scheme-light {`), so match a
		 * member of the list, not the literal `selector {` text that other
		 * `:root` blocks also start with.
		 */
		function baseDeclaration(selector: string, prop: string): string {
			const declaresProp = new RegExp(`^\\s*${prop}:\\s*([^;]+);`, "m");
			for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				const selectors = (rule[1] ?? "")
					.replace(/\/\*[\s\S]*?\*\//g, "")
					.split(",")
					.map((part) => part.trim());
				const value = selectors.includes(selector)
					? (rule[2] ?? "").match(declaresProp)?.[1]
					: undefined;
				if (value) {
					return value.trim();
				}
			}
			throw new Error(`no \`${selector}\` block declares \`${prop}\``);
		}

		for (const [label, selector] of [
			["light", ":root"],
			["dark", ".dark"],
		] as const) {
			for (const token of BRAND_TOKENS) {
				test(`${label} base ${token} is exactly ${BRAND}`, () => {
					expect(oklchToHex(baseDeclaration(selector, token))).toBe(BRAND);
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
