// Fixture constants and UI helpers for app-sidebar-entity-rows-proof.spec.ts.
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const STORY_URL = "/app-sidebar-entity-rows-proof.html";
export const PROJECT_PATH = "/workspace/project-alpha";
export const SPACE_ID = "space-research";

export async function openProof(
	page: Page,
	options: {
		failDelete?: boolean;
		failRename?: boolean;
		failSpaceIcon?: boolean;
		failProjectWrite?: boolean;
		failDocumentRead?: boolean;
	} = {}
) {
	await page.goto(STORY_URL);
	await page.evaluate(
		(fixture) => {
			localStorage.clear();
			for (const [key, value] of Object.entries(fixture)) {
				if (value) {
					localStorage.setItem(key, "true");
				}
			}
		},
		{
			"proof:fail-space-delete-once": options.failDelete,
			"proof:fail-space-rename-once": options.failRename,
			"proof:fail-space-icon-once": options.failSpaceIcon,
			"proof:fail-project-write-once": options.failProjectWrite,
			"proof:fail-document-read-once": options.failDocumentRead,
		}
	);
	await page.reload();
}

export async function openSpaceMenu(page: Page, rowId = "space-row-research") {
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	const menu = page.locator('[data-slot="context-menu-content"]').last();
	if (await menu.isVisible().catch(() => false)) {
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
	}
	const row = page.getByTestId(rowId).locator('[role="button"]').first();
	await row.click({ button: "right", force: true });
	await expect(menu).toBeVisible();
	return menu;
}

export async function openProjectMenu(page: Page, rowId = "project-row-alpha") {
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	const menu = page.locator('[data-slot="context-menu-content"]').last();
	if (await menu.isVisible().catch(() => false)) {
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
	}
	const header = page.getByTestId(rowId).getByRole("button").first();
	await header.click({ button: "right", force: true });
	await expect(menu).toBeVisible();
	return menu;
}

export async function chooseFixtureIcon(page: Page) {
	const dialog = page.getByRole("dialog", { name: /icon/i });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("tab", { name: "Icon", exact: true }).click();
	const search = dialog.getByRole("textbox", { name: "Search icons" });
	await search.fill("folder");
	const icon = dialog.getByRole("button", {
		name: "lucide:folder",
		exact: true,
	});
	await expect(icon).toBeVisible();
	await icon.click();
	await dialog.getByRole("button", { name: "Use icon", exact: true }).click();
	await expect(dialog).toBeHidden();
}

export async function confirmDestructiveDialog(page: Page, label: string) {
	const slider = page.getByRole("slider", { name: label });
	// SlideCommit (#941) holds a failed attempt in "pending", then "error", while
	// the handle springs home, and ignores keys until it is idle again.
	await expect(
		page.locator('[data-slot="slide-commit"]').filter({ has: slider })
	).toHaveAttribute("data-phase", "idle");
	await slider.focus();
	for (let step = 0; step < 5; step += 1) {
		await page.keyboard.press("ArrowRight");
	}
}
