import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/git-graph-proof.html";

test("renders the connected side-chat rail and filters the real Git graph", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("side-chat-rail")).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: /Open side chat: Why does this branch split here/,
		})
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Merge workspace changes/ })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Shape the branch rail/ })
	).toBeVisible();

	await page.getByRole("button", { exact: true, name: "feature/ui" }).click();
	await expect(
		page.getByRole("button", { name: /Merge workspace changes/ })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: /Shape the branch rail/ })
	).toBeVisible();

	await page
		.getByRole("button", {
			name: /Open side chat: Why does this branch split here/,
		})
		.click();
	await expect(
		page.getByText("Opened: Why does this branch split here?")
	).toBeVisible();
});

test("selects a commit, exposes details, and links to project changes", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: /Merge workspace changes/ }).click();
	await expect(page.getByText("Commit details")).toBeVisible();
	await expect(page.getByText("merge123").last()).toBeVisible();

	await page.getByRole("button", { name: "Open project changes" }).click();
	await expect(page.getByTestId("opened-tab")).toHaveText(
		"/project/diff/%2FUsers%2Fjiawei%2FDocuments%2FCode%2Fryu-closed"
	);

	await page.screenshot({
		path: test.info().outputPath("git-graph-proof.png"),
		fullPage: true,
	});
});
