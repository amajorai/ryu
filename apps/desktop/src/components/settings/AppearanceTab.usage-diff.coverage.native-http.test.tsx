// The REAL Appearance tab against a loopback Core: the Usage meter and the Diff
// viewer.
// The fixture, the consumers and the lifecycle live in appearance-coverage.*.

import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	choose,
	comboIn,
	consumer,
	hasRow,
	isDisabled,
	isOn,
	mountConsumers,
	mountTab,
	openPage,
	present,
	registerAppearanceCoverageLifecycle,
	settle,
	shown,
	storedJson,
	switchIn,
	toggle,
	unmountTab,
} from "./appearance-coverage.dom.tsx";
import {
	CORE_TOKEN,
	exchanges,
	USAGE_AGENT,
	undeclared,
} from "./appearance-coverage.harness.tsx";
import {
	consumerDiff,
	diffPreview,
	pickerMeter,
	previewPre,
	rendered,
	sidebarRing,
	themeCss,
	tokenColor,
} from "./appearance-coverage.helpers.tsx";

registerAppearanceCoverageLifecycle();

test("the two Usage meter switches gate the usage ring and flip every number between used and left, persist, and are read back by a fresh store load", async () => {
	await mountConsumers(["usage"]);
	await mountTab();
	await openPage("Usage meter");
	await settle(() => pickerMeter() !== null, "picker meter from Core");
	const usageCalls = exchanges.filter(
		(e) => e.path === `/api/agents/${USAGE_AGENT}/usage`
	);
	expect(usageCalls.length).toBeGreaterThan(0);
	expect(
		usageCalls.every((e) => e.authorization === `Bearer ${CORE_TOKEN}`)
	).toBe(true);

	// Defaults: the rings show, and a percentage reads as used.
	// The switches of the per bot and composer meters are gone with them.
	for (const title of [
		"Show usage meter",
		"Show in sidebar",
		"Show progress bar",
		"Circular progress ring",
		"Show percentage",
	]) {
		expect(hasRow(title)).toBe(false);
	}
	expect(isOn(switchIn("Show usage in the sidebar"))).toBe(true);
	expect(isOn(switchIn("Show remaining instead of used"))).toBe(false);
	expect(pickerMeter()!.getAttribute("aria-label")).toBe("Session: 40% used");
	expect(present(pickerMeter()!.querySelector("svg circle"))).toBe(true);
	expect(sidebarRing()!.getAttribute("aria-label")).toBe(
		"Usage of Claude Code: 5h: 40% used and 7d: 75% used"
	);

	await toggle(switchIn("Show remaining instead of used"));
	expect(pickerMeter()!.getAttribute("aria-label")).toBe("Session: 60% left");
	expect(sidebarRing()!.getAttribute("aria-label")).toBe(
		"Usage of Claude Code: 5h: 60% left and 7d: 25% left"
	);

	// The rings go; the picker's provider meter is not theirs to hide.
	await toggle(switchIn("Show usage in the sidebar"));
	expect(consumer("usage-sidebar").textContent).toBe("");
	expect(present(sidebarRing())).toBe(false);
	expect(present(pickerMeter())).toBe(true);
	// Used or left stays a choice with the rings off: the picker reads it too.
	expect(isDisabled(switchIn("Show remaining instead of used"))).toBe(false);

	const expected = { mode: "remaining", sidebar: false };
	expect(storedJson("ryu:usage-bar-prefs")).toEqual(expected);

	// An independent load of the store module reads the same choices back.
	const fresh = await import(
		`@/src/hooks/useUsageBarPrefs.ts?reload=${Date.now()}`
	);
	let freshPrefs: unknown = null;
	function FreshReader() {
		freshPrefs = fresh.useUsageBarPrefs();
		return null;
	}
	const probe = document.createElement("div");
	const probeRoot = createRoot(probe);
	await act(async () => probeRoot.render(<FreshReader />));
	await act(async () => probeRoot.unmount());
	expect(freshPrefs).toEqual(expected);

	await unmountTab();
	await mountTab();
	await openPage("Usage meter");
	expect(isOn(switchIn("Show usage in the sidebar"))).toBe(false);
	expect(isOn(switchIn("Show remaining instead of used"))).toBe(true);
	// Turning the rings back on restores the remembered reading.
	await toggle(switchIn("Show usage in the sidebar"));
	await settle(() => sidebarRing() !== null, "usage ring returns");
	expect(sidebarRing()!.getAttribute("aria-label")).toBe(
		"Usage of Claude Code: 5h: 60% left and 7d: 25% left"
	);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
	expect(undeclared).toEqual([]);
});

