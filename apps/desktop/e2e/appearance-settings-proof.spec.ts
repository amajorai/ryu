import { expect, test } from "@playwright/test";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";
import { storedAppearanceThemesSchema } from "./appearance-proof.contracts.ts";
import {
	appearanceSubpage,
	goBackToAppearance,
	openPage,
	RESET_EVIDENCE_PATH,
	STORY_URL,
	selectOption,
	THEME_EDITOR_EVIDENCE_PATH,
} from "./appearance-settings-proof.helpers.ts";

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
	const diffViewerPanel = appearanceSubpage(page, "Diff viewer");
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
