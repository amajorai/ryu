// Shared helpers for the chat-row menus story specs (chat-row-menus-story*.spec.ts).

import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const STORY_URL = "/chat-row-menus-story.html";
export const UNREAD_COUNT_PROOF = path.resolve(
	import.meta.dirname,
	"../artifacts/unread-message-count-proof-2026-09-30.png"
);
export const BROWSER_SURFACES = ["web", "extension", "mobile"] as const;
export const ROW_TITLE = "Fix the flaky auth test";
export const SESSION_ACTIONS = [
	"Pin chat",
	"Rename chat",
	"Remove from ryu",
	"Archive chat",
	"Open side chat",
	"Quick reply",
	"Copy",
	"Fork…",
	"Add scheduled task…",
	"Open in new window",
	"Mark as unread",
];
export const COPY_ACTIONS = [
	"Copy working directory",
	"Copy session ID",
	"Copy deeplink",
	"Continue on another node",
	"Copy as Markdown",
];

/** The row itself (the context-menu trigger), not the title span inside it. */
export function row(page: Page) {
	return page.getByTestId("sidebar-chat-row-conv-alpha");
}

export type MenuSurface = "context-menu" | "dropdown-menu";
export interface RecordedAction {
	args: unknown[];
	name: string;
}

export async function openMenu(page: Page, surface: MenuSurface) {
	if (surface === "dropdown-menu") {
		await openDropdown(page);
		return;
	}
	await openContextMenu(page);
}

export function menuItem(page: Page, surface: MenuSurface, label: string) {
	return page
		.locator(`[data-slot="${surface}-content"]`)
		.getByRole("menuitem", { name: label, exact: true });
}

export async function readCalls(page: Page): Promise<RecordedAction[]> {
	return page
		.getByTestId("action-log")
		.evaluate((element) => JSON.parse(element.textContent ?? "[]"));
}

export async function readClipboard(page: Page): Promise<string[]> {
	return page.evaluate(() =>
		JSON.parse(localStorage.getItem("proof:clipboard") ?? "[]")
	);
}

export async function openCopySubmenu(page: Page, surface: MenuSurface) {
	await menuItem(page, surface, "Copy").hover();
	const items = page.locator(
		`[data-slot="${surface}-sub-content"] [role="menuitem"]`
	);
	await expect(items.first()).toBeVisible();
	return items;
}

/**
 * Open the ⋯ dropdown. Two quirks make this fiddlier than a click: the trigger
 * is `display:none` until the row is hovered, and that same hover opens the
 * row's HoverCard preview. So the pointer opens the trigger and the keyboard
 * activates it — the one combination that is not a race with the preview.
 */
export async function openDropdown(page: Page) {
	const selectedBefore = await page.getByTestId("selection-state").innerText();
	await row(page).hover();
	const trigger = page.locator('[data-slot="dropdown-menu-trigger"]').first();
	await expect(trigger).toBeVisible();
	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("selection-state")).toHaveText(selectedBefore);
}

/** Open the right-click menu on the row. Forced past the same HoverCard preview,
 *  which a right-click has no reason to wait out. */
export async function openContextMenu(page: Page) {
	await row(page).click({ button: "right", force: true });
}

/**
 * Labels of one menu's rows, in render order. Scoped to the menu's own popup
 * (`data-slot`) rather than a bare `[role="menuitem"]`: a dismissed dropdown can
 * outlive its close animation in the DOM, and an unscoped query would then read
 * both menus at once and "agree" with itself.
 */
export async function menuLabels(
	page: Page,
	which: "context-menu" | "dropdown-menu"
): Promise<string[]> {
	const items = page.locator(
		`[data-slot="${which}-content"] [role="menuitem"]`
	);
	await expect(items.first()).toBeVisible();
	return (await items.allInnerTexts()).map((t) => t.trim());
}
