// The colour-theme picker says when the active interface is painting its own
// colours for that mode, so a pick that does not show at once is explained.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { setThemeOverride } = await import("@/src/lib/themes/theme-override.ts");
const { InterfaceThemeOverrideNote } = await import(
	"./appearance-preset-fields.tsx"
);

const roots: Root[] = [];

function render(mode: "light" | "dark"): HTMLDivElement {
	const host = document.createElement("div");
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(<InterfaceThemeOverrideNote mode={mode} />));
	return host;
}

beforeEach(() => {
	localStorage.clear();
	setThemeOverride(null);
});

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	setThemeOverride(null);
});

test("names the interface for the mode its colour theme covers", () => {
	setThemeOverride({
		label: "Pixel Town",
		light: "catppuccin-light",
		plugin: "@acme/pixel-town",
		source: "@acme/pixel-town:town",
	});
	expect(render("light").textContent).toBe(
		"Pixel Town is using its own colors. Your theme returns when you leave it."
	);
	expect(render("dark").textContent).toBe("");
});

test("shows nothing without an override", () => {
	expect(render("light").textContent).toBe("");
});
