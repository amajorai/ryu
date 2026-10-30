// The REAL Appearance tab against a loopback Core: the File tree page and Reset
// appearance.
// The fixture, the consumers and the lifecycle live in appearance-coverage.*.

import { expect, test } from "bun:test";
import { act } from "react";
import {
	backToIndex,
	buttonNamed,
	choose,
	comboIn,
	isOn,
	mountTab,
	openPage,
	registerAppearanceCoverageLifecycle,
	settle,
	shown,
	storedJson,
	switchIn,
	tabElement,
	toggle,
	treeItems,
	treePreviewHost,
	unmountTab,
	visibleText,
} from "./appearance-coverage.dom.tsx";
import {
	publishedThemePrefs,
	setChatPickerPlacement,
	undeclared,
} from "./appearance-coverage.harness.tsx";
import { notificationSlider } from "./appearance-coverage.helpers.tsx";

registerAppearanceCoverageLifecycle();

// ── File tree ──────────────────────────────────────────────────────────────
test("File tree Initial state, Search mode, Light theme and Dark theme reshape and recolour the live tree preview, persist, and survive a remount", async () => {
	await mountTab();
	await openPage("File tree");
	await settle(() => treeItems().length > 0, "tree preview rendered");
	expect(treeItems()).toEqual(["src/", "package.json", "README.md"]);

	await choose(comboIn("Initial state"), "Expanded");
	await settle(
		() => treeItems().includes("src/components/Button.tsx"),
		"folders expanded"
	);
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		initialExpansion: "open",
	});

	// Light theme: Match app theme keeps app colours; a named theme paints the
	// preview with that theme's own sidebar surface (Solarized Light's base2).
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-background")
	).toBe("");
	await choose(comboIn("Light theme"), "Solarized Light");
	await settle(
		() =>
			treePreviewHost().style.getPropertyValue(
				"--appearance-tree-background"
			) !== "",
		"tree theme applied"
	);
	expect(
		treePreviewHost()
			.style.getPropertyValue("--appearance-tree-background")
			.toLowerCase()
	).toBe("#eee8d5");

	// Search mode applies when the preview's search box filters.
	await toggle(switchIn("Search box"));
	await choose(comboIn("Search mode"), "Hide non-matches");
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		searchMode: "hide-non-matches",
		showSearch: true,
	});
	const search = () =>
		treePreviewHost().shadowRoot?.querySelector<HTMLInputElement>("input") ??
		null;
	await settle(() => search() !== null, "search box rendered");
	await act(async () => {
		const input = search()!;
		input.value = "Card";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await settle(
		() =>
			treeItems().includes("src/components/Card.tsx") &&
			!treeItems().includes("README.md"),
		"non-matches hidden"
	);

	// Dark theme applies while the app itself is dark: switch the app with the
	// Theme radio on the index, then pick a dark tree theme.
	await backToIndex();
	const darkMode = tabElement().querySelector<HTMLInputElement>(
		'input[name="theme"][value="dark"]'
	)!;
	await act(async () => darkMode.click());
	await settle(
		() => document.documentElement.classList.contains("dark"),
		"app dark"
	);
	expect(localStorage.getItem("theme")).toBe("dark");
	await openPage("File tree");
	await settle(
		() =>
			treePreviewHost()?.style.getPropertyValue("--appearance-tree-scheme") ===
			"dark",
		"tree follows the dark app"
	);
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-background")
	).toBe("");
	await choose(comboIn("Dark theme"), "Dracula");
	await settle(
		() =>
			treePreviewHost().style.getPropertyValue(
				"--appearance-tree-background"
			) !== "",
		"dark tree theme applied"
	);
	// Dracula's own sidebar surface and foreground.
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-background")
	).toBe("#21222C");
	expect(
		treePreviewHost().style.getPropertyValue("--appearance-tree-foreground")
	).toBe("#F8F8F2");
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		darkTheme: "dracula",
		lightTheme: "solarized-light",
	});

	await unmountTab();
	await mountTab();
	await openPage("File tree");
	expect(shown(comboIn("Initial state"))).toBe("Expanded");
	expect(shown(comboIn("Light theme"))).toBe("Solarized Light");
	expect(shown(comboIn("Dark theme"))).toBe("Dracula");
	expect(shown(comboIn("Search mode"))).toBe("Hide non-matches");
	await settle(
		() => treeItems().includes("src/components/Button.tsx"),
		"expanded after remount"
	);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});

