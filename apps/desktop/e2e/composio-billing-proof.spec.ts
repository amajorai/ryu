import { expect, test } from "@playwright/test";

for (const plan of ["Free", "Pro", "Business"]) {
	test(`${plan} has standard OpenRouter ZDR and Composio rollout off`, async ({
		page,
	}) => {
		const errors: string[] = [];

		page.on("pageerror", (error) => errors.push(error.message));

		await page.goto(`/composio-billing-proof.html?plan=${plan}`);

		await expect(
			page.getByText("OpenRouter zero data retention · On")
		).toBeVisible();

		await expect(
			page.getByText("Composio zero data retention · Off")
		).toBeVisible();

		await expect(
			page.getByText("Pending platform activation.", { exact: false })
		).toContainText("$0.60 per 1,000");

		await expect(page.getByRole("switch")).toHaveCount(0);

		await expect(page.getByText("Upgrade", { exact: false })).toHaveCount(0);

		expect(errors).toEqual([]);

		if (plan === "Free") {
			await page.screenshot({
				path: test.info().outputPath("standard-zdr-rollout-off.png"),
				fullPage: true,
			});
		}
	});
}

test("global Composio rollout adds the same surcharge and fits mobile", async ({
	page,
}) => {
	await page.goto("/composio-billing-proof.html?plan=Free&zdr=on");

	await expect(
		page.getByText("Composio zero data retention · On")
	).toBeVisible();

	await expect(
		page.getByText("Enabled globally.", { exact: false })
	).toContainText("$0.70 per 1,000");

	await expect(page.getByRole("switch")).toHaveCount(0);

	await page.setViewportSize({ width: 390, height: 1000 });

	await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);

	await page.screenshot({
		path: test.info().outputPath("standard-zdr-rollout-on-mobile.png"),
		fullPage: true,
	});
});
