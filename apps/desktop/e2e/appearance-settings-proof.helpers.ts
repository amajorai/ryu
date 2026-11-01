// Shared fixtures for the appearance-settings proof specs (split from
// appearance-settings-proof.spec.ts to stay under the file-size limit).
import { expect } from "@playwright/test";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";

export const STORY_URL = "/appearance-settings-proof.html";
export const LANGUAGE_PACK_EVIDENCE_PATH =
	"desktop-appearance-language-packs.png";
export const THEME_EDITOR_EVIDENCE_PATH = "desktop-appearance-theme-editor.png";
export const RESET_EVIDENCE_PATH = "desktop-appearance-reset.png";

export interface UsageBarPrefsProof {
	barStyle: "bar" | "ring";
	mode: "used" | "remaining";
	showBar: boolean;
	showPercent: boolean;
	sidebar: boolean;
	visible: boolean;
}

export async function readStoredAppearanceDocument(
	page: import("@playwright/test").Page,
	key: string
) {
	const raw = await page.evaluate((storageKey) => {
		const value = localStorage.getItem(storageKey);
		return value ? JSON.parse(value) : null;
	}, key);
	return raw === null ? null : pluginDocumentSchema.parse(raw);
}

export async function openPage(
	page: import("@playwright/test").Page,
	name: string
) {
	await page.getByRole("button", { name, exact: true }).click();
}

export async function goBackToAppearance(
	page: import("@playwright/test").Page
) {
	await page.getByRole("button", { name: "Appearance", exact: true }).click();
}

export async function selectOption(
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

/**
 * The open Appearance sub-page. Since 8e6685a730 (Ryu Quiet #914) a sub-page
 * has one title, the level-3 heading in its back row, and its sections no
 * longer repeat it; the page root holds that row and every control.
 */
export function appearanceSubpage(
	page: import("@playwright/test").Page,
	title: string
): import("@playwright/test").Locator {
	return page
		.getByRole("heading", { level: 3, name: title, exact: true })
		.last()
		.locator("xpath=../../..");
}
