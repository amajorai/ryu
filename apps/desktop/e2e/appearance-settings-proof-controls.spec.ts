import { expect, test } from "@playwright/test";
import {
	appearanceSubpage,
	goBackToAppearance,
	openPage,
	readStoredAppearanceDocument,
	STORY_URL,
	selectOption,
	type UsageBarPrefsProof,
} from "./appearance-settings-proof.helpers.ts";

test.describe.configure({ timeout: 120_000 });

test("keeps dependent motion and usage-meter controls in sync", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Motion & effects");

	const motionSwitches = page.getByRole("switch");
	await expect(motionSwitches).toHaveCount(3);
	const animationMaster = motionSwitches.nth(0);
	const streamAnimation = motionSwitches.nth(1);
	const seasonalEffects = motionSwitches.nth(2);
	// Seasonal effects default off since 0db714a247 (Ryu Quiet #914: "Seasonal
	// effects default off (stored opt-ins kept)"); the switch opts in.
	await expect(seasonalEffects).not.toBeChecked();
	await animationMaster.click();
	await expect(animationMaster).not.toBeChecked();
	await expect(streamAnimation).toBeDisabled();
	await expect(seasonalEffects).toBeDisabled();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:animations-enabled"))
	).resolves.toBe("false");
	await animationMaster.click();
	await expect(streamAnimation).toBeEnabled();
	await streamAnimation.click();
	await expect(streamAnimation).not.toBeChecked();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:stream-animation"))
	).resolves.toBe("false");
	await seasonalEffects.click();
	await expect(seasonalEffects).toBeChecked();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:seasonal-effects"))
	).resolves.toBe("true");
	await seasonalEffects.click();
	await expect(seasonalEffects).not.toBeChecked();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:seasonal-effects"))
	).resolves.toBe("false");
	await seasonalEffects.click();
	await expect(seasonalEffects).toBeChecked();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:seasonal-effects"))
	).resolves.toBe("true");
	const seasonSelect = page.getByRole("combobox").first();
	await seasonSelect.click();
	const seasonListboxId = await seasonSelect.getAttribute("aria-controls");
	const seasonListbox = seasonListboxId
		? page.locator(`[id="${seasonListboxId}"]`)
		: page.getByRole("listbox").last();
	await seasonListbox.getByRole("option", { name: /Christmas/ }).click();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:seasonal-theme"))
	).resolves.toBe("christmas");
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Previewing…", exact: true })
	).toBeVisible();

	await goBackToAppearance(page);
	await openPage(page, "Usage meter");
	const usageSwitches = page.getByRole("switch");
	await expect(usageSwitches).toHaveCount(6);
	// The six controls expose the complete initial preference, including enum
	// encodings; every write must preserve the other five values.
	let expectedUsage: UsageBarPrefsProof = {
		visible: await usageSwitches.nth(0).isChecked(),
		sidebar: await usageSwitches.nth(1).isChecked(),
		showBar: await usageSwitches.nth(2).isChecked(),
		barStyle: (await usageSwitches.nth(3).isChecked()) ? "ring" : "bar",
		showPercent: await usageSwitches.nth(4).isChecked(),
		mode: (await usageSwitches.nth(5).isChecked()) ? "remaining" : "used",
	};
	const toggleUsage = async (
		index: number,
		patch: Partial<UsageBarPrefsProof>
	) => {
		const control = usageSwitches.nth(index);
		const checked = await control.isChecked();
		await control.click();
		await expect(control).toBeChecked({ checked: !checked });
		expectedUsage = { ...expectedUsage, ...patch };
		await expect
			.poll(() =>
				page.evaluate(() =>
					JSON.parse(localStorage.getItem("ryu:usage-bar-prefs") ?? "null")
				)
			)
			.toEqual(expectedUsage);
	};
	await toggleUsage(0, { visible: false });
	for (const index of [2, 3, 4, 5]) {
		await expect(usageSwitches.nth(index)).toBeDisabled();
	}
	// Sidebar visibility remains independent when composer meters are hidden.
	await expect(usageSwitches.nth(1)).toBeEnabled();
	await toggleUsage(1, { sidebar: !expectedUsage.sidebar });
	await toggleUsage(0, { visible: true });
	await expect(usageSwitches.nth(2)).toBeEnabled();
	await toggleUsage(2, { showBar: false });
	await expect(usageSwitches.nth(3)).toBeDisabled();
	await toggleUsage(2, { showBar: true });
	await expect(usageSwitches.nth(3)).toBeEnabled();
	await toggleUsage(3, {
		barStyle: expectedUsage.barStyle === "ring" ? "bar" : "ring",
	});
	await toggleUsage(4, { showPercent: !expectedUsage.showPercent });
	await toggleUsage(5, {
		mode: expectedUsage.mode === "used" ? "remaining" : "used",
	});
	await page.reload();
	await openPage(page, "Usage meter");
	const reloadedUsage = page.getByRole("switch");
	const expectedChecks = [
		expectedUsage.visible,
		expectedUsage.sidebar,
		expectedUsage.showBar,
		expectedUsage.barStyle === "ring",
		expectedUsage.showPercent,
		expectedUsage.mode === "remaining",
	];
	for (const [index, checked] of expectedChecks.entries()) {
		await expect(reloadedUsage.nth(index)).toBeChecked({ checked });
	}
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("ryu:usage-bar-prefs") ?? "null")
			)
		)
		.toEqual(expectedUsage);

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-appearance-usage-proof.png"),
	});
});

