// Browser proof for the pinned summary's sidebar/scrollbar contract. It mounts
// the real AgentChat and CoworkContextPanel in the focused React artifact.

import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/pinned-summary-scroll-proof.html";
const PINNED_COLUMN_WIDTH = 300;

function rect(page: Page, testId: string) {
	return page.getByTestId(testId).boundingBox();
}

test("keeps the transcript scrollbar at the workspace edge beside a short card", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(STORY_URL);

	const viewport = page.locator('[data-slot="message-scroller-viewport"]');
	await expect(viewport).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Pinned summary" })
	).toBeVisible();
	await expect(page.getByText("Pinned summary scrollbar proof")).toBeVisible();

	await expect
		.poll(async () =>
			viewport.evaluate(
				(element) => element.scrollHeight - element.clientHeight
			)
		)
		.toBeGreaterThan(500);

	const workspace = await rect(page, "workspace");
	const viewportBox = await viewport.boundingBox();
	const card = await page.getByTestId("summary-card").boundingBox();
	const surface = await rect(page, "chat-surface");

	expect(workspace).not.toBeNull();
	expect(viewportBox).not.toBeNull();
	expect(card).not.toBeNull();
	expect(surface).not.toBeNull();
	if (!(workspace && viewportBox && card && surface)) {
		return;
	}

	// The viewport's own right edge is the scrollbar edge. It must reach the
	// workspace edge, while the chat surface itself remains 300px narrower.
	expect(
		Math.abs(
			viewportBox.x + viewportBox.width - (workspace.x + workspace.width)
		)
	).toBeLessThanOrEqual(1);
	expect(surface.width).toBeLessThan(workspace.width - 250);
	expect(card.x + card.width).toBeLessThanOrEqual(
		workspace.x + workspace.width + 1
	);

	const cardHeight = await page
		.getByTestId("summary-card")
		.evaluate((element) => element.getBoundingClientRect().height);
	expect(cardHeight).toBeLessThan(workspace.height * 0.8);
});

test("keeps the sidebar width transition when toggled", async ({ page }) => {
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(STORY_URL);

	const spacer = page.getByTestId("sidebar-spacer");
	const initialWidth = (await spacer.boundingBox())?.width ?? 0;
	await page.getByTestId("toggle-summary").click();
	await expect(
		page.getByRole("complementary", { name: "Pinned summary" })
	).not.toBeVisible();

	const transition = await spacer.evaluate(
		(element) => getComputedStyle(element).transitionProperty
	);
	expect(transition).toContain("width");
	await expect
		.poll(async () => (await spacer.boundingBox())?.width ?? -1)
		.toBe(0);
	await page.getByTestId("toggle-summary").click();
	await expect(
		page.getByRole("complementary", { name: "Pinned summary" })
	).toBeVisible();
	await expect
		.poll(async () => (await spacer.boundingBox())?.width ?? -1)
		.toBe(PINNED_COLUMN_WIDTH);
	expect(initialWidth).toBe(PINNED_COLUMN_WIDTH);
});
