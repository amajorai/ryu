import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/tab-search-proof.html";

test("searches, activates, closes, hides, and restores the tab search control", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const trigger = page.getByRole("button", { name: "Search open tabs" });
	await expect(trigger).toBeVisible();
	await trigger.click();

	const search = page.getByPlaceholder("Search open tabs…");
	await expect(search).toBeVisible();
	await expect(page.getByRole("option")).toHaveCount(4);

	await search.fill("spaces/research");
	await expect(page.getByRole("option")).toHaveCount(1);
	await expect(page.locator('[data-tab-search-id="research"]')).toBeVisible();
	await page
		.getByRole("dialog")
		.getByText("Research notes", { exact: true })
		.click();
	await expect(page.getByTestId("active-tab")).toHaveText("Research notes");
	await expect(search).toHaveCount(0);

	await trigger.click();
	await expect(
		page.getByRole("button", {
			name: "Close Long-running customer research plan",
		})
	).toBeVisible();
	await page
		.getByRole("button", { name: "Close Long-running customer research plan" })
		.click();
	await expect(page.locator('[data-tab-search-id="long-running"]')).toHaveCount(
		0
	);
	// Closing a row keeps the search dialog open so another tab can be managed;
	// dismiss the dialog before exercising the trigger's context menu.
	await page.keyboard.press("Escape");
	await expect(search).toHaveCount(0);

	await trigger.click({ button: "right" });
	await expect(
		page.getByRole("menuitem", { name: "Hide tab search button" })
	).toBeVisible();
	await page.getByRole("menuitem", { name: "Hide tab search button" }).click();
	await expect(trigger).toHaveCount(0);

	await page.getByTestId("restore-tab-search").click();
	await page.getByRole("button", { name: "Search open tabs" }).click();
	await expect(page.getByRole("option")).toHaveCount(3);
	await expect(page.getByTestId("proof-status")).toHaveAttribute(
		"data-proof-status",
		"pass"
	);
});
