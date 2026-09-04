import { expect, test } from "@playwright/test";

const PRODUCT_MENU_SCREENSHOT =
	"/Users/jiawei/.codex/visualizations/2026/08/25/01a03916-ee8c-7552-ab02-c72fe2dd4a39/ryu-product-mode-menu-proof.png";

test.beforeEach(async ({ page }) => {
	await page.goto("/sidebar-brand-badge-story.html?reset=1");
	await expect(page.getByTestId("badge-switcher")).toBeVisible();
});

test("shows the Ryu Bot lockup and gated product menu", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	await expect(switcher.getByText("Ryu", { exact: true })).toBeVisible();
	await expect(switcher.getByText("Bot", { exact: true })).toBeVisible();
	await expect(
		page.getByTestId("badge-member").getByTestId("product-mode-trigger")
	).toHaveCount(0);
	await expect(page.getByTestId("release-channel-badge")).toHaveCount(0);

	await switcher.getByTestId("product-mode-trigger").click();
	await expect(page.getByRole("menuitemradio", { name: /Bot/ })).toBeVisible();
	await expect(
		page.getByRole("menuitemradio", { name: /Console/ })
	).toBeVisible();
	await expect(page.getByRole("menuitemradio", { name: /OS/ })).toBeVisible();
	await page.screenshot({ path: PRODUCT_MENU_SCREENSHOT, fullPage: true });
});

test("switches the eligible lockup to Console", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /Console/ }).click();
	await expect(switcher.getByText("Console", { exact: true })).toBeVisible();
});

test("switches the eligible lockup back to Bot", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /Console/ }).click();
	await expect(switcher.getByText("Console", { exact: true })).toBeVisible();

	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /^Bot/ }).click();
	await expect(switcher.getByText("Bot", { exact: true })).toBeVisible();
	await expect(switcher).not.toContainText("Console");
});
