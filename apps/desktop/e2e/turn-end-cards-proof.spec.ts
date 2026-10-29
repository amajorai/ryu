import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/turn-end-cards-proof-story.html";

test("renders edited files and agent result cards at the end of a turn", async ({
	page,
}) => {
	await page.goto(STORY_URL);

	const fileCard = page.locator(
		'[data-slot="turn-file-edits-card"][data-layout="multiple"]'
	);
	await expect(fileCard).toBeVisible();
	await expect(
		fileCard.getByRole("heading", { name: "Edited 4 files" })
	).toBeVisible();
	await expect(fileCard).toContainText("+8");
	await expect(fileCard).toContainText("-3");
	await expect(fileCard).toContainText("apps/desktop/src/pages/ChatPage.tsx");
	await expect(fileCard).toContainText("docs/release-notes.md");
	await expect(fileCard).toContainText(
		"packages/blocks/src/desktop/agent-elements/message-list.tsx"
	);
	await expect(fileCard).toContainText("Show 1 more file");
	await expect(fileCard.getByRole("button", { name: "Review" })).toBeVisible();
	await expect(fileCard.getByRole("button", { name: /Undo/ })).toBeVisible();

	await expect(page.locator('[data-slot="turn-json-render-card"]')).toHaveCount(
		2
	);
	await expect(page.getByText("JSON mention card")).toBeVisible();
	await expect(
		page.getByRole("heading", { exact: true, name: "A2UI end-of-turn card" })
	).toHaveCount(2);
	await expect(
		page.getByText("Preserved through turn-end persistence")
	).toBeVisible();
	await page.getByRole("button", { name: "Confirm A2UI" }).click();
	await expect(page.getByTestId("action-state")).toHaveText(
		"JSON UI submitted"
	);
	const publicLink = page.getByRole("link", { name: /Public release guide/ });
	await expect(publicLink).toBeVisible();
	await expect(publicLink).toHaveAttribute(
		"href",
		"https://example.com/release-guide"
	);
	await expect(page.locator('[data-slot="turn-artifact-card"]')).toBeVisible();
	await expect(page.getByText("release-checklist.md")).toBeVisible();
	await expect(page.getByRole("button", { name: "Open in tab" })).toBeVisible();
});

test("renders the compact single-file card and confirms undo", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const fileCard = page.locator(
		'[data-slot="turn-file-edits-card"][data-layout="single"]'
	);
	await expect(fileCard).toBeVisible();
	await expect(
		fileCard.getByRole("heading", { name: "Edited .env" })
	).toBeVisible();
	await expect(fileCard).toContainText("+1");
	await expect(fileCard).toContainText("-0");

	await fileCard.getByRole("button", { name: "Review" }).click();
	await expect(page.getByTestId("action-state")).toHaveText(
		"Reviewing Last turn"
	);

	await fileCard.getByRole("button", { name: /Undo/ }).click();
	const dialog = page.getByRole("alertdialog");
	await expect(
		dialog.getByRole("heading", { name: "Undo changes to .env?" })
	).toBeVisible();
	await expect(dialog).toContainText(
		"affected text changed afterward or is staged"
	);
	await dialog.getByRole("button", { name: "Undo changes" }).click();
	await expect(page.getByTestId("action-state")).toHaveText("Undid .env");
	const undoneButton = fileCard.locator("button").filter({ hasText: "Undone" });
	await expect(undoneButton).toBeDisabled();
});

test("expands the full file list and keeps file actions wired", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const fileCard = page.locator(
		'[data-slot="turn-file-edits-card"][data-layout="multiple"]'
	);

	await fileCard.getByRole("button", { name: "Show 1 more file" }).click();
	await expect(fileCard).toContainText("apps/core/src/sidecar/mcp/README.md");
	await expect(
		fileCard.getByRole("button", { name: "Show fewer files" })
	).toBeVisible();

	await fileCard.getByRole("button", { name: /ChatPage\.tsx/ }).click();
	await expect(page.getByTestId("action-state")).toHaveText(
		"Opened apps/desktop/src/pages/ChatPage.tsx"
	);

	// The turn-end card opens under the inline row's id (`artifact-<toolCallId>`),
	// so it shares that row's saved page state and panel/tab.
	await page.getByRole("button", { name: "Open in tab" }).click();
	await expect(page.getByTestId("action-state")).toHaveText(
		"Opened artifact artifact-turn-end-proof-7 in tab"
	);
});

test("captures the completed product proof", async ({ page }) => {
	await page.goto(STORY_URL);
	await expect(
		page.locator('[data-slot="turn-end-cards"]').first()
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: "test-results/turn-end-cards-proof.png",
	});
});
