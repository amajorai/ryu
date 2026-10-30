import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/agent-conversation-branch-proof.html";

test("shows inline bot threads, fallback group chats, and agent-to-agent transcript bubbles", async ({
	page,
}, testInfo) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(STORY_URL);
	await expect(page.getByTestId("agent-sidebar-proof")).toBeVisible();
	await expect(
		page.getByText("Direct agent threads inline", { exact: false })
	).toBeVisible();
	await expect(page.getByText("Sessions", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Workspace transcript")).toBeVisible();
	await expect(page.getByTestId("agent-message-reply")).toBeVisible();

	// Agent rows are one line; the thread toggle shows on row hover (306ce31b7).
	await page
		.getByTestId("agent-sidebar-proof")
		.getByText("Builder", { exact: true })
		.first()
		.hover();
	await page
		.getByRole("button", { name: "Show 2 threads for Builder" })
		.click();
	await expect(page.getByTestId("agent-thread-list")).toBeVisible();
	await expect(page.getByText("Design review (branch)")).toBeVisible();
	const sessionRow = page.getByTestId("agent-thread-row-builder-branch");
	await sessionRow.click({ modifiers: ["Alt"], force: true });
	await expect(page.getByTestId("opened-thread")).toHaveText(
		"Quick reply builder-branch"
	);
	const sessionBounds = await sessionRow.boundingBox();
	if (!sessionBounds) {
		throw new Error("Agent session row did not expose layout bounds");
	}
	await page.keyboard.down("Shift");
	await page.mouse.move(
		sessionBounds.x + sessionBounds.width / 2,
		sessionBounds.y + sessionBounds.height / 2
	);
	await page.mouse.down();
	await page.waitForTimeout(500);
	const sessionPreview = page.getByTestId("quick-preview");
	await expect(sessionPreview).toBeVisible();
	await expect(sessionPreview).toContainText("The branch keeps the main chat");
	await expect(page.getByTestId("opened-thread")).toHaveText(
		"Quick reply builder-branch"
	);
	await page.mouse.up();
	await page.keyboard.up("Shift");
	await sessionPreview.getByRole("button", { name: "Mark as unread" }).click();
	await expect(
		sessionPreview.getByRole("button", { name: "Mark as read" })
	).toBeVisible();
	await sessionPreview.getByRole("button", { name: "Mark as read" }).click();
	await page.getByRole("button", { name: "Close" }).click();
	await expect(sessionPreview).not.toBeVisible();
	await sessionRow.hover();
	await expect(
		page.getByRole("button", {
			name: "More actions for Design review (branch)",
		})
	).toBeVisible();
	await page
		.getByRole("button", {
			name: "More actions for Design review (branch)",
		})
		.click();
	await expect(
		page.getByRole("menuitem", { name: "Quick reply", exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await sessionRow.click({ button: "right", force: true });
	await expect(
		page.getByRole("menuitem", { name: "Quick reply", exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Mark as unread", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Quick reply", exact: true })
		.click();
	await sessionRow.click({ button: "right", force: true });
	await page
		.getByRole("menuitem", { name: "Mark as unread", exact: true })
		.click();
	await sessionRow.click({ button: "right", force: true });
	await expect(
		page.getByRole("menuitem", { name: "Mark as read", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Mark as read", exact: true })
		.click();
	await page.getByRole("button", { name: "Show 1 more" }).first().click();
	await expect(page.getByText("Design review", { exact: true })).toBeVisible();

	await page
		.getByRole("button", { name: "Expand group chat threads", exact: true })
		.click();
	await expect(page.getByText("Group chat", { exact: true })).toBeVisible();
	await expect(page.getByText("Launch plan (branch)")).toBeVisible();

	expect(errors).toEqual([]);
	await expect(page.getByText("Archived design", { exact: true })).toHaveCount(
		0
	);
	await page.screenshot({
		path: testInfo.outputPath("agent-threads-product.png"),
		fullPage: true,
	});
});