test("persists diff and file-tree changes and restores defaults", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Diff viewer");
	const diffLayout = page.getByRole("combobox").first();
	await diffLayout.click();
	const listboxId = await diffLayout.getAttribute("aria-controls");
	const listbox = listboxId
		? page.locator(`[id="${listboxId}"]`)
		: page.getByRole("listbox").last();
	await listbox
		.getByRole("option", { exact: true, name: "Stacked (inline)" })
		.click();
	await expect
		.poll(() =>
			page.evaluate(() => {
				const value = localStorage.getItem("ryu:diff-view-prefs");
				return value ? JSON.parse(value).diffStyle : null;
			})
		)
		.toBe("unified");
	const diffOptions = [
		[1, "Light", "themeMode", "light"],
		[2, "GitHub Light", "lightTheme", "github-light"],
		[3, "GitHub Dark", "darkTheme", "github-dark"],
		[4, "Classic (+/−)", "diffIndicators", "classic"],
		[5, "Character", "lineDiffType", "char"],
		[6, "Metadata", "hunkSeparators", "metadata"],
	] as const;
	for (const [index, label, property, expected] of diffOptions) {
		await selectOption(page, page.getByRole("combobox").nth(index), label);
		await expect
			.poll(() =>
				page.evaluate((key) => {
					const value = localStorage.getItem("ryu:diff-view-prefs");
					return value ? JSON.parse(value)[key] : null;
				}, property)
			)
			.toBe(expected);
	}
	const diffSwitchProperties = [
		"showBackground",
		"showLineNumbers",
		"wrapLines",
		"expandUnchanged",
	] as const;
	const diffSwitches = page.getByRole("switch");
	await expect(diffSwitches).toHaveCount(diffSwitchProperties.length);
	for (let index = 0; index < diffSwitchProperties.length; index += 1) {
		const control = diffSwitches.nth(index);
		const next = !(await control.isChecked());
		await control.click();
		await expect(control).toBeChecked({ checked: next });
		await expect
			.poll(() =>
				page.evaluate((key) => {
					const value = localStorage.getItem("ryu:diff-view-prefs");
					return value ? JSON.parse(value)[key] : null;
				}, diffSwitchProperties[index])
			)
			.toBe(next);
	}

	await goBackToAppearance(page);
	await openPage(page, "File tree");
	const fileTreeOptions = [
		[0, "Compact", "density", "compact"],
		[1, "GitHub Light", "lightTheme", "github-light"],
		[2, "GitHub Dark", "darkTheme", "github-dark"],
		[3, "Standard", "iconSet", "standard"],
		[4, "Collapse non-matches", "searchMode", "collapse-non-matches"],
		[5, "Expanded", "initialExpansion", "open"],
	] as const;
	for (const [index, label, property, expected] of fileTreeOptions) {
		await selectOption(page, page.getByRole("combobox").nth(index), label);
		await expect
			.poll(() =>
				readStoredAppearanceDocument(page, "ryu:file-tree-prefs").then(
					(value) => (value ? value[property] : null)
				)
			)
			.toBe(expected);
	}
	const fileTreeSwitchProperties = [
		["Colored icons", "coloredIcons"],
		["Sticky folders", "stickyFolders"],
		["Search box", "showSearch"],
		["Flatten empty directories", "flattenEmptyDirectories"],
		["Drag and drop", "dragAndDrop"],
		["Inline rename", "renaming"],
	] as const;
	const fileTreePanel = appearanceSubpage(page, "File tree");
	for (const [label, property] of fileTreeSwitchProperties) {
		const control = fileTreePanel
			.getByText(label, { exact: true })
			.locator("xpath=../../..")
			.getByRole("switch");
		await expect(control).toHaveCount(1);
		if (await control.isDisabled()) {
			continue;
		}
		const before = await control.isChecked();
		await control.click();
		await expect(control).toBeChecked({ checked: !before });
		await expect
			.poll(() =>
				readStoredAppearanceDocument(page, "ryu:file-tree-prefs").then(
					(value) => (value ? value[property] : null)
				)
			)
			.toBe(!before);
	}

	await goBackToAppearance(page);
	await openPage(page, "Reset");
	await page.getByRole("button", { name: "Reset to defaults" }).click();
	await expect(
		page.getByRole("button", { name: "Confirm reset" })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect
		.poll(() =>
			readStoredAppearanceDocument(page, "ryu:file-tree-prefs").then((value) =>
				value ? value.density : null
			)
		)
		.toBe("compact");
	await page.getByRole("button", { name: "Reset to defaults" }).click();
	await page.getByRole("button", { name: "Confirm reset" }).click();
	await expect
		.poll(() =>
			readStoredAppearanceDocument(page, "ryu:file-tree-prefs").then((value) =>
				value ? value.density : null
			)
		)
		.toBe("default");
});

