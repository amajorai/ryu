import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSharedGlobals } from "../styles/read-shared-globals.ts";

const SQUIRCLE_UTILITY = /corner-(?:[a-z]{1,2}-)?(?:squircle|round)\b/;
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const THIS_FILE = "corner-shape.test.ts";
// Oversized files (and the `<name>-*` parts they were split into) keep inert
// corner-* tokens until they are cleaned up; no stylesheet registers the
// corner-shape plugin any more.
const AWAITING_SPLIT = new Set([
	"color-picker.tsx",
	"color-picker-popover.tsx",
	"color-picker-sliders-swatches.tsx",
	"color-picker-trigger-area.tsx",
	"tabs.tsx",
	"tabs-layout-menu.tsx",
	"tabs-more-menu.tsx",
	"tabs-overflow-navigation.tsx",
	"tabs-variants.ts",
]);

function readSource(path: string) {
	return readFileSync(new URL(path, import.meta.url), "utf8");
}

/** A component's source, including the `<name>-*.tsx` files it was split into. */
function readComponent(fileName: string) {
	const path = fileURLToPath(new URL(`./${fileName}`, import.meta.url));
	const directory = dirname(path);
	const stem = basename(path).replace(SOURCE_FILE, "");
	const parts = readdirSync(directory)
		.filter(
			(name) =>
				name.startsWith(`${stem}-`) &&
				SOURCE_FILE.test(name) &&
				!name.includes(".test.")
		)
		.sort()
		.map((name) => join(directory, name));
	return [path, ...parts].map((file) => readFileSync(file, "utf8")).join("\n");
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
			expect(readComponent(fileName), fileName).toMatch(/rounded(?:-|\[)/);
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

	test("keeps floating layers solid with the one popover shadow", () => {
		// Ryu Quiet (spec 6.2, addendum A4): menus, popovers and tooltips are
		// solid bg-popover with a hairline border and --shadow-popover, with no
		// glass blur.
		const floatingLayers = [
			"popover.tsx",
			"hover-card.tsx",
			"tooltip.tsx",
			"select.tsx",
			"combobox.tsx",
			"dropdown-menu-content.tsx",
			"dropdown-menu-sub.tsx",
			"context-menu.tsx",
			"menubar.tsx",
			"navigation-menu.tsx",
			"chart.tsx",
			"editor/ui/popover.tsx",
			"editor/ui/hover-card.tsx",
			"editor/ui/select.tsx",
			"editor/ui/dropdown-menu.tsx",
			"editor/ui/context-menu.tsx",
		] as const;

		for (const fileName of floatingLayers) {
			const source = readComponent(fileName);
			expect(source, fileName).toContain("shadow-(--shadow-popover)");
			expect(source, fileName).not.toMatch(/bg-popover\/\d/);
			expect(source, fileName).not.toContain("backdrop-saturate-150");
		}

		for (const css of [
			readSharedGlobals(),
			readSource("../styles/companion-theme.css"),
			// Fumadocs live previews use their own token sheet.
			readSource("../../../../apps/fumadocs/src/app/ui-preview.css"),
		]) {
			expect(css).toContain("--shadow-popover:");
		}
	});

	test("keeps the desktop window and Island on the round radius role", () => {
		const desktopWindow = readSource(
			"../../../../apps/desktop/src/components/layout/PageWrapper.tsx"
		);
		const island = readSource(
			"../../../../apps/island/src/renderer/components/Island.tsx"
		);

		// The window root follows the roundness-derived radius base, and the
		// Island shapes use the round contour so their ring and fill share one
		// silhouette.
		expect(desktopWindow).not.toContain("corner-squircle");
		expect(desktopWindow).toContain("layoutStyles.authored1");
		expect(island).not.toContain("corner-squircle");
		expect(island).toContain('contour="round"');
	});
});
