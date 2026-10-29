import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/fork-dialog-proof.html";

test("offers both fork destinations and records each selection", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByTestId("open-fork-dialog").click();

	await expect(
		page.getByRole("heading", { name: "Fork chat from here" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Fork in this workspace/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Fork in a new worktree/ })
	).toBeVisible();

	await page.getByRole("button", { name: /Fork in this workspace/ }).click();
	await expect(page.getByTestId("selection")).toHaveText("Selected: workspace");

	await page.getByTestId("open-fork-dialog").click();
	await page.getByRole("button", { name: /Fork in a new worktree/ }).click();
	await expect(page.getByTestId("selection")).toHaveText("Selected: worktree");

	await page.getByTestId("open-fork-dialog").click();
	await expect(
		page.getByRole("heading", { name: "Fork chat from here" })
	).toBeVisible();
	await page.waitForTimeout(400);
	await page.screenshot({
		path: test.info().outputPath("fork-dialog-proof.png"),
	});
});
