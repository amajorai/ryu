import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/tab-overflow-proof-story.html";

test("keeps clipped tab titles static and opens the shared context menu", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const row = page.locator('[data-proof-row="horizontal"]');
	const title = row.locator('span[data-slot="tooltip-trigger"]');
	const overflowButton = page.getByRole("button", {
		name: "horizontal tab options",
	});

	await expect(row).toBeVisible();
	await expect(title).toHaveCSS("mask-image", /linear-gradient/);
	await row.hover();
	await expect(overflowButton).toBeVisible();
	await expect
		.poll(() =>
			title
				.locator(":scope > span")
				.evaluate((element) => element.getAnimations().length)
		)
		.toBe(0);

	await overflowButton.click();
	const menu = page.locator('[data-slot="context-menu-content"]');
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Pin tab" })).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "Unload tab" })
	).toBeVisible();
	await expect(
		menu.getByRole("menuitem", { name: "Duplicate tab" })
	).toBeVisible();
	await expect(menu.getByRole("menuitem", { name: "Close tab" })).toBeVisible();
	await expect(page.getByTestId("proof-status")).toHaveAttribute(
		"data-status",
		"pass"
	);

	await page.keyboard.press("Escape");
	const verticalRow = page.locator('[data-proof-row="vertical"]');
	await verticalRow.hover();
	await expect(
		verticalRow.locator('span[data-slot="tooltip-trigger"]')
	).toHaveCSS("mask-image", /linear-gradient/);
	await expect(
		page.getByRole("button", { name: "vertical tab options" })
	).toBeVisible();
});
