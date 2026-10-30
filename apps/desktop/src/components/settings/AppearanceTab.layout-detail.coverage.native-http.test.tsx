// The REAL Appearance tab against a loopback Core: Layout & sizing, diff layout
// with file-tree behaviour, and chat detail.
// The fixture, the consumers and the lifecycle live in appearance-coverage.*.

import { expect, test } from "bun:test";
import { act } from "react";
import {
	backToIndex,
	buttonNamed,
	choose,
	comboIn,
	hasRow,
	isDisabled,
	isOn,
	mountConsumers,
	mountTab,
	openPage,
	present,
	press,
	registerAppearanceCoverageLifecycle,
	settle,
	shown,
	storedJson,
	switchIn,
	toggle,
	treePreviewHost,
	unmountTab,
	visibleText,
} from "./appearance-coverage.dom.tsx";
import {
	initTheme,
	publishedThemePrefs,
	undeclared,
} from "./appearance-coverage.harness.tsx";
import {
	detailCaption,
	detailSlider,
	pressOn,
	previewPre,
	rendered,
	rootStyle,
	slider,
	stepSlider,
	themeNumbersSchema,
	transcript,
	treeItem,
	treeShadow,
	workspaceTreeItems,
} from "./appearance-coverage.helpers.tsx";

registerAppearanceCoverageLifecycle();

test("Layout & sizing sliders step by keyboard and resize the document, publish the theme values to Core, and the boot path and a remount restore them", async () => {
	const sidebarEvents: unknown[] = [];
	const onSidebarWidth = (event: Event) =>
		sidebarEvents.push((event as CustomEvent<unknown>).detail);
	window.addEventListener("ryu:sidebar-width", onSidebarWidth);
	try {
		await mountTab();
		await openPage("Layout & text");
		expect(slider("Muted contrast").getAttribute("aria-valuetext")).toBe("50");
		expect(slider("Roundness").getAttribute("aria-valuetext")).toBe("0.625rem");
		expect(slider("Scale (UI zoom)").getAttribute("aria-valuetext")).toBe(
			"100%"
		);

		await stepSlider("Muted contrast", "ArrowRight");
		expect(localStorage.getItem("ryu_contrast")).toBe("51");
		expect(rootStyle("--muted")).toContain("var(--muted-base), white");

		await stepSlider("Roundness", "ArrowRight");
		expect(slider("Roundness").getAttribute("aria-valuetext")).toBe("0.650rem");
		expect(Number.parseFloat(rootStyle("--radius"))).toBeCloseTo(0.65, 5);

		await stepSlider("Scale (UI zoom)", "ArrowRight");
		expect(slider("Scale (UI zoom)").getAttribute("aria-valuetext")).toBe(
			"105%"
		);
		expect(Number(rootStyle("--ryu-ui-scale"))).toBeCloseTo(1.05, 5);
		expect(Number(document.documentElement.style.zoom)).toBeCloseTo(1.05, 5);

		await stepSlider("Zoom (spacing)", "ArrowLeft");
		expect(Number.parseFloat(rootStyle("--spacing"))).toBeCloseTo(0.245, 5);

		await stepSlider("Card padding", "ArrowRight");
		expect(Number.parseFloat(rootStyle("--card-pad"))).toBeCloseTo(0.98, 5);
		expect(Number.parseFloat(rootStyle("--card-pad-sm"))).toBeCloseTo(0.735, 5);

		await stepSlider("Chat width", "End");
		expect(slider("Chat width").getAttribute("aria-valuetext")).toBe("960px");
		expect(rootStyle("--an-max-width")).toBe("960px");

		await stepSlider("Sidebar width", "Home");
		expect(slider("Sidebar width").getAttribute("aria-valuetext")).toBe(
			"220px"
		);
		expect(localStorage.getItem("ryu:sidebar-width")).toBe("220");
		expect(sidebarEvents.at(-1)).toBe(220);

		// The theme-owned values reach Core in one debounced document.
		await settle(
			() =>
				publishedThemePrefs().some(
					(entry) => themeNumbersSchema.parse(entry.prefs).contrast === 51
				),
			"layout published"
		);
		const published = themeNumbersSchema.parse(
			publishedThemePrefs().at(-1)!.prefs
		);
		expect(published.contrast).toBe(51);
		expect(published.radius).toBeCloseTo(0.65, 5);
		expect(published.scale).toBeCloseTo(1.05, 5);
		expect(published.spacing).toBeCloseTo(0.245, 5);
		expect(published.cardSpacing).toBeCloseTo(0.98, 5);

		// Boot restores the document from storage alone.
		await unmountTab();
		for (const property of [
			"--radius",
			"--spacing",
			"--ryu-ui-scale",
			"--card-pad",
			"--an-max-width",
		]) {
			document.documentElement.style.removeProperty(property);
		}
		document.documentElement.style.zoom = "";
		initTheme();
		expect(Number.parseFloat(rootStyle("--radius"))).toBeCloseTo(0.65, 5);
		expect(Number.parseFloat(rootStyle("--spacing"))).toBeCloseTo(0.245, 5);
		expect(Number(document.documentElement.style.zoom)).toBeCloseTo(1.05, 5);
		expect(Number.parseFloat(rootStyle("--card-pad"))).toBeCloseTo(0.98, 5);
		expect(rootStyle("--an-max-width")).toBe("960px");

		await mountTab();
		await openPage("Layout & text");
		expect(slider("Muted contrast").getAttribute("aria-valuetext")).toBe("51");
		expect(slider("Roundness").getAttribute("aria-valuetext")).toBe("0.650rem");
		expect(slider("Scale (UI zoom)").getAttribute("aria-valuetext")).toBe(
			"105%"
		);
		expect(slider("Zoom (spacing)").getAttribute("aria-valuetext")).toBe(
			"0.245rem"
		);
		expect(slider("Card padding").getAttribute("aria-valuetext")).toBe(
			"0.98rem"
		);
		expect(slider("Chat width").getAttribute("aria-valuetext")).toBe("960px");
		expect(slider("Sidebar width").getAttribute("aria-valuetext")).toBe(
			"220px"
		);
		expect(localStorage.getItem("appearance-coverage-unrelated")).toBe(
			"keep-me"
		);
		expect(undeclared).toEqual([]);
	} finally {
		window.removeEventListener("ryu:sidebar-width", onSidebarWidth);
		for (const property of [
			"--radius",
			"--spacing",
			"--ryu-ui-scale",
			"--card-pad",
			"--card-pad-sm",
			"--an-max-width",
			"--muted",
			"--muted-foreground",
		]) {
			document.documentElement.style.removeProperty(property);
		}
		document.documentElement.style.zoom = "";
	}
});

