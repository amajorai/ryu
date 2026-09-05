import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const PROOF_SCREENSHOT =
	"/Users/jiawei/Documents/Code/ryu/apps/desktop/artifacts/message-bubbles-a-major-pass-proof.png";

test("proves grouped bubbles, compact actions, and pass access copy", async ({
	page,
}) => {
	await page.goto("/message-pass-proof.html");
	await expect(page.getByTestId("chat-proof")).toBeVisible();
	await expect(page.getByTestId("pricing-proof")).toContainText("A Major Pass");
	await expect(
		page.getByTestId("pricing-proof").locator('[aria-label="$20"]')
	).toBeVisible();
	await expect(page.getByTestId("pricing-proof")).toContainText("/mo");
	await expect(page.getByTestId("pricing-proof")).toContainText(
		"Get A Major Pass"
	);

	const userPositions = await page
		.locator(".group\\/user-message")
		.evaluateAll((nodes) =>
			nodes.map((node) =>
				node
					.closest('[data-slot="message-scroller-item"]')
					?.getAttribute("data-group-position")
			)
		);
	expect(userPositions).toEqual(["first", "middle", "last"]);

	const assistantPositions = await page
		.locator("[data-assistant-group-position]")
		.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-assistant-group-position"))
		);
	expect(assistantPositions).toEqual(["first", "middle", "last"]);

	const userBubbles = page.locator(
		'.group\\/user-message [data-testid="user-message-bubble"]'
	);
	await expect(userBubbles).toHaveCount(3);
	const userClasses = await userBubbles.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("class") ?? "")
	);
	expect(userClasses[0]).toContain("rounded-br-md");
	expect(userClasses[1]).toContain("rounded-r-md");
	expect(userClasses[2]).toContain("rounded-tr-md");

	const assistantBubbles = page.locator(
		'[data-assistant-group-position] [data-slot="bubble-content"]'
	);
	const assistantClasses = await assistantBubbles.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("class") ?? "")
	);
	expect(assistantClasses[0]).toContain("rounded-bl-md");
	expect(assistantClasses[1]).toContain("rounded-l-md");
	expect(assistantClasses[2]).toContain("rounded-tl-md");

	const assistantRows = page.locator("[data-assistant-group-position]");
	await expect(assistantRows).toHaveCount(3);
	await expect(page.locator('[data-slot="message-toolbar"]')).toHaveCount(6);
	for (let index = 0; index < 3; index += 1) {
		const row = assistantRows.nth(index).locator("..");
		const toolbar = row.locator('[data-slot="message-toolbar"]');
		await assistantRows.nth(index).hover();
		await expect(toolbar).toBeVisible();
		const geometry = await row.evaluate((node) => {
			const bubble = node.querySelector('[data-slot="bubble-content"]');
			const actions = node.querySelector('[data-slot="message-toolbar"]');
			if (!(bubble && actions)) {
				return null;
			}
			const bubbleRect = bubble.getBoundingClientRect();
			const actionRect = actions.getBoundingClientRect();
			return {
				actionCenterY: actionRect.top + actionRect.height / 2,
				actionLeft: actionRect.left,
				bubbleCenterY: bubbleRect.top + bubbleRect.height / 2,
				bubbleRight: bubbleRect.right,
			};
		});
		expect(geometry).not.toBeNull();
		if (geometry) {
			expect(geometry.actionLeft).toBeGreaterThanOrEqual(
				geometry.bubbleRight - 1
			);
			expect(
				Math.abs(geometry.actionCenterY - geometry.bubbleCenterY)
			).toBeLessThanOrEqual(2);
		}
	}

	await page.locator(".group\\/user-message").last().hover();
	const userToolbar = page.locator('[data-slot="message-toolbar"]').nth(2);
	await expect(
		userToolbar.getByRole("button", { name: "Add reaction" })
	).toBeVisible();
	await expect(
		userToolbar.getByRole("button", { name: "Reply to message" })
	).toBeVisible();
	await expect(
		userToolbar.getByRole("button", { name: "Copy message" })
	).toBeVisible();
	await expect(
		userToolbar.getByRole("button", { name: "More message actions" })
	).toBeVisible();

	await userToolbar
		.getByRole("button", { name: "More message actions" })
		.click();
	await expect(
		page.getByRole("menuitem", { name: "Edit message" })
	).toBeVisible();
	await expect(
		page.getByRole("menuitem", { name: "Fork chat from here" })
	).toBeVisible();
	await page.keyboard.press("Escape");

	const badge = page
		.getByTestId("eligible-listing")
		.locator('[data-slot="marketplace-access-trigger"]');
	await expect(badge).toBeVisible();
	await badge.click();
	await expect(
		page.locator('[data-slot="marketplace-access-popover"]')
	).toContainText("Get this with A Major Pass");
	// Keep the access disclosure open while hovering the assistant stack so the
	// proof frame shows both the ticket explanation and the compact toolbar.
	await page.locator('[data-assistant-group-position="last"]').hover();

	await page.screenshot({ fullPage: true, path: PROOF_SCREENSHOT });
});
