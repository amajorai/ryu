import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-activation-proof.html";

test.describe("onboarding activation proof", () => {
	test("keeps the first task behind checkout and rewards new connections", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page.getByRole("radio", { name: "Search" }).click();
		await page.getByRole("button", { exact: true, name: "Continue" }).click();
		await expect(page.getByText("Recommended for you")).toBeVisible();
		await page
			.getByRole("button", { name: /Connect · \+\$0\.50/ })
			.first()
			.click();
		await page
			.getByTestId("connection-permission-dialog")
			.getByRole("button", { name: "Continue to connect" })
			.click();
		await expect(page.getByText("2/20 · $1.00")).toBeVisible();
		await page.getByRole("button", { exact: true, name: "Continue" }).click();
		await page.getByRole("button", { name: "See your first task" }).click();
		await page
			.getByRole("button", { name: /Start first month for \$50/ })
			.click();
		await expect(page.getByText("I finished checkout")).toBeVisible();
		await expect(page.getByTestId("task-started")).toHaveCount(0);
		await page.getByRole("button", { name: "I finished checkout" }).click();
		await expect(
			page.getByText("Ryu is ready to start your first task")
		).toBeVisible();
		await page.getByRole("button", { name: "Start task" }).click();
		await expect(page.getByTestId("task-started")).toBeVisible();
	});

	test("skips checkout for an existing subscriber", async ({ page }) => {
		await page.goto(`${STORY_URL}?paid=true&notion=true`);
		await expect(page.getByText("Your subscription is ready")).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Start first month/ })
		).toHaveCount(0);
		await page.getByRole("button", { name: "Continue to task" }).click();
		await page.getByRole("button", { name: "Start task" }).click();
		await expect(page.getByTestId("task-started")).toBeVisible();
	});

	test("keeps a shared non-owner on the safe owner path", async ({ page }) => {
		await page.goto(`${STORY_URL}?role=member`);
		await expect(
			page.getByText("Ask the node owner to continue")
		).toBeVisible();
		await expect(page.getByTestId("task-started")).toHaveCount(0);
	});

	test("renders the completed task product proof", async ({ page }) => {
		await page.goto(`${STORY_URL}?paid=true&notion=true`);
		await page.getByRole("button", { name: "Continue to task" }).click();
		await page.getByRole("button", { name: "Start task" }).click();
		await expect(page.getByTestId("task-started")).toBeVisible();
		await expect(page.getByText("Ryu started your first task")).toBeVisible();
		await page.screenshot({
			path: "apps/desktop/e2e/artifacts/onboarding-activation-proof.png",
			fullPage: true,
		});
	});
});
