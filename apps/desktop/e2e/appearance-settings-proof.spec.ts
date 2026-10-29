import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { parseLanguagePackArchive } from "@ryu/i18n/core";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";
import {
	appearanceBackgroundProofSchema,
	appearanceLanguageRequestsSchema,
	storedAppearanceThemesSchema,
} from "./appearance-proof.contracts.ts";

const STORY_URL = "/appearance-settings-proof.html";
const LANGUAGE_PACK_EVIDENCE_PATH = "desktop-appearance-language-packs.png";
const THEME_EDITOR_EVIDENCE_PATH = "desktop-appearance-theme-editor.png";
const RESET_EVIDENCE_PATH = "desktop-appearance-reset.png";

interface UsageBarPrefsProof {
	barStyle: "bar" | "ring";
	mode: "used" | "remaining";
	showBar: boolean;
	showPercent: boolean;
	sidebar: boolean;
	visible: boolean;
}

async function readStoredAppearanceDocument(
	page: import("@playwright/test").Page,
	key: string
) {
	const raw = await page.evaluate((storageKey) => {
		const value = localStorage.getItem(storageKey);
		return value ? JSON.parse(value) : null;
	}, key);
	return raw === null ? null : pluginDocumentSchema.parse(raw);
}

async function openPage(page: import("@playwright/test").Page, name: string) {
	await page.getByRole("button", { name, exact: true }).click();
}

async function goBackToAppearance(page: import("@playwright/test").Page) {
	await page.getByRole("button", { name: "Appearance", exact: true }).click();
}

async function selectOption(
	page: import("@playwright/test").Page,
	select: import("@playwright/test").Locator,
	label: string
) {
	await select.click();
	const listbox = page.locator('[role="listbox"]:visible').last();
	await expect(listbox).toBeVisible();
	await listbox.getByRole("option", { exact: true, name: label }).click();
	await expect(page.locator('[role="listbox"]:visible')).toHaveCount(0);
}

test.describe.configure({ timeout: 120_000 });

test("changes themes and saves, shares, and deletes a custom preset", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();

	await page.getByRole("img", { name: "Light", exact: true }).click();
	await expect(page.locator("html")).toHaveClass(/light/);
	await page
		.getByRole("button", { name: "Set primary to Blue" })
		.first()
		.click();
	await page
		.getByRole("button", { name: "Custom primary color" })
		.first()
		.click();
	const hexColor = page.getByRole("textbox", { name: "Hex color value" });
	await hexColor.fill("#FF3B30");
	await expect(hexColor).toHaveValue("#FF3B30");
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Save as preset", exact: true })
		.click();
	const presetName = page.getByPlaceholder("Preset name…");
	await presetName.fill("Coverage theme");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("ryu_custom_themes")?.includes("Coverage theme")
			)
		)
		.toBe(true);

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-appearance-theme-preset-proof.png"),
	});
	await page.getByRole("button", { name: "Share Coverage theme" }).click();
	await expect(
		page.getByText("Theme manifest copied", { exact: true })
	).toBeVisible();
	const clipboardManifest = await page.evaluate(() =>
		navigator.clipboard.readText()
	);
	expect(
		pluginDocumentSchema.parse(JSON.parse(clipboardManifest))
	).toMatchObject({
		id: "@you/coverage-theme-theme",
		name: "Coverage theme Theme",
		category: "Themes",
		runnables: [],
		contributes: {
			themes: [
				{
					id: "@you/coverage-theme-theme:coverage-theme",
					label: "Coverage theme",
					mode: "light",
					tokens: { "--primary": "#FF3B30" },
				},
			],
		},
	});

	await page.getByRole("button", { name: "Delete Coverage theme" }).click();
	await expect(
		page.getByText("Delete “Coverage theme”?", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("ryu_custom_themes")?.includes("Coverage theme")
			)
		)
		.toBe(true);
	await page.getByRole("button", { name: "Delete Coverage theme" }).click();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("ryu_custom_themes")?.includes("Coverage theme")
			)
		)
		.toBe(false);
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_light_preset")))
		.toBe("ryu-light");
});