test("Diff Layout and the file tree Density, Icons, Colored icons, Sticky folders, Search box, Drag and drop, Inline rename and Flatten change the live previews and the workspace tree, and survive a remount", async () => {
	await mountConsumers(["workspace-tree"]);
	await mountTab();
	await openPage("Diff viewer");
	await settle(() => rendered(previewPre), "diff preview");
	expect(previewPre().getAttribute("data-diff-type")).toBe("split");
	expect(previewPre().querySelectorAll("code")).toHaveLength(2);
	await choose(comboIn("Layout"), "Stacked (inline)");
	await settle(
		() => previewPre().getAttribute("data-diff-type") === "single",
		"stacked diff"
	);
	expect(previewPre().querySelectorAll("code")).toHaveLength(1);

	await backToIndex();
	await openPage("File tree");
	await settle(() => treeItem("package.json") !== null, "tree preview");

	// Density sets the row height.
	expect(treeItem("package.json")!.style.minHeight).toBe("30px");
	await choose(comboIn("Density"), "Compact");
	await settle(
		() => treeItem("package.json")?.style.minHeight === "24px",
		"compact rows"
	);
	expect(treePreviewHost().style.getPropertyValue("--trees-item-height")).toBe(
		"24px"
	);

	// Icons: the complete set has a JSON glyph; Minimal falls back to the
	// generic file glyph.
	const jsonIcon = () =>
		treeItem("package.json")?.querySelector("use")?.getAttribute("href");
	expect(jsonIcon()).toBe("#file-tree-builtin-json");
	const wrapper = () =>
		treeShadow().querySelector("[data-file-tree-virtualized-wrapper]");
	expect(wrapper()?.getAttribute("data-file-tree-colored-icons")).toBe("true");
	await toggle(switchIn("Colored icons"));
	await settle(
		() => !wrapper()?.hasAttribute("data-file-tree-colored-icons"),
		"monochrome icons"
	);
	await choose(comboIn("Icons"), "Minimal");
	await settle(() => jsonIcon() === "#file-tree-icon-file", "minimal icons");

	// Sticky folders pins an expanded parent above its children.
	await choose(comboIn("Initial state"), "Expanded");
	await settle(
		() =>
			treeShadow().querySelector("[data-file-tree-sticky-overlay]") !== null,
		"sticky overlay"
	);
	await toggle(switchIn("Sticky folders"));
	await settle(
		() =>
			treeShadow().querySelector("[data-file-tree-sticky-overlay]") === null,
		"no sticky overlay"
	);

	// Search box shows and hides the filter.
	expect(present(treeShadow().querySelector("input"))).toBe(false);
	await toggle(switchIn("Search box"));
	await settle(() => treeShadow().querySelector("input") !== null, "search");
	await toggle(switchIn("Search box"));
	await settle(() => treeShadow().querySelector("input") === null, "no search");

	// Drag and drop makes rows draggable.
	expect(treeItem("package.json")!.getAttribute("draggable")).toBeNull();
	await toggle(switchIn("Drag and drop"));
	await settle(
		() => treeItem("package.json")?.getAttribute("draggable") === "true",
		"draggable rows"
	);

	// Inline rename: F2 opens the rename field only while it is on.
	await pressOn(treeItem("package.json")!, "F2");
	expect(present(treeShadow().querySelector("[data-item-rename-input]"))).toBe(
		false
	);
	await toggle(switchIn("Inline rename"));
	await settle(() => treeItem("package.json") !== null, "tree remounted");
	await pressOn(treeItem("package.json")!, "F2");
	await settle(
		() =>
			treeShadow()
				.querySelector("[data-item-rename-input]")
				?.getAttribute("aria-label") === "Rename package.json",
		"rename field"
	);

	// Flatten collapses a single-child folder chain in the workspace tree.
	await settle(
		() => workspaceTreeItems().includes("packages/"),
		"workspace tree"
	);
	await toggle(switchIn("Flatten empty directories"));
	await settle(
		() => workspaceTreeItems().includes("packages/app/src/"),
		"flattened chain"
	);

	expect(storedJson("ryu:file-tree-prefs")).toMatchObject({
		coloredIcons: false,
		density: "compact",
		dragAndDrop: true,
		flattenEmptyDirectories: true,
		iconSet: "minimal",
		renaming: true,
		showSearch: false,
		stickyFolders: false,
	});
	expect(storedJson("ryu:diff-view-prefs")).toMatchObject({
		diffStyle: "unified",
	});

	await unmountTab();
	await mountTab();
	await openPage("File tree");
	expect(shown(comboIn("Density"))).toBe("Compact");
	expect(shown(comboIn("Icons"))).toBe("Minimal");
	for (const [title, on] of [
		["Colored icons", false],
		["Sticky folders", false],
		["Search box", false],
		["Flatten empty directories", true],
		["Drag and drop", true],
		["Inline rename", true],
	] as const) {
		expect(isOn(switchIn(title))).toBe(on);
	}
	await settle(
		() => treeItem("package.json")?.getAttribute("draggable") === "true",
		"remounted preview keeps drag and drop"
	);
	await backToIndex();
	await openPage("Diff viewer");
	expect(shown(comboIn("Layout"))).toBe("Stacked (inline)");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
}, 30_000);

