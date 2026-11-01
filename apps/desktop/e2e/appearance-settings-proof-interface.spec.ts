import { expect, test } from "@playwright/test";
import {
	appearanceSubpage,
	openPage,
	STORY_URL,
	selectOption,
} from "./appearance-settings-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("every enabled Interface switch changes and persists its choice", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Interface");
	const interfacePanel = appearanceSubpage(page, "Interface");
	const getInterfaceSwitch = (label: string) =>
		interfacePanel
			.getByText(label, { exact: true })
			.locator("xpath=../../..")
			.getByRole("switch");

	const switchPreferences = [
		{
			id: "friendly-names-toggle",
			label: "Friendly names",
			key: "ryu.catalog.friendly",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "bot-terminology-toggle",
			label: "Use Bot terminology",
			key: "ryu:bot-terminology",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "pointer-cursor-toggle",
			label: "Pointer cursor",
			key: "ryu_pointer_cursor",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "chrome-shadows-toggle",
			label: "Navigation & sidebar shadows",
			key: "ryu_chrome_shadows",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "dialog-overlay-blur-toggle",
			label: "Dim dialog backgrounds",
			key: "ryu_dialog_overlay_blur",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "popup-overlay-blur-toggle",
			label: "Blur popup backgrounds",
			key: "ryu_popup_overlay_blur",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "inverted-backgrounds-toggle",
			label: "Invert overlay backgrounds",
			key: "ryu_inverted_backgrounds",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "transparent-sidebar-toggle",
			label: "Transparent sidebar",
			key: "ryu:sidebar-transparency",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "transparent-window-toggle",
			label: "Transparent window",
			key: "ryu:window-transparency",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "sidebar-tabbed-toggle",
			label: "Tabbed sidebar",
			key: "ryu:sidebar-mode",
			storedValue: (enabled: boolean) => (enabled ? "tabbed" : "sections"),
		},
		{
			id: "sidebar-agent-mode-toggle",
			label: "Agents view",
			key: "ryu:sidebar-mode",
			storedValue: (enabled: boolean) => (enabled ? "agent" : "sections"),
		},
		{
			id: "group-chats-by-date-toggle",
			label: "Group lists by date",
			key: "ryu:sidebar-group-chats-by-date",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "sidebar-grouped-nav-toggle",
			label: "Projects & Spaces as pickers",
			key: "ryu:sidebar-grouped-nav",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "sidebar-inset-toggle",
			label: "Inset sidebar",
			key: "ryu:sidebar-variant",
			storedValue: (enabled: boolean) => (enabled ? "inset" : "floating"),
		},
		{
			id: "sidebar-project-rail-toggle",
			label: "Project rail",
			key: "ryu:sidebar-project-rail",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "agent-row-messaging-toggle",
			label: "Messaging-style agent rows",
			key: "ryu:agent-row-style",
			storedValue: (enabled: boolean) => (enabled ? "messaging" : "compact"),
		},
		{
			id: "sidebar-chat-preview-toggle",
			label: "Show latest message / tool state in sidebar",
			key: "ryu:sidebar-chat-preview",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "markdown-composer-toggle",
			label: "Rich Markdown composer",
			key: "ryu:markdown-composer",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "node-selector-detail-toggle",
			label: "Detailed node picker",
			key: "ryu:node-selector-detail",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "sidebar-overflow-popover-toggle",
			label: "Search overflow in a popover",
			key: "ryu:sidebar-overflow-popover",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "tab-dropdown-toggle",
			label: "Show tabs as a dropdown",
			key: "ryu:tab-dropdown",
			storedValue: (enabled: boolean) => String(enabled),
		},
		{
			id: "tab-search-button-toggle",
			label: "Show tab search button",
			key: "ryu:tab-search-button",
			storedValue: (enabled: boolean) => String(enabled),
		},
	] as const;
	const interfaceSwitches = interfacePanel.getByRole("switch");
	await expect(interfaceSwitches).toHaveCount(switchPreferences.length);
	const tabbedSidebar = getInterfaceSwitch("Tabbed sidebar");
	const agentMode = getInterfaceSwitch("Agents view");
	const initialSidebarMode = (await tabbedSidebar.isChecked())
		? "tabbed"
		: (await agentMode.isChecked())
			? "agent"
			: "sections";
	const initialSwitchStates: boolean[] = [];
	for (const preference of switchPreferences) {
		const control = getInterfaceSwitch(preference.label);
		await expect(control).toBeVisible();
		const beforeChecked = await control.isChecked();
		initialSwitchStates.push(beforeChecked);
		if (await control.isDisabled()) {
			// Bot terminology follows Work mode; the tab-search control is disabled
			// while the searchable tab dropdown owns tab navigation.
			await expect(control).toBeDisabled();
			continue;
		}
		if (
			preference.id === "sidebar-tabbed-toggle" ||
			preference.id === "sidebar-agent-mode-toggle"
		) {
			continue;
		}
		await control.click();
		await expect(control).toBeChecked({ checked: !beforeChecked });
		await expect
			.poll(() =>
				page.evaluate(
					({ key, enabled }) => localStorage.getItem(key) === enabled,
					{
						key: preference.key,
						enabled: preference.storedValue(!beforeChecked),
					}
				)
			)
			.toBe(true);
		const transparencyAttribute =
			preference.id === "transparent-sidebar-toggle"
				? "data-ryu-sidebar-transparency"
				: preference.id === "transparent-window-toggle"
					? "data-ryu-window-transparency"
					: null;
		if (transparencyAttribute) {
			if (beforeChecked) {
				await expect(page.locator("html")).not.toHaveAttribute(
					transparencyAttribute
				);
			} else {
				await expect(page.locator("html")).toHaveAttribute(
					transparencyAttribute,
					"true"
				);
			}
		}
		if (
			[
				"sidebar-grouped-nav-toggle",
				"sidebar-inset-toggle",
				"agent-row-messaging-toggle",
				"sidebar-chat-preview-toggle",
				"sidebar-overflow-popover-toggle",
				"tab-dropdown-toggle",
				"tab-search-button-toggle",
			].includes(preference.id)
		) {
			await page.reload();
			await openPage(page, "Interface");
			await expect(control).toBeChecked({ checked: !beforeChecked });
			await expect
				.poll(() =>
					page.evaluate((key) => localStorage.getItem(key), preference.key)
				)
				.toBe(preference.storedValue(!beforeChecked));
		}
		await control.click();
		await expect(control).toBeChecked({ checked: beforeChecked });
		await expect
			.poll(() =>
				page.evaluate(
					({ key, enabled }) => localStorage.getItem(key) === enabled,
					{
						key: preference.key,
						enabled: preference.storedValue(beforeChecked),
					}
				)
			)
			.toBe(true);
		if (transparencyAttribute) {
			if (beforeChecked) {
				await expect(page.locator("html")).toHaveAttribute(
					transparencyAttribute,
					"true"
				);
			} else {
				await expect(page.locator("html")).not.toHaveAttribute(
					transparencyAttribute
				);
			}
		}
	}
	for (const control of [tabbedSidebar, agentMode]) {
		const beforeChecked = await control.isChecked();
		await control.click();
		await expect(control).toBeChecked({ checked: !beforeChecked });
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu:sidebar-mode")))
			.toBe(
				control === tabbedSidebar
					? beforeChecked
						? "sections"
						: "tabbed"
					: beforeChecked
						? "sections"
						: "agent"
			);
		await control.click();
		await expect(control).toBeChecked({ checked: beforeChecked });
		await expect
			.poll(() => page.evaluate(() => localStorage.getItem("ryu:sidebar-mode")))
			.toBe(
				control === tabbedSidebar
					? beforeChecked
						? "tabbed"
						: "sections"
					: beforeChecked
						? "agent"
						: "sections"
			);
	}
	if (initialSidebarMode === "agent" && !(await agentMode.isChecked())) {
		await agentMode.click();
	}
	if (initialSidebarMode === "tabbed" && !(await tabbedSidebar.isChecked())) {
		await tabbedSidebar.click();
	}
	if (initialSidebarMode === "sections") {
		if (await agentMode.isChecked()) {
			await agentMode.click();
		}
		if (await tabbedSidebar.isChecked()) {
			await tabbedSidebar.click();
		}
	}
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:sidebar-mode")))
		.toBe(initialSidebarMode);

	const dropdown = getInterfaceSwitch("Show tabs as a dropdown");
	const searchButton = getInterfaceSwitch("Show tab search button");
	await dropdown.click();
	await expect(searchButton).toBeEnabled();
	const searchBefore = await searchButton.isChecked();
	await searchButton.click();
	await expect(searchButton).toBeChecked({ checked: !searchBefore });
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:tab-search-button"))
		)
		.toBe(String(!searchBefore));
	await page.reload();
	await openPage(page, "Interface");
	await expect(searchButton).toBeChecked({ checked: !searchBefore });
	await expect(searchButton).toBeEnabled();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:tab-search-button"))
		)
		.toBe(String(!searchBefore));
	await searchButton.click();
	await dropdown.click();
	await expect(searchButton).toBeDisabled();

	const picker = page.getByRole("combobox");
	await expect(picker).toHaveCount(1);
	await selectOption(page, picker, "In tab bar actions tray");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:chat-picker-placement"))
		)
		.toBe("tab-bar");
	await page.reload();
	await openPage(page, "Interface");
	await expect(picker).toContainText("In tab bar actions tray");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:chat-picker-placement"))
		)
		.toBe("tab-bar");
	await selectOption(page, picker, "In composer");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:chat-picker-placement"))
		)
		.toBe("composer");

	const notificationLayout = page.getByRole("slider");
	await expect(notificationLayout).toHaveCount(1);
	await notificationLayout.focus();
	await page.keyboard.press("Home");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:notification-layout"))
		)
		.toBe("split");
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:notification-layout"))
		)
		.toBe("grouped");
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:notification-layout"))
		)
		.toBe("unified");
	await page.keyboard.press("ArrowLeft");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:notification-layout"))
		)
		.toBe("grouped");

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-appearance-interface-proof.png"),
	});

	await page.reload();
	await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();
	await openPage(page, "Interface");
	await expect(page.getByRole("slider")).toHaveAttribute("aria-valuenow", "1");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:notification-layout"))
		)
		.toBe("grouped");
	const reloadedSwitches = interfacePanel.getByRole("switch");
	await expect(reloadedSwitches).toHaveCount(switchPreferences.length);
	for (const [index, preference] of switchPreferences.entries()) {
		const control = getInterfaceSwitch(preference.label);
		const expectedChecked = initialSwitchStates[index] ?? false;
		await expect(control).toBeChecked({ checked: expectedChecked });
		if (preference.id === "bot-terminology-toggle") {
			await expect(control).toBeDisabled();
			continue;
		}
		if (
			preference.id === "sidebar-tabbed-toggle" ||
			preference.id === "sidebar-agent-mode-toggle"
		) {
			continue;
		}
		await expect
			.poll(() =>
				page.evaluate((key) => localStorage.getItem(key), preference.key)
			)
			.toBe(preference.storedValue(expectedChecked));
		const transparencyAttribute =
			preference.id === "transparent-sidebar-toggle"
				? "data-ryu-sidebar-transparency"
				: preference.id === "transparent-window-toggle"
					? "data-ryu-window-transparency"
					: null;
		if (transparencyAttribute) {
			if (expectedChecked) {
				await expect(page.locator("html")).toHaveAttribute(
					transparencyAttribute,
					"true"
				);
			} else {
				await expect(page.locator("html")).not.toHaveAttribute(
					transparencyAttribute
				);
			}
		}
	}
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:sidebar-mode")))
		.toBe("agent");
});

test("Bot terminology can be changed in Code mode and is forced in Ryu Work", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	await page.addInitScript(() => {
		localStorage.setItem("ryu:interface-level", "expert");
	});
	await page.goto(STORY_URL);
	await openPage(page, "Interface");
	const terminology = page.getByRole("switch").nth(1);
	await expect(terminology).toBeEnabled();
	const before = await terminology.isChecked();
	await terminology.click();
	await expect(terminology).toBeChecked({ checked: !before });
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:bot-terminology"))
		)
		.toBe(String(!before));
});