test("theme presets edit, discard, save by keyboard, persist, and report share errors", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();

	await page.getByRole("img", { name: "Light", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("light");
	const lightPreset = page.getByRole("combobox").first();
	await selectOption(page, lightPreset, "Ryu Light");
	await expect(lightPreset).toContainText("Ryu Light");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_light_preset")))
		.toBe("ryu-light-mono");

	const background = page.locator("#light-background");
	const originalBackground = await background.innerText();
	await background.click();
	const colorPopup = page.locator('[data-slot="color-picker-content"]');
	await expect(colorPopup).toBeVisible();
	const hexColor = page.getByRole("textbox", { name: "Hex color value" });
	await hexColor.fill("#F4F4F5");
	await expect(background).toContainText("#F4F4F5");
	await page.keyboard.press("Escape");
	await expect(colorPopup).toBeHidden();
	await page.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(background).toContainText(originalBackground);
	await expect(
		page.getByRole("button", { name: "Save as preset", exact: true })
	).toBeHidden();

	await background.click();
	await hexColor.fill("#F4F4F5");
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Save as preset", exact: true })
		.click();
	const presetName = page.getByPlaceholder("Preset name…");
	const savePreset = page.getByRole("button", { name: "Save", exact: true });
	await expect(savePreset).toBeDisabled();
	await presetName.fill("   ");
	await expect(savePreset).toBeDisabled();
	await presetName.fill("Canceled theme");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(presetName).toBeHidden();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_custom_themes") ?? "[]")
		)
		.not.toContain("Canceled theme");
	await expect(
		page.getByRole("button", { name: "Save as preset", exact: true })
	).toBeVisible();

	await page
		.getByRole("button", { name: "Save as preset", exact: true })
		.click();
	await presetName.fill("Dismissed theme");
	await presetName.press("Escape");
	await expect(presetName).toBeHidden();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu_custom_themes") ?? "[]")
		)
		.not.toContain("Dismissed theme");

	await page
		.getByRole("button", { name: "Save as preset", exact: true })
		.click();
	await presetName.fill("   ");
	await expect(savePreset).toBeDisabled();
	await presetName.fill("Keyboard Theme ");
	await presetName.press("Enter");
	await expect(presetName).toBeHidden();
	await expect(lightPreset).toContainText("Keyboard Theme");
	const savedTheme =
		storedAppearanceThemesSchema
			.parse(
				await page.evaluate(() =>
					JSON.parse(localStorage.getItem("ryu_custom_themes") ?? "[]")
				)
			)
			.find((theme) => theme.label === "Keyboard Theme") ?? null;
	expect(savedTheme).toMatchObject({
		label: "Keyboard Theme",
		mode: "light",
		tokens: { "--background": "#F4F4F5" },
	});
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_light_preset")))
		.toBe(savedTheme?.id);

	await page.getByRole("img", { name: "Dark", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("dark");
	const darkPreset = page.getByRole("combobox").nth(1);
	await selectOption(page, darkPreset, "Ryu Dark");
	await expect(darkPreset).toContainText("Ryu Dark");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_dark_preset")))
		.toBe("ryu-dark-mono");
	const darkBackground = page.locator("#dark-background");
	const originalDarkBackground = await darkBackground.innerText();
	await darkBackground.click();
	await page.getByRole("textbox", { name: "Hex color value" }).fill("#202124");
	await expect(darkBackground).toContainText("#202124");
	await expect
		.poll(() =>
			page.evaluate(() =>
				getComputedStyle(document.documentElement)
					.getPropertyValue("--background")
					.trim()
			)
		)
		.toBe("#202124");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(darkBackground).toContainText(originalDarkBackground);
	await page.getByRole("img", { name: "System", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("system");
	await page.getByRole("img", { name: "Light", exact: true }).click();
	await selectOption(page, lightPreset, "Ryu Light");
	await selectOption(page, lightPreset, "Keyboard Theme");
	await expect(lightPreset).toContainText("Keyboard Theme");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_light_preset")))
		.toBe(savedTheme?.id);

	await page.reload();
	await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();
	await expect(page.locator("html")).toHaveClass(/light/);
	const reloadedPreset = page.getByRole("combobox").first();
	await expect(reloadedPreset).toContainText("Keyboard Theme");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("light");
	await expect
		.poll(() =>
			page.evaluate(() =>
				getComputedStyle(document.documentElement)
					.getPropertyValue("--background")
					.trim()
			)
		)
		.toBe("#F4F4F5");
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath(THEME_EDITOR_EVIDENCE_PATH),
	});

	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					throw new Error("clipboard denied");
				},
			},
		});
	});
	await page.reload();
	await page.getByRole("button", { name: "Share Keyboard Theme" }).click();
	await expect(
		page.getByText("Couldn't copy the theme manifest", { exact: true })
	).toBeVisible();

	await openPage(page, "Layout & text");
	await selectOption(page, page.getByRole("combobox").first(), "Geist");
	await goBackToAppearance(page);
	await openPage(page, "Interface");
	const pointerCursor = page.getByRole("switch").nth(2);
	await pointerCursor.click();
	await expect(pointerCursor).toBeChecked();
	await goBackToAppearance(page);
	await openPage(page, "Diff viewer");
	const diffViewerPanel = page
		.getByRole("heading", { name: "Diff viewer", exact: true })
		.last()
		.locator("xpath=../..");
	const diffLayout = diffViewerPanel
		.getByText("Layout", { exact: true })
		.locator("xpath=../../..")
		.getByRole("combobox");
	await selectOption(page, diffLayout, "Stacked (inline)");
	await expect
		.poll(() =>
			page.evaluate(() => {
				const value = localStorage.getItem("ryu:diff-view-prefs");
				return value ? JSON.parse(value).diffStyle : null;
			})
		)
		.toBe("unified");
	await goBackToAppearance(page);
	await openPage(page, "File tree");
	await selectOption(page, page.getByRole("combobox").first(), "Compact");
	await expect
		.poll(() =>
			page.evaluate(() => {
				const value = localStorage.getItem("ryu:file-tree-prefs");
				return value ? JSON.parse(value).density : null;
			})
		)
		.toBe("compact");

	await goBackToAppearance(page);
	await openPage(page, "Reset");
	await page.getByRole("button", { name: "Reset to defaults" }).click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("light");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_ui_font")))
		.toBe('"Geist Variable", "Geist", sans-serif');
	await expect
		.poll(() =>
			page.evaluate(() => {
				const value = localStorage.getItem("ryu:diff-view-prefs");
				return value ? JSON.parse(value).diffStyle : null;
			})
		)
		.toBe("unified");
	await expect
		.poll(() =>
			page.evaluate(() => {
				const value = localStorage.getItem("ryu:file-tree-prefs");
				return value ? JSON.parse(value).density : null;
			})
		)
		.toBe("compact");
	await page.getByRole("button", { name: "Reset to defaults" }).click();
	await page.getByRole("button", { name: "Confirm reset" }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("system");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_light_preset")))
		.toBe("ryu-light");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_ui_font")))
		.toBe('"Inter Variable", "Inter", sans-serif');
	await expect
		.poll(() =>
			page.evaluate(() => {
				const value = localStorage.getItem("ryu:diff-view-prefs");
				return value ? JSON.parse(value).diffStyle : null;
			})
		)
		.toBe("split");
	await expect
		.poll(() =>
			page.evaluate(() => {
				const value = localStorage.getItem("ryu:file-tree-prefs");
				return value ? JSON.parse(value).density : null;
			})
		)
		.toBe("default");
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("ryu_custom_themes")?.includes("Keyboard Theme")
			)
		)
		.toBe(true);

	await page.reload();
	await expect(page.getByTestId("appearance-settings-proof")).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("theme")))
		.toBe("system");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu_light_preset")))
		.toBe("ryu-light");
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("ryu_custom_themes")?.includes("Keyboard Theme")
			)
		)
		.toBe(true);
	await openPage(page, "Interface");
	await expect(page.getByRole("switch").nth(2)).not.toBeChecked();
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath(RESET_EVIDENCE_PATH),
	});
});

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
	await expect(seasonalEffects).toBeChecked();
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
	const fileTreePanel = page
		.getByRole("heading", { name: "File tree", exact: true })
		.locator("xpath=../..");
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

