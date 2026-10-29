import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("app/plugin toast bridge renders, updates, and dismisses a Sileo toast", async ({
	page,
}, testInfo) => {
	await page.goto("/plugin-toast-story.html");
	await page.getByTestId("show-plugin-toast").click();
	await expect(page.getByText("Plugin connected")).toBeVisible();
	await expect(
		page.getByText("The host owns rendering and caller-scoped cleanup.")
	).toHaveText("The host owns rendering and caller-scoped cleanup.");

	await page.getByTestId("update-plugin-toast").click();
	await expect(page.getByText("Plugin finished")).toBeVisible();
	await expect(page.getByText("Plugin connected")).toHaveCount(0);
	await page.screenshot({
		path: test.info().outputPath("plugin-toast-proof.png"),
		fullPage: true,
	});

	await page.getByTestId("dismiss-plugin-toast").click();
	await expect(page.getByText("Plugin finished")).toHaveCount(0);
	await expect(page.getByText("No active caller id")).toBeVisible();
	void testInfo;
});
