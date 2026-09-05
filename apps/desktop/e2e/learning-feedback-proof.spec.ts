import { expect, test } from "@playwright/test";

const STORY_URL = "/learning-feedback-proof.html";

test("renders and toggles the Learning plugin feedback action", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);

	await expect(page.getByTestId("learning-feedback-proof")).toBeVisible();
	await expect(page.getByTestId("feedback-contract")).toContainText(
		"learning.recordFeedback"
	);
	const more = page.getByRole("button", { name: "More message actions" });
	await expect(more).toBeVisible();
	await expect(page.getByTestId("feedback-status")).toContainText(
		"No response rating selected"
	);

	await more.click();
	const good = page.getByRole("menuitem", { name: "Good response" });
	const bad = page.getByRole("menuitem", { name: "Bad response" });
	await expect(good).toBeVisible();
	await expect(bad).toBeVisible();
	await good.click();
	await expect(page.getByTestId("feedback-status")).toContainText(
		"Good response selected"
	);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("learning-feedback-proof.png"),
	});

	await more.click();
	await good.click();
	await expect(page.getByTestId("feedback-status")).toContainText(
		"No response rating selected"
	);

	await more.click();
	await bad.click();
	await expect(page.getByTestId("feedback-status")).toContainText(
		"Bad response selected"
	);
});
