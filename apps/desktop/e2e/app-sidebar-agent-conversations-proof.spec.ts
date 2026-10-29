import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/app-sidebar-agent-conversations-proof.html";

test("agent thread rows open the exact conversation from pointer and keyboard", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await page
		.getByRole("button", { name: "Show 2 threads for Builder" })
		.click();
	const branch = page.getByTestId("agent-thread-row-builder-branch");
	await branch.click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "builder-branch" }, path: "/chat" },
		])
	);

	await page.getByRole("button", { name: "Show 1 more", exact: true }).click();
	const main = page.getByTestId("agent-thread-row-builder-main");
	await main.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "builder-branch" }, path: "/chat" },
			{ options: { conversationId: "builder-main" }, path: "/chat" },
		])
	);

	await branch.hover();
	await page
		.getByRole("button", { name: "More actions for Design review (branch)" })
		.click();
	await page
		.getByRole("menuitem", { name: "Quick reply", exact: true })
		.click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "builder-branch" }, path: "/chat" },
			{ options: { conversationId: "builder-main" }, path: "/chat" },
			{
				options: { conversationId: "builder-branch" },
				path: "/chat/quick-reply",
			},
		])
	);

	await branch.hover();
	await page
		.getByRole("button", { name: "More actions for Design review (branch)" })
		.click();
	await page
		.getByRole("menuitem", { name: "Mark as unread", exact: true })
		.click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "builder-branch" }, path: "/chat" },
			{ options: { conversationId: "builder-main" }, path: "/chat" },
			{
				options: { conversationId: "builder-branch" },
				path: "/chat/quick-reply",
			},
		])
	);
	await branch.hover();
	await page
		.getByRole("button", { name: "More actions for Design review (branch)" })
		.click();
	const markAsReadAction = page.getByRole("menuitem", {
		name: "Mark as read",
		exact: true,
	});
	await expect(markAsReadAction).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-agent-thread-mark-unread-menu-no-navigation.png"
		),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("menu")
		.last()
		.screenshot({
			path: path.resolve(
				import.meta.dirname,
				"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-agent-thread-unread-menu.png"
			),
			animations: "disabled",
		});
	await markAsReadAction.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-agent-thread-mark-as-read-action.png"
		),
		animations: "disabled",
	});
	await markAsReadAction.click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "builder-branch" }, path: "/chat" },
			{ options: { conversationId: "builder-main" }, path: "/chat" },
			{
				options: { conversationId: "builder-branch" },
				path: "/chat/quick-reply",
			},
		])
	);

	await branch.click({ button: "right", force: true });
	await page
		.getByRole("menuitem", { name: "Quick reply", exact: true })
		.click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "builder-branch" }, path: "/chat" },
			{ options: { conversationId: "builder-main" }, path: "/chat" },
			{
				options: { conversationId: "builder-branch" },
				path: "/chat/quick-reply",
			},
			{
				options: { conversationId: "builder-branch" },
				path: "/chat/quick-reply",
			},
		])
	);
	await branch.click({ button: "right", force: true });
	await page
		.getByRole("menuitem", { name: "Mark as unread", exact: true })
		.click();
	await branch.click({ button: "right", force: true });
	await expect(
		page.getByRole("menuitem", { name: "Mark as read", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Mark as read", exact: true })
		.click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "builder-branch" }, path: "/chat" },
			{ options: { conversationId: "builder-main" }, path: "/chat" },
			{
				options: { conversationId: "builder-branch" },
				path: "/chat/quick-reply",
			},
			{
				options: { conversationId: "builder-branch" },
				path: "/chat/quick-reply",
			},
		])
	);
});

test("group chat rows select the latest thread and keep disclosure isolated", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	const groupRow = page
		.locator('div[role="button"]')
		.filter({ hasText: "Group chat" });
	const disclosure = page.getByRole("button", {
		name: "Expand group chat threads",
		exact: true,
	});
	await disclosure.click();
	await expect(
		page.getByRole("button", {
			name: "Collapse group chat threads",
			exact: true,
		})
	).toHaveAttribute("aria-expanded", "true");
	await expect(
		page.getByText("Launch plan (branch)", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("route-events")).toHaveText("[]");

	await page.getByText("Launch plan (branch)", { exact: true }).click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "group-branch" }, path: "/chat" },
		])
	);

	await groupRow.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { conversationId: "group-branch" }, path: "/chat" },
			{ options: { conversationId: "group-branch" }, path: "/chat" },
		])
	);

	await page.reload();
	const collapsedDisclosure = page.getByRole("button", {
		name: "Expand group chat threads",
		exact: true,
	});
	await collapsedDisclosure.click();
	await page
		.getByRole("button", { name: "Collapse group chat threads", exact: true })
		.click();
	await expect(
		page.getByText("Launch plan (branch)", { exact: true })
	).toHaveCount(0);
	await expect(page.getByTestId("route-events")).toHaveText("[]");
	await page.screenshot({
		path: testInfo.outputPath("group-chat-collapsed-product.png"),
		fullPage: true,
		animations: "disabled",
	});
});

test("messaging agent preview controls toggle threads and route edit without opening chat", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	const row = page.getByTestId("messaging-agent-row");
	await expect(row).toContainText("The branch has the revised layout.");
	const expandThreads = page.getByRole("button", {
		name: "Show 2 threads for Builder",
		exact: true,
	});
	await expandThreads.click();
	await expect(
		page.getByRole("button", {
			name: "Hide 2 threads for Builder",
			exact: true,
		})
	).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByTestId("agent-thread-list")).toBeVisible();
	await expect(page.getByTestId("route-events")).toHaveText("[]");
	await expect(
		page.getByRole("button", {
			name: "Hide 2 threads for Builder",
			exact: true,
		})
	).toBeVisible();

	await page.getByRole("button", { name: "Edit Builder", exact: true }).click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { title: "Builder" }, path: "/agents/builder/edit" },
		])
	);

	await page.getByText("Builder", { exact: true }).click();
	await expect(page.getByTestId("route-events")).toHaveText(
		JSON.stringify([
			{ options: { title: "Builder" }, path: "/agents/builder/edit" },
			{ options: { title: "Builder" }, path: "/chat/agent/builder" },
		])
	);
	await page.screenshot({
		path: testInfo.outputPath("messaging-agent-expanded-product.png"),
		fullPage: true,
		animations: "disabled",
	});
});