test("gradient and image backgrounds edit, persist, and clear on both surfaces", async ({
	page,
}, testInfo) => {
	page.setDefaultTimeout(20_000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Layout & text");

	const readBackground = async (surface: "page" | "sidebar") => {
		const value = await readStoredAppearanceDocument(page, `ryu:bg:${surface}`);
		return value === null ? null : appearanceBackgroundProofSchema.parse(value);
	};
	const switches = page.getByRole("switch");
	await expect(switches).toHaveCount(4);
	const backgroundSwitches = [
		[0, "sidebar", "gradientEnabled"],
		[1, "sidebar", "imageEnabled"],
		[2, "page", "gradientEnabled"],
		[3, "page", "imageEnabled"],
	] as const;
	for (const [index, surface, property] of backgroundSwitches) {
		const control = switches.nth(index);
		await control.click();
		await expect(control).toBeChecked();
		await expect
			.poll(async () => (await readBackground(surface))?.[property])
			.toBe(true);
	}

	const addStops = page.getByRole("button", { name: "Add stop", exact: true });
	await expect(addStops).toHaveCount(2);
	for (const surface of ["sidebar", "page"] as const) {
		const stopCount = (await readBackground(surface))?.gradientStops;
		if (!stopCount) {
			throw new Error(
				"The saved native background must contain its gradient stops"
			);
		}
		const addButton = addStops.nth(surface === "sidebar" ? 0 : 1);
		await addButton.click();
		await expect
			.poll(async () => {
				const value = await readBackground(surface);
				return value?.gradientStops?.length ?? 0;
			})
			.toBe(stopCount.length + 1);
		await page
			.getByRole("button", { name: "Remove gradient stop 3" })
			.last()
			.click();
		await expect
			.poll(async () => {
				const value = await readBackground(surface);
				return value?.gradientStops?.length ?? 0;
			})
			.toBe(stopCount.length);
	}

	const gradientStopColor = page.getByRole("button", {
		name: "Gradient stop 1 color",
	});
	await gradientStopColor.first().click();
	const gradientHex = page.getByRole("textbox", { name: "Hex color value" });
	await gradientHex.fill("#00CC88");
	await expect
		.poll(async () => {
			const value = await readBackground("sidebar");
			const stops = value?.gradientStops;
			return stops?.[0]?.color;
		})
		.toBe("#00CC88");
	await page.keyboard.press("Escape");

	const angle = page.getByRole("slider", { name: "Angle" }).first();
	const angleBefore = (await readBackground("sidebar"))?.gradientAngle ?? null;
	await angle.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(async () => (await readBackground("sidebar"))?.gradientAngle)
		.not.toBe(angleBefore);

	const file = {
		buffer: Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
			"base64"
		),
		mimeType: "image/png",
		name: "pixel.png",
	};
	for (const surface of ["sidebar", "page"] as const) {
		const chooseButton = page.getByRole("button", {
			name: "Choose image",
			exact: true,
		});
		if (surface === "page") {
			const invalidChooserPromise = page.waitForEvent("filechooser");
			await chooseButton.first().click();
			const invalidChooser = await invalidChooserPromise;
			await invalidChooser.setFiles({
				buffer: Buffer.from("not an image"),
				mimeType: "text/plain",
				name: "notes.txt",
			});
			await expect(
				page.getByText("Please choose an image file.", { exact: true })
			).toBeVisible();
			await expect
				.poll(async () => (await readBackground(surface))?.imageEnabled)
				.toBe(true);
		}
		const chooserPromise = page.waitForEvent("filechooser");
		await chooseButton.first().click();
		const chooser = await chooserPromise;
		await chooser.setFiles(file);
		await expect
			.poll(async () => (await readBackground(surface))?.imageEnabled)
			.toBe(true);
		await expect(
			page.getByRole("button", { name: "Replace", exact: true })
		).toHaveCount(surface === "sidebar" ? 1 : 2);
	}

	const fitOptions = [
		["Cover", "cover"],
		["Contain", "contain"],
		["Stretch", "fill"],
		["Center", "center"],
		["Tile", "tile"],
	] as const;
	for (const [fitIndex, surface] of (["sidebar", "page"] as const).entries()) {
		const fit = page.getByRole("combobox").nth(fitIndex);
		for (const [label, value] of fitOptions) {
			await selectOption(page, fit, label);
			await expect
				.poll(async () => (await readBackground(surface))?.imageFit)
				.toBe(value);
		}
	}

	const scaleSliders = page.getByRole("slider", { exact: true, name: "Scale" });
	await expect(scaleSliders).toHaveCount(2);
	for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
		const slider = scaleSliders.nth(index);
		const before = (await readBackground(surface))?.imageScale;
		await slider.focus();
		await page.keyboard.press("ArrowRight");
		await expect
			.poll(async () => (await readBackground(surface))?.imageScale)
			.not.toBe(before);
	}

	const overlayColors = page.getByRole("button", { name: "Overlay color" });
	for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
		await overlayColors.nth(index).click();
		const overlayHex = page
			.getByRole("textbox", { name: "Hex color value" })
			.last();
		const color = index === 0 ? "#EE6633" : "#3388EE";
		await overlayHex.fill(color);
		await expect
			.poll(async () => (await readBackground(surface))?.overlayColor)
			.toBe(color);
		await page.keyboard.press("Escape");
	}

	const overlayOpacity = page.getByRole("slider", { name: "Overlay opacity" });
	await expect(overlayOpacity).toHaveCount(2);
	for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
		const before = (await readBackground(surface))?.overlayOpacity;
		const control = overlayOpacity.nth(index);
		await control.focus();
		await page.keyboard.press("ArrowRight");
		await expect
			.poll(async () => (await readBackground(surface))?.overlayOpacity)
			.not.toBe(before);
	}

	for (const label of ["Transparency", "Backdrop blur"] as const) {
		const controls = page.getByRole("slider", { name: label });
		await expect(controls).toHaveCount(2);
		for (const [index, surface] of (["sidebar", "page"] as const).entries()) {
			const property =
				label === "Transparency" ? "transparency" : "backdropBlur";
			const control = controls.nth(index);
			const before = (await readBackground(surface))?.[property];
			await control.focus();
			await page.keyboard.press("ArrowRight");
			await expect
				.poll(async () => (await readBackground(surface))?.[property])
				.not.toBe(before);
		}
	}

	await page.getByRole("button", { name: "Remove image" }).nth(1).click();
	await expect(
		page.getByRole("button", { name: "Choose image", exact: true })
	).toHaveCount(1);
	await page.getByRole("button", { name: "Remove image" }).first().click();
	await expect(
		page.getByRole("button", { name: "Choose image", exact: true })
	).toHaveCount(2);
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue("--ryu-page-bg-image")
			)
		)
		.not.toContain("url(");
	await expect
		.poll(() =>
			page.evaluate(() =>
				document.documentElement.style.getPropertyValue(
					"--ryu-sidebar-bg-image"
				)
			)
		)
		.not.toContain("url(");
	await expect(
		page.getByText("Please choose an image file.", { exact: true })
	).toBeHidden();
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("desktop-appearance-backgrounds.png"),
	});
});

