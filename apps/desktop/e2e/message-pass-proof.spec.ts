import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

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

	// The quiet transcript (3cf89b6e6): a run reads as one by its
	// spacing, not by tail corners. Every user bubble is the same muted
	// rounded-3xl pill, and the assistant reply is plain prose with no bubble.
	const userBubbles = page.locator(
		'.group\\/user-message [data-testid="user-message-bubble"]'
	);
	await expect(userBubbles).toHaveCount(3);
	const userClasses = await userBubbles.evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute("class") ?? "")
	);
	for (const classes of userClasses) {
		expect(classes).toContain("rounded-3xl");
		expect(classes).not.toMatch(/rounded-(?:br|r|tr)-md/);
	}

	const assistantProse = await page
		.locator("[data-assistant-group-position]")
		.evaluateAll((nodes) =>
			nodes.map((node) => {
				const bubble = node.querySelector('[data-slot="bubble"]');
				const content = node.querySelector('[data-slot="bubble-content"]');
				const style = content ? getComputedStyle(content) : null;
				return {
					background: style?.backgroundColor ?? null,
					radius: style?.borderTopLeftRadius ?? null,
					variant: bubble?.getAttribute("data-variant") ?? null,
				};
			})
		);
	expect(assistantProse).toEqual(
		Array.from({ length: 3 }, () => ({
			background: "rgba(0, 0, 0, 0)",
			radius: "0px",
			variant: "ghost",
		}))
	);

	const assistantRows = page.locator("[data-assistant-group-position]");
	await expect(assistantRows).toHaveCount(3);
	await expect(page.locator('[data-slot="message-toolbar"]')).toHaveCount(6);
	for (let index = 0; index < 3; index += 1) {
		// The reply's action row sits under its prose, starting at its left edge.
		const turn = assistantRows.nth(index).locator("../..");
		const toolbar = turn.locator('[data-slot="message-toolbar"]');
		await assistantRows.nth(index).hover();
		await expect(toolbar).toBeVisible();
		const geometry = await turn.evaluate((node) => {
			const prose = node.querySelector('[data-slot="bubble-content"]');
			const actions = node.querySelector('[data-slot="message-toolbar"]');
			if (!(prose && actions)) {
				return null;
			}
			const proseRect = prose.getBoundingClientRect();
			const actionRect = actions.getBoundingClientRect();
			return {
				actionLeft: actionRect.left,
				actionTop: actionRect.top,
				proseBottom: proseRect.bottom,
				proseLeft: proseRect.left,
			};
		});
		expect(geometry).not.toBeNull();
		if (geometry) {
			expect(geometry.actionTop).toBeGreaterThanOrEqual(
				geometry.proseBottom - 1
			);
			expect(
				Math.abs(geometry.actionLeft - geometry.proseLeft)
			).toBeLessThanOrEqual(1);
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

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("message-bubbles-a-major-pass-proof.png"),
	});
});
