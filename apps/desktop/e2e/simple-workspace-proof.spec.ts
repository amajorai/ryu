import { expect, test } from "@playwright/test";

test("proves Simple workspace and branch-gated PR behavior", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto("/simple-workspace-proof.html");

	await expect(page.getByTestId("composer-footer")).toHaveText(
		"Simple mode · no project picker"
	);
	await expect(page.getByTestId("workspace-required-dialog")).toHaveCount(0);

	await page
		.getByRole("textbox", { name: "Chat message" })
		.fill("Fix the failing tests in this repo");
	await page.getByTestId("send-message").click();
	await expect(page.getByTestId("workspace-required-dialog")).toBeVisible();
	await page.getByTestId("choose-project").click();
	await expect(page.getByTestId("workspace-required-dialog")).toHaveCount(0);
	await expect(page.getByTestId("pinned-summary-folder")).toContainText(
		"ryu-closed"
	);
	await expect(page.getByTestId("files-changed")).toHaveText("3 files changed");
	await expect(page.getByTestId("create-pull-request")).toBeVisible();
	await expect(page.getByTestId("environment-summary")).not.toContainText("+");

	await page.getByTestId("toggle-branch").click();
	await expect(page.getByText("main", { exact: true })).toBeVisible();
	await expect(page.getByTestId("create-pull-request")).toHaveCount(0);
	await page.getByTestId("toggle-branch").click();
	await expect(page.getByTestId("create-pull-request")).toBeVisible();

	await page.screenshot({
		path: test.info().outputPath("simple-workspace-proof.png"),
		fullPage: true,
	});
});
