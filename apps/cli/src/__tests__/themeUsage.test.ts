import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { THEME_CATALOG } from "../ui/theme.ts";
import { contrastRatio, MIN_TEXT_CONTRAST } from "./color-contrast.ts";

// `muted` is a surface (background) token; `mutedForeground` is the text token
// meant to sit on it. Painting text with `muted` yields roughly 1.2:1 contrast
// against `background`, so it is effectively invisible. This guard keeps text
// colours on the readable side of the ladder, in our own sources and in the
// host-owned termcn components (toast, banner, status message) we adapt.
const CLI_DIR = join(import.meta.dir, "../..");
const MUTED_AS_COLOR = /\b(?:colors|themeColors)\.muted\b(?!Foreground)/;
const BACKGROUND_CONTEXT = /\bbg=|backgroundColor/;
const HOST_OWNED_COMPONENT = /resolve\(ROOT_DIR, "(components\/ui\/[^"]+)"\)/g;
// Token definitions, not usages.
const EXCLUDED = new Set([
	"src/ui/theme.ts",
	"components/ui/theme-provider.tsx",
]);

// Untouched vendored termcn files keep upstream styling; only the host-owned
// wrappers listed in scripts/vendor-termcn.ts are ours to keep legible.
function hostOwnedComponents(): string[] {
	const script = readFileSync(
		join(CLI_DIR, "scripts/vendor-termcn.ts"),
		"utf8"
	);
	return [...script.matchAll(HOST_OWNED_COMPONENT)].map(
		(match) => match[1] ?? ""
	);
}

function sourceFiles(): string[] {
	const glob = new Bun.Glob("**/*.{ts,tsx}");
	const files = [...glob.scanSync({ cwd: join(CLI_DIR, "src") })]
		.map((path) => `src/${path.split("\\").join("/")}`)
		.filter((path) => !path.startsWith("src/__tests__/"));
	files.push(...hostOwnedComponents());
	return files
		.filter((path) => !EXCLUDED.has(path))
		.map((path) => join(CLI_DIR, path));
}

describe("theme token usage", () => {
	test("text never uses the muted background token as a colour", () => {
		const files = sourceFiles();
		expect(files).toContain(join(CLI_DIR, "components/ui/toast.tsx"));
		const violations: string[] = [];
		for (const file of files) {
			const lines = readFileSync(file, "utf8").split("\n");
			for (const [index, line] of lines.entries()) {
				if (MUTED_AS_COLOR.test(line) && !BACKGROUND_CONTEXT.test(line)) {
					violations.push(`${relative(CLI_DIR, file)}:${index + 1}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test("mutedForeground stays readable against background in every palette", () => {
		const failures: string[] = [];
		for (const [presetId, preset] of Object.entries(THEME_CATALOG)) {
			for (const [scheme, theme] of [
				["dark", preset.dark],
				["light", preset.light],
			] as const) {
				const ratio = contrastRatio(
					theme.colors.mutedForeground,
					theme.colors.background
				);
				if (ratio < MIN_TEXT_CONTRAST) {
					failures.push(`${presetId}/${scheme}: ${ratio.toFixed(2)}:1`);
				}
			}
		}
		expect(failures).toEqual([]);
	});
});
