import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PaletteModeSwitch } from "./palette-mode-switch.tsx";

function hintClasses(): string[] {
	const markup = renderToStaticMarkup(
		<PaletteModeSwitch
			active="search"
			composeTabId="compose"
			onChange={() => undefined}
			searchTabId="search"
		/>
	);
	const hint = /<[^>]*data-slot="command-palette-mode-hint"[^>]*>/.exec(
		markup
	)?.[0];
	return /class="([^"]*)"/.exec(hint ?? "")?.[1]?.split(/\s+/) ?? [];
}

describe("PaletteModeSwitch", () => {
	test("pushes the Tab hint to the inline end so it follows dir=rtl", () => {
		const classes = hintClasses();
		expect(classes).toContain("ms-auto");
		expect(classes).not.toContain("ml-auto");
	});
});
