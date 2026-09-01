import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-search-story.html";

test("Ctrl+F opens chat search, cycles to files, and preserves the query", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("search-state")).toContainText("Press Ctrl+F");

	await page.keyboard.press("Control+f");
	const searchInput = page.getByTestId("chat-search-input");
	await expect(searchInput).toHaveAttribute(
		"aria-label",
		"Search chat messages"
	);
	await expect(searchInput).toBeFocused();

	await searchInput.fill("deployment");
	await expect(page.getByTestId("chat-search-status")).toHaveText("1 of 2");
	await expect(page.locator('[data-chat-search-active="true"]')).toHaveCount(1);

	await searchInput.press("Enter");
	await expect(page.getByTestId("chat-search-status")).toHaveText("2 of 2");

	await page.keyboard.press("Control+f");
	await expect(searchInput).toHaveAttribute(
		"aria-label",
		"Search project files"
	);
	await expect(searchInput).toHaveValue("deployment");
	await expect(page.getByTestId("file-search-panel")).toBeVisible();

	await searchInput.fill("README");
	await expect(page.getByTestId("file-search-panel")).toContainText(
		"README.md"
	);
	await expect(page.getByTestId("file-search-panel")).not.toContainText(
		"chat-search.ts"
	);

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("chat-search-files-mode-proof.png"),
	});

	await page.keyboard.press("Control+f");
	await expect(searchInput).toHaveAttribute(
		"aria-label",
		"Search chat messages"
	);
	await expect(page.getByTestId("chat-search-status")).toHaveText("1 of 2");
});
