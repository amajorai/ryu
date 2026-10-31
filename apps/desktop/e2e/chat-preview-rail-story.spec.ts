// Real-browser proof for the chat preview rail overflow behavior
// (`e2e/harness/chat-preview-rail-story.{html,tsx}`).

import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/chat-preview-rail-story.html";
const EXPECTED_MESSAGE_COUNT = "56";
const EXPECTED_NAVIGATION_COUNT = 28;
const CENTERED_TOLERANCE_PX = 4;

async function openStory(page: Page) {
	await page.goto(STORY_URL);
	await expect(page.getByTestId("story-state")).toHaveAttribute(
		"data-message-count",
		EXPECTED_MESSAGE_COUNT,
		{ timeout: 60_000 }
	);
}

function collapsedRail(page: Page) {
	return page.locator('[data-slot="message-navigation-collapsed-rail"]');
}

function navigationPopover(page: Page) {
	return page.locator('[data-message-navigation-popover="true"]');
}

test("collapses a long message rail into a compact trigger", async ({
	page,
}) => {
	await openStory(page);

	const trigger = collapsedRail(page);
	await expect(trigger).toBeVisible();
	await expect(trigger).toHaveAttribute(
		"data-count",
		String(EXPECTED_NAVIGATION_COUNT)
	);
	await expect(page.locator('[data-slot="preview-rail-item"]')).toHaveCount(0);

	const viewportHeight = await page
		.locator('[data-slot="message-scroller-viewport"]')
		.evaluate((element) => element.clientHeight);
	const triggerBox = await trigger.boundingBox();
	expect(triggerBox).not.toBeNull();
	if (triggerBox) {
		expect(triggerBox.height).toBeLessThan(viewportHeight * 0.3);
	}
});

test("keeps the message navigation rail on the left and opens its popover inward", async ({
	page,
}) => {
	await openStory(page);

	const viewport = page.locator('[data-slot="message-scroller-viewport"]');
	const trigger = collapsedRail(page);
	const viewportBox = await viewport.boundingBox();
	const triggerBox = await trigger.boundingBox();
	expect(viewportBox).not.toBeNull();
	expect(triggerBox).not.toBeNull();
	if (!(viewportBox && triggerBox)) {
		return;
	}

	expect(triggerBox.x).toBeGreaterThanOrEqual(viewportBox.x);
	expect(triggerBox.x + triggerBox.width).toBeLessThan(
		viewportBox.x + viewportBox.width / 2
	);

	await trigger.click();
	const popover = navigationPopover(page);
	const popoverBox = await popover.boundingBox();
	expect(popoverBox).not.toBeNull();
	if (popoverBox) {
		expect(popoverBox.x).toBeGreaterThan(triggerBox.x + triggerBox.width);
	}
});

test("opens every message in one bounded scrollable popover", async ({
	page,
}) => {
	await openStory(page);
	await collapsedRail(page).click();

	const popover = navigationPopover(page);
	await expect(popover).toBeVisible();
	const items = popover.locator('[data-slot="message-navigation-item"]');
	await expect(items).toHaveCount(EXPECTED_NAVIGATION_COUNT);

	const metrics = await popover
		.locator('[data-slot="message-navigation-list"]')
		.evaluate((element) => {
			const style = getComputedStyle(element);
			return {
				clientHeight: element.clientHeight,
				maxHeight: style.maxHeight,
				overflowY: style.overflowY,
				scrollHeight: element.scrollHeight,
			};
		});

	expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
	expect(metrics.overflowY).toBe("auto");
	expect(metrics.maxHeight).not.toBe("none");
});

test("selecting a popover message closes it and updates the active jump target", async ({
	page,
}) => {
	await openStory(page);
	const trigger = collapsedRail(page);
	await trigger.click();

	const target = navigationPopover(page)
		.locator('[data-slot="message-navigation-item"]')
		.nth(12);
	const targetId = await target.getAttribute("data-message-id");
	expect(targetId).not.toBeNull();
	await target.click();

	await expect(navigationPopover(page)).toHaveCount(0);
	if (targetId) {
		await expect(trigger).toHaveAttribute("data-active-message-id", targetId);
		// Rows above the target only take their real height as the jump reveals
		// them. The jump has landed once its message holds the viewport centre,
		// and the active jump target must still be that message afterwards.
		const viewport = page.locator('[data-slot="message-scroller-viewport"]');
		const message = viewport.locator(`[data-message-id="${targetId}"]`).first();
		await expect
			.poll(async () => {
				const viewportBox = await viewport.boundingBox();
				const messageBox = await message.boundingBox();
				if (!(viewportBox && messageBox)) {
					return Number.POSITIVE_INFINITY;
				}
				return Math.abs(
					messageBox.y +
						messageBox.height / 2 -
						(viewportBox.y + viewportBox.height / 2)
				);
			})
			.toBeLessThanOrEqual(CENTERED_TOLERANCE_PX);
		await expect(trigger).toHaveAttribute("data-active-message-id", targetId);
	}
});

test("captures the completed left message navigation proof", async ({
	page,
}, testInfo) => {
	await openStory(page);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("chat-preview-rail-left-proof.png"),
	});
});
