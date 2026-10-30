// The REAL Appearance tab against a loopback Core: Customize, typography,
// notification layout, seasonal effects and the chat picker.
// The fixture, the consumers and the lifecycle live in appearance-coverage.*.

import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	backToIndex,
	buttonNamed,
	choose,
	comboIn,
	consumer,
	flush,
	hasRow,
	indexRows,
	isDisabled,
	isOn,
	mountConsumers,
	mountTab,
	mountTabBare,
	openPage,
	PAGE_TITLES,
	present,
	press,
	registerAppearanceCoverageLifecycle,
	settle,
	shown,
	switchIn,
	tabElement,
	toggle,
	unmountTab,
	visibleText,
} from "./appearance-coverage.dom.tsx";
import {
	CORE_TOKEN,
	initTheme,
	publishedThemePrefs,
	requestSettingReveal,
	SETTINGS_ENTRIES,
	undeclared,
	useProductModeStore,
} from "./appearance-coverage.harness.tsx";
import {
	notificationSlider,
	previewButton,
} from "./appearance-coverage.helpers.tsx";

registerAppearanceCoverageLifecycle();

// ── Customize (SettingsSubpages) ───────────────────────────────────────────
test("Customize hides the Interfaces page when no workspace interface can be opened", async () => {
	useProductModeStore.setState({ osAccess: false });
	await mountTab();
	expect(indexRows()).toEqual(
		PAGE_TITLES.filter((title) => title !== "Interfaces")
	);
});

test("Customize lists every Appearance page, pushes the chosen page with Back, and a settings-search reveal opens the page that holds its row", async () => {
	await mountTab();
	expect(indexRows()).toEqual(PAGE_TITLES);
	// The theme intro stays on the index, above the page list.
	expect(visibleText()).toContain("Color theme");

	await openPage("Diff viewer");
	expect(visibleText()).toContain("Layout, themes and change markers.");
	expect(hasRow("Line numbers")).toBe(true);
	expect(indexRows()).toEqual([]);
	expect(visibleText()).not.toContain("Color theme");
	await backToIndex();
	expect(indexRows()).toEqual(PAGE_TITLES);

	// Each row is a native button, so it is a Tab stop that the platform
	// activates with Enter and Space.
	const usageRow = buttonNamed("Usage meter");
	expect(usageRow.getAttribute("type")).toBe("button");
	await act(async () => usageRow.focus());
	expect(document.activeElement === usageRow).toBe(true);

	// A search hit for a row on a closed page opens that page while the pane
	// is already mounted (the subscription path).
	const percentEntry = SETTINGS_ENTRIES.find(
		(entry) => entry.id === "appearance.usage-meter.show-percentage"
	)!;
	await act(async () => requestSettingReveal(percentEntry));
	await settle(() => hasRow("Show percentage"), "reveal opened Usage meter");
	expect(tabElement().querySelector("h3")?.textContent).toBe("Usage meter");
	await unmountTab();

	// …and when the request was made a beat BEFORE the pane mounted (the
	// section switch), the first render already lands on the right page.
	const lineNumbers = SETTINGS_ENTRIES.find(
		(entry) => entry.id === "appearance.diff-viewer.line-numbers"
	)!;
	requestSettingReveal(lineNumbers);
	await mountTabBare();
	await settle(() => hasRow("Line numbers"), "reveal before mount");
	expect(tabElement().querySelector("h3")?.textContent).toBe("Diff viewer");

	// A stale index entry naming a page that no longer exists leaves the user
	// where they are instead of on a blank page.
	await backToIndex();
	await act(async () =>
		requestSettingReveal({
			...lineNumbers,
			id: "appearance.removed-row",
			subpage: "removed-page",
		})
	);
	await flush(60);
	expect(indexRows()).toEqual(PAGE_TITLES);
	expect(undeclared).toEqual([]);
});

