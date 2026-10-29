import { expect, test } from "@playwright/test";

test("renders supplied model prices and score bars in the shipping hover preview", async ({
	page,
}) => {
	await page.goto("/model-pricing-proof.html");

	await expect(
		page.getByRole("heading", { name: "Model price preview rendering" })
	).toBeVisible();
	const scoreBars = page
		.getByTestId("price-preview")
		.locator('[data-slot="model-score-bar"]');
	await expect(scoreBars).toHaveCount(4);
	await expect(scoreBars.nth(0)).toHaveAttribute("data-score", "2");
	await expect(scoreBars.nth(0)).toHaveAttribute("data-filled-pips", "2");
	await expect(
		scoreBars.nth(0).locator('[data-slot="model-score-pip"]')
	).toHaveCount(5);
	await expect(
		scoreBars
			.nth(0)
			.locator('[data-slot="model-score-pip"][data-filled="true"]')
	).toHaveCount(2);
	await expect(page.getByTestId("price-preview")).toContainText("In $2.50 /1M");
	await expect(page.getByTestId("price-preview")).toContainText(
		"Out $15.00 /1M"
	);

	await page.getByTestId("model-row-anthropic/claude-sonnet-4").click();
	await expect(page.getByTestId("price-preview")).toContainText("In $3.00 /1M");
	await expect(page.getByTestId("price-preview")).toContainText(
		"Out $15.00 /1M"
	);
});