test("every enabled Interface switch changes and persists its choice", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Interface");
	const interfacePanel = page
		.getByRole("heading", { name: "Interface", exact: true })
		.last()
		.locator("xpath=../..");
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
			label: "Blur dialog backgrounds",
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

test("language settings select, export, enable, import, and open the marketplace", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Language & vibe");

	const languagePicker = page.getByRole("list").first().getByRole("combobox");
	/**
	 * A language choice re-renders the open Language page in place: the page
	 * stays open in the new language and its index row is not shown. An
	 * immediate choice also keeps keyboard focus on the picker; enabling a
	 * disabled pack disables the picker while Core works, so focus is not
	 * checked for that choice.
	 */
	const expectLanguagePageOpen = async (labels: {
		back: string;
		choice: string;
		focused: boolean;
		title: string;
	}) => {
		await expect(
			page.getByRole("button", { name: labels.back, exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("heading", { level: 3, name: labels.title, exact: true })
		).toHaveCount(2);
		await expect(
			page.getByRole("button", { name: labels.title, exact: true })
		).toHaveCount(0);
		await expect(languagePicker).toContainText(labels.choice);
		if (labels.focused) {
			await expect(languagePicker).toBeFocused();
		}
	};
	await selectOption(page, languagePicker, "Español");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-mode")))
		.toBe("fixed");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBe("official/es");
	await expect(page.locator("html")).toHaveAttribute("lang", "es");
	await expectLanguagePageOpen({
		back: "Apariencia",
		choice: "Español",
		focused: true,
		title: "Idioma y estilo",
	});
	await selectOption(page, languagePicker, "Detectar automáticamente");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-mode")))
		.toBe("auto");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBeNull();
	await expectLanguagePageOpen({
		back: "Appearance",
		choice: "Auto detect",
		focused: true,
		title: "Language & vibe",
	});

	await selectOption(page, languagePicker, "Coverage disabled voice");
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBe("proof/disabled-voice");
	await expectLanguagePageOpen({
		back: "Appearance",
		choice: "Coverage disabled voice",
		focused: false,
		title: "Language & vibe",
	});
	const requests = appearanceLanguageRequestsSchema.parse(
		await page.evaluate(() =>
			JSON.parse(
				localStorage.getItem("ryu_appearance_language_requests") ?? "[]"
			)
		)
	);
	expect(requests).toContainEqual({
		method: "POST",
		path: "/api/marketplace/packages/language_pack/proof%2Fdisabled-voice/enable",
	});

	const fileChooserPromise = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "Import", exact: true }).click();
	const fileChooser = await fileChooserPromise;
	await fileChooser.setFiles({
		buffer: Buffer.from("fixture language archive"),
		mimeType: "application/zip",
		name: "coverage.ryupack",
	});
	await expect(
		page.getByText("Coverage imported voice", { exact: true }).nth(1)
	).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("ryu:language-pack")))
		.toBe("proof/imported-voice");
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath(LANGUAGE_PACK_EVIDENCE_PATH),
	});
	const packName = "Coverage imported voice";
	const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
	await page.getByRole("button", { name: `Export ${packName}` }).click();
	const download = await downloadPromise;
	const archivePath = await download.path();
	if (!archivePath) {
		throw new Error(
			"Playwright did not preserve the downloaded language pack."
		);
	}
	const archive = await readFile(archivePath);
	expect(download.suggestedFilename()).toBe(
		"coverage-imported-voice-1.0.0.ryupack"
	);
	expect(archive.byteLength).toBeGreaterThan(0);
	const pack = parseLanguagePackArchive(new Uint8Array(archive));
	expect(pack.name).toBe(packName);
	expect(pack.id).toBe("proof/imported-voice");
	expect(pack.messages).toEqual({ "common.marketplace": "Marketplace" });
});

