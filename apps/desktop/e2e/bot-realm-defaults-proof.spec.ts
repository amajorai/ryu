import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 120_000 });

test("lets a Console admin choose the managed Bot realm default", async ({
	page,
}, testInfo) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});

	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto("/bot-realm-defaults-proof.html");

	const card = page.getByTestId("bot-realm-default-card");
	await expect(card).toBeVisible();
	await expect(
		card.getByText("Bot realm default", { exact: true })
	).toBeVisible();
	await expect(
		card.getByRole("button", { name: "Default cloud agent or model" })
	).toContainText("Ryu");
	// The caption names Organization owners since ec6fac15e2 (pre-#914 copy).
	await expect(
		card.getByText(
			/Organization owners and admins can choose the provider and model/
		)
	).toBeVisible();
	await expect(page.locator("body")).not.toHaveAttribute(
		"data-cloud-default-write"
	);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("bot-realm-auto-cloud-default.png"),
	});

	await card
		.getByRole("button", { name: "Default cloud agent or model" })
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByText("Auto cloud", { exact: true })).toBeVisible();
	await page.getByText("Auto cloud", { exact: true }).click();
	await page.getByText("Model", { exact: true }).click();
	await expect(
		page.getByText("anthropic/claude-sonnet-4", { exact: true })
	).toBeVisible();
	await page.getByText("anthropic/claude-sonnet-4", { exact: true }).click();

	await expect(page.getByTestId("selected-bot-default")).toContainText(
		"managed-openrouter · anthropic/claude-sonnet-4"
	);
	await expect(page.locator("body")).toHaveAttribute(
		"data-cloud-default-write",
		"true"
	);
	await expect(
		card.getByRole("button", { name: "Default cloud agent or model" })
	).toContainText("anthropic/claude-sonnet-4");

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("bot-realm-defaults-proof.png"),
	});
	await expect(
		browserErrors,
		`browser errors: ${browserErrors.join(" | ")}`
	).toEqual([]);
});
