import { expect, type Page, test } from "@playwright/test";

const row = (page: Page, id: string) =>
	page.getByTestId(`sidebar-chat-row-chat-${id}`);

test.beforeEach(async ({ page }) => {
	await page.goto("/chat-row-selection-story.html");
	await expect(row(page, "e")).toBeVisible();
});

test("shift-click selects a range from the last clicked chat", async ({
	page,
}) => {
	await row(page, "b").click();
	await expect(page.getByTestId("opened")).toHaveText("chat-b");

	await row(page, "d").click({ modifiers: ["Shift"] });
	await expect(page.getByTestId("selected")).toHaveText("chat-b,chat-c,chat-d");
	// A selection gesture never opens the chat.
	await expect(page.getByTestId("opened")).toHaveText("chat-b");
	await expect(row(page, "c")).toHaveAttribute("data-selected", "true");

	// Re-ranging keeps the anchor.
	await row(page, "a").click({ modifiers: ["Shift"] });
	await expect(page.getByTestId("selected")).toHaveText("chat-a,chat-b");

	// A plain click clears the selection and opens the chat.
	await row(page, "e").click();
	await expect(page.getByTestId("selected")).toHaveText("");
	await expect(page.getByTestId("opened")).toHaveText("chat-b,chat-e");
});

test("ctrl/cmd-click toggles chats and includes the open chat", async ({
	page,
}) => {
	await row(page, "a").click();
	await row(page, "c").click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByTestId("selected")).toHaveText("chat-a,chat-c");
	await row(page, "a").click({ modifiers: ["ControlOrMeta"] });
	await expect(page.getByTestId("selected")).toHaveText("chat-c");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("selected")).toHaveText("");
});

test("shift+arrow keys extend the selection from the focused chat", async ({
	page,
}) => {
	await row(page, "b").focus();
	await page.keyboard.press("Shift+ArrowDown");
	await page.keyboard.press("Shift+ArrowDown");
	await expect(page.getByTestId("selected")).toHaveText("chat-b,chat-c,chat-d");
	await expect(row(page, "d")).toBeFocused();
	await page.keyboard.press("Shift+ArrowUp");
	await expect(page.getByTestId("selected")).toHaveText("chat-b,chat-c");
	// Plain arrows only move focus.
	await page.keyboard.press("ArrowDown");
	await expect(row(page, "d")).toBeFocused();
	await expect(page.getByTestId("selected")).toHaveText("chat-b,chat-c");
});

test("right-click on a selection offers bulk actions", async ({ page }) => {
	await row(page, "a").click();
	await row(page, "c").click({ modifiers: ["Shift"] });
	await row(page, "b").click({ button: "right" });
	await expect(page.getByText("3 chats selected")).toBeVisible();
	await page.getByRole("menuitem", { name: "Pin 3 chats" }).click();
	await expect(page.getByTestId("bulk-log")).toHaveText(
		"pin:true:chat-a,chat-b,chat-c"
	);
	await expect(page.getByTestId("selected")).toHaveText("");
});
