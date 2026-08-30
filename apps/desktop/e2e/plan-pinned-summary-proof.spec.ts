import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/plan-pinned-summary-proof.html";

test("lists saved ACP and Pi plans and opens the selected artifact", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(STORY_URL);

	await expect(page.getByText("Pinned summary · Plans proof")).toBeVisible();
	await expect(page.getByText("2 saved plans")).toBeVisible();

	const plansTrigger = page.getByRole("button", { name: /Plans/ });
	await expect(plansTrigger).toBeVisible();
	await plansTrigger.click();

	const planRows = page.getByTestId("pinned-summary-plan");
	await expect(planRows).toHaveCount(2);
	await expect(page.getByText("ACP / Pi to-dos")).toBeVisible();
	await expect(page.getByText("Written plan")).toBeVisible();
	await expect(page.getByText("Saved to Artifacts").first()).toBeVisible();
	await expect(
		page.locator(
			'[data-testid="pinned-summary-proof"] [data-slot="bouncy-accordion-item-icon"]'
		)
	).toHaveCount(0);
	await expect(
		page.locator(
			'[data-testid="pinned-summary-proof"] [data-slot="cowork-section-count"]'
		)
	).toHaveCount(2);

	await planRows.nth(1).click();
	await expect(page.getByTestId("plan-artifact-empty")).not.toBeVisible();
	await expect(page.getByTestId("plan-artifact-viewer")).toContainText(
		"Persist plans to Artifacts"
	);
	await expect(page.getByTestId("plan-artifact-viewer")).toContainText(
		"Save every ACP and Pi plan snapshot"
	);
});
