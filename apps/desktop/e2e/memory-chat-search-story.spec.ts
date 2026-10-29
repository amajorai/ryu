import { expect, test } from "@playwright/test";
import { pluginDocumentSchema } from "../src/lib/api/plugin-wire-values.ts";

const STORY_URL = "/memory-chat-search-story.html";

test.beforeEach(async ({ page }) => {
	let chatMemoryEnabled = false;
	await page.route("**/api/preferences/chat-memory-enabled", async (route) => {
		if (route.request().method() === "GET") {
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					key: "chat-memory-enabled",
					value: String(chatMemoryEnabled),
				}),
			});
			return;
		}
		const body = pluginDocumentSchema.parse(route.request().postDataJSON());
		chatMemoryEnabled = body.value !== "false";
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ key: "chat-memory-enabled", ok: true }),
		});
	});
	await page.route("**/api/conversations/search**", async (route) => {
		const url = new URL(route.request().url());
		const query = url.searchParams.get("q");
		if (chatMemoryEnabled && query === "database migration") {
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					hits: [
						{
							content:
								"We chose a staged database migration so old clients can roll forward safely.",
							conversation_id: "conversation-architecture",
							created_at: 1_754_000_000_000,
							message_id: "message-architecture",
							role: "assistant",
							score: 0.91,
						},
					],
					indexed: true,
				}),
			});
			return;
		}
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ hits: [], indexed: true }),
		});
	});
});

test("searches embedded chats and opens the source conversation", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	await expect(page.getByText("Chat remembering is off").first()).toBeVisible();
	const toggle = page.getByRole("switch", { name: "Remember chats" });
	await expect(toggle).not.toBeChecked();

	await toggle.click();
	await expect(toggle).toBeChecked();
	await expect(page.getByText("Chat sources are remembered")).toBeVisible();
	await page.getByTestId("memory-open-dream").click();
	await expect(page.getByText("Opened memory view: dream")).toBeVisible();

	await page
		.getByRole("textbox", { name: "Search past chats" })
		.fill("database migration");
	await expect(page.getByTestId("memory-chat-result")).toContainText(
		"staged database migration"
	);
	await expect(page.getByTestId("memory-chat-result")).toContainText(
		"91% match"
	);

	await page.getByRole("button", { name: "Open Architecture chat" }).click();
	await expect(
		page.getByText("Opened conversation: conversation-architecture")
	).toBeVisible();

	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(page.getByText("Chat remembering is off").first()).toBeVisible();
});
