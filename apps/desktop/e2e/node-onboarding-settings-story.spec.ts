import { expect, test } from "@playwright/test";

const STORY_URL = "/node-onboarding-settings-story.html";

test("shows the node reset control in Gateway settings", async ({ page }) => {
	await page.setViewportSize({ height: 760, width: 1280 });
	await page.goto(STORY_URL);
	await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
	await expect(
		page.getByText("Node setup · Team or company", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Reset onboarding" })
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: "e2e/artifacts/node-onboarding-settings-proof.png",
	});
});
