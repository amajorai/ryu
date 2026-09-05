import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/agent-conversation-branch-proof.html";
const PROOF_SCREENSHOT =
	"/Users/jiawei/.codex/visualizations/2026/08/18/01a01378-f19e-7200-b6e0-d7997d5e209b/agent-conversation-branch-proof.png";

test("shows inline bot threads, fallback group chats, and agent-to-agent transcript bubbles", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("agent-sidebar-proof")).toBeVisible();
	await expect(
		page.getByText("Direct agent threads inline", { exact: false })
	).toBeVisible();
	await expect(page.getByText("Sessions", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Workspace transcript")).toBeVisible();
	await expect(page.getByTestId("agent-message-reply")).toBeVisible();

	await page
		.getByRole("button", { name: "Show 2 threads for Builder" })
		.click();
	await expect(page.getByTestId("agent-thread-list")).toBeVisible();
	await expect(page.getByText("Design review (branch)")).toBeVisible();
	await page.getByRole("button", { name: "Show 1 more" }).first().click();
	await expect(page.getByText("Design review", { exact: true })).toBeVisible();

	await page
		.getByRole("button", { name: "Expand group chat threads", exact: true })
		.click();
	await expect(page.getByText("Group chat", { exact: true })).toBeVisible();
	await expect(page.getByText("Launch plan (branch)")).toBeVisible();

	await page.screenshot({ path: PROOF_SCREENSHOT, fullPage: true });
});
