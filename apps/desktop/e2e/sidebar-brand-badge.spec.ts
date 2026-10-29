import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.goto("/sidebar-brand-badge-story.html?reset=1");
	await expect(page.getByTestId("badge-switcher")).toBeVisible();
});

test("shows the Bot lockup and gated product menu", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	// The lockup is the Ryu mark and the mode's name, with no "Ryu" word.
	await expect(switcher.getByText("Ryu", { exact: true })).toHaveCount(0);
	await expect(switcher.getByText("Bot", { exact: true })).toBeVisible();
	await expect(
		page.getByTestId("badge-member").getByTestId("product-mode-trigger")
	).toHaveCount(0);
	await expect(page.getByTestId("release-channel-badge")).toHaveCount(0);

	await switcher.getByTestId("product-mode-trigger").click();
	await expect(page.getByRole("menuitemradio", { name: /Bot/ })).toBeVisible();
	await expect(
		page.getByRole("menuitemradio", { name: /^Agent/ })
	).toBeVisible();
	await expect(page.getByRole("menuitemradio", { name: /OS/ })).toBeVisible();
	await page.screenshot({
		path: test.info().outputPath("ryu-product-mode-menu-proof.png"),
		fullPage: true,
	});
});

// Bot and Agent send different response modes, which are part of the Ryu
// assistant's system prompt, so the switch asks before resetting the cache.
async function confirmPromptCacheReset(page: Page) {
	const dialog = page.getByRole("alertdialog");
	await expect(dialog).toContainText(
		"The response mode is part of the system prompt for every Ryu assistant thread."
	);
	await dialog.getByRole("button", { name: "Apply now" }).click();
	await expect(dialog).toHaveCount(0);
}

test("switches the eligible lockup to Agent", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /^Agent/ }).click();
	await confirmPromptCacheReset(page);
	await expect(switcher.getByText("Agent", { exact: true })).toBeVisible();
});

test("cancelling the prompt-cache confirmation keeps Bot", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /^Agent/ }).click();
	const dialog = page.getByRole("alertdialog");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(switcher.getByText("Bot", { exact: true })).toBeVisible();
	await expect(switcher).not.toContainText("Agent");
});

test("switches between Code interfaces without asking", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /^Agent/ }).click();
	await confirmPromptCacheReset(page);

	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /OS/ }).click();
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(switcher.getByText("OS", { exact: true })).toBeVisible();
});

test("switches the eligible lockup back to Bot", async ({ page }) => {
	const switcher = page.getByTestId("badge-switcher");
	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /^Agent/ }).click();
	await confirmPromptCacheReset(page);
	await expect(switcher.getByText("Agent", { exact: true })).toBeVisible();

	await switcher.getByTestId("product-mode-trigger").click();
	await page.getByRole("menuitemradio", { name: /^Bot/ }).click();
	await confirmPromptCacheReset(page);
	await expect(switcher.getByText("Bot", { exact: true })).toBeVisible();
	await expect(switcher).not.toContainText("Agent");
});
