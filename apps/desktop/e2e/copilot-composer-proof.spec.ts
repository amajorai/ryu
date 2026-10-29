import { expect, test } from "@playwright/test";

test("in-page Copilot uses the shared composer styles in its shadow root", async ({
	page,
}, testInfo) => {
	test.setTimeout(180_000);
	await page.goto("/copilot-composer-story.html");
	const panel = page.locator("#copilot-host").locator(".panel");
	const composer = page.getByPlaceholder("Ask Ryu about this page…");

	await expect(panel).toBeVisible();
	const primaryToken = await panel.evaluate((element) =>
		getComputedStyle(element).getPropertyValue("--primary").trim()
	);
	expect(primaryToken).toBe("#0099ff");
	await expect(
		page.locator("#copilot-host").locator('[data-composer-layout="compact"]')
	).toBeVisible();
	await expect(page.locator("body")).toHaveCSS(
		"background-color",
		"rgb(243, 244, 246)"
	);

	await composer.fill("Summarize this page");
	const sendButton = page.getByRole("button", { name: "Send" });
	await expect(sendButton).toBeEnabled();
	await expect(sendButton).toHaveCSS("background-color", "rgb(0, 153, 255)");
	const proofPath = process.env.RYU_COPILOT_COMPOSER_PROOF_PATH;
	await page.screenshot({
		fullPage: true,
		path: proofPath ?? testInfo.outputPath("copilot-composer-proof.png"),
	});
	await composer.press("Enter");
	await expect(page.getByTestId("sent-message")).toHaveText(
		"Summarize this page"
	);
});
