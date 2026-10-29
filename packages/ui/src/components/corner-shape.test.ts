import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SQUIRCLE_UTILITY = /corner-(?:[a-z]{1,2}-)?(?:squircle|round)\b/;
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const THIS_FILE = "corner-shape.test.ts";
// Oversized files keep inert corner-* tokens until they are split under the
// file size limit; no stylesheet registers the corner-shape plugin any more.
const AWAITING_SPLIT = new Set([
	"color-picker.tsx",
	"dropdown-menu.tsx",
	"sidebar.tsx",
	"tabs.tsx",
]);

function readSource(path: string) {
	return readFileSync(new URL(path, import.meta.url), "utf8");
}

function componentSources() {
	const root = fileURLToPath(new URL("./", import.meta.url));
	return readdirSync(root, { recursive: true, encoding: "utf8" })
		.map((path) => path.replaceAll("\\", "/"))
		.filter(
			(path) =>
				SOURCE_FILE.test(path) &&
				!path.endsWith(THIS_FILE) &&
				!AWAITING_SPLIT.has(path)
		);
}

describe("shared corner radius contract", () => {
	test("shared Tailwind entrypoints do not reshape corners", () => {
		const partials = readdirSync(
			fileURLToPath(new URL("../styles/globals/", import.meta.url))
		).map((name) => `../styles/globals/${name}`);
		for (const entry of [
			"../styles/globals.css",
			"../styles/companion-theme.css",
			...partials,
		]) {
			const css = readSource(entry);
			expect(css, entry).not.toContain("@toolwind/corner-shape");
			expect(css, entry).not.toContain("corner-shape:");
			expect(css, entry).not.toMatch(/@utility corner-/);
		}
	});

	test("fields, buttons and surfaces keep their rounded radius", () => {
		for (const fileName of [
			"button-variants.ts",
			"input.tsx",
			"input-group.tsx",
			"textarea.tsx",
			"select.tsx",
			"native-select.tsx",
			"dialog.tsx",
			"alert-dialog.tsx",
			"card.tsx",
			"popover.tsx",
			"command.tsx",
			"editor/ui/button.tsx",
			"editor/ui/input.tsx",
		]) {
			expect(readSource(`./${fileName}`), fileName).toMatch(/rounded(?:-|\[)/);
		}
	});

	test("no shared component applies a squircle corner shape", () => {
		const sources = componentSources();
		expect(sources.length).toBeGreaterThan(50);
		for (const fileName of sources) {
			expect(readSource(`./${fileName}`), fileName).not.toMatch(
				SQUIRCLE_UTILITY
			);
		}
	});
});