test("persists every typography and layout control", async ({ page }) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Layout & text");

	const fontOptions = [
		[0, "Geist", "ryu_ui_font", '"Geist Variable", "Geist", sans-serif'],
		[1, "Inter", "ryu_heading_font", '"Inter Variable", "Inter", sans-serif'],
		[
			2,
			"JetBrains Mono",
			"ryu_code_font",
			'"JetBrains Mono", ui-monospace, monospace',
		],
	] as const;
	for (const [index, label, storageKey, expectedValue] of fontOptions) {
		const trigger = page.getByRole("combobox").nth(index);
		await selectOption(page, trigger, label);
		await expect(trigger).toContainText(label);
		await expect
			.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
			.toBe(expectedValue);
	}

	const sliderPreferences = [
		["Muted contrast", "ryu_contrast"],
		["Roundness", "ryu_radius"],
		["Scale (UI zoom)", "ryu_ui_scale"],
		["Zoom (spacing)", "ryu_spacing"],
		["Card padding", "ryu_card_spacing"],
		["Chat width", "ryu_chat_width"],
		["Sidebar width", "ryu:sidebar-width"],
	] as const;
	for (const [label, storageKey] of sliderPreferences) {
		const slider = page.getByRole("slider", { name: label });
		await expect(slider).toBeVisible();
		const before = await page.evaluate(
			(key) => localStorage.getItem(key),
			storageKey
		);
		await slider.focus();
		await page.keyboard.press("ArrowRight");
		await expect
			.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
			.not.toBe(before);
	}

	const timezone = page.getByRole("combobox").last();
	await timezone.click();
	const timezoneSearch = page.getByPlaceholder("Search a city or zone…");
	await timezoneSearch.fill("los_angeles");
	await page.getByRole("option", { name: /Los Angeles/ }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:timezone")))
		.toBe("America/Los_Angeles");
	await expect(
		page.locator("p").filter({ hasText: "America/Los Angeles" })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-appearance-layout-proof.png"),
	});
});
