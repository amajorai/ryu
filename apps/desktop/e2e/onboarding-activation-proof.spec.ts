import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-activation-proof.html";

test("previews a selected task, connects only that app, and requires checkout before managed execution", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?organization=true`);
	await expect(
		page.getByRole("heading", { name: "What would you like Ryu to do?" })
	).toBeVisible();
	await expect(page.getByTestId("task-started")).toHaveCount(0);
	await page
		.getByRole("button", { name: "Preview task", exact: true })
		.first()
		.click();
	await expect(
		page.getByText("Find the next task in Notion", { exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Connect Notion for this task" })
		.click();
	await page
		.getByTestId("connection-permission-dialog")
		.getByRole("button", { name: "Continue to connect" })
		.click();
	await page.getByRole("button", { name: "See managed pricing" }).click();
	await expect(page.getByTestId("task-started")).toHaveCount(0);
	// Subscription terms must still be acknowledged before checkout opens.
	await page.getByRole("checkbox").check();
	await page.getByRole("button", { name: "Start first month for $50" }).click();
	await expect(page.getByTestId("task-started")).toHaveCount(0);
	await page.getByRole("button", { name: "I finished checkout" }).click();
	await expect(
		page.getByText("Find the next task in Notion", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Start managed task" }).click();
	await expect(page.getByTestId("task-started")).toBeVisible();
});

test("shows personal pricing only after a task is chosen", async ({ page }) => {
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Preview a starting task" }).click();
	await expect(
		page.getByText("Turn recent email into a follow-up list", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Start Pro for $49/month" })
	).toHaveCount(0);
	await page.getByRole("button", { name: "See managed pricing" }).click();
	await expect(
		page.getByRole("button", { name: "Start Pro for $49/month" })
	).toBeVisible();
});

test("uses an existing subscription without another checkout", async ({
	page,
}) => {
	await page.goto(`${STORY_URL}?paid=true&notion=true`);
	await page
		.getByRole("button", { name: "Preview task", exact: true })
		.first()
		.click();
	await page.getByRole("button", { name: "Start managed task" }).click();
	await expect(page.getByTestId("task-started")).toBeVisible();
});

test("own-model path does not start managed execution", async ({ page }) => {
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "Preview a starting task" }).click();
	await page.getByRole("button", { name: "Choose my own model" }).click();
	await expect(page.getByTestId("own-model-chat")).toBeVisible();
	await expect(page.getByTestId("task-started")).toHaveCount(0);
});

test("connection cancellation keeps the task preview without starting work", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page
		.getByRole("button", { name: "Preview task", exact: true })
		.first()
		.click();
	await page
		.getByRole("button", { name: "Connect Notion for this task" })
		.click();
	await page
		.getByTestId("connection-permission-dialog")
		.getByRole("button", { name: "Cancel" })
		.click();
	await expect(
		page.getByRole("button", { name: "Connect Notion for this task" })
	).toBeVisible();
	await expect(page.getByTestId("task-started")).toHaveCount(0);
});

test("shared non-owner cannot start the activation task", async ({ page }) => {
	await page.goto(`${STORY_URL}?role=member`);
	await expect(page.getByText("Ask the node owner to continue")).toBeVisible();
	await expect(page.getByTestId("task-started")).toHaveCount(0);
});