test("Diff viewer selects and switches redraw the live preview and the workspace diff, persist, and survive a remount", async () => {
	await mountConsumers(["diff"]);
	await mountTab();
	await openPage("Diff viewer");
	await settle(
		() => rendered(previewPre) && rendered(consumerDiff),
		"both diffs rendered"
	);

	expect(previewPre().getAttribute("data-indicators")).toBe("bars");
	expect(previewPre().hasAttribute("data-background")).toBe(true);
	expect(previewPre().getAttribute("data-overflow")).toBe("scroll");
	expect(previewPre().hasAttribute("data-disable-line-numbers")).toBe(false);
	expect(
		diffPreview().querySelectorAll("[data-line-number-content]").length
	).toBeGreaterThan(0);
	expect(
		diffPreview().querySelectorAll("[data-diff-span]").length
	).toBeGreaterThan(0);
	const pierreLight = tokenColor(diffPreview(), "export", "light");
	expect(pierreLight).not.toBe("");
	const pierreDark = tokenColor(diffPreview(), "export", "dark");
	expect(pierreDark).not.toBe("");

	// Theme mode pins which of the two syntax themes the viewer resolves: Auto
	// leaves the colour scheme to the app; Dark and Light force it on the host.
	expect(themeCss()).not.toContain("color-scheme:");
	await choose(comboIn("Theme mode"), "Dark");
	await settle(
		() => themeCss().includes("color-scheme: dark"),
		"diff forced dark"
	);
	await choose(comboIn("Theme mode"), "Light");
	await settle(
		() => themeCss().includes("color-scheme: light"),
		"diff forced light"
	);

	// Dark theme swaps the dark-mode token colours (Dracula's keyword pink).
	await choose(comboIn("Dark theme"), "Dracula");
	await settle(
		() => tokenColor(diffPreview(), "export", "dark") !== pierreDark,
		"dark syntax theme changed"
	);
	expect(tokenColor(diffPreview(), "export", "dark").toUpperCase()).toBe(
		"#FF79C6"
	);

	await choose(comboIn("Change markers"), "Classic (+/−)");
	await settle(
		() => previewPre().getAttribute("data-indicators") === "classic",
		"classic markers"
	);
	await choose(comboIn("Change markers"), "None");
	// "None" drops the gutter-marker mode from the rendered diff entirely.
	await settle(
		() => !previewPre().hasAttribute("data-indicators"),
		"no markers"
	);

	await choose(comboIn("Inline highlighting"), "Off");
	await settle(
		() => diffPreview().querySelectorAll("[data-diff-span]").length === 0,
		"inline highlighting off"
	);

	await toggle(switchIn("Line backgrounds"));
	await settle(
		() => !previewPre().hasAttribute("data-background"),
		"backgrounds off"
	);

	// The gutter is hidden by the viewer's stylesheet through this marker.
	await toggle(switchIn("Line numbers"));
	await settle(
		() => previewPre().hasAttribute("data-disable-line-numbers"),
		"line numbers hidden"
	);

	await toggle(switchIn("Wrap long lines"));
	await settle(
		() => previewPre().getAttribute("data-overflow") === "wrap",
		"wrapping"
	);

	await choose(comboIn("Light theme"), "Solarized Light");
	await settle(
		() => tokenColor(diffPreview(), "export", "light") !== pierreLight,
		"light syntax theme changed"
	);

	// Hunk separators and unchanged context need collapsed lines, which the
	// workspace diff of a 40-line file has between its two hunks.
	await toggle(switchIn("Line numbers"));
	await settle(
		() => !previewPre().hasAttribute("data-disable-line-numbers"),
		"line numbers shown again"
	);
	await choose(comboIn("Hunk separators"), "Line info");
	await settle(
		() => /unmodified lines/i.test(consumerDiff().textContent ?? ""),
		"line-info separator"
	);
	expect(present(consumerDiff().querySelector('[data-line="20"]'))).toBe(false);
	await toggle(switchIn("Expand unchanged context"));
	await settle(
		() => consumerDiff().querySelector('[data-line="20"]') !== null,
		"unchanged context expanded"
	);
	expect(/unmodified lines/i.test(consumerDiff().textContent ?? "")).toBe(
		false
	);

	expect(storedJson("ryu:diff-view-prefs")).toMatchObject({
		darkTheme: "dracula",
		themeMode: "light",
		diffIndicators: "none",
		expandUnchanged: true,
		hunkSeparators: "line-info",
		lightTheme: "solarized-light",
		lineDiffType: "none",
		showBackground: false,
		showLineNumbers: true,
		wrapLines: true,
	});

	await unmountTab();
	await mountTab();
	await openPage("Diff viewer");
	expect(shown(comboIn("Change markers"))).toBe("None");
	expect(shown(comboIn("Inline highlighting"))).toBe("Off");
	expect(shown(comboIn("Hunk separators"))).toBe("Line info");
	expect(shown(comboIn("Light theme"))).toBe("Solarized Light");
	expect(shown(comboIn("Dark theme"))).toBe("Dracula");
	expect(shown(comboIn("Theme mode"))).toBe("Light");
	expect(isOn(switchIn("Line backgrounds"))).toBe(false);
	expect(isOn(switchIn("Line numbers"))).toBe(true);
	expect(isOn(switchIn("Wrap long lines"))).toBe(true);
	expect(isOn(switchIn("Expand unchanged context"))).toBe(true);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
}, 30_000);