// ── Reset appearance ───────────────────────────────────────────────────────
test("Reset appearance confirms first; Cancel keeps every change, Confirm restores every row's default, republishes to Core, and keeps saved presets and unrelated storage", async () => {
	const customTheme = JSON.stringify([
		{
			id: "custom-light-kept",
			label: "Kept preset",
			mode: "light",
			preview: { bg: "#ffffff", primary: "#ff0000", surface: "#eeeeee" },
			tokens: { "--primary": "#ff0000" },
		},
	]);
	localStorage.setItem("ryu_custom_themes", customTheme);
	localStorage.setItem("ryu_ui_font", "system-ui, -apple-system, sans-serif");
	localStorage.setItem("ryu:notification-layout", "split");
	setChatPickerPlacement("tab-bar");
	localStorage.setItem("ryu:seasonal-effects", "true");
	localStorage.setItem("ryu:seasonal-theme", "christmas");
	localStorage.setItem(
		"ryu:diff-view-prefs",
		JSON.stringify({ diffIndicators: "none", showLineNumbers: false })
	);
	localStorage.setItem(
		"ryu:file-tree-prefs",
		JSON.stringify({ initialExpansion: "open", searchMode: "hide-non-matches" })
	);
	const seeded = Object.fromEntries(
		Array.from({ length: localStorage.length }, (_, i) => {
			const key = localStorage.key(i)!;
			return [key, localStorage.getItem(key)];
		})
	);

	await mountTab();
	await openPage("Reset");
	expect(visibleText()).toContain("Saved custom theme presets are kept.");
	await act(async () => buttonNamed("Reset to defaults").click());
	expect(buttonNamed("Confirm reset").textContent).toBe("Confirm reset");
	await act(async () => buttonNamed("Cancel").click());
	expect(buttonNamed("Reset to defaults").textContent).toBe(
		"Reset to defaults"
	);
	for (const [key, value] of Object.entries(seeded)) {
		expect(localStorage.getItem(key)).toBe(value);
	}

	await act(async () => buttonNamed("Reset to defaults").click());
	await act(async () => buttonNamed("Confirm reset").click());
	expect(buttonNamed("Reset to defaults").textContent).toBe(
		"Reset to defaults"
	);

	expect(localStorage.getItem("ryu_ui_font")).toBe(
		'"Inter Variable", "Inter", sans-serif'
	);
	expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
		'"Inter Variable", "Inter", sans-serif'
	);
	expect(localStorage.getItem("ryu:notification-layout")).toBe("unified");
	expect(localStorage.getItem("ryu:chat-picker-placement")).toBe("composer");
	expect(localStorage.getItem("ryu:seasonal-effects")).toBe("false");
	expect(localStorage.getItem("ryu:seasonal-theme")).toBe("auto");
	expect(storedJson("ryu:diff-view-prefs")).toMatchObject({
		diffIndicators: "bars",
		showLineNumbers: true,
	});
	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		initialExpansion: "closed",
		searchMode: "expand-matches",
	});
	expect(storedJson("ryu:usage-bar-prefs")).toEqual({
		barStyle: "ring",
		mode: "used",
		showBar: true,
		showPercent: false,
		sidebar: true,
		visible: true,
	});
	expect(localStorage.getItem("theme")).toBe("system");
	// Kept: the saved preset and storage Appearance does not own.
	expect(localStorage.getItem("ryu_custom_themes")).toBe(customTheme);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");

	await settle(
		() =>
			publishedThemePrefs().some(
				(entry) =>
					entry.prefs.uiFont === '"Inter Variable", "Inter", sans-serif'
			),
		"reset published to Core"
	);

	// Every page reads the defaults back.
	await backToIndex();
	await openPage("Layout & text");
	expect(shown(comboIn("UI font"))).toBe("Inter");
	await backToIndex();
	await openPage("Interface");
	expect(shown(comboIn("Chat model & agent picker"))).toBe("In composer");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Unified");
	await backToIndex();
	await openPage("Motion & effects");
	expect(isOn(switchIn("Seasonal effects"))).toBe(false);
	expect(shown(comboIn("Season"))).toBe("Automatic");
	await backToIndex();
	await openPage("Diff viewer");
	expect(shown(comboIn("Change markers"))).toBe("Bars");
	expect(isOn(switchIn("Line numbers"))).toBe(true);
	await backToIndex();
	await openPage("File tree");
	expect(shown(comboIn("Initial state"))).toBe("Collapsed");
	expect(shown(comboIn("Search mode"))).toBe("Expand matches");
	expect(undeclared).toEqual([]);
}, 30_000);
