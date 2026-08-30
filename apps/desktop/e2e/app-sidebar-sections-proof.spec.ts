// Browser proof for the app-owned record pickers that now use the desktop
// sidebar contribution primitive instead of shipping their own primary rail.

import { expect, test } from "@playwright/test";

const STORY_URL = "/app-sidebar-sections-proof.html";

test.describe("app-owned sidebar sections", () => {
	test("renders all migrated record pickers through the shared section", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		for (const title of [
			"Plans",
			"Monitors",
			"Policies",
			"Contexts",
			"Campaigns",
			"Inboxes",
			"Workflows",
		]) {
			await expect(page.getByText(title, { exact: true })).toBeVisible();
		}
		for (const item of [
			"Launch plan",
			"Production API",
			"Release policy",
			"Q3 contracts",
			"Search campaign",
			"Support",
			"Release workflow",
		]) {
			await expect(page.getByText(item, { exact: true })).toBeVisible();
		}
	});

	test("opens a migrated row through its declarative item target", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.getByRole("button", { name: /Release workflow/ }).click();
		await expect(page.locator("#opened")).toHaveText("/workflows/workflow-1");
	});

	test("passes a record id through the migrated research target context", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.getByRole("button", { name: /Search campaign/ }).click();
		await expect(page.locator("#opened")).toHaveText(
			"/plugin/app__research-companion"
		);
		await expect(page.locator("#opened-context")).toHaveText(
			'{"campaignId":"campaign-1"}'
		);
	});
});