test("Detail level and Advanced detail drive what the transcript shows, None disables only the tool-row switches, and message and motion preferences reach the chat", async () => {
	await mountConsumers(["transcript"]);
	await mountTab();
	await openPage("Chat view");
	// Shipped defaults read as the Compact preset.
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Compact");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: false,
		expandCommands: false,
		expandFileEdits: false,
		groupToolUses: true,
		hideToolDetail: false,
	});

	await act(async () => detailSlider().focus());
	await press("End");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Detailed");
	expect(detailCaption()).toBe("Detailed");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: true,
		expandCommands: true,
		expandFileEdits: true,
		groupToolUses: false,
		hideToolDetail: false,
	});
	await press("ArrowLeft");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Minimal");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: false,
		expandCommands: false,
		expandFileEdits: true,
		groupToolUses: true,
	});

	// None hides tool detail but keeps the expansion choices for later.
	await press("Home");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("None");
	expect(transcript()).toMatchObject({
		expandFileEdits: true,
		hideToolDetail: true,
	});
	await act(async () => buttonNamed("Advanced detail").click());
	await settle(() => hasRow("Group tool uses"), "advanced open");
	expect(visibleText()).toContain(
		"Detail level is None, so the chat shows no tool calls to expand."
	);
	expect(isDisabled(switchIn("Group tool uses"))).toBe(true);
	expect(isDisabled(switchIn("Show file edits expanded"))).toBe(true);
	expect(isDisabled(switchIn("Auto-expand commands"))).toBe(true);
	expect(isDisabled(switchIn("Expand code blocks"))).toBe(false);
	await toggle(switchIn("Expand code blocks"));
	expect(transcript().expandCodeBlocks).toBe(true);

	// Stepping back up restores a preset; a manual divergence reads Custom.
	await act(async () => detailSlider().focus());
	await press("ArrowRight");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Compact");
	expect(transcript()).toMatchObject({
		expandCodeBlocks: false,
		expandFileEdits: false,
		hideToolDetail: false,
	});
	await toggle(switchIn("Auto-expand commands"));
	expect(transcript().expandCommands).toBe(true);
	// The caption and the announced value must agree: both say Custom.
	expect(detailCaption()).toBe("Custom");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Custom");
	await toggle(switchIn("Group tool uses"));
	expect(transcript().groupToolUses).toBe(false);
	await toggle(switchIn("Show file edits expanded"));
	expect(transcript().expandFileEdits).toBe(true);

	// Message preferences.
	for (const [title, key] of [
		["Pin user message while scrolling", "pinUserMessage"],
		["Open chats at the latest message", "openAtBottom"],
		["Session stats", "inferenceStats"],
	] as const) {
		expect(transcript()[key]).toBe(true);
		await toggle(switchIn(title));
		expect(transcript()[key]).toBe(false);
	}

	// Motion: streaming text follows its own switch and the master switch.
	await backToIndex();
	await openPage("Motion & effects");
	expect(transcript().streamAnimation).toBe(true);
	await toggle(switchIn("Animate streaming chat text"));
	expect(transcript().streamAnimation).toBe(false);
	await toggle(switchIn("Animate streaming chat text"));
	expect(transcript().streamAnimation).toBe(true);
	await toggle(switchIn("Enable animations"));
	expect(transcript()).toMatchObject({
		animationsEnabled: false,
		streamAnimation: false,
	});
	expect(document.documentElement.getAttribute("data-ryu-animations")).toBe(
		"off"
	);
	await toggle(switchIn("Enable animations"));
	expect(document.documentElement.hasAttribute("data-ryu-animations")).toBe(
		false
	);
	expect(transcript().streamAnimation).toBe(true);

	// Rich Markdown composer.
	await backToIndex();
	await openPage("Interface");
	expect(transcript().markdownComposer).toBe(false);
	await toggle(switchIn("Rich Markdown composer"));
	expect(transcript().markdownComposer).toBe(true);

	// A remount reopens Advanced on its own, because the combination is Custom.
	await unmountTab();
	await mountTab();
	await openPage("Chat view");
	expect(detailCaption()).toBe("Custom");
	expect(detailSlider().getAttribute("aria-valuetext")).toBe("Custom");
	expect(hasRow("Group tool uses")).toBe(true);
	expect(isOn(switchIn("Group tool uses"))).toBe(false);
	expect(isOn(switchIn("Show file edits expanded"))).toBe(true);
	expect(isOn(switchIn("Auto-expand commands"))).toBe(true);
	expect(isOn(switchIn("Pin user message while scrolling"))).toBe(false);
	expect(isOn(switchIn("Open chats at the latest message"))).toBe(false);
	expect(isOn(switchIn("Session stats"))).toBe(false);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});
