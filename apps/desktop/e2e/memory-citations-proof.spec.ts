import { expect, test } from "@playwright/test";

const STORY_URL = "/memory-citations-proof.html";

test("shows the registered memory citation action and tooltip", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);

	const proof = page.getByTestId("memory-citations-proof");
	await expect(proof).toBeVisible();

	const more = page.getByRole("button", { name: "More message actions" });
	await expect(more).toBeVisible();
	await more.click();
	const action = page.getByRole("menuitem", { name: "Memories cited" });
	await expect(action).toBeVisible();
	await action.click();

	const tooltip = page.locator('[data-slot="popover-content"]');
	await expect(tooltip).toBeVisible();
	await page.waitForTimeout(300);
	await expect(tooltip).toContainText("Memories cited");
	await expect(tooltip).toContainText(
		"Keeps the Marketplace package and provenance boundary intact."
	);
	await expect(tooltip).toContainText(
		"Prefers ordinary functionality to remain in signed Marketplace packages."
	);

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("memory-citations-proof.png"),
	});
});