test("language settings Marketplace action navigates to the catalog", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await openPage(page, "Language & vibe");
	await page.getByRole("button", { name: "Marketplace", exact: true }).click();
	await expect(page.getByTestId("proof-route")).toHaveText("/marketplace");
});

test("chat detail presets, advanced controls, and message preferences respond", async ({
	page,
}) => {
	page.setDefaultTimeout(7000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await openPage(page, "Chat");

	const detail = page.getByRole("slider", { name: "Detail level" });
	await expect(detail).toBeVisible();
	await detail.focus();
	await page.keyboard.press("ArrowRight");
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("ryu:hide-tool-detail"))
		)
		.toBe("false");

	await page.getByRole("button", { name: "Advanced detail" }).click();
	const advancedSwitches = [
		["group-tool-uses-toggle", "ryu:group-tool-uses"],
		["expand-file-edits-toggle", "ryu:expand-file-edits"],
		["expand-commands-toggle", "ryu:expand-commands"],
		["expand-code-blocks-toggle", "ryu:expand-code-blocks"],
	] as const;
	for (const [index, [, storageKey]] of advancedSwitches.entries()) {
		const control = page.getByRole("switch").nth(index);
		await expect(control).toBeVisible();
		const before = await control.isChecked();
		await control.click();
		await expect(control).toBeChecked({ checked: !before });
		await expect
			.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
			.toBe(String(!before));
	}

	const messagePreferences = [
		["pin-user-message-toggle", "ryu:pin-user-message"],
		["open-chat-at-bottom-toggle", "ryu:open-chat-at-bottom"],
		["inference-stats-toggle", "ryu:inference-stats"],
	] as const;
	for (const [index, [, key]] of messagePreferences.entries()) {
		const control = page.getByRole("switch").nth(index + 4);
		const before = await control.isChecked();
		await control.click();
		await expect(control).toBeChecked({ checked: !before });
		await expect
			.poll(() =>
				page.evaluate((storageKey) => localStorage.getItem(storageKey), key)
			)
			.toBe(String(!before));
	}
	const changedChatChecks = await page
		.getByRole("switch")
		.evaluateAll((controls) =>
			controls.map((control) => control.getAttribute("aria-checked") === "true")
		);
	const changedChatStorage = await page.evaluate(
		(keys) =>
			Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
		[
			...advancedSwitches.map(([, key]) => key),
			...messagePreferences.map(([, key]) => key),
		]
	);
	await page.reload();
	await openPage(page, "Chat");
	await page.getByRole("button", { name: "Advanced detail" }).click();
	for (const [index, checked] of changedChatChecks.entries()) {
		await expect(page.getByRole("switch").nth(index)).toBeChecked({ checked });
	}
	for (const [key, value] of Object.entries(changedChatStorage)) {
		await expect
			.poll(() =>
				page.evaluate((storageKey) => localStorage.getItem(storageKey), key)
			)
			.toBe(value);
	}
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-appearance-chat-settings-proof.png"),
	});
});
