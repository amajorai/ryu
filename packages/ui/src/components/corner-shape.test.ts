import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function readComponent(fileName: string) {
	return readFileSync(new URL(`./${fileName}`, import.meta.url), "utf8");
}

function variantClasses(source: string, variant: string): string[] {
	const declaration = new RegExp(`(?:"${variant}"|${variant}): "([^"]*)"`);
	return declaration.exec(source)?.[1]?.split(/\s+/) ?? [];
}

describe("shared corner radius contract", () => {
	test("registers squircle utilities in both shared Tailwind entrypoints", () => {
		const globals = readFileSync(
			new URL("../styles/globals.css", import.meta.url),
			"utf8"
		);
		const companion = readFileSync(
			new URL("../styles/companion-theme.css", import.meta.url),
			"utf8"
		);

		expect(globals).toContain('@plugin "@toolwind/corner-shape";');
		expect(companion).toContain('@plugin "@toolwind/corner-shape";');
		expect(globals).toContain('[class~="rounded-full"].corner-squircle');
	});

	test("pairs rounded fallbacks with squircle shapes across shared primitives", () => {
		const components = [
			"button-variants.ts",
			"button-group.tsx",
			"input.tsx",
			"textarea.tsx",
			"checkbox.tsx",
			"card.tsx",
			"alert.tsx",
			"accordion.tsx",
			"attachment.tsx",
			"chart.tsx",
			"color-picker.tsx",
			"combobox.tsx",
			"frame.tsx",
			"dialog.tsx",
			"alert-dialog.tsx",
			"sheet.tsx",
			"drawer.tsx",
			"popover.tsx",
			"hover-card.tsx",
			"tooltip.tsx",
			"select.tsx",
			"native-select.tsx",
			"command.tsx",
			"dropdown-menu.tsx",
			"context-menu.tsx",
			"menubar.tsx",
			"navigation-menu.tsx",
			"resizable.tsx",
			"sidebar.tsx",
			"skeleton.tsx",
			"table.tsx",
			"tabs-subtle.tsx",
			"tabs.tsx",
			"toggle.tsx",
			"toggle-group.tsx",
			"input-group.tsx",
			"item.tsx",
			"empty.tsx",
			"editor/ui/button.tsx",
			"editor/ui/input.tsx",
			"editor/ui/textarea.tsx",
			"editor/ui/checkbox.tsx",
			"editor/ui/input-group.tsx",
			"editor/ui/dialog.tsx",
			"editor/ui/alert-dialog.tsx",
			"editor/ui/popover.tsx",
			"editor/ui/hover-card.tsx",
			"editor/ui/tooltip.tsx",
			"editor/ui/select.tsx",
			"editor/ui/dropdown-menu.tsx",
			"editor/ui/context-menu.tsx",
			"editor/ui/command.tsx",
			"editor/ui/toolbar.tsx",
		] as const;

		for (const fileName of components) {
			const source = readComponent(fileName);
			expect(source, fileName).toMatch(/rounded(?:-|\[)/);
			expect(source, fileName).toMatch(/corner-(?:[trblse]{1,2}-)?squircle/);
		}
	});

	test("keeps equal-sized icon buttons round", () => {
		const buttons = readComponent("button-variants.ts");

		for (const [variant, size] of Object.entries({
			icon: "size-9",
			"icon-xs": "size-6",
			"icon-sm": "size-8",
			"icon-lg": "size-10",
		})) {
			const classes = variantClasses(buttons, variant);
			expect(classes).toContain(size);
			expect(classes).toContain("corner-round");
		}

		const editorButtons = readComponent("editor/ui/button.tsx");
		expect(variantClasses(editorButtons, "icon")).toContain("size-9");
		expect(variantClasses(editorButtons, "icon")).toContain("corner-round");

		expect(readComponent("calendar.tsx")).toMatch(
			/"(?=[^"]*corner-round)(?=[^"]*size-\(--cell-size\))[^"]*"/
		);
		expect(readComponent("editor/ui/calendar.tsx")).toMatch(
			/"(?=[^"]*corner-round)(?=[^"]*size-\(--cell-size\))[^"]*"/
		);
	});

	test("shapes the desktop window and Island morph surface", () => {
		const desktopWindow = readFileSync(
			new URL(
				"../../../../apps/desktop/src/components/layout/PageWrapper.tsx",
				import.meta.url
			),
			"utf8"
		);
		const island = readFileSync(
			new URL(
				"../../../../apps/island/src/renderer/components/Island.tsx",
				import.meta.url
			),
			"utf8"
		);

		expect(desktopWindow).toContain("corner-squircle");
		expect(island).toMatch(/\$\{\w+\} corner-squircle/);
	});
});