// ── Typography ─────────────────────────────────────────────────────────────
test("UI font, Heading font and Code font persist the picked family, apply it to the document, publish it to Core, and are restored by boot and by a remount", async () => {
	await mountTab();
	await openPage("Layout & text");
	expect(shown(comboIn("UI font"))).toBe("Inter");
	expect(shown(comboIn("Heading font"))).toBe("Geist");
	expect(shown(comboIn("Code font"))).toBe("System Mono");

	await choose(comboIn("UI font"), "Geist");
	expect(shown(comboIn("UI font"))).toBe("Geist");
	expect(localStorage.getItem("ryu_ui_font")).toBe(
		'"Geist Variable", "Geist", sans-serif'
	);
	expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
		'"Geist Variable", "Geist", sans-serif'
	);
	// Picking one font leaves the other two unwritten.
	expect(localStorage.getItem("ryu_heading_font")).toBeNull();
	expect(localStorage.getItem("ryu_code_font")).toBeNull();

	await choose(comboIn("Heading font"), "System UI");
	expect(
		document.documentElement.style.getPropertyValue("--font-heading")
	).toBe("system-ui, -apple-system, sans-serif");

	// Keyboard: ArrowDown opens on the saved choice, arrows move, Enter commits
	// and returns focus to the trigger.
	const code = comboIn("Code font");
	await act(async () => code.focus());
	await press("ArrowDown");
	expect(code.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement?.textContent?.trim()).toBe("System Mono");
	await press("ArrowDown");
	expect(document.activeElement?.textContent?.trim()).toBe("JetBrains Mono");
	await press("Enter");
	expect(code.getAttribute("aria-expanded")).toBe("false");
	expect(document.activeElement === code).toBe(true);
	expect(shown(code)).toBe("JetBrains Mono");
	expect(document.documentElement.style.getPropertyValue("--font-code")).toBe(
		'"JetBrains Mono", ui-monospace, monospace'
	);

	// Core acknowledges one debounced theme document carrying all three fonts.
	await settle(
		() =>
			publishedThemePrefs().some(
				(entry) =>
					entry.prefs.codeFont === '"JetBrains Mono", ui-monospace, monospace'
			),
		"theme prefs published"
	);
	const latest = publishedThemePrefs().at(-1)!;
	expect(latest.authorization).toBe(`Bearer ${CORE_TOKEN}`);
	expect(latest.prefs.uiFont).toBe('"Geist Variable", "Geist", sans-serif');
	expect(latest.prefs.headingFont).toBe("system-ui, -apple-system, sans-serif");
	expect(latest.prefs.codeFont).toBe(
		'"JetBrains Mono", ui-monospace, monospace'
	);

	// Boot: the document loses its inline fonts; the app's real boot path
	// re-applies them from storage alone.
	await unmountTab();
	for (const property of ["--font-sans", "--font-heading", "--font-code"]) {
		document.documentElement.style.removeProperty(property);
	}
	initTheme();
	expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe(
		'"Geist Variable", "Geist", sans-serif'
	);
	expect(
		document.documentElement.style.getPropertyValue("--font-heading")
	).toBe("system-ui, -apple-system, sans-serif");
	expect(document.documentElement.style.getPropertyValue("--font-code")).toBe(
		'"JetBrains Mono", ui-monospace, monospace'
	);
	await mountTab();
	await openPage("Layout & text");
	expect(shown(comboIn("UI font"))).toBe("Geist");
	expect(shown(comboIn("Heading font"))).toBe("System UI");
	expect(shown(comboIn("Code font"))).toBe("JetBrains Mono");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
	expect(undeclared).toEqual([]);
});

test("Notification layout steps by keyboard through Unified, Grouped and Split; the caption, stored layout and the sidebar's subscribed consumer follow, and a remount restores the step", async () => {
	await mountConsumers(["notification"]);
	await mountTab();
	await openPage("Interface");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Unified");
	expect(notificationSlider().getAttribute("aria-valuenow")).toBe("2");
	expect(visibleText()).toContain(
		"Blend everything into one compact notification stack."
	);
	expect(consumer("notification-layout").textContent).toBe("unified");

	await act(async () => notificationSlider().focus());
	await press("ArrowLeft");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Grouped");
	expect(visibleText()).toContain(
		"Share one tray while keeping Inbox and announcements grouped."
	);
	expect(localStorage.getItem("ryu:notification-layout")).toBe("grouped");
	expect(consumer("notification-layout").textContent).toBe("grouped");

	await press("Home");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Split");
	expect(visibleText()).toContain(
		"Keep the announcement stack and Inbox tray separate."
	);
	expect(localStorage.getItem("ryu:notification-layout")).toBe("split");
	expect(consumer("notification-layout").textContent).toBe("split");
	// Below the first step there is nowhere to go; nothing changes.
	await press("ArrowLeft");
	expect(localStorage.getItem("ryu:notification-layout")).toBe("split");

	await unmountTab();
	await mountTab();
	await openPage("Interface");
	expect(notificationSlider().getAttribute("aria-valuetext")).toBe("Split");
	await act(async () => notificationSlider().focus());
	await press("End");
	expect(localStorage.getItem("ryu:notification-layout")).toBe("unified");
	expect(consumer("notification-layout").textContent).toBe("unified");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});

