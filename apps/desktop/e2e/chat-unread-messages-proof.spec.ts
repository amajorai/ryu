// Real-browser proof for the production MessageList unread affordance
// (`e2e/harness/chat-unread-messages-proof.{html,tsx}`).

import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-unread-messages-proof.html";

async function openStory(page: Page) {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("story-state")).toHaveAttribute(
		"data-message-count",
		"24",
		{ timeout: 60_000 }
	);
}

async function leaveLiveEdge(page: Page) {
	await page.getByTestId("leave-live-edge").click();
	await expect(
		page.getByRole("button", { name: "Scroll to latest" })
	).toBeVisible();
}

test("shows the unread count beside the bottom affordance and at the boundary", async ({
	page,
}) => {
	await openStory(page);
	await leaveLiveEdge(page);
	await page.getByTestId("receive-replies").click();

	const affordance = page.getByRole("button", {
		name: "Scroll to latest, 3 new messages",
	});
	await expect(affordance).toBeVisible();
	await expect(affordance).toContainText("3 new messages");

	const marker = page.locator('[data-slot="unread-message-marker"]');
	await expect(marker).toBeVisible();
	await expect(marker).toContainText("3 new messages");
	await expect(marker.locator('[data-slot="marker"]')).toHaveClass(
		/text-primary/
	);
});

test("keeps a streaming reply at one unread message while its text grows", async ({
	page,
}) => {
	await openStory(page);
	await leaveLiveEdge(page);
	await page.getByTestId("start-streaming-reply").click();

	const affordance = page.getByRole("button", {
		name: "Scroll to latest, 1 new message",
	});
	await expect(affordance).toBeVisible();
	await expect(
		page.getByRole("status", { name: "Agent is active" })
	).toBeVisible();

	await page.getByTestId("grow-streaming-reply").click();
	await expect(
		page.getByRole("button", { name: "Scroll to latest, 1 new message" })
	).toBeVisible();
	await expect(
		page.locator('[data-slot="unread-message-marker"]')
	).toContainText("1 new message");
});

test("clears when the reader reaches the unread boundary or latest message", async ({
	page,
}) => {
	await openStory(page);
	await leaveLiveEdge(page);
	await page.getByTestId("receive-replies").click();

	const marker = page.locator('[data-slot="unread-message-marker"]');
	await expect(marker).toBeVisible();
	await marker.scrollIntoViewIfNeeded();
	await expect(marker).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Scroll to latest" })
	).toBeVisible();

	await page.getByTestId("receive-replies").click();
	const affordance = page.getByRole("button", {
		name: "Scroll to latest, 3 new messages",
	});
	await expect(affordance).toBeVisible();
	await affordance.focus();
	await page.keyboard.press("Enter");
	// Choosing the live edge follows the newest reply: the count-carrying
	// affordance and the boundary marker both clear, and the transcript sits at
	// its end. Since the quiet transcript (3cf89b6e68) this story's 24 messages
	// already reach the bottom here, which is the case the click must settle
	// itself (it scrolls nothing, so the scroller reports no follow change).
	await expect(affordance).toHaveCount(0);
	await expect(page.getByRole("button", { name: /new message/ })).toHaveCount(
		0
	);
	await expect(page.locator('[data-slot="unread-message-marker"]')).toHaveCount(
		0
	);
	await expect
		.poll(() =>
			page
				.locator('[data-slot="message-scroller-viewport"]')
				.evaluate(
					(viewport) =>
						viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
				)
		)
		.toBeLessThanOrEqual(1);
});