test("Seasonal effects drives the titlebar particle layer, obeys Enable animations, pins or previews a Season, and closing Settings releases a running preview", async () => {
	await mountConsumers(["season"]);
	await mountTab();
	await openPage("Motion & effects");
	const seasonal = () => switchIn("Seasonal effects");
	const season = () => comboIn("Season");
	// Off by default: nothing drifts down the titlebar until it is opted into.
	expect(isOn(seasonal())).toBe(false);
	expect(consumer("season").dataset.season).toBe("none");
	expect(isDisabled(season())).toBe(true);

	await toggle(seasonal());
	expect(isOn(seasonal())).toBe(true);
	expect(localStorage.getItem("ryu:seasonal-effects")).toBe("true");
	expect(shown(season())).toBe("Automatic");
	// Automatic follows the calendar: October is Halloween.
	expect(consumer("season").dataset.season).toBe("halloween");
	expect(consumer("season").textContent).toContain("🎃");

	await toggle(seasonal());
	expect(isOn(seasonal())).toBe(false);
	expect(localStorage.getItem("ryu:seasonal-effects")).toBe("false");
	expect(consumer("season").dataset.season).toBe("none");
	expect(isDisabled(season())).toBe(true);
	// Preview still works with the switch off, and shows today's season.
	expect(isDisabled(previewButton())).toBe(false);
	await act(async () => previewButton().click());
	await settle(() => consumer("season").dataset.season === "halloween");
	expect(previewButton().textContent).toBe("Previewing…");
	expect(isDisabled(previewButton())).toBe(true);
	// Closing Settings mid-preview hands the titlebar back to the real setting.
	await unmountTab();
	await settle(() => consumer("season").dataset.season === "none");

	await mountTab();
	await openPage("Motion & effects");
	expect(isOn(seasonal())).toBe(false);
	await toggle(seasonal());
	expect(localStorage.getItem("ryu:seasonal-effects")).toBe("true");
	await choose(season(), "❄️ Christmas");
	expect(shown(season())).toBe("❄️ Christmas");
	expect(localStorage.getItem("ryu:seasonal-theme")).toBe("christmas");
	expect(consumer("season").dataset.season).toBe("christmas");

	// The master motion switch turns the whole feature off, controls included.
	await toggle(switchIn("Enable animations"));
	expect(localStorage.getItem("ryu:animations-enabled")).toBe("false");
	expect(consumer("season").dataset.season).toBe("none");
	expect(isDisabled(seasonal())).toBe(true);
	expect(isDisabled(season())).toBe(true);
	expect(isDisabled(previewButton())).toBe(true);
	expect(isDisabled(switchIn("Animate streaming chat text"))).toBe(true);
	await toggle(switchIn("Enable animations"));
	expect(consumer("season").dataset.season).toBe("christmas");
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});

// ── Chat model & agent picker ──────────────────────────────────────────────
test("Chat model & agent picker moves the picker into the tab bar, names the choice after a remount, and a fresh store load reads it back", async () => {
	await mountConsumers(["chat-picker"]);
	await mountTab();
	await openPage("Interface");
	const picker = () => comboIn("Chat model & agent picker");
	expect(shown(picker())).toBe("In composer");
	expect(
		present(
			consumer("chat-picker").querySelector(
				'[data-testid="chat-model-agent-picker-composer"]'
			)
		)
	).toBe(true);

	await choose(picker(), "In tab bar actions tray");
	expect(shown(picker())).toBe("In tab bar actions tray");
	expect(localStorage.getItem("ryu:chat-picker-placement")).toBe("tab-bar");
	expect(
		present(
			consumer("chat-picker").querySelector(
				'[data-testid="chat-model-agent-picker-tab-bar"]'
			)
		)
	).toBe(true);

	// Reopening Settings must name the stored choice, not print its raw id.
	await unmountTab();
	await mountTab();
	await openPage("Interface");
	expect(shown(picker())).toBe("In tab bar actions tray");

	// An independent load of the store module reads the persisted placement.
	const fresh = await import(
		`@/src/hooks/useChatPickerPlacement.ts?reload=${Date.now()}`
	);
	const freshValues: string[] = [];
	function FreshReader() {
		const [placement] = fresh.useChatPickerPlacement();
		freshValues.push(placement);
		return null;
	}
	const probe = document.createElement("div");
	const probeRoot = createRoot(probe);
	await act(async () => probeRoot.render(<FreshReader />));
	await act(async () => probeRoot.unmount());
	expect(freshValues.at(-1)).toBe("tab-bar");

	await choose(picker(), "In composer");
	expect(localStorage.getItem("ryu:chat-picker-placement")).toBe("composer");
	expect(
		present(
			consumer("chat-picker").querySelector(
				'[data-testid="chat-model-agent-picker-composer"]'
			)
		)
	).toBe(true);
	expect(localStorage.getItem("appearance-coverage-unrelated")).toBe("keep-me");
});
